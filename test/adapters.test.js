import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProvider, parseDeepSeek, parseGlm } from '../adapters.js';

const quota = (limits, extra = {}) => ({ success: true, code: 200, data: { limits }, ...extra });
const credit = (extra = {}) => ({ type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 42, ...extra });
const fails = fn => assert.throws(fn, { message: 'invalid-response' });

test('only explicit known official routes are recognized without a URL', () => {
  for (const [provider, kind] of Object.entries({
    deepseek: 'deepseek', 'deepseek-official': 'deepseek', openai: 'openai',
    zai: 'glm-global', 'zai-coding-cn': 'glm-cn',
  })) {
    const result = classifyProvider({ provider });
    assert.equal(result.kind, kind);
    assert.ok(result.dashboardUrl.startsWith('https://'));
  }
  for (const provider of ['glm', 'zhipu', 'OpenAI', 'my-openai', 'deepseek-account', '__proto__', 'constructor', undefined]) {
    assert.deepEqual(classifyProvider({ provider }), { kind: 'unsupported', dashboardUrl: null });
  }
});

test('official HTTPS endpoint determines provider even for custom route names', () => {
  for (const [baseURL, kind] of [
    ['https://api.deepseek.com/v1', 'deepseek'],
    ['https://open.bigmodel.cn/api/coding/paas/v4', 'glm-cn'],
    ['https://api.z.ai/api/anthropic', 'glm-global'],
    ['https://api.openai.com:443/v1', 'openai'],
  ]) assert.equal(classifyProvider({ provider: 'custom', baseURL }).kind, kind);
  assert.equal(classifyProvider({ provider: 'openai', baseURL: 'https://api.z.ai/api/coding/paas/v4' }).kind, 'glm-global');
});

test('explicit unsafe or unknown URLs cannot fall back to an official route', () => {
  for (const baseURL of [
    '', 'not-a-url', 'http://api.openai.com/v1', 'https://api.openai.com:8443/v1',
    'https://user@api.openai.com/v1', 'https://user:pass@api.z.ai',
    'https://api.openai.com.attacker.example/v1', 'https://api.openai.com@attacker.example/v1',
    'https://attacker.example/api.openai.com', 'https://proxy.example/v1',
    'https://api.openai.com./v1', ' https://api.openai.com/v1', 42,
  ]) assert.equal(classifyProvider({ provider: 'openai', baseURL }).kind, 'unsupported', String(baseURL));
});

test('DeepSeek preserves precision, currencies, recharge, and granted balances', () => {
  assert.deepEqual(parseDeepSeek({ is_available: true, balance_infos: [
    { currency: 'CNY', total_balance: '126.800000000000000001', granted_balance: '6.80', topped_up_balance: '120.00' },
    { currency: 'USD', total_balance: '0.00' },
  ] }), [
    { type: 'balance', currency: 'CNY', amount: '126.800000000000000001', granted: '6.80', toppedUp: '120.00' },
    { type: 'balance', currency: 'USD', amount: '0.00' },
  ]);
});

test('negative available balance is real debt, not a parsing failure', () => {
  assert.deepEqual(parseDeepSeek({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '-0.012' }] }),
    [{ type: 'balance', currency: 'USD', amount: '-0.012' }]);
});

test('DeepSeek rejects missing, malformed, or silently coercible balances', () => {
  for (const value of [null, '', ' ', 'NaN', 'Infinity', '1e3', '1,000', 0, false]) {
    fails(() => parseDeepSeek({ balance_infos: [{ currency: 'CNY', total_balance: value }] }));
  }
  for (const response of [null, [], {}, { balance_infos: [] }, { balance_infos: [null] },
    { balance_infos: [{ currency: 'EUR', total_balance: '1' }] },
    { is_available: 'false', balance_infos: [{ currency: 'CNY', total_balance: '1' }] },
    { balance_infos: [{ currency: 'CNY', total_balance: '1', granted_balance: '-2' }] },
    { balance_infos: [{ currency: 'CNY', total_balance: '1', topped_up_balance: null }] },
  ]) fails(() => parseDeepSeek(response));
});

test('current credit shape has explicit rolling and weekly windows, regardless of order', () => {
  const reset = 1793856000000;
  const weekly = credit({ unit: 6, number: 1, percentage: 68, usage: 10000, currentValue: 6800, remaining: 3200 });
  const rolling = credit({ percentage: 42, usage: 2000, currentValue: 840, remaining: 1160, nextResetTime: reset });
  assert.deepEqual(parseGlm(quota([weekly, rolling])), [
    { type: 'quota-window', label: 'weekly', unit: 'credits', usedPercent: 68, used: 6800, total: 10000, remaining: 3200, durationSeconds: 604800 },
    { type: 'quota-window', label: 'rolling', unit: 'credits', usedPercent: 42, used: 840, total: 2000, remaining: 1160, durationSeconds: 18000, resetsAt: reset },
  ]);
});

test('legacy token and MCP shapes retain their semantics without assuming a calendar-month length', () => {
  assert.deepEqual(parseGlm(quota([
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 20 },
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 30, usage: 100, currentValue: 30 },
  ])), [
    { type: 'quota-window', label: 'rolling', unit: 'tokens', usedPercent: 20, durationSeconds: 18000 },
    { type: 'quota-window', label: 'mcp', unit: 'requests', usedPercent: 30, used: 30, total: 100, remaining: 70 },
  ]);
});

test('zero reported usage is preserved, never inferred from null or missing', () => {
  assert.equal(parseGlm(quota([credit({ percentage: 0 })]))[0].usedPercent, 0);
  assert.equal(parseGlm(quota([credit({ percentage: 0, currentValue: 0, usage: 2000 })]))[0].used, 0);
  for (const percentage of [undefined, null, '', '0', false, NaN, Infinity, 1.5]) {
    fails(() => parseGlm(quota([credit({ percentage })])));
  }
});

test('currentValue is USED, and counts override a stale reported percentage', () => {
  const metric = parseGlm(quota([credit({ percentage: 90, usage: 100, currentValue: 25 })]))[0];
  assert.equal(metric.usedPercent, 25);
  assert.equal(metric.used, 25);
  assert.equal(metric.remaining, 75);
});

test('remaining counts compute used; conflicting counts choose conservative used value', () => {
  assert.equal(parseGlm(quota([credit({ usage: 100, remaining: 75 })]))[0].usedPercent, 25);
  const metric = parseGlm(quota([credit({ usage: 100, remaining: 75, currentValue: 30 })]))[0];
  assert.equal(metric.usedPercent, 30);
  assert.equal(metric.used, 30);
  assert.equal(metric.remaining, 75); // Preserve explicitly returned count; do not rewrite upstream data.
});

test('overage is bounded for progress bars but its actual count is retained', () => {
  const metric = parseGlm(quota([credit({ usage: 100, currentValue: 120 })]))[0];
  assert.equal(metric.usedPercent, 100);
  assert.equal(metric.used, 120);
  assert.equal(metric.remaining, 0);
  assert.equal(parseGlm(quota([credit({ percentage: -5 })]))[0].usedPercent, 0);
  assert.equal(parseGlm(quota([credit({ percentage: 105 })]))[0].usedPercent, 100);
});

test('known duration units map explicitly; unknown durations never use reset ordering', () => {
  for (const [unit, number, durationSeconds, label] of [
    [5, 300, 18000, 'rolling'], [1, 7, 604800, 'weekly'], [3, 1, 3600, 'quota'],
  ]) {
    const result = parseGlm(quota([credit({ unit, number })]))[0];
    assert.equal(result.durationSeconds, durationSeconds);
    assert.equal(result.label, label);
  }
  const results = parseGlm(quota([
    credit({ unit: 99, number: 1, nextResetTime: 1793900000000 }),
    credit({ unit: undefined, number: undefined, nextResetTime: 1793800000000 }),
  ]));
  assert.deepEqual(results.map(row => row.label), ['quota', 'quota']);
  assert.ok(results.every(row => !('durationSeconds' in row)));
});

test('a recognized direct limits object is supported alongside API envelopes', () => {
  assert.equal(parseGlm({ limits: [credit()] })[0].usedPercent, 42);
  assert.equal(parseGlm({ code: 200, data: { limits: [credit()] } })[0].usedPercent, 42);
});

test('error envelopes, empty limits, and wholly unknown responses fail safely', () => {
  for (const response of [null, [], {}, { limits: [] }, { limits: null },
    quota([credit()], { success: false }), quota([credit()], { code: 500 }),
    { code: '200', data: { limits: [credit()] } },
    { limits: [{ type: 'FUTURE_LIMIT', mysteriousField: true }] },
    { limits: [null] }, { limits: [{}] }, { data: null, limits: [credit()] },
  ]) fails(() => parseGlm(response));
});

test('mixed responses preserve recognized quota, skipping unsupported types without inventing metrics', () => {
  const response = quota([{ type: 'FUTURE_LIMIT', percentage: null }, credit()]);
  assert.equal(parseGlm(response).length, 1);
});

test('malformed recognized counts, duration metadata, and timestamps are rejected', () => {
  for (const extra of [
    { usage: '100' }, { usage: -1 }, { remaining: Infinity }, { currentValue: false },
    { currentValue: Number.MAX_SAFE_INTEGER + 1 }, { usage: 100, remaining: 101 },
    { unit: '3' }, { number: -1 }, { number: 1.5 }, { number: Number.MAX_SAFE_INTEGER },
    { nextResetTime: '1793856000000' }, { nextResetTime: 0 }, { nextResetTime: Infinity },
  ]) fails(() => parseGlm(quota([credit(extra)])));
});

test('parsers do not mutate upstream objects or arrays', () => {
  const input = quota([credit({ usage: 100, remaining: 50 })]);
  const before = structuredClone(input);
  Object.freeze(input.data.limits[0]);
  Object.freeze(input.data.limits);
  Object.freeze(input.data);
  Object.freeze(input);
  parseGlm(input);
  assert.deepEqual(input, before);
});

test('optional null counts do not become zeros; total zero does not divide by zero', () => {
  const metric = parseGlm(quota([credit({ usage: null, currentValue: null, remaining: null })]))[0];
  assert.equal(metric.usedPercent, 42);
  assert.ok(!('used' in metric));
  assert.ok(!('remaining' in metric));
  assert.equal(parseGlm(quota([credit({ usage: 0, currentValue: 0, percentage: 0 })]))[0].usedPercent, 0);
});

// These fixtures are deliberately synthetic and contain no real credentials or account data.
// They exercise the legacy official script and the newer CREDIT_LIMIT shape described
// by CodexBar; successful tests are not a claim of live supplier API compatibility.
