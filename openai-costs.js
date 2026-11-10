// Organization-wide month-to-date costs, not account balance or inference-key usage.
// Contract: https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage.md
const ENDPOINT = 'https://api.openai.com/v1/organization/costs';
const MAX_BODY = 1_048_576;
const MAX_PAGES = 8;
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = code => Object.assign(new Error(code), { code });
const invalid = () => { throw error('invalid-response'); };
const aborted = signal => { if (signal.aborted) throw error('timeout'); };
function bounded(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(error('timeout')); };
    if (signal.aborted) { reject(error('timeout')); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', onAbort); resolve(value);
    }, () => {
      signal.removeEventListener('abort', onAbort); reject(error(signal.aborted ? 'timeout' : 'network'));
    });
  });
}

// Number.toString supplies a finite decimal (possibly scientific). Sum those
// decimals as integer coefficients: never accumulate money with float addition.
function decimal(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  const [mantissa, exponent = '0'] = String(value).split('e');
  const scale = (mantissa.split('.')[1]?.length ?? 0) - Number(exponent);
  let integer = BigInt(mantissa.replace('.', ''));
  if (scale < 0) integer *= 10n ** BigInt(-scale);
  return { integer, scale: Math.max(0, scale) };
}
function add(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    integer: left.integer * 10n ** BigInt(scale - left.scale) + right.integer * 10n ** BigInt(scale - right.scale),
    scale,
  };
}
function format({ integer, scale }) {
  if (integer === 0n) return '0';
  const sign = integer < 0n ? '-' : '';
  let digits = (integer < 0n ? -integer : integer).toString();
  if (!scale) return sign + digits;
  digits = digits.padStart(scale + 1, '0');
  return (sign + digits.slice(0, -scale) + '.' + digits.slice(-scale)).replace(/\.?0+$/, '');
}
function cancel(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* No raw upstream errors. */ }
}
async function pageJson(response, signal) {
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
      const { done, value } = await bounded(reader.read(), signal);
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
    if (cause?.code === 'network') throw error('network');
    throw error('invalid-response');
  } finally {
    try { reader.releaseLock(); } catch { /* no raw errors */ }
  }
}

/** now is a Unix-millisecond number; periodStart and periodEnd are milliseconds.
 * All pages share ONE 25s deadline. Any incomplete/invalid page rejects the
 * entire result; amounts from earlier pages are never returned as a total.
 */
export async function queryOpenAICosts({ key, fetcher = fetch, now = Date.now(), signal, groupByApiKey = false } = {}) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(key)) throw error('unauthorized');
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) invalid();
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
  if (typeof groupByApiKey !== 'boolean') invalid();
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const periodStart = start.getTime();
  const startSec = Math.floor(periodStart / 1000);
  const endSec = Math.floor(now / 1000);
  const periodEnd = endSec * 1000;
  const shared = { type: 'spend', periodStart, periodEnd, timezone: 'UTC', scope: 'organization' };
  // The API accepts whole Unix seconds and end_time is exclusive. During the
  // first second of a UTC month both boundaries quantize to the same instant;
  // an empty month-to-date range is known to contain no records and needs no call.
  if (endSec === startSec) {
    if (signal?.aborted) throw error('timeout');
    return [{ ...shared, amount: '0', currency: 'USD', noRecords: true }];
  }
  const combined = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
  const sums = new Map();
  const perKey = new Map();
  const cursors = new Set();
  const buckets = new Set();
  let cursor;
  let records = 0;
  {
    for (let index = 0; index < MAX_PAGES; index++) {
      aborted(combined);
      const url = new URL(ENDPOINT);
      url.searchParams.set('start_time', String(startSec));
      url.searchParams.set('end_time', String(endSec));
      url.searchParams.set('bucket_width', '1d');
      url.searchParams.set('limit', '180');
      if (groupByApiKey) url.searchParams.set('group_by', 'api_key_id');
      if (cursor !== undefined) url.searchParams.set('page', cursor);
      let response;
      try {
        response = await bounded(fetcher(url.href, { method: 'GET', redirect: 'error', signal: combined,
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }), combined);
      } catch { throw error(combined.aborted ? 'timeout' : 'network'); }
      aborted(combined);
      const page = await pageJson(response, combined);
      if (!obj(page) || page.object !== 'page' || !Array.isArray(page.data) || typeof page.has_more !== 'boolean') invalid();
      for (const bucket of page.data) {
        if (!obj(bucket) || bucket.object !== 'bucket' || !Array.isArray(bucket.results) ||
          !Number.isSafeInteger(bucket.start_time) || !Number.isSafeInteger(bucket.end_time) ||
          bucket.start_time < 0 || bucket.end_time <= bucket.start_time) invalid();
        const bucketId = `${bucket.start_time}:${bucket.end_time}`;
        if (buckets.has(bucketId)) invalid();
        buckets.add(bucketId);
        for (const result of bucket.results) {
          if (!obj(result) || result.object !== 'organization.costs.result' || !obj(result.amount) ||
            typeof result.amount.currency !== 'string' || !/^[a-zA-Z]{3}$/.test(result.amount.currency)) invalid();
          if (result.api_key_id !== undefined && result.api_key_id !== null &&
            (typeof result.api_key_id !== 'string' || !result.api_key_id || result.api_key_id.length > 256 || !/^[\x21-\x7e]+$/.test(result.api_key_id))) invalid();
          const currency = result.amount.currency.toUpperCase();
          const amount = decimal(result.amount.value);
          sums.set(currency, add(sums.get(currency) ?? { integer: 0n, scale: 0 }, amount));
          if (groupByApiKey) {
            const slot = `${currency}\u0000${result.api_key_id ?? ''}`;
            perKey.set(slot, add(perKey.get(slot) ?? { integer: 0n, scale: 0 }, amount));
          }
          records++;
        }
      }
      if (!page.has_more) {
        if (page.next_page !== null) invalid();
        break;
      }
      if (typeof page.next_page !== 'string' || !page.next_page.trim() || page.next_page.length > 4096 || cursors.has(page.next_page) || index === MAX_PAGES - 1) invalid();
      cursor = page.next_page;
      cursors.add(cursor);
    }
  }
  aborted(combined);
  const breakdown = groupByApiKey ? [...perKey]
    .map(([slot, amount]) => {
      const [currency, apiKeyId] = slot.split('\u0000');
      return { apiKeyId: apiKeyId || null, currency, amount: format(amount) };
    })
    .sort((a, b) => Number(b.amount) - Number(a.amount) || a.currency.localeCompare(b.currency) || (a.apiKeyId ?? '').localeCompare(b.apiKeyId ?? ''))
    : undefined;
  if (!records) return [{ ...shared, amount: '0', currency: 'USD', noRecords: true }];
  return [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({
    ...shared, amount: format(amount), currency,
    ...(breakdown ? { breakdown: breakdown.filter(entry => entry.currency === currency) } : {}),
  }));
}
