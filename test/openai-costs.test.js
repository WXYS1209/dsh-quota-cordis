import test from 'node:test';
import assert from 'node:assert/strict';
import { queryOpenAICosts } from '../src/openai-costs.js';

const KEY = 'synthetic-admin-key-only';
const NOW = Date.UTC(2026, 10, 5, 9, 30, 45, 123);
const START = Date.UTC(2026, 10, 1);
const DAY_MS = 86_400_000;
const TODAY = Math.floor(NOW / DAY_MS) * DAY_MS;
const HISTORY_START = TODAY - 30 * DAY_MS;
const result = (value, currency = 'usd', extra = {}) => ({ object: 'organization.costs.result', amount: { value, currency }, ...extra });
const bucket = (results = [], day = 1) => ({ object: 'bucket', start_time: START / 1000 + (day - 1) * 86400, end_time: START / 1000 + day * 86400, results });
const page = (data = [], next_page = null) => ({ object: 'page', data, has_more: next_page !== null, next_page });
const response = body => Response.json(body);
const base = { key: KEY, now: NOW };
const run = (body, args = {}) => queryOpenAICosts({ ...base, fetcher: async () => response(body), ...args });
const rejects = async (promise, code = 'invalid-response') => assert.rejects(promise, err => {
  assert.equal(err.message, code);
  assert.equal(err.code, code);
  assert.equal(err.cause, undefined);
  assert.ok(!JSON.stringify(err).includes(KEY));
  return true;
});

test('queries the official Costs endpoint for complete UTC days, today-to-now, and month-to-date', async () => {
  let calls = 0;
  const metrics = await queryOpenAICosts({ ...base, fetcher: async (address, options) => {
    calls++;
    const url = new URL(address);
    assert.equal(url.origin, 'https://api.openai.com');
    assert.equal(url.pathname, '/v1/organization/costs');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      start_time: String(HISTORY_START / 1000), end_time: String(Math.floor(NOW / 1000)), bucket_width: '1d', limit: '180',
    });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    assert.ok(options.signal instanceof AbortSignal);
    return response(page([bucket([result(12.42)])]));
  } });
  assert.equal(calls, 1);
  const daily = Array.from({ length: 30 }, (_, index) => ({ date: HISTORY_START + index * DAY_MS, amount: index === 26 ? '12.42' : '0', hasRecords: index === 26 }));
  assert.deepEqual(metrics, [{ type: 'spend', amount: '12.42', currency: 'USD', periodStart: START, periodEnd: Math.floor(NOW / 1000) * 1000, timezone: 'UTC', scope: 'organization', daily,
    ranges: { '0d': { amount: '0', noRecords: true }, '1d': { amount: '0', noRecords: true }, '7d': { amount: '12.42' }, '30d': { amount: '12.42' } },
  }]);
  assert.ok(!JSON.stringify(metrics).includes(KEY));
});

test('all pages share one signal and opaque cursors never change host/path or add filters', async () => {
  const cursor = 'https://evil.example/?api_key_ids[]=secret&group_by=model#x';
  const signals = [];
  let calls = 0;
  const metrics = await queryOpenAICosts({ ...base, fetcher: async (address, options) => {
    const url = new URL(address);
    signals.push(options.signal);
    assert.equal(url.origin + url.pathname, 'https://api.openai.com/v1/organization/costs');
    if (calls++ === 0) return response(page([bucket([result(0.1)])], cursor));
    assert.equal(url.searchParams.get('page'), cursor);
    assert.deepEqual([...url.searchParams.keys()].sort(), ['bucket_width', 'end_time', 'limit', 'page', 'start_time']);
    return response(page([bucket([result(0.2)], 2)]));
  } });
  assert.equal(calls, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(metrics[0].amount, '0.3');
});

test('sums only amount.value in results; separates currencies and ignores unrelated totals', async () => {
  const data = page([bucket([
    result(1.1, 'USD', { total: 999, quantity: 888, input_tokens: 777 }),
    result(2.2, 'usd'), result(0.5, 'eur'), result(-0.25, 'EUR'),
  ])]);
  data.total = 9999;
  data.data[0].amount = { value: 50000, currency: 'usd' };
  const metrics = await run(data);
  assert.deepEqual(metrics.map(({ currency, amount }) => ({ currency, amount })), [{ currency: 'EUR', amount: '0.25' }, { currency: 'USD', amount: '3.3' }]);
});

test('zero records differ from a real zero or credit/refund result', async () => {
  for (const data of [page(), page([bucket()])]) {
    const metrics = await run(data);
    assert.equal(metrics[0].noRecords, true);
    assert.equal(metrics[0].amount, '0');
    assert.equal(metrics[0].currency, 'USD');
  }
  for (const value of [0, -0, -1.5]) {
    const metrics = await run(page([bucket([result(value)])]));
    assert.equal(metrics[0].amount, value === 0 ? '0' : String(value));
    assert.equal(metrics[0].noRecords, undefined);
  }
});

test('decimal arithmetic handles exponents, cancellation, fractions, and large finite amounts', async () => {
  for (const [values, expected] of [
    [[1e-7, 2e-7], '0.0000003'], [[1e21, 1e21], '2000000000000000000000'],
    [[1, -1], '0'], [[0.000001, -0.0000001], '0.0000009'], [[100, 0.01], '100.01'],
  ]) assert.equal((await run(page([bucket(values.map(value => result(value)))])))[0].amount, expected);
});

test('group_by=api_key_id produces per-key breakdown; null key means organization-level', async () => {
  const calls = [];
  const metrics = await queryOpenAICosts({ ...base, groupByApiKey: true, fetcher: async (address, options) => {
    calls.push(new URL(address));
    return response(page([bucket([
      { ...result(3.5), api_key_id: 'key_AAA', project_id: 'proj_AAA' },
      { ...result(1.5), api_key_id: 'key_AAA', project_id: 'proj_AAA' },
      { ...result(0.75, 'eur'), api_key_id: 'key_BBB', project_id: 'proj_BBB' },
      result(2.0),
    ])]));
  } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].searchParams.getAll('group_by'), ['project_id', 'api_key_id']);
  const usd = metrics.find(metric => metric.currency === 'USD');
  assert.equal(usd.amount, '7');
  assert.deepEqual(usd.breakdown, [
    { apiKeyId: 'key_AAA', projectId: 'proj_AAA', currency: 'USD', amount: '5' },
    { apiKeyId: null, currency: 'USD', amount: '2' },
  ]);
  const eur = metrics.find(metric => metric.currency === 'EUR');
  assert.equal(eur.amount, '0.75');
  assert.deepEqual(eur.breakdown, [{ apiKeyId: 'key_BBB', projectId: 'proj_BBB', currency: 'EUR', amount: '0.75' }]);
  assert.equal(usd.ranges['30d'].amount, '7');
  assert.deepEqual(usd.ranges['30d'].breakdown, usd.breakdown);
  assert.equal(eur.ranges['30d'].amount, '0.75');
  assert.deepEqual(eur.ranges['30d'].breakdown, eur.breakdown);
  assert.ok(!JSON.stringify(metrics).includes(KEY));
});

test('each complete-day range aggregates only its dates and matching API-key groups', async () => {
  const bucketAt = (date, apiKeyId, projectId, value) => ({ object: 'bucket', start_time: date / 1000, end_time: date / 1000 + 86400, results: [
    { object: 'organization.costs.result', amount: { currency: 'usd', value }, api_key_id: apiKeyId, project_id: projectId },
  ] });
  const metrics = await queryOpenAICosts({ ...base, groupByApiKey: true, fetcher: async () => response(page([
    bucketAt(HISTORY_START, 'key_Old', 'proj_Old', 4),
    bucketAt(START - DAY_MS, 'key_Week', 'proj_Week', 2),
    bucketAt(TODAY - DAY_MS, 'key_Yesterday', 'proj_Yesterday', 0.1),
  ])) });
  const usd = metrics.find(metric => metric.currency === 'USD');
  assert.equal(usd.ranges['1d'].amount, '0.1');
  assert.deepEqual(usd.ranges['1d'].breakdown, [
    { apiKeyId: 'key_Yesterday', projectId: 'proj_Yesterday', currency: 'USD', amount: '0.1' },
  ]);
  assert.equal(usd.ranges['7d'].amount, '2.1');
  assert.deepEqual(usd.ranges['7d'].breakdown.map(entry => [entry.apiKeyId, entry.amount]), [['key_Week', '2'], ['key_Yesterday', '0.1']]);
  assert.equal(usd.ranges['30d'].amount, '6.1');
  assert.deepEqual(usd.ranges['30d'].breakdown.map(entry => [entry.apiKeyId, entry.amount]), [['key_Old', '4'], ['key_Week', '2'], ['key_Yesterday', '0.1']]);
  assert.equal(usd.breakdown.length, 1);
  assert.equal(usd.breakdown[0].apiKeyId, 'key_Yesterday');
});

test('0d range aggregates only today so far with matching API-key groups', async () => {
  const bucketAt = (date, results) => ({ object: 'bucket', start_time: date / 1000, end_time: date / 1000 + 86400, results });
  const entry = (value, api_key_id = null, project_id = null, currency = 'usd') => ({
    object: 'organization.costs.result', amount: { currency, value }, api_key_id, project_id,
  });
  const metrics = await queryOpenAICosts({ ...base, groupByApiKey: true, fetcher: async () => response(page([
    bucketAt(TODAY - DAY_MS, [entry(0.4, 'key_Yesterday', 'proj_Yesterday')]),
    bucketAt(TODAY, [
      entry(0.75, 'key_TodayA', 'proj_TodayA'),
      entry(0.5, 'key_TodayB', 'proj_TodayB'),
      entry(0.25),
      entry(1, 'key_EUR', 'proj_EUR', 'eur'),
    ]),
  ])) });
  const usd = metrics.find(metric => metric.currency === 'USD');
  assert.equal(usd.ranges['0d'].amount, '1.5');
  assert.deepEqual(usd.ranges['0d'].breakdown, [
    { apiKeyId: 'key_TodayA', projectId: 'proj_TodayA', currency: 'USD', amount: '0.75' },
    { apiKeyId: 'key_TodayB', projectId: 'proj_TodayB', currency: 'USD', amount: '0.5' },
    { apiKeyId: null, currency: 'USD', amount: '0.25' },
  ]);
  assert.equal(usd.ranges['1d'].amount, '0.4');
  assert.deepEqual(usd.ranges['1d'].breakdown, [
    { apiKeyId: 'key_Yesterday', projectId: 'proj_Yesterday', currency: 'USD', amount: '0.4' },
  ]);
  assert.equal(usd.ranges['7d'].amount, '0.4');
  assert.equal(usd.ranges['30d'].amount, '0.4');
  const eur = metrics.find(metric => metric.currency === 'EUR');
  assert.equal(eur.ranges['0d'].amount, '1');
  assert.deepEqual(eur.ranges['0d'].breakdown, [
    { apiKeyId: 'key_EUR', projectId: 'proj_EUR', currency: 'EUR', amount: '1' },
  ]);
  assert.equal(eur.ranges['1d'].amount, '0');
  assert.equal(eur.ranges['1d'].noRecords, true);
});

test('daily history covers 30 complete UTC days, excludes today from history, and keeps MTD separate', async () => {
  const bucketAt = (date, results) => ({ object: 'bucket', start_time: date / 1000, end_time: date / 1000 + 86400, results });
  let requestUrl;
  const metrics = await queryOpenAICosts({ ...base, fetcher: async address => {
    requestUrl = new URL(address);
    return response(page([
      bucketAt(START - DAY_MS, [result(7)]), // Oct 31, in the 7d window but before MTD.
      bucketAt(START, [result(1.25)]),
      bucketAt(START + 2 * DAY_MS, [result(2)]),
      bucketAt(START + 3 * DAY_MS, [result(0.5, 'eur')]), // Yesterday.
      bucketAt(TODAY, [result(99)]), // Today's partial bucket is selected separately as 0d.
    ]));
  } });
  assert.equal(requestUrl.searchParams.get('start_time'), String(HISTORY_START / 1000));
  const usd = metrics.find(metric => metric.currency === 'USD');
  assert.equal(usd.amount, '102.25');
  assert.equal(usd.daily.length, 30);
  assert.deepEqual(usd.daily[25], { date: START - DAY_MS, amount: '7', hasRecords: true });
  assert.deepEqual(usd.daily[26], { date: START, amount: '1.25', hasRecords: true });
  assert.equal(usd.daily.at(-1).date, TODAY - DAY_MS);
  assert.equal(usd.daily.at(-1).amount, '0');
  assert.equal(usd.ranges['0d'].amount, '99');
  assert.equal(usd.ranges['0d'].noRecords, undefined);
  assert.equal(usd.ranges['1d'].amount, '0');
  assert.equal(usd.ranges['1d'].noRecords, true);
  assert.equal(usd.ranges['7d'].amount, '10.25');
  assert.equal(usd.ranges['30d'].amount, '10.25');
  assert.equal(usd.ranges['30d'].amount.includes('99'), false);
  const eur = metrics.find(metric => metric.currency === 'EUR');
  assert.equal(eur.amount, '0.5');
  assert.equal(eur.daily.at(-1).amount, '0.5');
  assert.equal(eur.ranges['1d'].amount, '0.5');
});

test('range noRecords is tracked per currency independently of MTD', async () => {
  const bucketAt = (date, results) => ({ object: 'bucket', start_time: date / 1000, end_time: date / 1000 + 86400, results });
  const metrics = await queryOpenAICosts({ ...base, fetcher: async () => response(page([
    bucketAt(HISTORY_START, [result(3, 'eur')]), // 30d history only; no MTD record.
    bucketAt(START, [result(2, 'usd')]),
  ])) });
  const eur = metrics.find(metric => metric.currency === 'EUR');
  const usd = metrics.find(metric => metric.currency === 'USD');
  assert.equal(eur.amount, '0');
  assert.equal(eur.noRecords, true);
  assert.equal(eur.daily[0].amount, '3');
  assert.equal(eur.ranges['30d'].amount, '3');
  assert.equal(eur.ranges['30d'].noRecords, undefined);
  assert.equal(eur.ranges['0d'].amount, '0');
  assert.equal(eur.ranges['0d'].noRecords, true);
  assert.equal(usd.amount, '2');
  assert.equal(usd.noRecords, undefined);
  assert.equal(usd.ranges['0d'].amount, '0');
  assert.equal(usd.ranges['0d'].noRecords, true);
  assert.equal(usd.ranges['30d'].amount, '2');
});

test('without groupByApiKey no breakdown is emitted and no group parameter is sent', async () => {
  let url;
  const metrics = await queryOpenAICosts({ ...base, fetcher: async address => { url = new URL(address); return response(page([bucket([{ ...result(4), api_key_id: 'key_AAA' }])])); } });
  assert.equal(url.searchParams.get('group_by'), null);
  assert.equal(metrics[0].breakdown, undefined);
  assert.equal(metrics[0].amount, '4');
});

test('malformed api_key_id values and non-boolean groupByApiKey fail closed', async () => {
  for (const api_key_id of [123, '', 'bad\nkey', 'x'.repeat(257)]) await rejects(run(page([bucket([{ ...result(1), api_key_id }])])));
  let calls = 0;
  await rejects(queryOpenAICosts({ ...base, groupByApiKey: 'yes', fetcher: async () => { calls++; return response(page()); } }));
  assert.equal(calls, 0);
});

test('UTC month boundaries never depend on local timezone and end milliseconds are retained', async () => {
  for (const now of [Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1, 0, 0, 0, 999), Date.UTC(2026, 11, 31, 23, 59, 59, 999)]) {
    const expectedStart = new Date(now);
    expectedStart.setUTCDate(1);
    expectedStart.setUTCHours(0, 0, 0, 0);
    const metrics = await run(page(), { now });
    assert.equal(metrics[0].periodStart, expectedStart.getTime());
    assert.equal(metrics[0].periodEnd, Math.floor(now / 1000) * 1000);
    assert.equal(metrics[0].timezone, 'UTC');
  }
});

test('month-start MTD interval stays empty while the 30-day query remains nonzero-length', async () => {
  let calls = 0;
  const monthStart = Date.UTC(2026, 10, 1);
  const expectedHistoryStart = monthStart - 30 * DAY_MS;
  for (const now of [monthStart, monthStart + 1, monthStart + 999]) {
    const metrics = await queryOpenAICosts({ ...base, now, fetcher: async address => {
      calls++;
      const url = new URL(address);
      assert.equal(url.searchParams.get('start_time'), String(expectedHistoryStart / 1000));
      assert.equal(url.searchParams.get('end_time'), String(monthStart / 1000));
      assert.ok(Number(url.searchParams.get('end_time')) > Number(url.searchParams.get('start_time')));
      return response(page());
    } });
    assert.equal(metrics[0].amount, '0');
    assert.equal(metrics[0].periodStart, monthStart);
    assert.equal(metrics[0].periodEnd, monthStart);
    assert.equal(metrics[0].noRecords, true);
    assert.equal(metrics[0].daily.length, 30);
    assert.deepEqual(metrics[0].daily.map(point => point.amount), Array(30).fill('0'));
    assert.deepEqual(Object.keys(metrics[0].ranges), ['0d', '1d', '7d', '30d']);
    assert.ok(Object.values(metrics[0].ranges).every(range => range.noRecords === true));
  }
  assert.equal(calls, 3);
  const controller = new AbortController(); controller.abort();
  await rejects(queryOpenAICosts({ ...base, now: monthStart + 500, signal: controller.signal, fetcher: async () => { calls++; return response(page()); } }), 'timeout');
  assert.equal(calls, 3);
});

test('first second after month-start requests aligned MTD and weekly boundaries', async () => {
  const monthStart = Date.UTC(2026, 10, 1);
  let requestUrl;
  const metrics = await queryOpenAICosts({ ...base, now: monthStart + 1000, fetcher: async address => { requestUrl = new URL(address); return response(page()); } });
  assert.equal(requestUrl.searchParams.get('start_time'), String((monthStart - 30 * DAY_MS) / 1000));
  assert.equal(requestUrl.searchParams.get('end_time'), String(monthStart / 1000 + 1));
  assert.equal(metrics[0].periodEnd, monthStart + 1000);
});

test('stream read failures remain network errors while malformed JSON stays invalid-response', async () => {
  const broken = new ReadableStream({ start(controller) { controller.error(new Error(`private stream ${KEY}`)); } });
  await rejects(queryOpenAICosts({ ...base, fetcher: async () => new Response(broken) }), 'network');
  await rejects(queryOpenAICosts({ ...base, fetcher: async () => new Response('{broken-json') }), 'invalid-response');
});

test('later page failure rejects the entire operation, never a partial sum', async () => {
  let calls = 0;
  await rejects(queryOpenAICosts({ ...base, fetcher: async () => {
    if (calls++ === 0) return response(page([bucket([result(999)])], 'next'));
    throw new Error(`LEAK ${KEY}`);
  } }), 'network');
  assert.equal(calls, 2);
});

test('repeated cursor and missing cursor fail closed', async () => {
  let calls = 0;
  await rejects(queryOpenAICosts({ ...base, fetcher: async () => response(page([bucket([result(1)], ++calls)], 'same')) }));
  assert.equal(calls, 2);
  for (const next_page of [null, undefined, '', ' ', 123, 'a'.repeat(4097)]) {
    await rejects(run({ object: 'page', data: [], has_more: true, next_page }));
  }
});

test('eight page upper bound rejects truncation; exactly eight complete pages succeed', async () => {
  let calls = 0;
  await rejects(queryOpenAICosts({ ...base, fetcher: async () => {
    calls++;
    return response(page([bucket([result(1)], calls)], `cursor-${calls}`));
  } }));
  assert.equal(calls, 8);
  calls = 0;
  const metrics = await queryOpenAICosts({ ...base, fetcher: async () => {
    calls++;
    return response(page([bucket([result(1)], calls)], calls === 8 ? null : `cursor-${calls}`));
  } });
  assert.equal(calls, 8);
  assert.equal(metrics[0].amount, '8');
});

test('repeated buckets across pages are rejected rather than double-counted', async () => {
  let calls = 0;
  await rejects(queryOpenAICosts({ ...base, fetcher: async () => response(page([bucket([result(1)])], calls++ ? null : 'next')) }));
});

test('HTTP statuses and thrown errors expose only whitelisted code/message', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate-limited'], [500, 'upstream'], [302, 'upstream']]) {
    await rejects(queryOpenAICosts({ ...base, fetcher: async () => new Response(`raw body ${KEY}`, { status, headers: { Location: 'https://evil.example' } }) }), code);
  }
  await rejects(queryOpenAICosts({ ...base, fetcher: async () => { throw new Error(`failed URL with ${KEY}`); } }), 'network');
  await rejects(queryOpenAICosts({ ...base, fetcher: async () => null }));
});

test('aborted signal cancels fetch wait without exposing abort reason', async () => {
  const controller = new AbortController();
  const pending = queryOpenAICosts({ ...base, signal: controller.signal, fetcher: () => new Promise(() => {}) });
  controller.abort(new Error(`private ${KEY}`));
  await rejects(pending, 'timeout');
});

test('body read is also bounded by the same abort signal', async () => {
  const controller = new AbortController();
  const stream = new ReadableStream({ start() {} });
  const pending = queryOpenAICosts({ ...base, signal: controller.signal, fetcher: async () => {
    queueMicrotask(() => controller.abort());
    return new Response(stream);
  } });
  await rejects(pending, 'timeout');
});

test('response body greater than 1 MiB is rejected before JSON parsing', async () => {
  await rejects(queryOpenAICosts({ ...base, fetcher: async () => new Response(' '.repeat(1_048_577)) }));
  const tinyChunks = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(700_000));
    controller.enqueue(new Uint8Array(400_000));
    controller.close();
  } });
  await rejects(queryOpenAICosts({ ...base, fetcher: async () => new Response(tinyChunks) }));
});

test('malformed JSON, page/bucket/result/amount schemas cannot silently imply zero', async () => {
  for (const data of [null, [], {}, { ...page(), object: 'list' }, { ...page(), data: null },
    { ...page(), has_more: 'false' }, { object: 'page', data: [], has_more: false },
    { ...page(), next_page: 'unexpected' }, page([null]), page([{ ...bucket(), object: 'other' }]),
    page([{ ...bucket(), results: null }]), page([{ ...bucket(), start_time: '123' }]),
    page([{ ...bucket(), end_time: 0 }]), page([bucket([null])]),
    page([bucket([{ ...result(1), object: 'costs.result' }])]),
    page([bucket([{ object: 'organization.costs.result' }])]),
    page([bucket([{ ...result(1), amount: null }])]),
  ]) await rejects(run(data));
  await rejects(queryOpenAICosts({ ...base, fetcher: async () => new Response(`bad ${KEY}`) }));
});

test('non-numeric values and malformed currencies fail rather than coercing', async () => {
  for (const value of [null, '', '0', true, undefined]) await rejects(run(page([bucket([result(value)])])));
  // JSON encodes nonfinite numbers as null, which must also be rejected.
  for (const value of [NaN, Infinity, -Infinity]) await rejects(run(page([bucket([result(value)])])));
  for (const currency of ['', 'us', 'dollars', ' USD', null, 123]) await rejects(run(page([bucket([result(1, currency)])])));
});

test('invalid input fails before any network request and never includes credentials', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return response(page()); };
  for (const key of ['', undefined, 'bad\r\nkey', ' ', 'x'.repeat(8193)]) await rejects(queryOpenAICosts({ ...base, key, fetcher }), 'unauthorized');
  for (const now of [NaN, Infinity, -1, '123', 0.5, Number.MAX_SAFE_INTEGER]) await rejects(queryOpenAICosts({ ...base, now, fetcher }));
  for (const signal of [null, {}, 'abort']) await rejects(queryOpenAICosts({ ...base, signal, fetcher }));
  assert.equal(calls, 0);
});

// All values and requests above are synthetic; no real keys, environment files,
// provider traffic, or persistent profile state are involved.
