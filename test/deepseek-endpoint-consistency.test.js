import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaManager } from '../src/manager.js';
import { readProviderRouteHosts } from '../src/route-hosts.js';

const OFFICIAL = 'https://api.deepseek.com/anthropic';
const RELAY = 'https://relay.example.test/anthropic';
const BALANCE = 'https://api.deepseek.com/user/balance';
const KEY_REF = 'SYNTHETIC_DEEPSEEK_KEY';
const balance = amount => ({ balance_infos: [{ currency: 'CNY', total_balance: amount, granted_balance: '0.00', topped_up_balance: amount }] });
function put(root, path, value) {
  if (!path.length) return value;
  let at = root;
  for (const segment of path.slice(0, -1)) at = at[segment] ??= {};
  at[path.at(-1)] = value;
  return root;
}
function fixture({ provider = 'deepseek-official', ns = 'llm-deepseek', path = [], profile = {}, launchValue, storedEndpoint = OFFICIAL } = {}) {
  const state = {
    directory: [{ provider, displayName: 'Synthetic native route', settingsNs: ns, settingsPath: [...path] }],
    registered: [{ id: provider, name: 'Synthetic native route', nativeAuth: { env: [KEY_REF] } }],
    documents: { [ns]: put({}, path, { apiKeyEnv: KEY_REF, ...profile }) },
    keys: { [KEY_REF]: 'fixture-key-A', SYNTHETIC_OTHER_KEY: 'fixture-other-key' },
    launchValue, launchError: null, storedEndpoint, endpointRefs: {}, keyReads: [], endpointReads: [], launchReads: [], requests: [], amount: '20.00', now: 1_000_000,
  };
  const services = {
    llm: { listConfigurableProviders: () => state.directory, listProviders: () => state.registered },
    settings: { describe(options) { assert.equal(options.redactSecrets, true); return Object.entries(state.documents).map(([ns, value]) => ({ ns, value })); } },
    launchEnvironment: { get(ref) {
      assert.equal(ref, 'DEEPSEEK_BASE_URL'); state.launchReads.push(ref);
      if (state.launchError) throw state.launchError;
      return state.launchValue === undefined ? undefined : { value: state.launchValue, source: 'process' };
    } },
    credentials: {
      describe(ref) { return { configured: typeof state.keys[ref] === 'string' }; },
      resolve(ref) {
        if (ref === 'DEEPSEEK_BASE_URL') {
          state.endpointReads.push(ref);
          if (state.storedEndpoint instanceof Error) throw state.storedEndpoint;
          return state.storedEndpoint === undefined ? undefined : { value: state.storedEndpoint };
        }
        if (Object.hasOwn(state.endpointRefs, ref)) { state.endpointReads.push(ref); return { value: state.endpointRefs[ref] }; }
        state.keyReads.push(ref);
        assert.ok(Object.hasOwn(state.keys, ref), 'only explicitly configured synthetic key references may be resolved');
        return { value: state.keys[ref] };
      },
      describeRecord() { throw Error('native endpoint consistency tests must not inspect grants'); },
      readRecord() { throw Error('native endpoint consistency tests must not read grants'); },
    },
  };
  const manager = new QuotaManager(services, {
    now: () => state.now,
    adminKeyResolver: async () => { throw Error('OpenAI admin lookup is unrelated'); },
    fetcher: async (url, options) => {
      assert.ok([BALANCE, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'].includes(url), 'never contact an unapproved destination');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      state.requests.push({ url, authorization: options.headers.Authorization });
      return Response.json(url === BALANCE ? balance(state.amount) : { limits: [{ type: 'TOKENS_LIMIT', percentage: 25 }] });
    },
  });
  return { state, services, manager, profile: state.documents[ns] };
}
function unsupported(row) {
  assert.ok(row, 'an ineligible native route remains visible as unsupported');
  assert.equal(row.kind, 'unsupported');
  assert.equal(row.status, 'unsupported');
  assert.deepEqual(row.metrics, []);
}
async function close(f) { await f.manager.dispose(); }

// All services, endpoint values, credentials and HTTP responses below are synthetic.
// No process.env, user config, native account or real network is consulted.
test('stored official endpoint cannot override the native launch relay for grouping or quota eligibility', async () => {
  const f = fixture({ launchValue: RELAY, storedEndpoint: OFFICIAL });
  try {
    assert.equal((await readProviderRouteHosts(f.services)).routes[0].hostname, 'relay.example.test');
    unsupported((await f.manager.snapshot()).rows[0]);
    assert.deepEqual(f.state.keyReads, []);
    assert.deepEqual(f.state.endpointReads, []);
    assert.deepEqual(f.state.requests, []);
  } finally { await close(f); }
});

test('stored relay endpoint cannot suppress official launch endpoint or change same-key cache identity', async () => {
  const f = fixture({ launchValue: OFFICIAL, storedEndpoint: RELAY });
  try {
    assert.equal((await readProviderRouteHosts(f.services)).routes[0].hostname, 'api.deepseek.com');
    const first = await f.manager.snapshot();
    const second = await f.manager.snapshot();
    assert.equal(first.rows[0].status, 'ok');
    assert.equal(second.rows[0].metrics[0].amount, '20.00');
    assert.equal(f.state.requests.length, 1);
    assert.equal(f.state.requests[0].url, BALANCE);
    assert.equal(f.state.requests[0].authorization, 'Bearer fixture-key-A');
    assert.deepEqual(f.state.endpointReads, []);
    assert.equal(JSON.stringify(second).includes('fixture-key-A'), false);
  } finally { await close(f); }
});

test('explicit native profile relay wins over both launch and managed endpoint values without reading keys', async () => {
  const f = fixture({ profile: { baseURL: RELAY }, launchValue: OFFICIAL, storedEndpoint: OFFICIAL });
  try {
    assert.equal((await readProviderRouteHosts(f.services)).routes[0].hostname, 'relay.example.test');
    unsupported((await f.manager.snapshot()).rows[0]);
    assert.deepEqual(f.state.launchReads, []);
    assert.deepEqual(f.state.endpointReads, []);
    assert.deepEqual(f.state.keyReads, []);
    assert.deepEqual(f.state.requests, []);
  } finally { await close(f); }
});

test('blank and invalid native profile endpoints never default to official quota or read an API key', async () => {
  for (const baseURL of ['', ' ', 0, false, 'not a URL', 'https://api.deepseek.com/anthropic?token=fixture', 'https://api.deepseek.com/anthropic#fixture', 'https://user:fixture@api.deepseek.com/anthropic', 'http://api.deepseek.com/anthropic', 'https://api.deepseek.com:9443/anthropic']) {
    const f = fixture({ profile: { baseURL }, launchValue: OFFICIAL });
    try {
      unsupported((await f.manager.snapshot()).rows[0]);
      assert.deepEqual(f.state.keyReads, [], String(baseURL));
      assert.deepEqual(f.state.requests, [], String(baseURL));
      assert.deepEqual(f.state.launchReads, [], 'present invalid config must not fall through');
    } finally { await close(f); }
  }
});

test('blank, failing or unavailable launch snapshot fails closed rather than using stored endpoint/default', async () => {
  for (const scenario of ['blank', 'invalid', 'query', 'fragment', 'userinfo', 'error', 'missing', 'malformed']) {
    const f = fixture({ storedEndpoint: OFFICIAL });
    if (scenario === 'blank') f.state.launchValue = '';
    if (scenario === 'invalid') f.state.launchValue = 'invalid endpoint';
    if (scenario === 'query') f.state.launchValue = `${OFFICIAL}?token=fixture`;
    if (scenario === 'fragment') f.state.launchValue = `${OFFICIAL}#fixture`;
    if (scenario === 'userinfo') f.state.launchValue = 'https://user:fixture@api.deepseek.com/anthropic';
    if (scenario === 'error') f.state.launchError = new Error('PRIVATE_SYNTHETIC_ERROR');
    if (scenario === 'missing') f.services.launchEnvironment = undefined;
    if (scenario === 'malformed') f.services.launchEnvironment = {};
    try {
      assert.equal((await readProviderRouteHosts(f.services)).routes[0].hostname, null);
      const snapshot = await f.manager.snapshot();
      unsupported(snapshot.rows[0]);
      assert.deepEqual(f.state.keyReads, [], scenario);
      assert.deepEqual(f.state.endpointReads, [], scenario);
      assert.deepEqual(f.state.requests, [], scenario);
      assert.equal(JSON.stringify(snapshot).includes('PRIVATE_SYNTHETIC_ERROR'), false);
    } finally { await close(f); }
  }
});

test('verified native namespaces use the public default when launch snapshot authoritatively has no override', async () => {
  for (const ns of ['llm-deepseek', 'llm-deepseek-api-key']) {
    const f = fixture({ ns, profile: { baseURL: null }, storedEndpoint: new Error('managed endpoint must not be read') });
    try {
      assert.equal((await readProviderRouteHosts(f.services)).routes[0].hostname, 'api.deepseek.com');
      const snapshot = await f.manager.snapshot();
      assert.equal(snapshot.rows[0].kind, 'deepseek');
      assert.equal(snapshot.rows[0].status, 'ok');
      assert.equal(f.state.requests.length, 1);
      assert.deepEqual(f.state.endpointReads, []);
    } finally { await close(f); }
  }
});

test('relay transition cannot expose cached official success or read a key; rotated official key gets isolated cache', async () => {
  const f = fixture({ launchValue: OFFICIAL });
  try {
    assert.equal((await f.manager.snapshot()).rows[0].metrics[0].amount, '20.00');
    const reads = f.state.keyReads.length;
    f.state.launchValue = RELAY;
    unsupported((await f.manager.snapshot()).rows[0]);
    assert.equal(f.state.keyReads.length, reads);
    assert.equal(f.state.requests.length, 1);
    f.state.launchValue = OFFICIAL;
    f.state.keys[KEY_REF] = 'fixture-key-B';
    f.state.amount = '30.00';
    const fresh = await f.manager.snapshot();
    assert.equal(fresh.rows[0].status, 'ok');
    assert.equal(fresh.rows[0].metrics[0].amount, '30.00');
    assert.equal(f.state.requests.length, 2);
    assert.equal(f.state.requests[1].authorization, 'Bearer fixture-key-B');
    assert.equal(JSON.stringify(fresh).includes('fixture-key-B'), false);
  } finally { await close(f); }
});

test('same-name pi-ai routes, arbitrary namespaces and nonempty native paths cannot inherit native environment/defaults', async () => {
  for (const options of [{ ns: 'llm-pi-ai', path: ['providers', 'deepseek-official'] }, { ns: 'custom-adapter' }, { ns: 'llm-deepseek', path: ['providers', 'deepseek-official'] }]) {
    const f = fixture({ ...options, launchValue: OFFICIAL, storedEndpoint: OFFICIAL });
    try {
      assert.equal((await readProviderRouteHosts(f.services)).routes[0].hostname, null);
      unsupported((await f.manager.snapshot()).rows[0]);
      assert.deepEqual(f.state.launchReads, []);
      assert.deepEqual(f.state.endpointReads, []);
      assert.deepEqual(f.state.keyReads, []);
      assert.deepEqual(f.state.requests, []);
    } finally { await close(f); }
  }
});

test('explicit invalid generic pi-ai endpoints cannot manufacture an official default or consult endpoint fallbacks', async () => {
  for (const provider of ['deepseek-official', 'deepseek', 'work-name-default-deepseek']) {
    for (const baseURL of ['', ' ', null, false, 0, {}]) {
      const f = fixture({ provider, ns: 'llm-pi-ai', path: ['providers', provider], profile: { baseURL }, launchValue: OFFICIAL });
      f.state.directory[0].defaultBaseURL = OFFICIAL;
      f.state.directory[0].baseURLEnv = ['SYNTHETIC_ADVERTISED_ENDPOINT'];
      f.state.endpointRefs.SYNTHETIC_ADVERTISED_ENDPOINT = OFFICIAL;
      try {
        assert.equal((await readProviderRouteHosts(f.services)).routes[0].hostname, null);
        unsupported((await f.manager.snapshot()).rows[0]);
        assert.deepEqual(f.state.launchReads, []);
        assert.deepEqual(f.state.endpointReads, []);
        assert.deepEqual(f.state.keyReads, []);
        assert.deepEqual(f.state.requests, []);
      } finally { await close(f); }
    }
    const valid = fixture({ provider, ns: 'llm-pi-ai', path: ['providers', provider], profile: { baseURL: RELAY }, launchValue: OFFICIAL });
    valid.state.directory[0].defaultBaseURL = OFFICIAL;
    valid.state.directory[0].baseURLEnv = ['SYNTHETIC_ADVERTISED_ENDPOINT'];
    valid.state.endpointRefs.SYNTHETIC_ADVERTISED_ENDPOINT = OFFICIAL;
    try {
      assert.equal((await readProviderRouteHosts(valid.services)).routes[0].hostname, 'relay.example.test');
      unsupported((await valid.manager.snapshot()).rows[0]);
      assert.deepEqual(valid.state.endpointReads, []);
      assert.deepEqual(valid.state.keyReads, []);
      assert.deepEqual(valid.state.requests, []);
    } finally { await close(valid); }
  }
});

test('generic same-name routes remain eligible when their actual advertised endpoint is official', async () => {
  for (const advertised of ['catalog', 'environment']) {
    const f = fixture({ ns: 'llm-pi-ai', path: ['providers', 'deepseek-official'], launchValue: RELAY, storedEndpoint: RELAY });
    if (advertised === 'catalog') f.state.directory[0].defaultBaseURL = OFFICIAL;
    else { f.state.directory[0].baseURLEnv = ['SYNTHETIC_ADVERTISED_ENDPOINT']; f.state.endpointRefs.SYNTHETIC_ADVERTISED_ENDPOINT = OFFICIAL; }
    try {
      assert.equal((await readProviderRouteHosts(f.services)).routes[0].hostname, 'api.deepseek.com');
      assert.equal((await f.manager.snapshot()).rows[0].status, 'ok');
      assert.equal(f.state.requests.length, 1);
      assert.deepEqual(f.state.launchReads, []);
      assert.equal(f.state.endpointReads.includes('DEEPSEEK_BASE_URL'), false);
    } finally { await close(f); }
  }
});

test('registered-only DeepSeek names without an actual endpoint stay unsupported without key or network reads', async () => {
  for (const provider of ['deepseek-official', 'deepseek']) {
    const f = fixture({ provider });
    f.state.directory = [];
    try {
      unsupported((await f.manager.snapshot()).rows[0]);
      assert.deepEqual(f.state.keyReads, []);
      assert.deepEqual(f.state.requests, []);
      assert.deepEqual(f.state.launchReads, []);
    } finally { await close(f); }
  }
});

test('a failing native endpoint is row-local and does not hide a healthy unrelated provider', async () => {
  const f = fixture();
  f.state.launchError = new Error('PRIVATE_ENDPOINT_FAILURE');
  f.state.directory.push({ provider: 'zai-coding-cn', settingsNs: 'other-provider', settingsPath: ['providers', 'zai-coding-cn'] });
  f.state.registered.push({ id: 'zai-coding-cn', name: 'Unrelated healthy provider' });
  f.state.documents['other-provider'] = { providers: { 'zai-coding-cn': { apiKeyEnv: 'SYNTHETIC_OTHER_KEY', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' } } };
  try {
    const snapshot = await f.manager.snapshot();
    unsupported(snapshot.rows.find(row => row.id === 'deepseek-official'));
    const healthy = snapshot.rows.find(row => row.id === 'zai-coding-cn');
    assert.equal(healthy.status, 'ok');
    assert.equal(healthy.metrics[0].usedPercent, 25);
    assert.deepEqual(f.state.keyReads, ['SYNTHETIC_OTHER_KEY']);
    assert.equal(f.state.requests.length, 1);
    assert.equal(f.state.requests[0].url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
    assert.equal(JSON.stringify(snapshot).includes('PRIVATE_ENDPOINT_FAILURE'), false);
  } finally { await close(f); }
});

test('the native account wallet stays separate from inference-route endpoint eligibility', async () => {
  for (const failingLaunch of [false, true]) {
    const f = fixture({ provider: 'deepseek-account', ns: 'llm-deepseek-account', launchValue: RELAY });
    if (failingLaunch) f.state.launchError = new Error('inference endpoint is unavailable');
    let walletCalls = 0;
    f.services.deepseekAccount = {
      getState: () => ({ status: 'credential-stored' }),
      getPlatformSession: () => ({ token: 'synthetic-wallet-session' }),
      getBalance: () => { walletCalls++; return { status: 'ready', value: [{ currency: 'CNY', balance: '9.00' }], bonusWallets: [] }; },
    };
    try {
      const snapshot = await f.manager.snapshot();
      assert.equal(snapshot.rows[0].kind, 'account');
      assert.equal(snapshot.rows[0].status, 'ok');
      assert.equal(snapshot.rows[0].metrics[0].amount, '9.00');
      assert.equal(walletCalls, 1);
      assert.deepEqual(f.state.keyReads, []);
      assert.deepEqual(f.state.requests, []);
      assert.equal(JSON.stringify(snapshot).includes('synthetic-wallet-session'), false);
    } finally { await close(f); }
  }
});
