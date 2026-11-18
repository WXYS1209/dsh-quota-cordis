import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { resolveNativeCodexCredential, parseCodexUsage, queryCodexUsage } from '../codex-usage.js';

const NOW = 1_794_288_000_000;
const credential = { access: 'MOCK_ACCESS_ACCOUNT_A', accountId: 'mock-account-a', expires: NOW + 600_000 };
const fixture = { rate_limit: {
  primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1_794_290_000 },
  secondary_window: { used_percent: 42.5, limit_window_seconds: 604800, reset_at: 1_794_800_000 },
}, account_id: 'PRIVATE_ID', plan_type: 'PRIVATE_PLAN', credits: { balance: 123 } };
const windows = metrics => metrics.filter(metric => metric.type === 'quota-window');
const creditMetric = credits => parseCodexUsage({ ...fixture, credits }).at(-1);
const isCode = expected => cause => cause instanceof Error && cause.code === expected && cause.message === expected && cause.cause === undefined;
const grant = payload => ({ kind: 'grant', payload: { type: 'oauth', ...credential, ...payload } });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function recordStore(record) {
  const calls = [];
  return { calls, service: new Proxy({}, { get(_target, method) {
    assert.equal(method, 'readRecord', 'only the native record read is permitted');
    return async key => { calls.push(key); assert.equal(key, 'llm-pi-ai/openai-codex'); return record; };
  } }) };
}
function response(json = fixture, { status = 200, redirected = false, text, chunks, declared, url } = {}) {
  let cancelled = 0, released = 0, reads = 0;
  const buffers = chunks ?? [new TextEncoder().encode(text ?? JSON.stringify(json))];
  return {
    status, ok: status >= 200 && status < 300, redirected, url,
    headers: { get(name) { assert.equal(name, 'content-length'); return declared ?? null; } },
    body: { cancel() { cancelled++; }, getReader() { return {
      read() { return Promise.resolve(reads < buffers.length ? { done: false, value: buffers[reads++] } : { done: true }); },
      cancel() { cancelled++; }, releaseLock() { released++; },
    }; } },
    stats() { return { cancelled, released, reads }; },
  };
}

test('native credential resolution uses exactly one fixed record; never reads refresh or copies payload', async () => {
  const payload = { type: 'oauth', ...credential };
  Object.defineProperty(payload, 'refresh', { enumerable: true, get() { throw new Error('REFRESH_MUST_NOT_BE_READ'); } });
  Object.freeze(payload);
  const record = Object.freeze({ kind: 'grant', payload });
  const store = recordStore(record);
  assert.deepEqual(await resolveNativeCodexCredential(store.service, { now: NOW }), credential);
  assert.deepEqual(store.calls, ['llm-pi-ai/openai-codex']);
});

test('missing native grant, unsupported shapes and unsafe header values fail closed', async () => {
  for (const value of [null, undefined]) {
    await assert.rejects(resolveNativeCodexCredential(recordStore(value).service, { now: NOW }), isCode('codex-auth-required'));
  }
  for (const value of [
    {}, [], { kind: 'apiKey', payload: credential }, { kind: 'grant', payload: null },
    grant({ type: 'apiKey' }), grant({ access: '' }), grant({ accountId: '' }),
    grant({ access: 'x\r\nInjected: yes' }), grant({ accountId: 'account\nInjected' }),
    grant({ accountId: ' account' }), grant({ expires: '1794288600000' }),
    grant({ expires: NaN }), grant({ expires: Infinity }), grant({ expires: 0 }), grant({ expires: 12.5 }),
    grant({ expires: 8_640_000_000_000_001 }),
  ]) await assert.rejects(resolveNativeCodexCredential(recordStore(value).service, { now: NOW }), isCode('unsupported-auth'));
  await assert.rejects(resolveNativeCodexCredential({ readRecord() { throw new Error('RAW_SECRET'); } }, { now: NOW }), isCode('unsupported-auth'));
});

test('expiry is Unix milliseconds with a strict thirty-second safety margin and no refresh', async () => {
  for (const expires of [NOW - 1, NOW, NOW + 29_999, NOW + 30_000]) {
    const store = recordStore(grant({ expires }));
    await assert.rejects(resolveNativeCodexCredential(store.service, { now: NOW }), isCode('codex-auth-expired'));
    assert.equal(store.calls.length, 1);
  }
  assert.equal((await resolveNativeCodexCredential(recordStore(grant({ expires: NOW + 30_001 })).service, { now: NOW })).expires, NOW + 30_001);
});

test('main windows preserve true zero, convert epoch seconds and omit private metadata', () => {
  const metrics = parseCodexUsage(fixture);
  assert.deepEqual(windows(metrics), [
    { type: 'quota-window', label: 'rolling', unit: 'percent', usedPercent: 0, durationSeconds: 18000, resetsAt: 1_794_290_000_000 },
    { type: 'quota-window', label: 'weekly', unit: 'percent', usedPercent: 42.5, durationSeconds: 604800, resetsAt: 1_794_800_000_000 },
  ]);
  assert.deepEqual(metrics.at(-1), { type: 'credits', unit: 'credits', state: 'unknown' });
  assert.equal(JSON.stringify(metrics).includes('PRIVATE'), false);
});

test('window semantics and sorting follow duration rather than primary/secondary position', () => {
  const swapped = { rate_limit: { primary_window: fixture.rate_limit.secondary_window, secondary_window: fixture.rate_limit.primary_window } };
  assert.deepEqual(parseCodexUsage(swapped), parseCodexUsage(fixture));
  assert.deepEqual(windows(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 2592000 } } })), [
    { type: 'quota-window', label: 'quota', unit: 'percent', usedPercent: 100, durationSeconds: 2592000 },
  ]);
  assert.deepEqual(windows(parseCodexUsage({ rate_limit: { secondary_window: { used_percent: 8 } } })), [
    { type: 'quota-window', label: 'quota', unit: 'percent', usedPercent: 8 },
  ]);
});

test('credits preserve signed decimal strings, explicit zero and precision without numeric coercion', () => {
  for (const balance of ['0', '-0', '0.0000', '-0.0000', '123.4500', '-42.0050', '000123.4500', '123456789012345678901234567890.12345678901234567890', '9'.repeat(128)]) {
    for (const has_credits of [true, false]) assert.deepEqual(creditMetric({ has_credits, unlimited: false, balance }), { type: 'credits', unit: 'credits', state: 'balance', amount: balance });
  }
});

test('unlimited credits take priority without reading a balance, but both flags must be actual booleans', () => {
  for (const has_credits of [true, false]) {
    const credits = { has_credits, unlimited: true };
    Object.defineProperty(credits, 'balance', { get() { throw Error('UNLIMITED_BALANCE_MUST_NOT_BE_READ'); } });
    assert.deepEqual(creditMetric(credits), { type: 'credits', unit: 'credits', state: 'unlimited' });
  }
  for (const credits of [{ has_credits: 'true', unlimited: true }, { has_credits: false, unlimited: 'true' }, { unlimited: true }]) {
    assert.deepEqual(creditMetric(credits), { type: 'credits', unit: 'credits', state: 'unknown' });
  }
});

test('availability flags with absent or null balances do not fabricate a zero credit amount', () => {
  for (const balance of [undefined, null]) for (const has_credits of [true, false]) {
    assert.deepEqual(creditMetric({ has_credits, unlimited: false, balance }), { type: 'credits', unit: 'credits', state: has_credits ? 'available' : 'unavailable' });
  }
  assert.deepEqual(creditMetric({ has_credits: true, unlimited: false }), { type: 'credits', unit: 'credits', state: 'available' });
  assert.deepEqual(creditMetric({ has_credits: false, unlimited: false }), { type: 'credits', unit: 'credits', state: 'unavailable' });
});

test('missing, null and malformed credit metadata stays independently unknown without failing valid quota windows', () => {
  const unknown = { type: 'credits', unit: 'credits', state: 'unknown' };
  for (const credits of [undefined, null, [], false, 0, 'PRIVATE_CREDITS', {}, { balance: '25' },
    { has_credits: true }, { has_credits: 'false', unlimited: false }, { has_credits: 1, unlimited: false },
    { has_credits: null, unlimited: false }, { has_credits: false, unlimited: 0 }]) {
    const metrics = parseCodexUsage({ ...fixture, credits });
    assert.equal(windows(metrics).length, 2);
    assert.deepEqual(metrics.at(-1), unknown);
  }
  for (const balance of [0, -1, 12.5, NaN, Infinity, false, [], {}, '', ' ', '\t', '+1', '1e3', '--1', '.5', '1.', '1.2.3', '1_000', '1,000', '12 credits', 'NaN', 'Infinity', ' 1', '1 ', '1\n', '9'.repeat(129)]) {
    assert.deepEqual(creditMetric({ has_credits: true, unlimited: false, balance }), unknown);
  }
  const throwingCredits = { ...fixture };
  Object.defineProperty(throwingCredits, 'credits', { get() { throw Error('PRIVATE_ERROR'); } });
  assert.deepEqual(parseCodexUsage(throwingCredits).at(-1), unknown);
  assert.deepEqual(parseCodexUsage({ rate_limit: fixture.rate_limit }).at(-1), unknown);
});

test('credit normalization only returns the allowlisted state and amount, never private or reset-credit fields', () => {
  const credits = Object.freeze({ has_credits: true, unlimited: false, balance: '-12.3400',
    approx_local_messages: ['PRIVATE_LOCAL'], approx_cloud_messages: ['PRIVATE_CLOUD'], account_id: 'PRIVATE_CREDIT_ACCOUNT', currency: 'USD', reset_at: 123 });
  const json = Object.freeze({ ...fixture, credits, email: 'PRIVATE_EMAIL', rate_limit_reset_credits: { available_count: 999, credits: ['PRIVATE_RESET'] } });
  const metrics = parseCodexUsage(json);
  assert.deepEqual(metrics.at(-1), { type: 'credits', unit: 'credits', state: 'balance', amount: '-12.3400' });
  assert.equal(JSON.stringify(metrics).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(metrics).includes('USD'), false);
  assert.equal(metrics.filter(metric => metric.type === 'credits').length, 1);
  const ignored = { has_credits: true, unlimited: false, balance: '5' };
  for (const field of ['approx_local_messages', 'approx_cloud_messages', 'account_id', 'currency']) Object.defineProperty(ignored, field, { get() { throw Error('MUST_NOT_READ'); } });
  assert.equal(creditMetric(ignored).amount, '5');
});

test('missing windows and additional model limits never fabricate a zero main quota', () => {
  for (const value of [undefined, null, [], {}, { rate_limit: null }, { rate_limit: {} }, { rate_limit: { primary_window: null } },
    { rate_limit: { unknown_window: { used_percent: 0 } } },
    { additional_rate_limits: [{ rate_limit: fixture.rate_limit }] },
    { credits: { has_credits: true, unlimited: false, balance: '100' } },
    { rate_limit: {}, credits: { has_credits: true, unlimited: true } },
  ]) assert.throws(() => parseCodexUsage(value), isCode('invalid-response'));
});

test('malformed percentages, durations and reset timestamps are rejected without coercion', () => {
  for (const used_percent of [undefined, null, '', '0', NaN, Infinity, -1, 101]) {
    assert.throws(() => parseCodexUsage({ rate_limit: { primary_window: { used_percent } } }), isCode('invalid-response'));
  }
  for (const limit_window_seconds of ['18000', 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds } } }), isCode('invalid-response'));
  }
  for (const reset_at of ['1794290000', 0, -1, 1.5, Infinity, 8_640_000_000_001]) {
    assert.throws(() => parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1, reset_at } } }), isCode('invalid-response'));
  }
});

test('query fixes endpoint, method and redirect policy; returns normalized metrics only', async () => {
  const result = response();
  const metrics = await queryCodexUsage({ credential, fetcher: async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Authorization: `Bearer ${credential.access}`, 'ChatGPT-Account-Id': credential.accountId, Accept: 'application/json' });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
    return result;
  } });
  assert.deepEqual(metrics, parseCodexUsage(fixture));
  assert.equal(result.stats().released, 1);
  assert.equal(JSON.stringify(metrics).includes(credential.access), false);
  assert.equal(JSON.stringify(metrics).includes(credential.accountId), false);
});

test('credits use the same single account-scoped GET and never initiate an extra balance request', async () => {
  let calls = 0;
  const metrics = await queryCodexUsage({ credential, fetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${credential.access}`);
    assert.equal(options.headers['ChatGPT-Account-Id'], credential.accountId);
    return response({ ...fixture, credits: { has_credits: true, unlimited: false, balance: '-1.2500' } });
  } });
  assert.equal(calls, 1);
  assert.equal(windows(metrics).length, 2);
  assert.deepEqual(metrics.at(-1), { type: 'credits', unit: 'credits', state: 'balance', amount: '-1.2500' });
});

test('simultaneous account queries keep access and account headers isolated', async () => {
  const requests = [];
  const other = { ...credential, access: 'MOCK_ACCESS_B', accountId: 'mock-account-b' };
  const fetcher = async (_url, options) => {
    requests.push(options.headers);
    await nextTurn();
    return response({ ...fixture, credits: { has_credits: true, unlimited: false, balance: options.headers['ChatGPT-Account-Id'] === credential.accountId ? '25.5000' : '93.0001' } });
  };
  const [first, second] = await Promise.all([queryCodexUsage({ credential, fetcher }), queryCodexUsage({ credential: other, fetcher })]);
  assert.equal(first.at(-1).amount, '25.5000');
  assert.equal(second.at(-1).amount, '93.0001');
  assert.deepEqual(requests.map(headers => [headers.Authorization, headers['ChatGPT-Account-Id']]), [
    [`Bearer ${credential.access}`, credential.accountId], [`Bearer ${other.access}`, other.accountId],
  ]);
  assert.notEqual(requests[0], requests[1]);
});

test('HTTP errors and redirects expose only fixed codes and do not consume error bodies', async () => {
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate-limited'], [500, 'upstream'], [302, 'upstream']]) {
    const result = response(null, { status, text: 'RAW_SECRET_ERROR' });
    await assert.rejects(queryCodexUsage({ credential, fetcher: async () => result }), isCode(expected));
    assert.equal(result.stats().reads, 0);
    assert.equal(result.stats().cancelled, 1);
  }
  for (const settings of [{ redirected: true }, { url: 'https://evil.invalid/usage' }]) {
    const result = response(fixture, settings);
    await assert.rejects(queryCodexUsage({ credential, fetcher: async () => result }), isCode('upstream'));
    assert.equal(result.stats().reads, 0);
  }
  await assert.rejects(queryCodexUsage({ credential, fetcher: async () => { throw new TypeError('redirect to SECRET'); } }), isCode('network'));
});

test('one MiB limit applies to declared length and actual streamed bytes; exact boundary works', async () => {
  const declared = response(fixture, { declared: '1048577' });
  await assert.rejects(queryCodexUsage({ credential, fetcher: async () => declared }), isCode('invalid-response'));
  assert.equal(declared.stats().reads, 0);
  const oversized = response(null, { chunks: [new Uint8Array(600_000), new Uint8Array(448_577)] });
  await assert.rejects(queryCodexUsage({ credential, fetcher: async () => oversized }), isCode('invalid-response'));
  assert.equal(oversized.stats().cancelled, 1);
  assert.equal(oversized.stats().released, 1);
  const encoded = JSON.stringify(fixture);
  const boundary = response(null, { text: encoded + ' '.repeat(1_048_576 - Buffer.byteLength(encoded)) });
  assert.deepEqual(await queryCodexUsage({ credential, fetcher: async () => boundary }), parseCodexUsage(fixture));
});

test('invalid JSON, UTF-8, body and chunk types fail without raw response leakage', async () => {
  for (const result of [response(null, { text: '<html>RAW_SECRET</html>' }), response(null, { chunks: [new Uint8Array([255])] }),
    response(null, { chunks: ['not-bytes'] }), { status: 200, ok: true, body: null },
  ]) await assert.rejects(queryCodexUsage({ credential, fetcher: async () => result }), isCode('invalid-response'));
});

test('external cancellation bounds a non-cooperative fetch and cleans its signal listener', async () => {
  const controller = new AbortController();
  let combined;
  const pending = queryCodexUsage({ credential, signal: controller.signal, fetcher: (_url, options) => {
    combined = options.signal;
    return new Promise(() => {});
  } });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await assert.rejects(pending, isCode('timeout'));
  assert.equal(combined.aborted, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(getEventListeners(combined, 'abort').length, 0);
});

test('total deadline is exactly twelve seconds even if fetch ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = queryCodexUsage({ credential, fetcher: () => new Promise(() => {}) });
    const rejected = assert.rejects(pending, isCode('timeout'));
    t.mock.timers.tick(12_000);
    await rejected;
  } finally { t.mock.timers.reset(); }
});

test('successful query clears its deadline timer and caller listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const controller = new AbortController();
    let combined;
    await queryCodexUsage({ credential, signal: controller.signal, fetcher: async (_url, options) => {
      combined = options.signal; return response();
    } });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    t.mock.timers.tick(12_001);
    assert.equal(combined.aborted, false);
    assert.equal(getEventListeners(combined, 'abort').length, 0);
  } finally { t.mock.timers.reset(); }
});

test('body reads share the deadline and reader cancellation/lock release run on abort', async () => {
  const controller = new AbortController();
  let cancelled = 0, released = 0;
  const result = { status: 200, ok: true, body: { getReader() { return {
    read() { controller.abort(); return new Promise(() => {}); }, cancel() { cancelled++; }, releaseLock() { released++; },
  }; } } };
  await assert.rejects(queryCodexUsage({ credential, signal: controller.signal, fetcher: async () => result }), isCode('timeout'));
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('already-aborted requests and invalid credential never invoke fetch', async () => {
  const controller = new AbortController(); controller.abort();
  const fetcher = () => assert.fail('must not request network');
  await assert.rejects(queryCodexUsage({ credential, signal: controller.signal, fetcher }), isCode('timeout'));
  for (const value of [undefined, {}, { ...credential, access: '\n' }, { ...credential, accountId: '\r' }]) {
    await assert.rejects(queryCodexUsage({ credential: value, fetcher }), isCode('unauthorized'));
  }
});
