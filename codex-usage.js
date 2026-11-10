// Native DSH OAuth grant only. Never read CLI files, refresh tokens or mutate grants.
// Usage endpoint/schema reference: https://github.com/steipete/CodexBar/blob/main/docs/codex.md
// This is a ChatGPT/Codex subscription probe, NOT the OpenAI API balance/cost API.
const RECORD_KEY = 'llm-pi-ai/openai-codex';
const ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const MAX_BODY = 1_048_576;
const DEADLINE_MS = 12_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const internal = Symbol('codex-usage-error');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fault = code => Object.assign(new Error(code), { code, [internal]: true });
const invalid = () => { throw fault('invalid-response'); };
const headerValue = (value, max) => typeof value === 'string' && value.length <= max && /^[\x21-\x7e]+$/.test(value);

/** Access-only credential for one native account. now and expires are Unix ms.
 * Reading the record is the sole credential operation: do not inspect refresh,
 * copy the payload, trigger login/renewal, or return this value through UI/tools.
 */
export async function resolveNativeCodexCredential(credentials, { now = Date.now() } = {}) {
  let record;
  try { record = await credentials.readRecord(RECORD_KEY); }
  catch { throw fault('unsupported-auth'); }
  if (record === null || record === undefined) throw fault('codex-auth-required');
  try {
    if (!object(record) || record.kind !== 'grant' || !object(record.payload)) throw fault('unsupported-auth');
    const payload = record.payload;
    const access = payload.access;
    const accountId = payload.accountId;
    const expires = payload.expires;
    if (payload.type !== 'oauth' || !headerValue(access, 8192) || !headerValue(accountId, 1024) ||
      !Number.isSafeInteger(expires) || expires <= 0 || expires > MAX_DATE_MS ||
      !Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS) throw fault('unsupported-auth');
    if (expires <= now + 30_000) throw fault('codex-auth-expired');
    return { access, accountId, expires };
  } catch (cause) {
    if (cause?.[internal]) throw cause;
    throw fault('unsupported-auth');
  }
}

/** Normalize only the main subscription windows; model-specific limits and
 * credits are intentionally omitted. Window positions are not semantic labels.
 */
export function parseCodexUsage(json) {
  if (!object(json) || !object(json.rate_limit)) invalid();
  const metrics = [];
  for (const key of ['primary_window', 'secondary_window']) {
    const row = json.rate_limit[key];
    if (row === undefined || row === null) continue;
    if (!object(row) || typeof row.used_percent !== 'number' || !Number.isFinite(row.used_percent) || row.used_percent < 0 || row.used_percent > 100) invalid();
    const duration = row.limit_window_seconds;
    if (duration !== undefined && duration !== null && (!Number.isSafeInteger(duration) || duration <= 0)) invalid();
    const metric = {
      type: 'quota-window',
      label: duration === 18000 ? 'rolling' : duration === 604800 ? 'weekly' : 'quota',
      unit: 'percent', usedPercent: row.used_percent,
    };
    if (duration !== undefined && duration !== null) metric.durationSeconds = duration;
    if (row.reset_at !== undefined && row.reset_at !== null) {
      if (!Number.isSafeInteger(row.reset_at) || row.reset_at <= 0 || row.reset_at > MAX_DATE_MS / 1000) invalid();
      metric.resetsAt = row.reset_at * 1000;
    }
    metrics.push(metric);
  }
  if (!metrics.length) invalid();
  return metrics.sort((left, right) => (left.durationSeconds ?? Infinity) - (right.durationSeconds ?? Infinity));
}

function cancelBody(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* best effort; no upstream error text */ }
}
function aborted(signal) {
  if (signal.aborted) throw fault('timeout');
}
// The deadline also bounds non-cooperative fetchers/readers. Late rejections are
// consumed, and the listener is removed after either settlement path.
function bounded(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(fault('timeout')); };
    Promise.resolve(operation).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(fault('timeout')); else resolve(value);
    }, () => {
      signal.removeEventListener('abort', abort);
      reject(fault(signal.aborted ? 'timeout' : 'network'));
    });
    if (signal.aborted) { reject(fault('timeout')); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function responseJson(response, signal) {
  if (!object(response) || !Number.isInteger(response.status) || typeof response.ok !== 'boolean') invalid();
  if (response.redirected || (typeof response.url === 'string' && response.url && response.url !== ENDPOINT)) {
    cancelBody(response.body); throw fault('upstream');
  }
  if (!response.ok || response.status < 200 || response.status >= 300) {
    cancelBody(response.body);
    throw fault(response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 429 ? 'rate-limited' : 'upstream');
  }
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined && /^\d+$/.test(declared) && Number(declared) > MAX_BODY) {
    cancelBody(response.body); invalid();
  }
  let reader;
  try { reader = response.body?.getReader(); } catch { invalid(); }
  if (!reader) invalid();
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      aborted(signal);
      const chunk = await bounded(reader.read(), signal);
      aborted(signal);
      if (!object(chunk) || typeof chunk.done !== 'boolean') invalid();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) invalid();
      length += chunk.value.byteLength;
      if (length > MAX_BODY) invalid();
      chunks.push(chunk.value);
    }
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))); }
    catch { invalid(); }
    return parsed;
  } catch (cause) {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
    if (signal.aborted) throw fault('timeout');
    if (cause?.[internal]) throw cause;
    invalid();
  } finally {
    try { reader.releaseLock(); } catch { /* best effort */ }
  }
}

/** One account-scoped, bounded GET. Returns normalized metrics only; never the
 * raw body, account id, bearer, subscription identity, or provider error text.
 * Caller cancellation shares the fixed timeout code; no implicit retry/refresh.
 */
export async function queryCodexUsage({ credential, fetcher = fetch, signal } = {}) {
  if (!object(credential) || !headerValue(credential.access, 8192) || !headerValue(credential.accountId, 1024)) throw fault('unauthorized');
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, DEADLINE_MS);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    aborted(controller.signal);
    let response;
    try {
      response = await bounded(fetcher(ENDPOINT, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${credential.access}`, 'ChatGPT-Account-Id': credential.accountId, Accept: 'application/json' },
      }), controller.signal);
    } catch { throw fault(controller.signal.aborted ? 'timeout' : 'network'); }
    aborted(controller.signal);
    return parseCodexUsage(await responseJson(response, controller.signal));
  } catch (cause) {
    if (controller.signal.aborted) throw fault('timeout');
    if (cause?.[internal]) throw cause;
    invalid();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
