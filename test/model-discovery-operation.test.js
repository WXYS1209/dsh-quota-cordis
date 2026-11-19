import test from 'node:test';
import assert from 'node:assert/strict';
import { runModelDiscovery } from '../src/model-discovery-operation.js';
import { apply } from '../index.js';

function fixture(provider = 'openai', { profile, declared = false, oauth = false, stored, record, namespace = 'llm-pi-ai' } = {}) {
  const calls = [];
  const services = {
    llm: {
      listConfigurableProviders: () => [{ provider, declared, settingsNs: namespace, settingsPath: ['providers', provider], nativeAuth: { oauth } }],
      async discoverModels(ns, args, signal) {
        assert.equal(signal?.aborted, signal === undefined ? undefined : false);
        calls.push(['dsh', ns, args]);
        return [{ id: 'new', contextWindow: 1000 }, { id: 'old' }];
      },
    },
    settings: { describe: options => {
      assert.deepEqual(options, { redactSecrets: true });
      return [{ ns: namespace, value: { providers: { [provider]: profile } } }];
    } },
    credentials: {
      async resolve(ref) { calls.push(['resolve', ref]); return stored ? { value: stored } : undefined; },
      async describeRecord(key) { calls.push(['describe', key]); return { configured: !!record, kind: record?.kind }; },
      async readRecord(key) { calls.push(['read', key]); return record; },
    },
  };
  return { calls, services, draft: { settingsNs: namespace, provider } };
}

test('live candidates win, DSH only enriches exact matches on the default route', async () => {
  const { calls, services, draft } = fixture('openai', { stored: 'synthetic' });
  const result = await runModelDiscovery(services, draft, { live: async (target, { apiKey, useHostProxy }) => {
    assert.equal(useHostProxy, true);
    assert.deepEqual(target, { baseURL: 'https://api.openai.com/v1', api: 'openai-responses' });
    assert.equal(apiKey, 'synthetic');
    return [{ id: 'new', name: 'Platform name' }, { id: 'newer', debug: 'never exposed' }];
  } });
  assert.deepEqual(result, { source: 'live', scope: 'credential', models: [{ id: 'new', name: 'Platform name', contextWindow: 1000 }, { id: 'newer' }] });
  assert.deepEqual(calls.at(-1), ['dsh', 'llm-pi-ai', { provider: 'openai' }]);
});

test('empty live list is not a failure, Go uses its own public endpoint', async () => {
  const { calls, services, draft } = fixture('opencode-go');
  assert.deepEqual(await runModelDiscovery(services, draft, { live: async (target, opts) => {
    assert.equal(target.baseURL, 'https://opencode.ai/inference/go/v1');
    assert.equal(opts.apiKey, undefined);
    return [];
  } }), { source: 'live', scope: 'public', models: [] });
  assert.equal(calls.some(([type]) => type === 'dsh'), false);
});

test('failed live request falls back with sanitized reason, no address or key replay', async () => {
  const { calls, services, draft } = fixture('openai');
  const result = await runModelDiscovery(services, { ...draft, apiKey: 'synthetic' }, { live: async () => {
    throw Object.assign(new Error('private raw payload'), { code: 'authentication' });
  } });
  assert.equal(result.source, 'dsh-catalog');
  assert.equal(result.reason, 'authentication');
  assert.deepEqual(calls, [['dsh', 'llm-pi-ai', { provider: 'openai' }]]);
  assert.doesNotMatch(JSON.stringify(result), /payload|synthetic/);
});

test('OAuth-only built-in uses official fallback without touching credentials or network', async () => {
  const { calls, services, draft } = fixture('openai-codex', { oauth: true, record: { kind: 'grant' } });
  const result = await runModelDiscovery(services, draft, { live: async () => assert.fail('no network') });
  assert.equal(result.reason, 'unsupported');
  assert.deepEqual(calls, [['dsh', 'llm-pi-ai', { provider: 'openai-codex' }]]);
});

test('explicit temporary key works for a new unlisted compatible route without credential lookup', async () => {
  const result = await runModelDiscovery({}, { settingsNs: 'llm-pi-ai', baseURL: 'https://gateway.example/v1', api: 'openai-completions', apiKey: 'one-shot' }, { live: async (target, options) => {
    assert.equal(target.baseURL, 'https://gateway.example/v1');
    assert.equal(options.apiKey, 'one-shot');
    assert.equal(options.useHostProxy, false);
    return [{ id: 'platform-only' }];
  } });
  assert.deepEqual(result, { source: 'live', scope: 'credential', models: [{ id: 'platform-only' }] });
});

test('configured custom route uses its exact reference; explicit miss does not borrow an ambient key', async () => {
  const profile = { baseURL: 'https://gateway.example/v1', api: 'openai-completions', apiKeyEnv: 'GATEWAY_KEY' };
  const { calls, services, draft } = fixture('my-gateway', { declared: true, profile, stored: 'bound' });
  const result = await runModelDiscovery(services, draft, { live: async (_, opts) => {
    assert.equal(opts.apiKey, 'bound');
    return [{ id: 'new' }];
  } });
  assert.equal(result.source, 'live');
  assert.deepEqual(calls, [['resolve', 'GATEWAY_KEY']]);
  const missing = fixture('my-gateway', { declared: true, profile });
  assert.deepEqual(await runModelDiscovery(missing.services, missing.draft, { live: async () => assert.fail('no key') }), { error: 'missing-credential' });
  assert.deepEqual(missing.calls, [['resolve', 'GATEWAY_KEY']]);
});

test('a changed address cannot receive saved keys or make the default-route fallback a network proxy', async () => {
  const { calls, services, draft } = fixture('openai', { profile: { apiKeyEnv: 'TEAM_KEY' }, stored: 'bound' });
  const result = await runModelDiscovery(services, { ...draft, baseURL: 'https://other.example/v1' }, { live: async () => assert.fail('no network') });
  assert.equal(result.source, 'dsh-catalog');
  assert.equal(result.reason, 'missing-credential');
  assert.deepEqual(calls, [['dsh', 'llm-pi-ai', { provider: 'openai' }]]);
});

test('cancelled queries never fall back; custom failures do not replay the same request', async () => {
  const { calls, services, draft } = fixture();
  const controller = new AbortController();
  await assert.rejects(runModelDiscovery(services, { ...draft, apiKey: 'synthetic' }, { signal: controller.signal, live: async () => {
    controller.abort();
    throw Object.assign(new Error('network fault'), { code: 'failed' });
  } }), { code: 'cancelled' });
  assert.deepEqual(calls, []);
  const custom = fixture('my-gateway', { declared: true, profile: { baseURL: 'https://gateway.example/v1', api: 'openai-completions' } });
  assert.deepEqual(await runModelDiscovery(custom.services, custom.draft, { live: async () => { throw Object.assign(new Error(), { code: 'timeout' }); } }), { error: 'timeout' });
  assert.deepEqual(custom.calls, []);
});

test('HTTP route enforces Host origin and settings CSRF before accessing credentials', async () => {
  const { calls, services } = fixture('openai-codex', { oauth: true });
  const routes = new Map();
  const ctx = {
    ...services, get() {}, provide() {}, effect(setup) { setup(); },
    connection: { fetch: { register(options) { routes.set(options.path, options); } } },
    tools: { register() {} },
  };
  apply(ctx);
  const settings = await routes.get('/api/provider-quota-settings').fetch(new Request('http://dsh.internal/api/provider-quota-settings'));
  const { csrf } = await settings.json();
  assert.equal(typeof csrf, 'string');
  calls.length = 0;
  const route = routes.get('/api/provider-quota-model-discovery');
  assert.equal(route.requestBody, 'streaming');
  const post = (origin, token) => route.fetch(new Request('http://dsh.internal/api/provider-quota-model-discovery', {
    method: 'POST', headers: { Host: 'localhost:3080', Origin: origin, 'Content-Type': 'application/json', 'X-Quota-Settings-CSRF': token },
    body: JSON.stringify({ settingsNs: 'llm-pi-ai', provider: 'openai-codex' }),
  }));
  assert.equal((await post('http://other.example', csrf)).status, 403);
  assert.equal((await post('http://localhost:3080', 'wrong')).status, 403);
  assert.deepEqual(calls, []);
  const response = await post('http://localhost:3080', csrf);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).source, 'dsh-catalog');
  assert.deepEqual(calls, [['dsh', 'llm-pi-ai', { provider: 'openai-codex' }]]);
});
