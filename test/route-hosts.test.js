import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerRouteHostname, readProviderRouteHosts, resolveProviderBaseURL } from '../src/route-hosts.js';
import { apply } from '../index.js';

const entry = (provider, extra = {}) => ({ provider, settingsNs: 'pi', settingsPath: ['providers', provider], defaultBaseURL: 'https://api.openai.com/v1', ...extra });
function fixture(directory, values = { pi: { providers: {} } }, refs = {}) {
  const calls = [];
  const services = {
    llm: { listConfigurableProviders: () => directory, listProviders() { throw Error('registered routes not needed'); } },
    settings: { describe(options) { assert.deepEqual(options, { redactSecrets: true }); return Object.entries(values).map(([ns, value]) => ({ ns, value })); } },
    credentials: { resolve(ref) { calls.push(ref); if (refs[ref] instanceof Error) throw refs[ref]; return refs[ref] === undefined ? undefined : { value: refs[ref] }; },
      readRecord() { throw Error('must never read records'); }, describe() { throw Error('must never describe API keys'); } },
  };
  return { services, calls };
}

test('generic URL resolver preserves configured, advertised endpoint-env and catalog precedence', async () => {
  const f = fixture([], {}, { FIRST_URL: 'https://env.example/v1', SECOND_URL: 'https://other.example/v1', DEEPSEEK_BASE_URL: 'https://deepseek-relay.example/v1' });
  const env = entry('custom', { baseURLEnv: ['FIRST_URL', 'SECOND_URL'] });
  assert.equal(await resolveProviderBaseURL(env, { baseURL: 'https://profile.example/v1' }, f.services.credentials), 'https://profile.example/v1');
  assert.deepEqual(f.calls, []);
  await assert.rejects(resolveProviderBaseURL(env, { baseURL: '   ' }, f.services.credentials));
  assert.deepEqual(f.calls, []);
  assert.equal(await resolveProviderBaseURL(env, {}, f.services.credentials), 'https://env.example/v1');
  assert.deepEqual(f.calls, ['FIRST_URL']);
  assert.equal(await resolveProviderBaseURL(entry('deepseek-official', { baseURLEnv: ['DEEPSEEK_BASE_URL'] }), {}, f.services.credentials), 'https://deepseek-relay.example/v1');
  assert.equal(await resolveProviderBaseURL(entry('ordinary'), {}, f.services.credentials), 'https://api.openai.com/v1');
  assert.deepEqual(f.calls, ['FIRST_URL', 'DEEPSEEK_BASE_URL']);
});

test('resolver failures and malformed overrides do not fall back to an official URL', async () => {
  const f = fixture([], {}, { BROKEN_URL: Error('private credential exception'), INVALID_URL: 'not a URL' });
  await assert.rejects(resolveProviderBaseURL(entry('custom', { baseURLEnv: ['BROKEN_URL'] }), {}, f.services.credentials));
  assert.equal(await resolveProviderBaseURL(entry('custom', { baseURLEnv: ['INVALID_URL'] }), {}, f.services.credentials), 'not a URL');
  assert.equal(await resolveProviderBaseURL(entry('custom'), { baseURL: 'invalid configured URL' }, f.services.credentials), 'invalid configured URL');
});

test('hostname projection strips port, path, query and fragment; rejects userinfo and invalid URLs', () => {
  assert.equal(providerRouteHostname('https://API.Example.com.:8443/private/path?key=secret#fragment'), 'api.example.com');
  for (const value of [undefined, null, '', 'not a URL', 'https://user:pass@example.com/v1', 'https://user@example.com', 'https://@example.com', 'ftp://example.com', ' https://example.com', 'https://example.com\n', 'https://example.com/has space']) assert.equal(providerRouteHostname(value), null);
});

test('metadata retains every directory row identity including dormant routes and whole-section paths', async () => {
  const directory = [
    entry('same-id'),
    entry('same-id', { settingsNs: 'other', settingsPath: ['alternate'], defaultBaseURL: 'https://second.example/path' }),
    entry('whole', { settingsNs: 'whole', settingsPath: [], defaultBaseURL: 'https://whole-default.example' }),
    entry('no-namespace', { settingsNs: 'missing' }),
  ];
  const f = fixture(directory, { pi: { providers: {} }, other: {}, whole: { baseURL: 'https://whole.example/private?secret=1' } });
  const result = await readProviderRouteHosts(f.services);
  assert.deepEqual(result, { routes: [
    { provider: 'same-id', settingsNs: 'pi', settingsPath: ['providers', 'same-id'], hostname: 'api.openai.com' },
    { provider: 'same-id', settingsNs: 'other', settingsPath: ['alternate'], hostname: 'second.example' },
    { provider: 'whole', settingsNs: 'whole', settingsPath: [], hostname: 'whole.example' },
    { provider: 'no-namespace', settingsNs: 'missing', settingsPath: ['providers', 'no-namespace'], hostname: null },
  ] });
  assert.deepEqual(f.calls, []);
});

test('metadata resolves only advertised endpoint references; never auth references', async () => {
  const f = fixture([
    entry('env', { baseURLEnv: ['ENDPOINT_URL'], nativeAuth: { env: ['SECRET_API_KEY'] } }),
    entry('deepseek-official', { settingsPath: [], baseURLEnv: ['DEEPSEEK_BASE_URL'] }),
    entry('configured', { baseURLEnv: ['UNNEEDED_URL'] }),
  ], { pi: { providers: { env: { apiKeyEnv: 'CUSTOM_API_KEY' }, configured: { baseURL: 'https://configured.example/v1', apiKeyEnv: 'IGNORED_KEY' } } } }, {
    ENDPOINT_URL: 'https://env.example/secret-path?token=secret-query', DEEPSEEK_BASE_URL: 'https://native.example/v1',
  });
  const result = await readProviderRouteHosts(f.services);
  assert.deepEqual(result.routes.map(row => row.hostname), ['env.example', 'native.example', 'configured.example']);
  assert.deepEqual(f.calls, ['ENDPOINT_URL', 'DEEPSEEK_BASE_URL']);
  const serialized = JSON.stringify(result);
  for (const secret of ['https:', 'secret-path', 'secret-query', 'ENDPOINT_URL', 'CUSTOM_API_KEY', 'SECRET_API_KEY', 'apiKeyEnv']) assert.equal(serialized.includes(secret), false);
});

test('partial reference failures and invalid URLs yield null only for affected rows, with per-request read deduplication', async () => {
  const f = fixture([
    entry('broken-a', { baseURLEnv: ['BROKEN_URL'] }), entry('broken-b', { baseURLEnv: ['BROKEN_URL'] }),
    entry('valid-a', { baseURLEnv: ['VALID_URL'] }), entry('valid-b', { baseURLEnv: ['VALID_URL'] }),
    entry('userinfo'), entry('invalid'),
  ], { pi: { providers: { userinfo: { baseURL: 'https://user:password@api.openai.com/v1' }, invalid: { baseURL: 'not a URL' } } } }, {
    BROKEN_URL: Error('secret failure details'), VALID_URL: 'https://valid.example/v1',
  });
  const result = await readProviderRouteHosts(f.services);
  assert.deepEqual(result.routes.map(row => row.hostname), [null, null, 'valid.example', 'valid.example', null, null]);
  assert.deepEqual(f.calls, ['BROKEN_URL', 'VALID_URL']);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('reference count and route count are bounded without reading arbitrary auth or records', async () => {
  const f = fixture(Array.from({ length: 257 }, (_, index) => entry(`route-${index}`, { baseURLEnv: [`BASE_URL_${index}`] })));
  const result = await readProviderRouteHosts(f.services);
  assert.equal(f.calls.length, 256);
  assert.equal(result.routes[256].hostname, null);
  const tooMany = fixture(Array.from({ length: 2001 }, (_, index) => entry(`route-${index}`)));
  await assert.rejects(readProviderRouteHosts(tooMany.services), { code: 'route-hosts-unavailable' });
  const invalid = fixture([entry('invalid', { baseURLEnv: ['NOT A REFERENCE'] })]);
  assert.equal((await readProviderRouteHosts(invalid.services)).routes[0].hostname, null);
  assert.deepEqual(invalid.calls, []);
});

test('empty directory avoids unrelated settings and credential reads', async () => {
  const f = fixture([]);
  f.services.settings.describe = () => { throw Error('unnecessary settings read'); };
  assert.deepEqual(await readProviderRouteHosts(f.services), { routes: [] });
  assert.deepEqual(f.calls, []);
});

test('reference timeout is row-local and a gross timeout/cancellation is sanitized', async () => {
  const f = fixture([entry('pending', { baseURLEnv: ['PENDING_URL'] }), entry('ordinary')]);
  f.services.credentials.resolve = () => new Promise(() => {});
  const result = await readProviderRouteHosts(f.services, { resolveTimeoutMs: 5 });
  assert.deepEqual(result.routes.map(row => row.hostname), [null, 'api.openai.com']);
  const g = fixture([entry('ordinary')]);
  g.services.settings.describe = () => new Promise(() => {});
  await assert.rejects(readProviderRouteHosts(g.services, { timeoutMs: 5 }), { code: 'route-hosts-unavailable' });
  const h = fixture([]);
  h.services.llm.listConfigurableProviders = () => { throw Error('must not call after pre-abort'); };
  const controller = new AbortController(); controller.abort('private abort reason');
  await assert.rejects(readProviderRouteHosts(h.services, { signal: controller.signal }), { code: 'route-hosts-unavailable' });
});

function hostFixture(services) {
  const routes = new Map(); const cleanup = [];
  const ctx = { ...services, get: () => undefined, provide: () => {},
    connection: { fetch: { register: route => {
      // ConnectionFetchRoute requires an explicit body mode, even for GET.
      // Without it rc.3's HTTP bridge builds a GET Request with a body and throws
      // before dispatch; a direct route.fetch fixture alone would miss this.
      assert.ok(['buffered', 'streaming'].includes(route.requestBody), `${route.path} must declare requestBody`);
      routes.set(route.path, route); return () => {};
    } } },
    tools: { register: () => () => {} }, effect: effect => cleanup.push(effect()),
  };
  apply(ctx);
  return { route: routes.get('/api/provider-quota-route-hosts'), async close() { for (const fn of cleanup.reverse()) if (typeof fn === 'function') await fn(); } };
}

test('GET metadata endpoint returns only sanitized identities and hosts without any quota network', async () => {
  const f = fixture([entry('ordinary')]);
  const h = hostFixture(f.services);
  try {
    assert.deepEqual(h.route.methods, ['GET']);
    assert.equal(h.route.requestBody, 'buffered');
    const response = await h.route.fetch(new Request('http://localhost/api/provider-quota-route-hosts'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await response.json(), { routes: [{ provider: 'ordinary', settingsNs: 'pi', settingsPath: ['providers', 'ordinary'], hostname: 'api.openai.com' }] });
    assert.deepEqual(f.calls, []);
  } finally { await h.close(); }
});

test('GET metadata body mode matches the installed HTTP bridge Request-construction contract', async () => {
  const f = fixture([entry('ordinary')]);
  const h = hostFixture(f.services);
  // Only the Request construction branch from the installed rc.3 bridge:
  // any mode other than 'buffered' supplies a streaming body, invalid for GET.
  const bridgeRequest = mode => new Request('http://localhost/api/provider-quota-route-hosts', {
    method: 'GET',
    ...(mode === 'buffered' ? {} : { body: new ReadableStream({ start(controller) { controller.close(); } }), duplex: 'half' }),
  });
  try {
    assert.throws(() => bridgeRequest(undefined), TypeError);
    const request = bridgeRequest(h.route.requestBody);
    assert.equal(request.body, null);
    const response = await h.route.fetch(request);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).routes[0].hostname, 'api.openai.com');
  } finally { await h.close(); }
});

test('GET metadata endpoint returns fixed safe503 on directory/settings failure or malformed shape', async () => {
  for (const stage of ['directory', 'settings', 'shape']) {
    const f = fixture([entry('ordinary')]);
    if (stage === 'directory') f.services.llm.listConfigurableProviders = () => { throw Error('secret internal directory path'); };
    if (stage === 'settings') f.services.settings.describe = () => { throw Error('secret internal settings path'); };
    if (stage === 'shape') f.services.llm.listConfigurableProviders = () => [entry('ordinary', { settingsPath: [42] })];
    const h = hostFixture(f.services);
    try {
      const response = await h.route.fetch(new Request('http://localhost/api/provider-quota-route-hosts'));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'route-hosts-unavailable' });
      assert.deepEqual(f.calls, []);
    } finally { await h.close(); }
  }
});
