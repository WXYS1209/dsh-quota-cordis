import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaManager, readJson } from '../manager.js';
import { apply, inject } from '../index.js';

const balance = amount => ({ balance_infos: [{ currency: 'CNY', total_balance: amount, granted_balance: '0.00', topped_up_balance: amount }] });
function fixture({ providers = { deepseek: { apiKeyEnv: 'CUSTOM_KEY' } }, keys = { CUSTOM_KEY: 'secret-fixture-A' }, records = {}, whole = false } = {}) {
  let now = 1000000;
  const state = { providers, keys, records, requests: [], response: balance('20.00'), code: 200 };
  const services = {
    llm: {
      listProviders: () => Object.keys(state.providers).map(id => ({ id, name: id })),
      listConfigurableProviders: () => [
        ...Object.keys(state.providers).map(provider => ({ provider, displayName: provider, settingsNs: 'pi', settingsPath: ['providers', provider], defaultBaseURL: provider === 'deepseek' ? 'https://api.deepseek.com' : provider === 'minimax-cn' ? 'https://api.minimaxi.com/anthropic' : undefined, nativeAuth: { env: ['NATIVE_KEY'] } })),
        { provider: 'dormant', displayName: 'Dormant', settingsNs: 'pi', settingsPath: ['providers', 'dormant'] },
        ...(whole ? [{ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'official', settingsPath: [] }] : []),
      ],
    },
    settings: { describe: ({ redactSecrets }) => { assert.equal(redactSecrets, true); return [{ ns: 'pi', value: { providers: state.providers } }, ...(whole ? [{ ns: 'official', value: { apiKeyEnv: 'ABSENT_KEY' } }] : [])]; } },
    credentials: {
      resolve: ref => state.keys[ref] ? { value: state.keys[ref] } : undefined,
      describe: ref => ({ configured: Boolean(state.keys[ref]) }),
      describeRecord: key => ({ configured: Boolean(state.records[key]), kind: state.records[key]?.kind }),
      readRecord: key => state.records[key],
    },
    agentDefaultModel: { currentSelection: () => ({ provider: Object.keys(state.providers)[0], model: 'test' }) },
  };
  const fetcher = async (url, options) => {
    state.requests.push({ url, options });
    return Response.json(state.response, { status: state.code });
  };
  const manager = new QuotaManager(services, { fetcher, now: () => now, adminKeyResolver: async () => undefined });
  return { state, services, manager, advance: milliseconds => { now += milliseconds; } };
}

test('discovers saved app routes, not dormant catalog entries or missing pristine built-ins', async () => {
  const f = fixture({ whole: true });
  try {
    const result = await f.manager.snapshot();
    assert.deepEqual(result.rows.map(row => row.id), ['deepseek']);
    assert.equal(result.defaultProvider, 'deepseek');
    assert.equal(result.rows[0].status, 'ok');
  } finally { await f.manager.dispose(); }
});

test('resolves the custom configured ref; neither credentials nor internal URLs appear in normalized output', async () => {
  const f = fixture();
  try {
    const result = await f.manager.snapshot();
    assert.equal(f.state.requests[0].options.headers.Authorization, 'Bearer secret-fixture-A');
    const serialized = JSON.stringify(result);
    for (const secret of ['secret-fixture-A', 'CUSTOM_KEY', 'Authorization', '/user/balance', 'nativeRecord']) assert.equal(serialized.includes(secret), false);
    assert.equal(result.rows[0].metrics[0].amount, '20.00');
  } finally { await f.manager.dispose(); }
});

test('success TTL, manual cooldown and credential rotation keep snapshots isolated', async () => {
  const f = fixture();
  try {
    await f.manager.snapshot();
    await f.manager.snapshot({ refresh: true });
    assert.equal(f.state.requests.length, 1);
    f.advance(10001);
    await f.manager.snapshot({ refresh: true });
    assert.equal(f.state.requests.length, 2);
    f.state.keys.CUSTOM_KEY = 'secret-fixture-B';
    f.state.response = balance('30.00');
    const result = await f.manager.snapshot();
    assert.equal(f.state.requests.length, 3);
    assert.equal(result.rows[0].metrics[0].amount, '30.00');
    delete f.state.keys.CUSTOM_KEY;
    const missing = await f.manager.snapshot();
    assert.equal(missing.rows[0].status, 'missing-credential');
    assert.deepEqual(missing.rows[0].metrics, []);
  } finally { await f.manager.dispose(); }
});

test('failure retains only same-credential success, marks stale and respects backoff', async () => {
  const f = fixture();
  try {
    await f.manager.snapshot();
    f.advance(120001);
    f.state.code = 401;
    f.state.response = { error: 'secret-upstream-message' };
    const failed = await f.manager.snapshot();
    assert.equal(failed.rows[0].status, 'unauthorized');
    assert.equal(failed.rows[0].stale, true);
    assert.equal(failed.rows[0].metrics[0].amount, '20.00');
    await f.manager.snapshot({ refresh: true });
    assert.equal(f.state.requests.length, 2);
    assert.equal(JSON.stringify(failed).includes('secret-upstream-message'), false);
    f.state.keys.CUSTOM_KEY = 'rotated-key';
    const rotated = await f.manager.snapshot();
    assert.deepEqual(rotated.rows[0].metrics, []);
    assert.equal(rotated.rows[0].stale, false);
  } finally { await f.manager.dispose(); }
});

test('general OpenCode Zen never sends its key to the Go-only usage endpoint', async () => {
  const f = fixture({ providers: { opencode: { apiKeyEnv: 'CUSTOM_KEY' } } });
  try {
    const result = await f.manager.snapshot();
    assert.equal(result.rows[0].id, 'opencode');
    assert.equal(result.rows[0].status, 'opencode-go-only');
    assert.equal(result.rows[0].dashboardUrl, 'https://opencode.ai/console');
    assert.equal(f.state.requests.length, 0);
  } finally { await f.manager.dispose(); }
});

test('OpenCode Go uses its official read-only usage endpoint and maps percent windows', async () => {
  const f = fixture({ providers: { 'opencode-go': { apiKeyEnv: 'CUSTOM_KEY' } } });
  f.state.response = { usage: { rolling: { percent: 11, resetsAt: '2026-12-17T17:10:09.580Z' }, weekly: { percent: 4 }, monthly: { percent: 2 } } };
  try {
    const result = await f.manager.snapshot();
    assert.equal(result.rows[0].kind, 'opencode-go');
    assert.equal(result.rows[0].source, 'opencode-usage');
    assert.equal(result.rows[0].metrics[0].usedPercent, 11);
    assert.equal(f.state.requests.length, 1);
    assert.equal(f.state.requests[0].url, 'https://opencode.ai/zen/go/v1/usage');
    assert.equal(f.state.requests[0].options.headers.Authorization, 'Bearer secret-fixture-A');
  } finally { await f.manager.dispose(); }
});

test('MiniMax CN queries only the official remains endpoint with Bearer auth and maps M Plan windows', async () => {
  const f = fixture({ providers: { 'minimax-cn': { apiKeyEnv: 'CUSTOM_KEY' } } });
  f.state.response = {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [{
      model_name: 'general', start_time: 1781834400000, end_time: 1781852400000,
      current_interval_remaining_percent: 68, weekly_start_time: 1781452800000,
      weekly_end_time: 1782057600000, current_weekly_remaining_percent: 41,
    }],
  };
  try {
    const result = await f.manager.snapshot();
    assert.equal(result.rows[0].kind, 'minimax-cn');
    assert.equal(result.rows[0].source, 'minimax-plan');
    assert.deepEqual(result.rows[0].metrics.map(({ label, usedPercent }) => ({ label, usedPercent })), [
      { label: 'rolling', usedPercent: 32 }, { label: 'weekly', usedPercent: 59 },
    ]);
    assert.equal(f.state.requests.length, 1);
    assert.equal(f.state.requests[0].url, 'https://www.minimax.cn/v1/token_plan/remains');
    assert.equal(f.state.requests[0].options.headers.Authorization, 'Bearer secret-fixture-A');
    assert.equal(JSON.stringify(result).includes('secret-fixture-A'), false);
  } finally { await f.manager.dispose(); }
});

test('registered-only MiniMax CN route is classified, but never queried without credential metadata', async () => {
  const f = fixture({ providers: { 'minimax-cn': {} } });
  f.services.llm.listConfigurableProviders = () => [];
  try {
    const result = await f.manager.snapshot();
    assert.equal(result.rows[0].kind, 'minimax-cn');
    assert.equal(result.rows[0].status, 'missing-credential');
    assert.equal(f.state.requests.length, 0);
  } finally { await f.manager.dispose(); }
});

test('MiniMax HTTP-200 error envelope is not treated as an empty successful quota', async () => {
  const f = fixture({ providers: { 'minimax-cn': { apiKeyEnv: 'CUSTOM_KEY' } } });
  f.state.response = { base_resp: { status_code: 1004, status_msg: 'secret upstream error' }, model_remains: [] };
  try {
    const result = await f.manager.snapshot();
    assert.equal(result.rows[0].status, 'upstream');
    assert.deepEqual(result.rows[0].metrics, []);
    assert.equal(JSON.stringify(result).includes('secret upstream error'), false);
  } finally { await f.manager.dispose(); }
});

test('MiniMax CN route never sends its key to an explicit custom relay', async () => {
  const f = fixture({ providers: { 'minimax-cn': { baseURL: 'https://relay.example/v1', apiKeyEnv: 'CUSTOM_KEY' } } });
  try {
    const result = await f.manager.snapshot();
    assert.equal(result.rows[0].kind, 'unsupported');
    assert.equal(result.rows[0].status, 'unsupported');
    assert.equal(f.state.requests.length, 0);
  } finally { await f.manager.dispose(); }
});

test('unknown relay, OpenAI and custom authentication do not send any network request', async () => {
  const f = fixture({ providers: {
    relay: { baseURL: 'https://relay.example/v1', apiKeyEnv: 'CUSTOM_KEY' },
    openai: { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'CUSTOM_KEY' },
    deepseek: { apiKeyEnv: 'CUSTOM_KEY', headers: { 'x-api-key': '[redacted]' } },
  } });
  try {
    const result = await f.manager.snapshot();
    assert.deepEqual(result.rows.map(row => row.status), ['unsupported', 'admin-key-required', 'unsupported-auth']);
    assert.equal(f.state.requests.length, 0);
  } finally { await f.manager.dispose(); }
});

test('explicit missing key does not silently fall back to native environment', async () => {
  const f = fixture({ keys: { NATIVE_KEY: 'wrong-fallback' } });
  try {
    const result = await f.manager.snapshot();
    assert.equal(result.rows[0].status, 'missing-credential');
    assert.equal(f.state.requests.length, 0);
  } finally { await f.manager.dispose(); }
});

test('native API-key record is supported while OAuth grants are never read', async () => {
  const f = fixture({ providers: { deepseek: {} }, records: { 'llm-pi-ai/deepseek': { kind: 'api-key', key: 'stored-record-key' } } });
  try {
    const good = await f.manager.snapshot();
    assert.equal(good.rows[0].status, 'ok');
    assert.equal(f.state.requests[0].options.headers.Authorization, 'Bearer stored-record-key');
    f.state.records['llm-pi-ai/deepseek'] = { kind: 'grant', payload: 'must-not-read' };
    f.services.credentials.readRecord = () => { throw Error('grant was read'); };
    const unsupported = await f.manager.snapshot();
    assert.equal(unsupported.rows[0].status, 'unsupported-auth');
    assert.equal(f.state.requests.length, 1);
  } finally { await f.manager.dispose(); }
});

test('native Base URL overrides cannot accidentally send a relay key to official endpoints', async () => {
  const f = fixture({ keys: { CUSTOM_KEY: 'relay-key', CUSTOM_BASE_URL: 'https://relay.example/v1' } });
  const old = f.services.llm.listConfigurableProviders;
  f.services.llm.listConfigurableProviders = () => old().map(row => ({ ...row, baseURLEnv: ['CUSTOM_BASE_URL'] }));
  try {
    const result = await f.manager.snapshot();
    assert.equal(result.rows[0].status, 'unsupported');
    assert.equal(f.state.requests.length, 0);
  } finally { await f.manager.dispose(); }
});

test('GLM domestic and global keys stay on their own fixed hosts with official-plugin auth', async () => {
  const f = fixture({ providers: {
    'zai-coding-cn': { baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'CN_KEY' },
    zai: { baseURL: 'https://api.z.ai/api/coding/paas/v4', apiKeyEnv: 'GLOBAL_KEY' },
  }, keys: { CN_KEY: 'cn-secret', GLOBAL_KEY: 'global-secret' } });
  f.state.response = { code: 200, data: { limits: [{ type: 'CREDIT_LIMIT', percentage: 40, usage: 2000, currentValue: 800, unit: 3, number: 5 }] } };
  try {
    const result = await f.manager.snapshot();
    assert.equal(result.rows[0].metrics[0].usedPercent, 40);
    const requests = new Map(f.state.requests.map(request => [new URL(request.url).hostname, request.options.headers.Authorization]));
    assert.equal(requests.get('open.bigmodel.cn'), 'cn-secret');
    assert.equal(requests.get('api.z.ai'), 'global-secret');
  } finally { await f.manager.dispose(); }
});

test('simultaneous consumers share a single in-flight account query', async () => {
  const f = fixture();
  let release;
  f.manager.fetcher = async (...args) => {
    f.state.requests.push(args);
    await new Promise(resolve => { release = resolve; });
    return Response.json(balance('5.00'));
  };
  try {
    const one = f.manager.snapshot();
    const two = f.manager.snapshot();
    // Yield event-loop work, without sleeping or creating timers.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.requests.length, 1);
    release();
    assert.deepEqual((await one).rows, (await two).rows);
  } finally { await f.manager.dispose(); }
});

test('account wallets remain separate, and account queries never cache across calls', async () => {
  const f = fixture({ providers: {} });
  let identity = 'account-one', calls = 0;
  f.services.llm.listConfigurableProviders = () => [{ provider: 'deepseek-account', displayName: 'Account', settingsNs: 'account', settingsPath: [] }];
  f.services.settings.describe = () => [{ ns: 'account', value: {} }];
  f.services.deepseekAccount = {
    getState: () => ({ status: 'credential-stored' }),
    getDeviceIdentity: () => ({ userId: identity }),
    getBalance: () => { calls++; return { status: 'ready', value: [{ currency: 'CNY', balance: '10.00' }], bonusWallets: [{ currency: 'CNY', balance: '2.00' }] }; },
  };
  try {
    const result = await f.manager.snapshot();
    assert.deepEqual(result.rows[0].metrics.map(metric => metric.wallet), ['recharge', 'bonus']);
    await f.manager.snapshot();
    assert.equal(calls, 2);
    assert.equal(f.manager.cache.size, 0);
    identity = 'account-two';
    await f.manager.snapshot();
    assert.equal(calls, 3);
    f.services.deepseekAccount.getState = () => ({ status: 'signed-out' });
    assert.deepEqual((await f.manager.snapshot()).rows, []);
  } finally { await f.manager.dispose(); }
});

test('network helper rejects arbitrary destinations and redirects without disclosing errors', async () => {
  let calls = 0;
  await assert.rejects(readJson('https://evil.example', 'secret', { fetcher: () => { calls++; } }), /unsupported/);
  assert.equal(calls, 0);
  await assert.rejects(readJson('https://api.deepseek.com/user/balance', 'secret', { fetcher: (_url, opts) => {
    assert.equal(opts.redirect, 'error');
    throw Error('secret-in-error');
  } }), error => error.message === 'network');
  await assert.rejects(readJson('https://api.deepseek.com/user/balance', 'secret', { fetcher: () => new Response('x'.repeat(1048577)) }), /invalid-response/);
});

test('one shared operation backs both authenticated Fetch and the agent tool', async () => {
  const f = fixture();
  let route, tool;
  const effects = [];
  const ctx = {
    ...f.services,
    get: key => f.services[key],
    provide: () => {},
    connection: { fetch: { register: value => { route = value; return async () => {}; } } },
    tools: { register: value => { tool = value; return () => {}; } },
    effect: fn => effects.push(fn()),
  };
  assert.deepEqual(inject, ['llm', 'settings', 'credentials', 'connection', 'tools']);
  // Use an unsupported route: registration parity requires no real network.
  f.state.providers = { relay: { baseURL: 'https://relay.example' } };
  apply(ctx);
  try {
    assert.equal(route.path, '/api/provider-quota');
    assert.deepEqual(route.methods, ['GET', 'POST']);
    const toolResult = await tool.execute({ provider: 'relay' });
    const uiResult = await (await route.fetch(new Request('http://127.0.0.1/api/provider-quota?provider=relay', { method: 'POST' }))).json();
    assert.deepEqual(toolResult.rows, uiResult.rows);
    assert.equal(uiResult.rows[0].status, 'unsupported');
  } finally {
    for (const cleanup of effects.reverse()) if (typeof cleanup === 'function') await cleanup();
    await f.manager.dispose();
  }
});
