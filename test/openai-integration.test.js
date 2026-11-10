import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaManager } from '../manager.js';

function fixture() {
  const state = { now: Date.UTC(2026, 10, 5, 9, 30), admin: 'sk-admin-private-test-key', calls: 0, status: 200, reads: 0 };
  const services = {
    llm: {
      listProviders: () => [{ id: 'openai-custom', name: 'OpenAI' }],
      listConfigurableProviders: () => [{ provider: 'openai-custom', displayName: 'OpenAI', settingsNs: 'pi', settingsPath: ['providers', 'openai-custom'] }],
    },
    settings: { describe: () => [{ ns: 'pi', value: { providers: { 'openai-custom': { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'INFERENCE_KEY' } } } }] },
    credentials: {
      resolve: () => { throw Error('inference key must not be read for billing'); },
    },
  };
  const manager = new QuotaManager(services, {
    now: () => state.now,
    adminKeyResolver: async () => { state.reads++; return state.admin; },
    fetcher: async (url, options) => {
      state.calls++;
      assert.equal(new URL(url).origin, 'https://api.openai.com');
      assert.equal(new URL(url).pathname, '/v1/organization/costs');
      assert.equal(options.headers.Authorization, `Bearer ${state.admin}`);
      if (state.status !== 200) return Response.json({ error: 'private-upstream-body' }, { status: state.status });
      return Response.json({ object: 'page', has_more: false, next_page: null, data: [{ object: 'bucket', start_time: Date.UTC(2026, 10, 1) / 1000, end_time: Date.UTC(2026, 10, 2) / 1000, results: [{ object: 'organization.costs.result', amount: { currency: 'usd', value: 1.25 } }] }] });
    },
  });
  return { manager, state };
}

test('configured official route shows separately authorized organization spend, never inference-key spend', async () => {
  const { manager, state } = fixture();
  try {
    const result = await manager.snapshot();
    assert.equal(result.rows[0].status, 'ok');
    assert.equal(result.rows[0].source, 'official-costs');
    assert.equal(result.rows[0].metrics[0].type, 'spend');
    assert.equal(result.rows[0].metrics[0].scope, 'organization');
    assert.equal(result.rows[0].metrics[0].amount, '1.25');
    assert.equal(JSON.stringify(result).includes(state.admin), false);
    assert.equal(JSON.stringify(result).includes('INFERENCE_KEY'), false);
  } finally { await manager.dispose(); }
});

test('spend success cache lasts 15 minutes but key rotation and UTC month changes invalidate it', async () => {
  const { manager, state } = fixture();
  try {
    await manager.snapshot();
    state.now += 120001;
    await manager.snapshot();
    assert.equal(state.calls, 1);
    assert.equal(state.reads, 2);
    state.admin = 'sk-admin-rotated-test-key';
    await manager.snapshot();
    assert.equal(state.calls, 2);
    state.now += 900001;
    await manager.snapshot();
    assert.equal(state.calls, 3);
    state.now = Date.UTC(2026, 11, 1, 0, 1);
    await manager.snapshot();
    assert.equal(state.calls, 4);
  } finally { await manager.dispose(); }
});

test('removing admin key never shows cached spend from a previous authorization', async () => {
  const { manager, state } = fixture();
  try {
    await manager.snapshot();
    state.admin = undefined;
    const result = await manager.snapshot();
    assert.equal(result.rows[0].status, 'admin-key-required');
    assert.deepEqual(result.rows[0].metrics, []);
    assert.equal(state.calls, 1);
  } finally { await manager.dispose(); }
});

test('permission denial is explicit and does not become zero spend or leak upstream body', async () => {
  const { manager, state } = fixture();
  state.status = 403;
  try {
    const result = await manager.snapshot();
    assert.equal(result.rows[0].status, 'forbidden');
    assert.deepEqual(result.rows[0].metrics, []);
    assert.equal(JSON.stringify(result).includes('private-upstream-body'), false);
  } finally { await manager.dispose(); }
});

test('invalid admin configuration reports sanitized failure and never falls back to inference auth', async () => {
  const { manager, state } = fixture();
  manager.adminKeyResolver = async () => { throw Object.assign(Error('invalid-admin-key'), { code: 'invalid-admin-key' }); };
  try {
    const result = await manager.snapshot();
    assert.equal(result.rows[0].status, 'invalid-admin-key');
    assert.equal(state.calls, 0);
  } finally { await manager.dispose(); }
});
