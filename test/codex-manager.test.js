import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaManager } from '../manager.js';
import { classifyProvider } from '../adapters.js';

function fixture() {
  const state = { now: Date.UTC(2026, 10, 10, 6), calls: 0, used: 40, http: 200, profile: {}, duringFetch: null,
    credits: { has_credits: true, unlimited: false, balance: '123.4500', account_id: 'PRIVATE_CREDIT_ACCOUNT', approx_local_messages: ['PRIVATE_APPROX'] } };
  const grant = (access, accountId) => ({ kind: 'grant', payload: { type: 'oauth', access, accountId, expires: state.now + 3600000 } });
  state.record = grant('native-token-A', 'native-account-A');
  const services = {
    llm: {
      listProviders: () => [{ id: 'openai-codex', name: 'Codex' }],
      listConfigurableProviders: () => [{ provider: 'openai-codex', displayName: 'Codex', settingsNs: 'pi', settingsPath: ['providers', 'openai-codex'], defaultBaseURL: 'https://chatgpt.com/backend-api', nativeAuth: { env: [], oauth: true } }],
    },
    settings: { describe: () => [{ ns: 'pi', value: { providers: { 'openai-codex': state.profile } } }] },
    credentials: { readRecord: async key => { assert.equal(key, 'llm-pi-ai/openai-codex'); return state.record; } },
  };
  const manager = new QuotaManager(services, {
    now: () => state.now,
    fetcher: async (url, options) => {
      state.calls++;
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, undefined);
      assert.equal(options.headers.Authorization, `Bearer ${state.record.payload.access}`);
      assert.equal(options.headers['ChatGPT-Account-Id'], state.record.payload.accountId);
      state.duringFetch?.();
      if (state.http !== 200) return Response.json({ error: 'private-response' }, { status: state.http });
      return Response.json({ rate_limit: { primary_window: { used_percent: state.used, limit_window_seconds: 18000, reset_at: Math.floor(state.now / 1000) + 1000 }, secondary_window: { used_percent: 90, limit_window_seconds: 604800 } }, credits: state.credits, rate_limit_reset_credits: { available_count: 999, credits: ['PRIVATE_RESET'] } });
    },
  });
  return { manager, state, grant };
}
async function using(run) { const h = fixture(); try { await run(h); } finally { await h.manager.dispose(); } }
const creditMetric = row => row.metrics.find(metric => metric.type === 'credits');

test('only exact native Codex route and official API root are subscription candidates', () => {
  assert.equal(classifyProvider({ provider: 'openai-codex' }).kind, 'codex');
  assert.equal(classifyProvider({ provider: 'openai-codex', baseURL: 'https://chatgpt.com/backend-api' }).kind, 'codex');
  for (const baseURL of ['https://proxy.example/backend-api', 'https://api.openai.com/v1', 'http://chatgpt.com/backend-api', 'https://user@chatgpt.com/backend-api', 'https://chatgpt.com/backend-api?x=1', 'https://chatgpt.com/backend-api/codex']) assert.equal(classifyProvider({ provider: 'openai-codex', baseURL }).kind, 'unsupported');
  assert.equal(classifyProvider({ provider: 'custom', baseURL: 'https://chatgpt.com/backend-api' }).kind, 'unsupported');
});

test('native subscription windows are normalized without returning identity or access material', async () => using(async h => {
  const result = await h.manager.snapshot();
  const row = result.rows[0];
  assert.equal(row.kind, 'codex');
  assert.equal(row.source, 'codex-usage');
  assert.equal(row.status, 'ok');
  assert.deepEqual(row.metrics.filter(metric => metric.type === 'quota-window').map(metric => [metric.label, metric.usedPercent]), [['rolling', 40], ['weekly', 90]]);
  assert.deepEqual(creditMetric(row), { type: 'credits', unit: 'credits', state: 'balance', amount: '123.4500' });
  assert.equal(h.state.calls, 1);
  const text = JSON.stringify(result);
  for (const privateValue of ['native-token-A', 'native-account-A', 'Authorization', 'ChatGPT-Account-Id', 'refresh_token', 'PRIVATE_CREDIT_ACCOUNT', 'PRIVATE_APPROX', 'PRIVATE_RESET']) assert.equal(text.includes(privateValue), false);
}));

test('grant rotation bypasses old cache and removed grants never show old quota', async () => using(async h => {
  const first = await h.manager.snapshot();
  assert.equal(creditMetric(first.rows[0]).amount, '123.4500');
  h.state.credits.balance = '999.9999';
  const cached = await h.manager.snapshot();
  assert.equal(creditMetric(cached.rows[0]).amount, '123.4500', 'cached credit amount cannot mutate when the next upstream fixture changes');
  assert.equal(h.state.calls, 1);
  h.state.record = h.grant('native-token-B', 'native-account-B');
  h.state.used = 60;
  h.state.credits.balance = '7.0001';
  const rotated = await h.manager.snapshot();
  assert.equal(h.state.calls, 2);
  assert.equal(rotated.rows[0].metrics[0].usedPercent, 60);
  assert.equal(creditMetric(rotated.rows[0]).amount, '7.0001');
  assert.equal(JSON.stringify(rotated).includes('123.4500'), false);
  h.state.record = undefined;
  const removed = await h.manager.snapshot();
  assert.equal(removed.rows[0].status, 'codex-auth-required');
  assert.deepEqual(removed.rows[0].metrics, []);
}));

test('expired native grant reports renewal instead of reading refresh or making inference', async () => using(async h => {
  h.state.record.payload.expires = h.state.now + 1000;
  Object.defineProperty(h.state.record.payload, 'refresh', { get() { throw Error('must not read refresh'); } });
  const result = await h.manager.snapshot();
  assert.equal(result.rows[0].status, 'codex-auth-expired');
  assert.deepEqual(result.rows[0].metrics, []);
  assert.equal(h.state.calls, 0);
}));

test('native route with explicit API-key override cannot borrow the stored OAuth grant', async () => using(async h => {
  h.state.profile = { apiKeyEnv: 'OTHER_AUTH' };
  h.manager.services.credentials.readRecord = () => { throw Error('must not read grant under override'); };
  const result = await h.manager.snapshot();
  assert.equal(result.rows[0].status, 'unsupported-auth');
  assert.equal(h.state.calls, 0);
}));

test('grant changes during a successful query discard results and previous same-row cache', async () => using(async h => {
  await h.manager.snapshot();
  h.state.now += 120001;
  h.state.duringFetch = () => { h.state.record = h.grant('native-token-B', 'native-account-B'); };
  const result = await h.manager.snapshot();
  assert.equal(result.rows[0].status, 'account-changed');
  assert.deepEqual(result.rows[0].metrics, []);
  assert.equal(result.rows[0].stale, false);
}));

test('grant changes during an HTTP failure cannot expose another account stale quota', async () => using(async h => {
  await h.manager.snapshot();
  h.state.now += 120001;
  h.state.http = 503;
  h.state.duringFetch = () => { h.state.record = h.grant('native-token-B', 'native-account-B'); };
  const result = await h.manager.snapshot();
  assert.equal(result.rows[0].status, 'account-changed');
  assert.deepEqual(result.rows[0].metrics, []);
}));

test('transient failure retains only the same still-valid grant quota and marks it stale', async () => using(async h => {
  await h.manager.snapshot();
  h.state.now += 120001;
  h.state.http = 503;
  h.state.credits.balance = '999.0000';
  const result = await h.manager.snapshot();
  assert.equal(result.rows[0].status, 'upstream');
  assert.equal(result.rows[0].stale, true);
  assert.equal(result.rows[0].metrics[0].usedPercent, 40);
  assert.equal(creditMetric(result.rows[0]).amount, '123.4500');
  assert.equal(JSON.stringify(result).includes('999.0000'), false);
}));

test('missing and malformed credits remain independent of healthy Codex subscription windows', async () => using(async h => {
  for (const credits of [undefined, null, { has_credits: true, unlimited: false, balance: 123 }, { has_credits: 'false', unlimited: false, balance: '10' }]) {
    h.state.credits = credits;
    const result = await h.manager.snapshot();
    assert.equal(result.rows[0].status, 'ok');
    assert.equal(result.rows[0].metrics[0].usedPercent, 40);
    assert.deepEqual(creditMetric(result.rows[0]), { type: 'credits', unit: 'credits', state: 'unknown' });
    h.state.now += 120001;
  }
  assert.equal(h.state.calls, 4, 'one existing usage GET per refresh, never an extra credit probe');
}));

test('Codex credit states share the existing usage refresh and preserve signed balances in account snapshots', async () => using(async h => {
  const cases = [
    [{ has_credits: false, unlimited: false, balance: '0' }, { type: 'credits', unit: 'credits', state: 'balance', amount: '0' }],
    [{ has_credits: false, unlimited: false, balance: '-12.345600' }, { type: 'credits', unit: 'credits', state: 'balance', amount: '-12.345600' }],
    [{ has_credits: false, unlimited: true, balance: null }, { type: 'credits', unit: 'credits', state: 'unlimited' }],
    [{ has_credits: true, unlimited: false, balance: null }, { type: 'credits', unit: 'credits', state: 'available' }],
    [{ has_credits: false, unlimited: false, balance: null }, { type: 'credits', unit: 'credits', state: 'unavailable' }],
  ];
  for (const [credits, expected] of cases) {
    h.state.credits = credits;
    const result = await h.manager.snapshot();
    assert.equal(result.rows[0].status, 'ok');
    assert.deepEqual(creditMetric(result.rows[0]), expected);
    h.state.now += 120001;
  }
  assert.equal(h.state.calls, cases.length);
}));

test('401 never fabricates new credits or exposes another grant cached amount', async () => using(async h => {
  h.state.http = 401;
  const initiallyDenied = await h.manager.snapshot();
  assert.equal(initiallyDenied.rows[0].status, 'unauthorized');
  assert.deepEqual(initiallyDenied.rows[0].metrics, []);
  assert.equal(initiallyDenied.rows[0].stale, false);
  h.state.now += 120001;
  h.state.http = 200;
  const authorized = await h.manager.snapshot();
  assert.equal(creditMetric(authorized.rows[0]).amount, '123.4500');
  h.state.now += 120001;
  h.state.http = 401;
  h.state.credits.balance = '999.0000';
  const sameGrantDenied = await h.manager.snapshot();
  assert.equal(sameGrantDenied.rows[0].status, 'unauthorized');
  assert.equal(sameGrantDenied.rows[0].stale, true);
  assert.equal(creditMetric(sameGrantDenied.rows[0]).amount, '123.4500', 'existing same-grant stale policy remains explicit');
  assert.equal(JSON.stringify(sameGrantDenied).includes('999.0000'), false);
  h.state.record = h.grant('native-token-B', 'native-account-B');
  const otherGrantDenied = await h.manager.snapshot();
  assert.equal(otherGrantDenied.rows[0].status, 'unauthorized');
  assert.deepEqual(otherGrantDenied.rows[0].metrics, []);
  assert.equal(otherGrantDenied.rows[0].stale, false);
  assert.equal(h.state.calls, 4);
  assert.equal(JSON.stringify(otherGrantDenied).includes('123.4500'), false);
}));

test('same-account bearer rotation cannot reuse credit cache from an older grant', async () => using(async h => {
  await h.manager.snapshot();
  h.state.record = h.grant('native-token-rotated', 'native-account-A');
  h.state.http = 401;
  const result = await h.manager.snapshot();
  assert.equal(result.rows[0].status, 'unauthorized');
  assert.deepEqual(result.rows[0].metrics, []);
  assert.equal(result.rows[0].stale, false);
  assert.equal(h.state.calls, 2);
}));
