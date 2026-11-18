import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { readProviderRouteHosts } from '../route-hosts.js';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pure = source.split('// BEGIN PURE LAYOUT')[1].split('// END PURE LAYOUT')[0];
const { hasSavedProviderSettings, providerRowSavedState, sortModelProviderCompanyGroups } = vm.runInNewContext(`${pure}\n({hasSavedProviderSettings,providerRowSavedState,sortModelProviderCompanyGroups})`, { URL });
const hasPath = (value, path) => {
  for (const part of path) {
    if (!Object.hasOwn(value ?? {}, part)) return false;
    value = value[part];
  }
  return value !== undefined;
};
const accountEntry = (extra = {}) => ({ provider: 'deepseek-account', settingsNs: 'llm-deepseek-account', settingsPath: [], ...extra });
const officialEntry = (extra = {}) => ({ provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [], ...extra });
const oauthEntry = (provider = 'openai-codex', extra = {}) => ({ provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], defaultBaseURL: 'https://chatgpt.com/backend-api', nativeAuth: { oauth: true }, ...extra });
function guardedMetadata(publicFields, privateFields, reads) {
  const value = { ...publicFields };
  for (const field of privateFields) Object.defineProperty(value, field, { enumerable: true, get() { reads.push(field); throw Error(`PRIVATE_${field}`); } });
  return value;
}
function fixture({ directory = [accountEntry()], documents, accountStatus = 'credential-stored', descriptors = {}, keyDescriptors = {} } = {}) {
  if (documents === undefined) documents = Object.fromEntries([...new Set(directory.map(entry => entry.settingsNs))].map(ns => [ns, ns === 'llm-pi-ai' ? { providers: {} } : {}]));
  const calls = { account: 0, records: [], keys: [], forbidden: [], private: [], launch: [] };
  const rejectRead = name => () => { calls.forbidden.push(name); throw Error(`FORBIDDEN_${name}`); };
  const state = guardedMetadata({ status: accountStatus }, ['attempt', 'authUrl', 'deviceCode', 'token', 'account', 'identity'], calls.private);
  const services = {
    llm: { listConfigurableProviders: () => directory, listProviders: rejectRead('listProviders') },
    settings: { describe(options) { assert.deepEqual(options, { redactSecrets: true }); return Object.entries(documents).map(([ns, value]) => ({ ns, value })); } },
    launchEnvironment: { get(ref) { calls.launch.push(ref); assert.equal(ref, 'DEEPSEEK_BASE_URL'); return undefined; } },
    credentials: {
      resolve: rejectRead('resolve'), readRecord: rejectRead('readRecord'),
      describe(ref) { calls.keys.push(ref); const value = keyDescriptors[ref]; if (value instanceof Error) throw value; return value; },
      describeRecord(ref) { calls.records.push(ref); const value = descriptors[ref]; if (value instanceof Error) throw value; return value; },
    },
    deepseekAccount: { getState() { calls.account++; return state; }, getBalance: rejectRead('getBalance'), getPlatformSession: rejectRead('getPlatformSession'), getDeviceIdentity: rejectRead('getDeviceIdentity'), startLogin: rejectRead('startLogin') },
  };
  return { services, calls, state };
}
const omitted = row => assert.equal(Object.hasOwn(row, 'authConfigured'), false, 'non-positive or unavailable auth state is omitted, not false/unknown data');
const safe = f => { assert.deepEqual(f.calls.forbidden, []); assert.deepEqual(f.calls.private, []); };

// Pure saved-state composition and mocked public Host services only; no React/DOM emulation, real accounts or HTTP calls.
test('nested user profiles use the exact hasPath result without confusing base/default settings with saved user settings', () => {
  const user = { providers: { saved: {} } };
  const path = ['providers', 'saved'];
  let calls = 0;
  assert.equal(hasSavedProviderSettings(user, path, (actualUser, actualPath) => { calls++; assert.equal(actualUser, user); assert.equal(actualPath, path); return hasPath(actualUser, actualPath); }), true);
  assert.equal(calls, 1);
  assert.equal(hasSavedProviderSettings({}, ['providers', 'only-in-base'], hasPath), false);
  assert.equal(hasSavedProviderSettings({ providers: {} }, ['providers', 'absent'], hasPath), false);
});

test('whole-section native user settings count only nonempty objects, without reading field values', () => {
  const noNestedLookup = () => { throw Error('empty path must not be treated as an existing profile'); };
  for (const value of [undefined, null, {}, [], '', false, 0, Object.create({ inheritedOnly: true })]) assert.equal(hasSavedProviderSettings(value, [], noNestedLookup), false);
  const privateValue = {};
  Object.defineProperty(privateValue, 'apiKeyEnv', { enumerable: true, get() { throw Error('a field value must not be read to determine persistence'); } });
  assert.equal(hasSavedProviderSettings(privateValue, [], noNestedLookup), true);
  assert.equal(hasSavedProviderSettings({ retryPolicy: { mode: 'normal' } }, [], noNestedLookup), true);
});

test('saved-state composition accepts only strict saved/settings/credential/auth booleans', () => {
  assert.equal(providerRowSavedState(true, undefined, undefined), true);
  assert.equal(providerRowSavedState(false, { configured: true }, false), true);
  assert.equal(providerRowSavedState(false, undefined, true), true);
  assert.equal(providerRowSavedState(false, { configured: false }, false), false);
  for (const truthy of [1, 'true', {}, [], new Boolean(true)]) {
    assert.equal(providerRowSavedState(truthy, { configured: truthy }, truthy), false);
  }
  const reads = [];
  const credential = guardedMetadata({ configured: true }, ['key', 'value', 'masked', 'source', 'payload'], reads);
  assert.equal(providerRowSavedState(false, credential, false), true);
  assert.deepEqual(reads, []);
  assert.equal(providerRowSavedState(false, { configured: false, active: true, declared: true }, false), false);
});

test('saved native authentication changes only the generic priority flag, never hard-coded company order', () => {
  const groups = [
    { key: 'company:deepseek', title: 'DeepSeek', entries: [{ savedConfiguration: providerRowSavedState(false, undefined, true) }] },
    { key: 'company:anthropic', title: 'Anthropic', entries: [{ savedConfiguration: false }] },
    { key: 'company:openai', title: 'OpenAI', entries: [{ savedConfiguration: providerRowSavedState(false, { configured: true }, false) }] },
  ];
  assert.deepEqual(Array.from(sortModelProviderCompanyGroups(groups, 'en'), group => group.key), ['company:deepseek', 'company:openai', 'company:anthropic']);
  groups[1].entries[0].savedConfiguration = providerRowSavedState(true, undefined, false);
  assert.deepEqual(Array.from(sortModelProviderCompanyGroups(groups, 'en'), group => group.key), ['company:anthropic', 'company:deepseek', 'company:openai']);
});

test('native stored-account status projects only a positive bool and preserves the verified model hostname', async () => {
  const f = fixture();
  const result = await readProviderRouteHosts(f.services);
  assert.equal(result.routes[0].hostname, 'api.deepseek.com');
  assert.equal(result.routes[0].authConfigured, true);
  assert.deepEqual(Object.keys(result.routes[0]).sort(), ['authConfigured', 'hostname', 'provider', 'settingsNs', 'settingsPath']);
  assert.equal(f.calls.account, 1);
  assert.deepEqual(f.calls.records, []);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  safe(f);
});

test('signed-out, in-progress or malformed account statuses do not imply stored authentication', async () => {
  for (const status of ['signed-out', 'pending', 'starting', 'authorizing', 'Credential-stored', undefined, null, true]) {
    const f = fixture({ accountStatus: status });
    if (status === undefined) delete f.state.status;
    const row = (await readProviderRouteHosts(f.services)).routes[0];
    assert.equal(row.hostname, 'api.deepseek.com'); omitted(row); safe(f);
  }
});

test('account status errors or unavailable service leave only auth metadata unknown, not the hostname', async () => {
  for (const mode of ['error', 'absent', 'method-absent']) {
    const f = fixture();
    if (mode === 'error') f.services.deepseekAccount.getState = () => { throw Error('PRIVATE_ACCOUNT_ERROR'); };
    if (mode === 'absent') f.services.deepseekAccount = undefined;
    if (mode === 'method-absent') f.services.deepseekAccount = {};
    const result = await readProviderRouteHosts(f.services);
    assert.equal(result.routes[0].hostname, 'api.deepseek.com'); omitted(result.routes[0]);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false); safe(f);
  }
});

test('same-name routes with another namespace/path and official API routes cannot borrow native account auth', async () => {
  for (const entry of [
    accountEntry({ settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'deepseek-account'], defaultBaseURL: 'https://relay.example.test/v1' }),
    accountEntry({ settingsNs: 'other-native-owner', defaultBaseURL: 'https://relay.example.test/v1' }),
    accountEntry({ settingsPath: ['nested'], defaultBaseURL: 'https://relay.example.test/v1' }),
    accountEntry({ provider: 'deepseek-official', settingsNs: 'llm-deepseek' }),
  ]) {
    const f = fixture({ directory: [entry] });
    omitted((await readProviderRouteHosts(f.services)).routes[0]);
    assert.equal(f.calls.account, 0); safe(f);
  }
});

test('native account auth needs its settings namespace document and is deduplicated per metadata request', async () => {
  const missing = fixture({ documents: {} });
  omitted((await readProviderRouteHosts(missing.services)).routes[0]);
  assert.equal(missing.calls.account, 0); safe(missing);
  const f = fixture({ directory: [accountEntry(), accountEntry()] });
  const result = await readProviderRouteHosts(f.services);
  assert.deepEqual(result.routes.map(row => row.authConfigured), [true, true]);
  assert.equal(f.calls.account, 1); safe(f);
});

test('native API-key adapters use only public default or explicit credential descriptors, including ambient configured metadata', async () => {
  for (const settingsNs of ['llm-deepseek', 'llm-deepseek-api-key']) {
    for (const explicit of [undefined, 'WORK_DEEPSEEK_KEY']) {
      const ref = explicit ?? 'DEEPSEEK_API_KEY';
      const reads = [];
      const descriptor = guardedMetadata({ configured: true }, ['value', 'key', 'masked', 'payload', 'source'], reads);
      const f = fixture({ directory: [officialEntry({ settingsNs })], documents: { [settingsNs]: explicit === undefined ? {} : { apiKeyEnv: explicit } }, keyDescriptors: { [ref]: descriptor } });
      const row = (await readProviderRouteHosts(f.services)).routes[0];
      assert.equal(row.hostname, 'api.deepseek.com'); assert.equal(row.authConfigured, true);
      assert.deepEqual(f.calls.keys, [ref]); assert.equal(f.calls.account, 0); assert.deepEqual(f.calls.records, []);
      assert.deepEqual(reads, []); safe(f);
    }
  }
});

test('invalid explicit native key references never borrow a configured default key', async () => {
  for (const apiKeyEnv of ['', ' ', null, false, 0, {}, 'BAD-REF', 'BAD REF', '1NUMBER', 'llm-pi-ai/openai-codex']) {
    const f = fixture({ directory: [officialEntry()], documents: { 'llm-deepseek': { apiKeyEnv } }, keyDescriptors: { DEEPSEEK_API_KEY: { configured: true } } });
    const row = (await readProviderRouteHosts(f.services)).routes[0];
    assert.equal(row.hostname, 'api.deepseek.com'); omitted(row);
    assert.deepEqual(f.calls.keys, []); assert.equal(f.calls.account, 0); safe(f);
  }
});

test('native API-key descriptor absence, false values and errors omit optional auth without losing hostname', async () => {
  for (const descriptor of [undefined, { configured: false }, { configured: 'true' }, { configured: 1 }, Error('PRIVATE_KEY_DESCRIPTOR_ERROR')]) {
    const f = fixture({ directory: [officialEntry()], keyDescriptors: { DEEPSEEK_API_KEY: descriptor } });
    const result = await readProviderRouteHosts(f.services);
    assert.equal(result.routes[0].hostname, 'api.deepseek.com'); omitted(result.routes[0]);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false); safe(f);
  }
  const f = fixture({ directory: [officialEntry()] });
  delete f.services.credentials.describe;
  omitted((await readProviderRouteHosts(f.services)).routes[0]); safe(f);
});

test('native key descriptor lookups are cached by exact reference and never borrowed by other namespaces', async () => {
  const f = fixture({ directory: [officialEntry(), officialEntry({ settingsNs: 'llm-deepseek-api-key' }), officialEntry({ settingsNs: 'other-owner', defaultBaseURL: 'https://relay.example.test/v1' })], keyDescriptors: { DEEPSEEK_API_KEY: { configured: true } } });
  const result = await readProviderRouteHosts(f.services);
  assert.equal(result.routes[0].authConfigured, true); assert.equal(result.routes[1].authConfigured, true); omitted(result.routes[2]);
  assert.deepEqual(f.calls.keys, ['DEEPSEEK_API_KEY']); assert.equal(f.calls.account, 0); safe(f);
});

test('pi-ai OAuth-capable routes describe only their exact scoped record and accept grant or api-key metadata', async () => {
  for (const kind of ['grant', 'api-key']) {
    const reads = [];
    const descriptor = guardedMetadata({ configured: true, kind }, ['payload', 'key', 'access', 'refresh'], reads);
    const f = fixture({ directory: [oauthEntry()], descriptors: { 'llm-pi-ai/openai-codex': descriptor } });
    const row = (await readProviderRouteHosts(f.services)).routes[0];
    assert.equal(row.hostname, 'chatgpt.com'); assert.equal(row.authConfigured, true);
    assert.deepEqual(f.calls.records, ['llm-pi-ai/openai-codex']);
    assert.equal(f.calls.account, 0); assert.deepEqual(reads, []); safe(f);
  }
});

test('OAuth record metadata must be strictly configured with a recognized stored kind', async () => {
  for (const descriptor of [undefined, { configured: false, kind: 'grant' }, { configured: 'true', kind: 'grant' }, { configured: 1, kind: 'api-key' }, { configured: true, kind: 'unknown' }, { configured: true }, { configured: true, kind: 'apiKey' }]) {
    const f = fixture({ directory: [oauthEntry()], descriptors: { 'llm-pi-ai/openai-codex': descriptor } });
    const row = (await readProviderRouteHosts(f.services)).routes[0];
    assert.equal(row.hostname, 'chatgpt.com'); omitted(row); safe(f);
  }
});

test('OAuth descriptor failures, missing method or missing namespace do not corrupt route host metadata', async () => {
  for (const mode of ['failure', 'method-absent', 'namespace-absent']) {
    const f = fixture({ directory: [oauthEntry()], descriptors: { 'llm-pi-ai/openai-codex': Error('PRIVATE_DESCRIPTOR_ERROR') } });
    if (mode === 'method-absent') delete f.services.credentials.describeRecord;
    if (mode === 'namespace-absent') f.services.settings.describe = () => [];
    const result = await readProviderRouteHosts(f.services);
    assert.equal(result.routes[0].hostname, mode === 'namespace-absent' ? null : 'chatgpt.com');
    omitted(result.routes[0]); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    if (mode === 'namespace-absent') assert.deepEqual(f.calls.records, []);
    safe(f);
  }
});

test('OAuth metadata lookup requires exact pi-ai namespace, provider path and literal oauth capability', async () => {
  for (const entry of [
    oauthEntry('openai-codex', { settingsNs: 'other-pi' }),
    oauthEntry('openai-codex', { settingsPath: ['providers', 'other-provider'] }),
    oauthEntry('openai-codex', { settingsPath: ['providers', 'openai-codex', 'nested'] }),
    oauthEntry('openai-codex', { settingsPath: [] }),
    oauthEntry('openai-codex', { nativeAuth: { oauth: false } }),
    oauthEntry('openai-codex', { nativeAuth: { oauth: 'true' } }),
  ]) {
    const f = fixture({ directory: [entry], descriptors: { 'llm-pi-ai/openai-codex': { configured: true, kind: 'grant' } } });
    omitted((await readProviderRouteHosts(f.services)).routes[0]);
    assert.deepEqual(f.calls.records, []); assert.equal(f.calls.account, 0); safe(f);
  }
});

test('OAuth record descriptors are cached by exact provider identity and never borrowed across profiles', async () => {
  const f = fixture({ directory: [oauthEntry(), oauthEntry('anthropic'), oauthEntry()], descriptors: {
    'llm-pi-ai/openai-codex': { configured: true, kind: 'grant' },
    'llm-pi-ai/anthropic': { configured: false, kind: 'grant' },
  } });
  const result = await readProviderRouteHosts(f.services);
  assert.equal(result.routes[0].authConfigured, true); omitted(result.routes[1]); assert.equal(result.routes[2].authConfigured, true);
  assert.deepEqual(f.calls.records, ['llm-pi-ai/openai-codex', 'llm-pi-ai/anthropic']); safe(f);
});

test('auth metadata remains optional for callers without the new account/record services', async () => {
  const f = fixture({ directory: [accountEntry(), oauthEntry()] });
  f.services.deepseekAccount = undefined;
  delete f.services.credentials.describeRecord;
  const result = await readProviderRouteHosts(f.services);
  for (const row of result.routes) assert.deepEqual(Object.keys(row).sort(), ['hostname', 'provider', 'settingsNs', 'settingsPath']);
  assert.deepEqual(result.routes.map(row => row.hostname), ['api.deepseek.com', 'chatgpt.com']); safe(f);
});

test('stored-auth metadata lookups are bounded across a large public provider directory', async () => {
  const directory = Array.from({ length: 257 }, (_, index) => oauthEntry(`synthetic-${index}`));
  const descriptors = Object.fromEntries(directory.map(entry => [`llm-pi-ai/${entry.provider}`, { configured: true, kind: 'grant' }]));
  const f = fixture({ directory, descriptors });
  const result = await readProviderRouteHosts(f.services);
  assert.equal(result.routes.length, 257);
  assert.equal(f.calls.records.length, 256);
  assert.equal(result.routes[0].authConfigured, true);
  omitted(result.routes.at(-1));
  assert.equal(result.routes.at(-1).hostname, 'chatgpt.com'); safe(f);
});

test('bounded account/record/key metadata can time out without losing hostnames or accepting late positive results', async () => {
  for (const kind of ['account', 'record', 'key']) {
    const f = fixture({ directory: [kind === 'account' ? accountEntry() : kind === 'record' ? oauthEntry() : officialEntry()] });
    let resolve;
    const pending = () => new Promise(done => { resolve = done; });
    if (kind === 'account') f.services.deepseekAccount.getState = pending;
    if (kind === 'record') f.services.credentials.describeRecord = pending;
    if (kind === 'key') f.services.credentials.describe = pending;
    const result = await readProviderRouteHosts(f.services, { timeoutMs: 1000, resolveTimeoutMs: 5 });
    assert.equal(result.routes[0].hostname, kind === 'record' ? 'chatgpt.com' : 'api.deepseek.com'); omitted(result.routes[0]);
    resolve(kind === 'account' ? { status: 'credential-stored' } : kind === 'record' ? { configured: true, kind: 'grant' } : { configured: true });
    await Promise.resolve();
    omitted(result.routes[0]); safe(f);
  }
});
