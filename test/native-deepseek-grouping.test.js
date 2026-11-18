import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { readProviderRouteHosts, nativeDeepSeekEndpointEnvironment } from '../route-hosts.js';
import { apply } from '../index.js';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pure = source.split('// BEGIN PURE LAYOUT')[1].split('// END PURE LAYOUT')[0];
const { groupModelProvidersByCompany } = vm.runInNewContext(`${pure}\n({groupModelProvidersByCompany})`, { URL });
const native = () => [
  { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] },
  { provider: 'deepseek-official', displayName: 'DeepSeek Official', settingsNs: 'llm-deepseek', settingsPath: [] },
];
function fixture({ directory = native(), documents = { 'llm-deepseek-account': {}, 'llm-deepseek': {} }, endpoint } = {}) {
  const lookups = [];
  const services = {
    llm: { listConfigurableProviders: () => directory, listProviders() { throw Error('registry/auth lookup is not needed'); } },
    settings: { describe(options) { assert.deepEqual(options, { redactSecrets: true }); return Object.entries(documents).map(([ns, value]) => ({ ns, value })); } },
    launchEnvironment: { get(ref) { assert.equal(ref, 'DEEPSEEK_BASE_URL'); lookups.push(ref); if (endpoint instanceof Error) throw endpoint; return endpoint === undefined ? undefined : { value: endpoint, source: 'process' }; } },
    credentials: {
      resolve() { throw Error('native endpoint must not use managed credentials or key references'); },
      readRecord() { throw Error('native grant must not be read'); }, describe() { throw Error('API key status must not be read'); },
    },
  };
  return { services, lookups, directory };
}
const hosts = result => result.routes.map(route => route.hostname);
function grouped(result, directory) {
  return groupModelProvidersByCompany(result.routes.map((route, index) => ({ entry: directory[index], routeHostname: route.hostname })), 'Unknown');
}

test('both standard native DeepSeek adapters share the verified Messages default and one DeepSeek company', async () => {
  const f = fixture();
  const result = await readProviderRouteHosts(f.services);
  assert.deepEqual(hosts(result), ['api.deepseek.com', 'api.deepseek.com']);
  assert.deepEqual(f.lookups, ['DEEPSEEK_BASE_URL'], 'one bounded launch lookup serves both adapters');
  const groups = grouped(result, f.directory);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'company:deepseek');
  assert.equal(groups[0].icon, 'deepseek');
  assert.deepEqual(Array.from(groups[0].entries, row => row.entry.provider), ['deepseek-account', 'deepseek-official']);
});

test('the unaliased native API-key package namespace is also supported without guessing custom aliases', async () => {
  const f = fixture({ directory: [{ ...native()[1], settingsNs: 'llm-deepseek-api-key' }], documents: { 'llm-deepseek-api-key': {} } });
  assert.deepEqual(hosts(await readProviderRouteHosts(f.services)), ['api.deepseek.com']);
});

test('both native adapters honor the launch-snapshot override rather than stored credential values', async () => {
  const f = fixture({ endpoint: 'https://relay.example.net/anthropic' });
  const result = await readProviderRouteHosts(f.services);
  assert.deepEqual(hosts(result), ['relay.example.net', 'relay.example.net']);
  assert.equal(grouped(result, f.directory)[0].key, 'domain:example.net');
  assert.deepEqual(f.lookups, ['DEEPSEEK_BASE_URL']);
});

test('native configured endpoint overrides win, and absent launch service does not prevent explicit endpoint projection', async () => {
  const f = fixture({ documents: {
    'llm-deepseek-account': { baseURL: 'https://account-relay.example.net/anthropic' },
    'llm-deepseek': { baseURL: 'https://official-relay.example.net/anthropic' },
  } });
  f.services.launchEnvironment = undefined;
  assert.deepEqual(hosts(await readProviderRouteHosts(f.services)), ['account-relay.example.net', 'official-relay.example.net']);
  assert.deepEqual(f.lookups, []);
});

test('explicit blank or invalid native endpoints never fall through to the official default or environment', async () => {
  for (const baseURL of ['', ' ', 'not a URL', 0, false, 'ftp://api.deepseek.com', 'https://user:password@api.deepseek.com', 'https://api.deepseek.com/anthropic?token=PRIVATE_QUERY', 'https://api.deepseek.com/anthropic#PRIVATE_FRAGMENT', `https://api.deepseek.com/${'a'.repeat(16_384)}`]) {
    const f = fixture({ documents: { 'llm-deepseek-account': { baseURL }, 'llm-deepseek': { baseURL } }, endpoint: 'https://api.deepseek.com/anthropic' });
    assert.deepEqual(hosts(await readProviderRouteHosts(f.services)), [null, null], String(baseURL));
    assert.deepEqual(f.lookups, [], 'a present invalid override is not absent');
  }
});

test('native nullish values preserve exact precedence including blank launch overrides and lookup failures', async () => {
  for (const endpoint of ['', ' ', 'invalid endpoint', new Error('PRIVATE_LAUNCH_ERROR')]) {
    const f = fixture({ endpoint });
    const result = await readProviderRouteHosts(f.services);
    assert.deepEqual(hosts(result), [null, null]);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(f.lookups.length, 1);
  }
  const f = fixture({ documents: { 'llm-deepseek-account': { baseURL: null }, 'llm-deepseek': {} } });
  assert.deepEqual(hosts(await readProviderRouteHosts(f.services)), ['api.deepseek.com', 'api.deepseek.com']);
});

test('missing launch snapshot, settings document or valid native profile leaves uncertain routes unclassified', async () => {
  const noLaunch = fixture();
  noLaunch.services.launchEnvironment = undefined;
  assert.deepEqual(hosts(await readProviderRouteHosts(noLaunch.services)), [null, null]);
  const missing = fixture({ documents: {} });
  assert.deepEqual(hosts(await readProviderRouteHosts(missing.services)), [null, null]);
  assert.deepEqual(missing.lookups, []);
  for (const value of [undefined, null, 1, [], 'invalid profile']) {
    const f = fixture({ documents: { 'llm-deepseek-account': value, 'llm-deepseek': value } });
    assert.deepEqual(hosts(await readProviderRouteHosts(f.services)), [null, null]);
    assert.deepEqual(f.lookups, []);
  }
});

test('provider-name lookalikes, renamed namespaces and nested paths never inherit native endpoint defaults', async () => {
  const directory = [
    ...native().map(entry => ({ ...entry, settingsNs: 'llm-pi-ai', settingsPath: ['providers', entry.provider] })),
    { ...native()[0], settingsNs: 'custom-account' },
    { ...native()[1], settingsPath: ['providers', 'deepseek-official'] },
  ];
  const f = fixture({ directory, endpoint: 'https://api.deepseek.com/anthropic', documents: {
    'llm-pi-ai': { providers: { 'deepseek-account': {}, 'deepseek-official': {} } },
    'custom-account': {}, 'llm-deepseek': { providers: { 'deepseek-official': {} } },
  } });
  assert.deepEqual(hosts(await readProviderRouteHosts(f.services)), [null, null, null, null]);
  assert.deepEqual(f.lookups, []);
});

test('generic lookalikes still follow explicitly advertised endpoints rather than their provider names', async () => {
  const directory = [
    { ...native()[0], settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'deepseek-account'], defaultBaseURL: 'https://relay.example.net/v1' },
    { ...native()[1], settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'deepseek-official'], baseURLEnv: ['MY_ENDPOINT'] },
  ];
  const f = fixture({ directory, documents: { 'llm-pi-ai': { providers: {} } } });
  f.services.credentials.resolve = ref => { assert.equal(ref, 'MY_ENDPOINT'); return { value: 'https://other-relay.example.net/v1?secret=PRIVATE' }; };
  const result = await readProviderRouteHosts(f.services);
  assert.deepEqual(hosts(result), ['relay.example.net', 'other-relay.example.net']);
  assert.deepEqual(f.lookups, []);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('SDK-compatible endpoint-only fallback is lazy and never overrides an authoritative launch snapshot', async () => {
  for (const value of [undefined, '', 'https://relay.example.net/anthropic']) {
    let reads = 0;
    const f = fixture();
    f.services.launchEnvironment = nativeDeepSeekEndpointEnvironment(undefined, () => { reads++; return value; });
    assert.equal(reads, 0);
    assert.throws(() => f.services.launchEnvironment.get('UNRELATED_SECRET'));
    assert.equal(reads, 0);
    assert.deepEqual(hosts(await readProviderRouteHosts(f.services)), value === undefined ? ['api.deepseek.com', 'api.deepseek.com'] : value === '' ? [null, null] : ['relay.example.net', 'relay.example.net']);
    assert.equal(reads, 1);
  }
  for (const endpoint of [undefined, new Error('snapshot failure')]) {
    const f = fixture({ endpoint });
    const snapshot = f.services.launchEnvironment;
    f.services.launchEnvironment = nativeDeepSeekEndpointEnvironment(snapshot, () => { throw Error('must not read process when snapshot exists'); });
    assert.equal(f.services.launchEnvironment, snapshot);
    assert.deepEqual(hosts(await readProviderRouteHosts(f.services)), endpoint === undefined ? ['api.deepseek.com', 'api.deepseek.com'] : [null, null]);
  }
});

test('Host route passes the existing launch snapshot through without reading accounts or exposing endpoints', async () => {
  const f = fixture();
  const routes = new Map();
  const cleanup = [];
  const ctx = { ...f.services,
    get: key => key === 'launchEnvironment' ? f.services.launchEnvironment : undefined,
    provide() {}, effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    tools: { register() { return () => {}; } },
  };
  try {
    apply(ctx);
    const response = await routes.get('/api/provider-quota-route-hosts').fetch(new Request('http://localhost/api/provider-quota-route-hosts'));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(hosts(result), ['api.deepseek.com', 'api.deepseek.com']);
    assert.equal(grouped(result, f.directory)[0].key, 'company:deepseek');
    assert.equal(JSON.stringify(result).includes('/anthropic'), false);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  } finally { for (const dispose of cleanup.reverse()) dispose(); }
});
