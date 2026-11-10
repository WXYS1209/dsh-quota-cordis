import { randomBytes, timingSafeEqual } from 'node:crypto';

export const DEFAULT_COLOR_THRESHOLDS = Object.freeze({ greenMin: 50, orangeMin: 25 });
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function validateColorThresholds(value = DEFAULT_COLOR_THRESHOLDS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-thresholds');
  const { greenMin, orangeMin } = value;
  if (!Number.isInteger(greenMin) || !Number.isInteger(orangeMin) || orangeMin < 0 || greenMin > 100 || orangeMin >= greenMin) fail('invalid-thresholds');
  if (Object.keys(value).some(key => !['greenMin', 'orangeMin'].includes(key))) fail('invalid-thresholds');
  return { greenMin, orangeMin };
}

export class QuotaColorSettings {
  constructor(value, persist) {
    this.value = validateColorThresholds(value);
    this.persist = persist;
    this.csrf = randomBytes(32).toString('base64url');
  }
  read() { return { colorThresholds: { ...this.value }, writable: typeof this.persist === 'function' }; }
  browserRead() { return { ...this.read(), csrf: this.csrf }; }
  csrfMatches(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(this.csrf));
  }
  async save(value) {
    const validated = validateColorThresholds(value);
    if (typeof this.persist !== 'function') fail('settings-unavailable');
    try { await this.persist(validated); }
    catch (cause) {
      fail(typeof cause?.code === 'string' && /conflict/i.test(cause.code) ? 'settings-conflict' : 'save-failed');
    }
    this.value = validated;
    return { ...this.read(), saved: true };
  }
}

export async function readSmallSettingsBody(request) {
  if (Number(request.headers.get('content-length') ?? 0) > 1024) fail('invalid-thresholds');
  const reader = request.body?.getReader();
  if (!reader) fail('invalid-thresholds');
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const result = await new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('invalid-thresholds')); };
        if (signal.aborted) { reject(new Error('invalid-thresholds')); return; }
        signal.addEventListener('abort', abort, { once: true });
        reader.read().then(value => { signal.removeEventListener('abort', abort); resolve(value); }, () => { signal.removeEventListener('abort', abort); reject(new Error('invalid-thresholds')); });
      });
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 1024) fail('invalid-thresholds');
      parts.push(result.value);
    }
    return validateColorThresholds(JSON.parse(Buffer.concat(parts).toString('utf8')));
  } catch { fail('invalid-thresholds'); }
  finally {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}
