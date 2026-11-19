// Organization-wide month-to-date costs and recent daily history, not account balance or inference-key usage.
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

/** now is a Unix-millisecond number; amount remains month-to-date for the agent
 * tool, 0d covers today's partial UTC day through now, and 1d/7d/30d cover
 * complete UTC days ending yesterday. daily remains the 30-day complete history.
 * All pages share ONE 25s deadline. Any incomplete/invalid page rejects the
 * entire result; amounts from earlier pages are never returned as a total.
 */
export async function queryOpenAICosts({ key, fetcher = fetch, now = Date.now(), signal, groupByApiKey = false } = {}) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(key)) throw error('unauthorized');
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) invalid();
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
  if (typeof groupByApiKey !== 'boolean') invalid();
  const dayMs = 86_400_000;
  const month = new Date(now);
  month.setUTCDate(1);
  month.setUTCHours(0, 0, 0, 0);
  const periodStart = month.getTime();
  const endSec = Math.floor(now / 1000);
  const periodEnd = endSec * 1000;
  const historyEnd = Math.floor(now / dayMs) * dayMs;
  const historyStart = Math.max(0, historyEnd - 30 * dayMs);
  const historyDays = Math.floor((historyEnd - historyStart) / dayMs);
  const queryStart = Math.min(periodStart, historyStart);
  const startSec = Math.floor(queryStart / 1000);
  const periodStartSec = Math.floor(periodStart / 1000);
  const shared = { type: 'spend', periodStart, periodEnd, timezone: 'UTC', scope: 'organization' };
  const rangeDays = [['0d', 0], ['1d', 1], ['7d', 7], ['30d', 30]];
  if (endSec <= startSec) {
    if (signal?.aborted) throw error('timeout');
    const daily = Array.from({ length: historyDays }, (_, index) => ({ date: historyStart + index * dayMs, amount: '0', hasRecords: false }));
    const ranges = Object.fromEntries(rangeDays.map(([name]) => [name, { amount: '0', noRecords: true, ...(groupByApiKey ? { breakdown: [] } : {}) }]));
    return [{ ...shared, amount: '0', currency: 'USD', noRecords: true, daily, ranges, ...(groupByApiKey ? { breakdown: [] } : {}) }];
  }
  const combined = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
  const sums = new Map();
  const perKey = new Map();
  const projectsByKey = new Map();
  const dailySums = new Map();
  const dailyRecords = new Set();
  const dailyPerKey = new Map();
  const dailyProjectsByKey = new Map();
  const todaySums = new Map();
  const todayRecords = new Set();
  const todayPerKey = new Map();
  const todayProjectsByKey = new Map();
  const cursors = new Set();
  const buckets = new Set();
  let cursor;
  const monthRecords = new Map();
  for (let index = 0; index < MAX_PAGES; index++) {
    aborted(combined);
    const url = new URL(ENDPOINT);
    url.searchParams.set('start_time', String(startSec));
    url.searchParams.set('end_time', String(endSec));
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', '180');
    if (groupByApiKey) {
      url.searchParams.append('group_by', 'project_id');
      url.searchParams.append('group_by', 'api_key_id');
    }
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
        if (result.project_id !== undefined && result.project_id !== null &&
          (typeof result.project_id !== 'string' || !result.project_id || result.project_id.length > 256 || !/^[\x21-\x7e]+$/.test(result.project_id))) invalid();
        const currency = result.amount.currency.toUpperCase();
        const amount = decimal(result.amount.value);
        const day = Math.floor(bucket.start_time * 1000 / dayMs) * dayMs;
        if (day === historyEnd) {
          todaySums.set(currency, add(todaySums.get(currency) ?? { integer: 0n, scale: 0 }, amount));
          todayRecords.add(currency);
          if (groupByApiKey) {
            const keySlot = `${currency}\u0000${result.api_key_id ?? ''}`;
            todayPerKey.set(keySlot, add(todayPerKey.get(keySlot) ?? { integer: 0n, scale: 0 }, amount));
            if (result.api_key_id && result.project_id) {
              let projects = todayProjectsByKey.get(keySlot);
              if (!projects) todayProjectsByKey.set(keySlot, projects = new Set());
              projects.add(result.project_id);
            }
          }
        }
        if (day >= historyStart && day < historyEnd) {
          const dailySlot = `${currency}\u0000${day}`;
          dailySums.set(dailySlot, add(dailySums.get(dailySlot) ?? { integer: 0n, scale: 0 }, amount));
          dailyRecords.add(dailySlot);
          if (groupByApiKey) {
            const apiKeyId = result.api_key_id ?? '';
            const keySlot = `${currency}\u0000${day}\u0000${apiKeyId}`;
            dailyPerKey.set(keySlot, add(dailyPerKey.get(keySlot) ?? { integer: 0n, scale: 0 }, amount));
            if (result.api_key_id && result.project_id) {
              let projects = dailyProjectsByKey.get(keySlot);
              if (!projects) dailyProjectsByKey.set(keySlot, projects = new Set());
              projects.add(result.project_id);
            }
          }
        }
        if (bucket.start_time >= periodStartSec) {
          sums.set(currency, add(sums.get(currency) ?? { integer: 0n, scale: 0 }, amount));
          if (groupByApiKey) {
            const slot = `${currency}\u0000${result.api_key_id ?? ''}`;
            perKey.set(slot, add(perKey.get(slot) ?? { integer: 0n, scale: 0 }, amount));
            if (result.api_key_id && result.project_id) {
              let projects = projectsByKey.get(slot);
              if (!projects) projectsByKey.set(slot, projects = new Set());
              projects.add(result.project_id);
            }
          }
          monthRecords.set(currency, (monthRecords.get(currency) ?? 0) + 1);
        }
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
  aborted(combined);
  const toBreakdown = (amounts, projectsBySlot) => [...amounts]
    .map(([slot, amount]) => {
      const [currency, apiKeyId] = slot.split('\u0000');
      const projects = projectsBySlot.get(slot);
      return { apiKeyId: apiKeyId || null, ...(projects?.size === 1 ? { projectId: [...projects][0] } : {}), currency, amount: format(amount) };
    })
    .sort((a, b) => Number(b.amount) - Number(a.amount) || a.currency.localeCompare(b.currency) || (a.apiKeyId ?? '').localeCompare(b.apiKeyId ?? ''));
  const breakdown = groupByApiKey ? toBreakdown(perKey, projectsByKey) : undefined;
  const currencies = new Set([...sums.keys(), ...[...dailySums.keys()].map(slot => slot.split('\u0000')[0]), ...todaySums.keys()]);
  if (!currencies.size) currencies.add('USD');
  return [...currencies].sort((a, b) => a.localeCompare(b)).map(currency => {
    const daily = Array.from({ length: historyDays }, (_, index) => {
      const date = historyStart + index * dayMs;
      const slot = `${currency}\u0000${date}`;
      const value = dailySums.get(slot) ?? { integer: 0n, scale: 0 };
      return { date, amount: format(value), hasRecords: dailyRecords.has(slot) };
    });
    const ranges = Object.fromEntries(rangeDays.map(([name, days]) => {
      if (days === 0) {
        const currencyPrefix = `${currency}\u0000`;
        const rangePerKey = new Map([...todayPerKey].filter(([slot]) => slot.startsWith(currencyPrefix)));
        const rangeProjects = new Map([...todayProjectsByKey].filter(([slot]) => slot.startsWith(currencyPrefix)));
        return [name, {
          amount: format(todaySums.get(currency) ?? { integer: 0n, scale: 0 }),
          ...(!todayRecords.has(currency) ? { noRecords: true } : {}),
          ...(groupByApiKey ? { breakdown: toBreakdown(rangePerKey, rangeProjects) } : {}),
        }];
      }
      const rangeStart = historyEnd - days * dayMs;
      let total = { integer: 0n, scale: 0 };
      let hasRecords = false;
      for (const point of daily) {
        if (point.date < rangeStart) continue;
        const amount = dailySums.get(`${currency}\u0000${point.date}`);
        if (amount) total = add(total, amount);
        if (point.hasRecords) hasRecords = true;
      }
      if (!groupByApiKey) return [name, { amount: format(total), ...(!hasRecords ? { noRecords: true } : {}) }];
      const rangePerKey = new Map();
      const rangeProjects = new Map();
      for (const [slot, amount] of dailyPerKey) {
        const [entryCurrency, date, apiKeyId] = slot.split('\u0000');
        if (entryCurrency !== currency || Number(date) < rangeStart) continue;
        const keySlot = `${currency}\u0000${apiKeyId}`;
        rangePerKey.set(keySlot, add(rangePerKey.get(keySlot) ?? { integer: 0n, scale: 0 }, amount));
        const projects = dailyProjectsByKey.get(slot);
        if (projects?.size) {
          let combinedProjects = rangeProjects.get(keySlot);
          if (!combinedProjects) rangeProjects.set(keySlot, combinedProjects = new Set());
          for (const project of projects) combinedProjects.add(project);
        }
      }
      return [name, { amount: format(total), ...(!hasRecords ? { noRecords: true } : {}), breakdown: toBreakdown(rangePerKey, rangeProjects) }];
    }));
    return {
      ...shared, amount: format(sums.get(currency) ?? { integer: 0n, scale: 0 }), currency, daily, ranges,
      ...(monthRecords.get(currency) === undefined ? { noRecords: true } : {}),
      ...(breakdown ? { breakdown: breakdown.filter(entry => entry.currency === currency) } : {}),
    };
  });
}
