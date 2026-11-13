// OpenCode Zen usage probe. Single fixed official endpoint, read-only.
// Reference implementations reviewed 2026-11-12:
// https://github.com/steipete/CodexBar/blob/main/docs/opencode.md (MIT)
// https://cdn.jsdelivr.net/npm/pi-opencodego@0.1.5/docs/OPENCODE-API.md
// The endpoint is an account-status read, not an inference call.
const ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';
const MAX_BODY = 1_048_576;
const DEADLINE_MS = 12_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const WINDOWS = Object.freeze({ rolling: 'rolling', weekly: 'weekly', monthly: 'monthly' });
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = code => Object.assign(new Error(code), { code });
const invalid = () => { throw error('invalid-response'); };
const aborted = signal => { if (signal.aborted) throw error('timeout'); };

function resetsAtMs(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_DATE_MS) invalid();
    return parsed;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 100_000_000_000 && value <= MAX_DATE_MS) return value;
  invalid();
}

/** now is Unix ms. Returns quota-window metrics for the reported windows;
 * missing or null windows are skipped, never shown as 0%. */
export function parseOpenCodeUsage(json) {
  if (!obj(json) || !obj(json.usage)) invalid();
  const metrics = [];
  for (const [name, label] of Object.entries(WINDOWS)) {
    const row = json.usage[name];
    if (row === undefined || row === null) continue;
    if (!obj(row) || typeof row.percent !== 'number' || !Number.isFinite(row.percent) || row.percent < 0 || row.percent > 100) invalid();
    const metric = { type: 'quota-window', label, unit: 'percent', usedPercent: row.percent };
    const resetsAt = resetsAtMs(row.resetsAt);
    if (resetsAt !== undefined) metric.resetsAt = resetsAt;
    metrics.push(metric);
  }
  if (!metrics.length) invalid();
  return metrics;
}

function cancel(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* no raw upstream errors. */ }
}

async function responseJson(response, signal) {
  if (!obj(response) || typeof response.ok !== 'boolean' || !Number.isInteger(response.status)) invalid();
  if (response.redirected) { cancel(response.body); throw error('upstream'); }
  if (!response.ok) {
    cancel(response.body);
    throw error(response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 429 ? 'rate-limited' : 'upstream');
  }
  let reader;
  try { reader = response.body?.getReader(); } catch { invalid(); }
  if (!reader) invalid();
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      aborted(signal);
      let item;
      try { item = await reader.read(); }
      catch { throw error(signal.aborted ? 'timeout' : 'network-read'); }
      const { done, value } = item;
      aborted(signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) invalid();
      length += value.byteLength;
      if (length > MAX_BODY) {
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
        invalid();
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (cause) {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
    if (signal.aborted) throw error('timeout');
    if (cause?.code === 'network-read') throw error('network-read');
    throw error('invalid-response');
  } finally {
    try { reader.releaseLock(); } catch { /* no raw errors */ }
  }
}

export async function queryOpenCodeUsage({ key, fetcher = fetch, now = Date.now(), signal } = {}) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(key)) throw error('unauthorized');
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS) invalid();
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
  try {
    aborted(combined);
    let response;
    try {
      response = await fetcher(ENDPOINT, {
        method: 'GET', redirect: 'error', signal: combined,
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      }).then(value => { aborted(combined); return value; }, () => { throw error(combined.aborted ? 'timeout' : 'network-connect'); });
    } catch (cause) { throw cause?.code ? cause : error('network-connect'); }
    aborted(combined);
    return parseOpenCodeUsage(await responseJson(response, combined));
  } catch (cause) {
    if (combined.aborted) throw error('timeout');
    if (cause?.code) throw cause;
    invalid();
  }
}
