import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { apply } from '../index.js';
import { createModelCatalogGrouping, loadModelCatalogGrouping, resolveModelCatalogVersions } from '../src/model-catalog-grouping.js';
import { readProviderRouteHosts, resolveProviderBaseURL } from '../src/route-hosts.js';

const versions = { dshVersion: '0.2.2-rc.5', piAiVersion: '1.3.0' };
const row = { hostname: 'catalog.example.com', modelIds: ['chat-one', 'chat-two'] };
const snapshot = { schemaVersion: 1, ...versions, providers: { 'stock-gateway': row } };
const entry = { declared: false, settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'stock-gateway'], provider: 'stock-gateway' };
const grouping = createModelCatalogGrouping(snapshot, versions);

test('binds catalog grouping to exact certified DSH and pi-ai versions', () => {
  assert.equal(grouping(entry), row.hostname);
  for (const observed of [null, {}, { ...versions, dshVersion: '0.2.2-rc.4' }, { ...versions, piAiVersion: '1.3.1' }]) {
    assert.equal(createModelCatalogGrouping(snapshot, observed)(entry), null);
  }
  for (const invalid of [{ ...row, hostname: 'https://example.com/api' }, { ...row, modelIds: [] }, { ...row, modelIds: ['same', 'same'] }]) {
    assert.equal(createModelCatalogGrouping({ ...snapshot, providers: { 'stock-gateway': invalid } }, versions)(entry), null);
  }
  assert.equal(resolveModelCatalogVersions('relative/install'), null);
  assert.equal(resolveModelCatalogVersions(new URL('.', import.meta.url).pathname), null);
});

test('requires the stock exact route and a compatible modeled profile', () => {
  for (const invalid of [{ ...entry, declared: true }, { ...entry, declared: undefined }, { ...entry, settingsNs: 'other' }, { ...entry, settingsPath: ['wrong', 'stock-gateway'] },
    { ...entry, defaultBaseURL: 'https://other.example.com' }, { ...entry, baseURLEnv: ['ENDPOINT'] }, { ...entry, error: 'invalid' }]) assert.equal(grouping(invalid), null);
  for (const compatible of [undefined, {}, { apiKeyEnv: 'BOUND_KEY', headers: {}, models: [{ id: 'chat-two', name: 'Name' }] }, { modelOverrides: { 'chat-one': { name: 'Name' } } }]) {
    assert.equal(grouping(entry, compatible), row.hostname);
  }
  for (const invalid of [null, [], { baseURL: null }, { baseURL: '' }, { api: 'openai-responses' }, { headers: { Host: 'relay.example.com' } },
    { models: [{ id: 'custom' }] }, { models: [{ id: 'chat-one', baseUrl: 'https://relay.example.com' }] }, { models: [{ id: 'chat-one', api: 'other' }] },
    { models: [{ id: 'chat-one' }, { id: 'chat-one' }] }, { models: [{ id: 'chat-one' }], modelOverrides: { 'chat-one': {} } },
    { modelOverrides: { custom: {} } }, { modelOverrides: { 'chat-one': { id: 'chat-two' } } }, { modelOverrides: { 'chat-one': { baseURL: 'https://relay.example.com' } } }]) assert.equal(grouping(entry, invalid), null);
});

const fixture = (directory, document, credentials) => ({
  llm: { listConfigurableProviders: async () => directory, discoverModels: () => assert.fail('no discovery'), listModels: () => assert.fail('no models query') },
  settings: { describe: async options => {
    assert.deepEqual(options, { redactSecrets: true });
    return [{ ns: 'llm-pi-ai', value: document }];
  } },
  credentials: credentials ?? { resolve: () => assert.fail('no credential lookup') },
  catalogGrouping: grouping,
});

test('projects grouping separately from the request endpoint', async () => {
  const { routes: [value] } = await readProviderRouteHosts(fixture([entry], { providers: {} }));
  assert.deepEqual(value, { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'stock-gateway'], provider: 'stock-gateway', hostname: null,
    groupingHostname: row.hostname, groupingSource: 'model-catalog' });
  assert.equal(await resolveProviderBaseURL(entry, undefined, {}), undefined);
});

const checkHost = async (entry, document, hostname, credentials) => {
  const { routes: [value] } = await readProviderRouteHosts(fixture([entry], document, credentials));
  assert.equal(value.hostname, hostname);
  assert.equal(Object.hasOwn(value, 'groupingHostname'), false);
  assert.equal(Object.hasOwn(value, 'groupingSource'), false);
};

test('effective endpoint wins and invalid or ambiguous resolution never falls back', async () => {
  await checkHost(entry, { providers: { 'stock-gateway': { baseURL: 'https://relay.example.com/openai' } } }, 'relay.example.com');
  for (const baseURL of ['', null, 'invalid', 'https://user@relay.example.com']) {
    await checkHost(entry, { providers: { 'stock-gateway': { baseURL } } }, null);
  }
  await checkHost(entry, { providers: null }, null);
  await checkHost(entry, { providers: { 'stock-gateway': { models: [{ id: 'custom' }] } } }, null);
  await checkHost({ ...entry, baseURLEnv: ['ENDPOINT'] }, {}, null, { resolve: async () => { throw Error('unavailable'); } });
  await checkHost({ ...entry, baseURLEnv: ['ENDPOINT'] }, {}, null, { resolve: async () => undefined });
});

test('managed Electron baseline loads both OpenCode routes when versions can be verified', { skip: !process.versions.electron || !process.env.DSH_INSTALL_DIR?.includes('.asar') }, t => {
  const observed = resolveModelCatalogVersions();
  assert.ok(observed, 'the managed Desktop package layout must resolve both versions');
  if (observed.dshVersion !== versions.dshVersion || observed.piAiVersion !== versions.piAiVersion) return t.skip('installed catalog does not match the shipped test baseline');
  const installed = loadModelCatalogGrouping();
  for (const provider of ['opencode', 'opencode-go']) {
    assert.equal(installed({ ...entry, provider, settingsPath: ['providers', provider] }), 'opencode.ai');
  }
  assert.equal(installed({ ...entry, provider: 'amazon-bedrock', settingsPath: ['providers', 'amazon-bedrock'] }), null);
});

test('Desktop plugin apply serves the grouping from profileContext without a shell overlay', { skip: !process.versions.electron || !process.env.DSH_INSTALL_DIR?.includes('.asar') }, async t => {
  const installation = process.env.DSH_INSTALL_DIR;
  const observed = resolveModelCatalogVersions(installation);
  assert.ok(observed);
  if (observed.dshVersion !== versions.dshVersion || observed.piAiVersion !== versions.piAiVersion) return t.skip('installed catalog does not match the shipped test baseline');
  const ids = ['opencode', 'opencode-go'];
  const register = new Map();
  const provided = new Map();
  const services = fixture(ids.map(provider => ({ ...entry, provider, settingsPath: ['providers', provider] })), { providers: {} });
  delete process.env.DSH_INSTALL_DIR;
  try {
    assert.equal(resolveModelCatalogVersions(), null);
    apply({ ...services,
      get: name => name === 'profileContext' ? { installAnchor: join(installation, 'package.json') } : undefined,
      effect: setup => setup(), provide: (name, value) => provided.set(name, value),
      connection: { fetch: { register: options => register.set(options.path, options) } }, tools: { register() {} },
    });
    const response = await register.get('/api/provider-quota-route-hosts').fetch(new Request('http://dsh.internal/api/provider-quota-route-hosts'));
    assert.equal(response.status, 200);
    assert.equal(provided.get('providerQuota').version, observed.dshVersion);
    assert.deepEqual((await response.json()).routes.map(({ provider, hostname, groupingHostname, groupingSource }) => [provider, hostname, groupingHostname, groupingSource]),
      ids.map(provider => [provider, null, 'opencode.ai', 'model-catalog']));
  } finally {
    process.env.DSH_INSTALL_DIR = installation;
    await provided.get('providerQuota')?.dispose();
  }
});
