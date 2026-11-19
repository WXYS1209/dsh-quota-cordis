// Best-effort display-name lookup for project API keys referenced by Costs.
// Only the fixed official OpenAI Admin endpoint is queried. `redacted_value`
// and owner details are deliberately ignored; only id/name are retained.
const ORIGIN = 'https://api.openai.com';
const MAX_LOOKUPS = 40;
const MAX_BODY = 262_144;
const DEADLINE_MS = 8_000;
const CONCURRENCY = 4;
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function cancel(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* no raw errors */ }
}
function nameText(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  return text || undefined;
}
function validId(value, prefix) {
  return typeof value === 'string' && value.length <= 256 && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value);
}
function bounded(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(new Error('aborted')); };
    if (signal.aborted) { reject(new Error('aborted')); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', onAbort); resolve(value);
    }, () => {
      signal.removeEventListener('abort', onAbort); reject(new Error('network'));
    });
  });
}
async function jsonBody(response, signal) {
  if (!obj(response) || typeof response.ok !== 'boolean' || !Number.isInteger(response.status)) return undefined;
  if (response.redirected || !response.ok) { cancel(response.body); return undefined; }
  let reader;
  try { reader = response.body?.getReader(); } catch { return undefined; }
  if (!reader) return undefined;
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      if (signal.aborted) return undefined;
      const { done, value } = await bounded(reader.read(), signal);
      if (signal.aborted) return undefined;
      if (done) break;
      if (!(value instanceof Uint8Array)) return undefined;
      length += value.byteLength;
      if (length > MAX_BODY) { cancel(reader); return undefined; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    cancel(reader);
    return undefined;
  } finally {
    try { reader.releaseLock(); } catch { /* no raw errors */ }
  }
}

/**
 * Resolve project-scoped API-key IDs to user-assigned names. Failure is best
 * effort: callers keep their existing ID fallback and retain the Costs result.
 * @param {{key:string, entries:Array<{projectId?:string,apiKeyId?:string|null}>, fetcher?:Function, signal?:AbortSignal}} options
 * @returns {Promise<Map<string,string>>} key is `${projectId}\0${apiKeyId}`
 */
export async function queryOpenAIKeyNames({ key, entries, fetcher = fetch, signal } = {}) {
  const names = new Map();
  if (typeof key !== 'string' || !Array.isArray(entries) || (signal !== undefined && !(signal instanceof AbortSignal))) return names;
  const unique = new Map();
  for (const entry of entries) {
    if (!obj(entry) || !validId(entry.projectId, 'proj') || !validId(entry.apiKeyId, 'key')) continue;
    unique.set(`${entry.projectId}\u0000${entry.apiKeyId}`, { projectId: entry.projectId, apiKeyId: entry.apiKeyId });
  }
  const candidates = [...unique].slice(0, MAX_LOOKUPS);
  if (!candidates.length || signal?.aborted) return names;
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
  let cursor = 0;
  async function worker() {
    while (!combined.aborted) {
      const index = cursor++;
      if (index >= candidates.length) return;
      const [slot, item] = candidates[index];
      try {
        const url = new URL(`/v1/organization/projects/${encodeURIComponent(item.projectId)}/api_keys/${encodeURIComponent(item.apiKeyId)}`, ORIGIN);
        const response = await bounded(fetcher(url.href, {
          method: 'GET', redirect: 'error', signal: combined,
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        }), combined);
        const json = await jsonBody(response, combined);
        if (!obj(json) || (json.object !== undefined && json.object !== 'organization.project.api_key') || json.id !== item.apiKeyId) continue;
        const name = nameText(json.name);
        if (name) names.set(slot, name);
        // Never retain the response object: it also contains redacted_value and owner metadata.
      } catch { /* Key-name enrichment never breaks cost reporting. */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
  return names;
}
