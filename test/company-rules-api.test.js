import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';
import { BUNDLED_COMPANY_RULES, COMPANY_RULES_URL } from '../src/company-rules.js';

function fixture({ fetcher = async () => new Response(null, { status: 404 }), storageDomain } = {}) {
  const calls = { fetch: [], credential: 0, config: 0, get: [] };
  const routes = new Map(), tools = new Map(), services = new Map(), disposers = [];
  const ownedFetcher = (url, options) => { calls.fetch.push({ url, options }); return fetcher(url, options); };
  const ctx = {
    llm: { listConfigurableProviders() { throw Error('company rules must not query provider URLs'); }, listProviders() { throw Error('company rules must not list configured providers'); } },
    settings: { describe() { throw Error('company rules must not read profile settings'); } },
    credentials: { resolve() { calls.credential++; throw Error('must not resolve credentials'); }, readRecord() { calls.credential++; throw Error('must not read credential records'); } },
    get(key) { calls.get.push(key); return key === 'storageDomain' ? storageDomain : undefined; },
    provide(name, service) { services.set(name, service); },
    effect(callback) { disposers.push(callback()); },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
    connection: { fetch: { register(route) {
      assert.ok(['buffered', 'streaming'].includes(route.requestBody), 'every exact route declares its transport contract');
      routes.set(route.path, route); return () => {};
    } } },
  };
  // The manager captures the fixed-source fetcher at construction. Restore the
  // global immediately so no test or later background operation uses live I/O.
  const original = globalThis.fetch;
  globalThis.fetch = ownedFetcher;
  try { apply(ctx); } finally { globalThis.fetch = original; }
  const route = routes.get('/api/provider-quota-company-rules');
  return {
    calls, route, tool: tools.get('provider_company_rules'), manager: services.get('providerCompanyRules'),
    get() { return route.fetch(new Request('http://localhost/api/provider-quota-company-rules')); },
    post(body, csrf, contentType = 'application/json') {
      return route.fetch(new Request('http://localhost/api/provider-quota-company-rules', {
        method: 'POST', headers: { 'Content-Type': contentType, ...(csrf ? { 'X-Quota-Settings-CSRF': csrf } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body),
      }));
    },
    async close() { for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose(); },
  };
}

async function using(options, callback) {
  const f = fixture(options);
  try { await callback(f); } finally { await f.close(); }
}

test('rules service and exact GET/POST route are registered with no startup network or storage opens', async () => using({}, async f => {
  assert.ok(f.manager);
  assert.deepEqual(f.route.methods, ['GET', 'POST']);
  assert.equal(f.route.requestBody, 'buffered');
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.get.includes('storageDomain'), false, 'storage is lazy');
  assert.equal(f.calls.credential, 0);
  assert.equal(f.tool.deferLoading, true);
  assert.deepEqual(f.tool.parameters.properties.action.enum, ['read', 'refresh']);
  assert.equal(f.tool.parameters.additionalProperties, false);
}));

test('GET serves bundled rules and CSRF immediately while source404 safely preserves bundled rules', async () => using({}, async f => {
  const response = await f.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const first = await response.json();
  assert.deepEqual(first.rules, BUNDLED_COMPANY_RULES);
  assert.equal(first.source, 'bundled');
  assert.equal(first.persistent, false);
  assert.equal(typeof first.csrf, 'string');
  assert.equal(first.csrf.length, 43);
  const result = await f.manager.refresh();
  assert.equal(result.error, 'not-published');
  const second = await (await f.get()).json();
  assert.equal(second.error, 'not-published');
  assert.deepEqual(second.rules, BUNDLED_COMPANY_RULES);
  assert.equal(second.csrf, first.csrf);
  assert.equal(f.calls.fetch.length, 1, 'read and manual refresh share one request/cooldown');
  assert.equal(f.calls.fetch[0].url, COMPANY_RULES_URL);
  assert.equal(f.calls.credential, 0);
}));

test('API and tool can serve a fresh persistent cache without requesting the source', async () => {
  let opens = 0, closes = 0;
  const timestamp = Date.now();
  let saved = { sourceUrl: COMPANY_RULES_URL, rules: BUNDLED_COMPANY_RULES, lastCheckedAt: timestamp, lastUpdatedAt: timestamp };
  const storageDomain = { async open(spec) {
    opens++;
    saved = spec.tables.cache.valueSchema.parse(saved);
    return { table(name) {
      assert.equal(name, 'cache');
      return { get(key) { assert.equal(key, 'current'); return saved; }, async put(key, value) { assert.equal(key, 'current'); saved = value; } };
    }, async close() { closes++; } };
  } };
  await using({ storageDomain }, async f => {
    const read = await f.tool.execute({ action: 'read' });
    assert.equal(read.source, 'cache');
    assert.equal(read.persistent, true);
    assert.equal(Object.hasOwn(read, 'csrf'), false);
    const browser = await (await f.get()).json();
    assert.equal(browser.source, 'cache');
    assert.equal(browser.persistent, true);
    assert.equal(f.calls.fetch.length, 0);
    assert.equal(opens, 1);
  });
  assert.equal(closes, 1);
});

test('POST refresh and tool use one manager and snapshots but tool results never include CSRF', async () => using({ fetcher: async () => Response.json(BUNDLED_COMPANY_RULES) }, async f => {
  const browser = await (await f.get()).json();
  const response = await f.post({ action: 'refresh' }, browser.csrf);
  assert.equal(response.status, 200);
  const posted = await response.json();
  const read = await f.tool.execute({ action: 'read' });
  assert.equal(Object.hasOwn(read, 'csrf'), false);
  assert.deepEqual({ ...posted, csrf: undefined }, { ...read, csrf: undefined });
  const refreshed = await f.tool.execute({ action: 'refresh' });
  assert.equal(Object.hasOwn(refreshed, 'csrf'), false);
  assert.deepEqual(refreshed.rules, posted.rules);
  assert.equal(f.calls.fetch.length, 1);
  assert.equal(f.calls.credential, 0);
}));

test('POST rejects missing/forged CSRF and non-JSON before any remote update', async () => using({}, async f => {
  for (const [token, type] of [[undefined, 'application/json'], ['forged', 'application/json'], [undefined, 'text/plain']]) {
    const response = await f.post({ action: 'refresh' }, token, type);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'forbidden' });
  }
  assert.equal(f.calls.fetch.length, 0);
  const browser = await (await f.get()).json();
  await f.manager.refresh();
  const before = f.calls.fetch.length;
  const response = await f.post({ action: 'refresh' }, browser.csrf, 'text/plain');
  assert.equal(response.status, 403);
  assert.equal(f.calls.fetch.length, before);
}));

test('POST accepts only the bounded exact refresh action, never domains, URLs, credentials or rule writes', async () => using({}, async f => {
  const browser = await (await f.get()).json();
  await f.manager.refresh();
  const before = f.calls.fetch.length;
  for (const value of [
    {}, { action: 'read' }, { action: 'refresh', domain: 'private.example' },
    { action: 'refresh', url: 'https://private.example/secret' }, { action: 'refresh', credentials: 'private-key' },
    { action: 'refresh', rules: BUNDLED_COMPANY_RULES }, [], null, '{broken', ' '.repeat(16_385),
  ]) {
    const response = await f.post(value, browser.csrf);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid-request' });
  }
  assert.equal(f.calls.fetch.length, before);
  assert.equal(f.calls.credential, 0);
}));

test('tool validates unknown inputs even when invoked without schema validation', async () => using({}, async f => {
  for (const value of [null, [], { action: null }, { action: 'set' }, { action: 'refresh', url: 'https://private.example' }, { domain: 'private.example' }]) {
    assert.deepEqual(await f.tool.execute(value), { error: 'invalid-request' });
  }
  assert.equal(f.calls.fetch.length, 0);
  const result = await f.tool.execute();
  assert.deepEqual(result.rules, BUNDLED_COMPANY_RULES);
  assert.equal(Object.hasOwn(result, 'csrf'), false);
  assert.equal(f.calls.credential, 0);
}));

test('network and malformed source failures return safe snapshot200 without leaking upstream content', async () => {
  for (const fetcher of [
    async () => { throw Error('private-header or token in raw failure'); },
    async () => new Response('{"secret":"private-raw-body"}', { headers: { 'Content-Type': 'application/json' } }),
  ]) await using({ fetcher }, async f => {
    const browser = await (await f.get()).json();
    const response = await f.post({ action: 'refresh' }, browser.csrf);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.deepEqual(snapshot.rules, BUNDLED_COMPANY_RULES);
    assert.equal(typeof snapshot.error, 'string');
    assert.equal(JSON.stringify(snapshot).includes('private-'), false);
    assert.equal(snapshot.source, 'bundled');
  });
});
