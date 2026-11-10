import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaManager } from '../manager.js';
import { classifyProvider } from '../adapters.js';

function fixture() {
  const state = { now: Date.UTC(2026, 10, 10, 6), calls: 0, used: 40, http: 200, profile: {}, duringFetch: null };
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
      assert.equal(options.headers.Authorization, `Bearer ${state.record.payload.access}`);
      assert.equal(options.headers['ChatGPT-Account-Id'], state.record.payload.accountId);
      state.duringFetch?.();
      if (state.http !== 200) return Response.json({ error: 'private-response' }, { status: state.http });
      return Response.json({ rate_limit: { primary_window: { used_percent: state.used, limit_window_seconds: 18000, reset_at: Math.floor(state.now / 1000) + 1000 }, secondary_window: { used_percent: 90, limit_window_seconds: 604800 } } });
    },
  });
  return { manager, state, grant };
}
async function using(run) { const h = fixture(); try { await run(h); } finally { await h.manager.dispose(); } }

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
  assert.deepEqual(row.metrics.map(metric => [metric.label, metric.usedPercent]), [['rolling', 40], ['weekly', 90]]);
  const text = JSON.stringify(result);
  for (const privateValue of ['native-token-A', 'native-account-A', 'Authorization', 'ChatGPT-Account-Id', 'refresh_token']) assert.equal(text.includes(privateValue), false);
}));

test('grant rotation bypasses old cache and removed grants never show old quota', async () => using(async h => {
  await h.manager.snapshot();
  await h.manager.snapshot();
  assert.equal(h.state.calls, 1);
  h.state.record = h.grant('native-token-B', 'native-account-B');
  h.state.used = 60;
  const rotated = await h.manager.snapshot();
  assert.equal(h.state.calls, 2);
  assert.equal(rotated.rows[0].metrics[0].usedPercent, 60);
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
  const result = await h.manager.snapshot();
  assert.equal(result.rows[0].status, 'upstream');
  assert.equal(result.rows[0].stale, true);
  assert.equal(result.rows[0].metrics[0].usedPercent, 40);
}));
