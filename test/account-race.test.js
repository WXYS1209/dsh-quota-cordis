import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaManager } from '../src/manager.js';

function setup(identityValues) {
  let read = 0;
  let calls = 0;
  const manager = new QuotaManager({
    llm: {
      listProviders: () => [{ id: 'deepseek-account', name: 'Account' }],
      listConfigurableProviders: () => [{ provider: 'deepseek-account', displayName: 'Account', settingsNs: 'account', settingsPath: [] }],
    },
    settings: { describe: () => [{ ns: 'account', value: {} }] },
    credentials: {},
    deepseekAccount: {
      getState: () => ({ status: 'credential-stored' }),
      getDeviceIdentity: () => ({ userId: identityValues[Math.min(read++, identityValues.length - 1)] }),
      getBalance: () => { calls++; return { status: 'ready', value: [{ currency: 'CNY', balance: String(calls * 10) }], bonusWallets: [] }; },
    },
  }, { now: () => 1000 });
  return { manager, calls: () => calls };
}

test('account identity A→B between identity and wallet reads discards the wallet, never caching under A', async () => {
  const { manager, calls } = setup(['A', 'B', 'A', 'A']);
  try {
    const switched = await manager.snapshot();
    assert.equal(switched.rows[0].status, 'account-changed');
    assert.deepEqual(switched.rows[0].metrics, []);
    assert.equal(manager.cache.size, 0);
    const restored = await manager.snapshot();
    assert.equal(restored.rows[0].status, 'ok');
    assert.equal(restored.rows[0].metrics[0].amount, '20');
    assert.equal(calls(), 2);
  } finally { await manager.dispose(); }
});

test('missing stable account identity never falls back to a timestamp cache key', async () => {
  const { manager, calls } = setup([undefined]);
  try {
    const result = await manager.snapshot();
    assert.equal(result.rows[0].status, 'account-changed');
    assert.deepEqual(result.rows[0].metrics, []);
    assert.equal(manager.cache.size, 0);
    assert.equal(calls(), 0);
  } finally { await manager.dispose(); }
});

test('account without a user ID checks a Host-only grant fingerprint and never exposes it', async () => {
  const { manager, calls } = setup([undefined]);
  manager.services.deepseekAccount.getPlatformSession = () => ({ token: 'private-grant-fixture', userId: null });
  try {
    const result = await manager.snapshot();
    assert.equal(result.rows[0].status, 'ok');
    assert.equal(calls(), 1);
    assert.equal(manager.cache.size, 0);
    assert.equal(JSON.stringify(result).includes('private-grant-fixture'), false);
    assert.equal(JSON.stringify(result).includes('grant:'), false);
  } finally { await manager.dispose(); }
});

test('grant changes discard the balance even when public account IDs are unchanged', async () => {
  const { manager } = setup(['same-public-id']);
  let reads = 0;
  manager.services.deepseekAccount.getPlatformSession = () => ({ token: ++reads === 1 ? 'grant-before' : 'grant-after' });
  try {
    const result = await manager.snapshot();
    assert.equal(result.rows[0].status, 'account-changed');
    assert.deepEqual(result.rows[0].metrics, []);
    assert.equal(manager.cache.size, 0);
  } finally { await manager.dispose(); }
});

test('two account snapshots are not merged under an unbound identity', async () => {
  const { manager, calls } = setup(['A']);
  try {
    await Promise.all([manager.snapshot(), manager.snapshot()]);
    assert.equal(calls(), 2);
    assert.equal(manager.cache.size, 0);
  } finally { await manager.dispose(); }
});
