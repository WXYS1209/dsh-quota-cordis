import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import test from 'node:test';
import { discoverPlatformModels, modelDiscoveryTarget } from '../src/model-discovery.js';

const openai = { baseURL: 'https://models.example.com/team/v1/', api: 'openai-responses' };
const anthropic = { baseURL: 'https://models.example.com/team/v1/', api: 'anthropic-messages' };
const gemini = { baseURL: 'https://models.example.com/team/v1beta/', api: 'google-generative-ai' };
const reason = code => error => error.code === code && !error.cause && !error.message.includes('private-upstream-detail');

test('builds canonical listing paths and keeps the gateway prefix', () => {
  assert.equal(modelDiscoveryTarget(openai).href, 'https://models.example.com/team/v1/models');
  assert.equal(modelDiscoveryTarget(anthropic).href, 'https://models.example.com/team/v1/models?limit=1000');
  assert.equal(modelDiscoveryTarget({ ...anthropic, baseURL: 'https://models.example.com/team:443' }).href, 'https://models.example.com/team:443/v1/models?limit=1000');
  assert.equal(modelDiscoveryTarget(gemini).href, 'https://models.example.com/team/v1beta/models?pageSize=1000');
  assert.equal(modelDiscoveryTarget({ ...openai, baseURL: 'https://opencode.ai/inference/go/v1' }).href, 'https://opencode.ai/inference/go/v1/models');
});

test('refuses unsafe or ambiguous endpoints and protocols before dispatch', async () => {
  let calls = 0;
  const fetcher = () => { calls++; throw new Error('private-upstream-detail'); };
  for (const baseURL of [
    'http://models.example.com/v1', 'https://127.0.0.1/v1', 'https://0x7f000001/v1', 'https://2130706433/v1',
    'https://[::1]/v1', 'https://user@models.example.com/v1', 'https://models.example.com:444/v1',
    'https://local', 'https://a.localhost/v1', 'https://a.home.arpa/v1', 'https://a.internal/v1',
    'https://models.example.com./v1', 'https://models.example.com/v1?x=1', 'https://models.example.com/v1#x',
    'https://models.example.com/v1?', 'https://models.example.com/v1#', 'https://models.example.com/v1/../account',
    'https://models.example.com/v1/%2e%2e/account', 'https://models.example.com/v1%5caccount',
  ]) {
    assert.throws(() => modelDiscoveryTarget({ ...openai, baseURL }), reason('unsafe-endpoint'), baseURL);
    await assert.rejects(discoverPlatformModels({ ...openai, baseURL }, { fetcher }), reason('unsafe-endpoint'));
  }
  await assert.rejects(discoverPlatformModels({ ...openai, api: 'openai-codex-responses' }, { fetcher }), reason('unsupported'));
  assert.equal(calls, 0);
});

test('OpenAI shape normalizes new identities, capacities and modalities without guessing', async () => {
  const actual = await discoverPlatformModels(openai, { apiKey: 'fixture-key', fetcher(url, init) {
    assert.equal(url.href, 'https://models.example.com/team/v1/models');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.Authorization, 'Bearer fixture-key');
    assert.equal(init.headers['x-goog-api-key'], undefined);
    return Response.json({ data: [
      { id: 'brand-new', name: ' New Model ', limit: { context: 1000, output: 28 }, modalities: { input: ['text', 'image/png', 'image', 'video'] } },
      { id: 'brand-new', context_window: 999 }, null, { id: 'bare', max_tokens: -5 }, { id: 'bad\u0000id' },
    ] });
  } });
  assert.deepEqual(actual, [{ id: 'brand-new', name: 'New Model', contextWindow: 1000, maxTokens: 28, inputModalities: ['text', 'image'] }, { id: 'bare' }]);
});

test('honors gateway aliases, data-array precedence, and empty success', async () => {
  assert.deepEqual(await discoverPlatformModels(openai, { fetcher: () => Response.json({ models: { routeAlias: { id: 'canonical' }, invalid: 3 } }) }), [{ id: 'routeAlias' }]);
  assert.deepEqual(await discoverPlatformModels(openai, { fetcher: () => Response.json({ data: [], models: { unused: { id: 'unused' } } }) }), []);
  for (const body of [{ error: 'private-upstream-detail' }, { data: [null, {}] }]) {
    await assert.rejects(discoverPlatformModels(openai, { fetcher: () => Response.json(body) }), reason('failed'));
  }
});

test('Anthropic paginates on exactly the same route and uses native headers', async () => {
  const targets = [];
  const result = await discoverPlatformModels(anthropic, { apiKey: 'fixture', fetcher(url, { headers }) {
    targets.push(url.href);
    assert.equal(headers['x-api-key'], 'fixture');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers.Authorization, undefined);
    return targets.length === 1
      ? Response.json({ data: [{ id: 'first', display_name: 'First' }], has_more: true, last_id: 'a?evil=1' })
      : Response.json({ data: [{ id: 'second' }], has_more: false });
  } });
  assert.deepEqual(targets, ['https://models.example.com/team/v1/models?limit=1000', 'https://models.example.com/team/v1/models?limit=1000&after_id=a%3Fevil%3D1']);
  assert.deepEqual(result.map(row => row.id), ['first', 'second']);
});

test('Gemini paginates, excludes embedding-only models and never puts its key in URL', async () => {
  const targets = [];
  const result = await discoverPlatformModels(gemini, { apiKey: 'fixture', fetcher(url, { headers }) {
    targets.push(url.href);
    assert.equal(headers['x-goog-api-key'], 'fixture');
    assert.equal(headers.Authorization, undefined);
    return targets.length === 1 ? Response.json({ models: [
      { name: 'models/text-embed', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/pro', displayName: 'Pro', inputTokenLimit: 1000, outputTokenLimit: 500, supportedGenerationMethods: ['generateContent'] },
    ], nextPageToken: 'a/b?' }) : Response.json({ models: [{ name: 'models/flash' }] });
  } });
  assert.deepEqual(targets, ['https://models.example.com/team/v1beta/models?pageSize=1000', 'https://models.example.com/team/v1beta/models?pageSize=1000&pageToken=a%2Fb%3F']);
  assert.deepEqual(result, [{ id: 'pro', name: 'Pro', contextWindow: 1000, maxTokens: 500 }, { id: 'flash' }]);
});

test('pagination refuses cursor loops, missing cursors and unbounded paging', async () => {
  let calls = 0;
  const repeated = () => { calls++; return Response.json({ data: [{ id: 'first' }], has_more: true, last_id: 'same' }); };
  await assert.rejects(discoverPlatformModels(anthropic, { fetcher: repeated }), reason('failed'));
  assert.equal(calls, 2);
  await assert.rejects(discoverPlatformModels(anthropic, { fetcher: () => Response.json({ data: [], has_more: true }) }), reason('failed'));
  calls = 0;
  await assert.rejects(discoverPlatformModels(gemini, { fetcher: () => Response.json({ models: [], nextPageToken: `${++calls}` }) }), reason('failed'));
  assert.equal(calls, 10);
});

test('sanitizes authentication, redirect, network and JSON failures', async () => {
  for (const status of [401, 403, 302, 404, 429, 500]) {
    let calls = 0;
    await assert.rejects(discoverPlatformModels(openai, { fetcher() {
      calls++;
      return new Response('private-upstream-detail', { status, headers: { location: 'https://private-upstream-detail.example.com' } });
    } }), reason(status === 401 || status === 403 ? 'authentication' : status === 302 ? 'failed' : 'platform-error'));
    assert.equal(calls, 1);
  }
  await assert.rejects(discoverPlatformModels(openai, { fetcher() { throw new Error('private-upstream-detail'); } }), reason('network'));
  await assert.rejects(discoverPlatformModels(openai, { fetcher: () => new Response('private-upstream-detail') }), reason('failed'));
  await assert.rejects(discoverPlatformModels(openai, { apiKey: 'bad\nheader', fetcher() { assert.fail('invalid key sent'); } }), reason('authentication'));
});

test('fixed platform transport uses the Host global fetch without overriding its dispatcher', async t => {
  const supplied = { ...openai, baseURL: 'https://api.openai.com/v1' };
  const lookup = t.mock.method(dns, 'lookup', () => assert.fail('Host owns DNS and proxy routing'));
  const request = t.mock.method(https, 'request', () => assert.fail('No direct HTTPS bypass'));
  const fetch = t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url.href, 'https://api.openai.com/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer fixture');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(Object.hasOwn(options, 'dispatcher'), false);
    return Response.json({ data: [{ id: 'fixture-model' }] });
  });
  assert.deepEqual(await discoverPlatformModels(supplied, { apiKey: 'fixture', useHostProxy: true }), [{ id: 'fixture-model' }]);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(request.mock.callCount(), 0);
});

test('does not expose a key echoed in nominal model metadata', async () => {
  const apiKey = 'fixture-do-not-return';
  await assert.rejects(discoverPlatformModels(openai, {
    apiKey, fetcher: () => Response.json({ data: [{ id: 'claimed-model', name: `Echo: ${apiKey}` }] }),
  }), error => error.code === 'failed' && !error.message.includes(apiKey));
});

test('global deadline also stops a transport ignoring AbortSignal', async t => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 8000); return deadline.signal; });
  const pending = discoverPlatformModels(openai, { fetcher() {
    queueMicrotask(() => deadline.abort(new Error('private-upstream-detail')));
    return new Promise(() => {});
  } });
  await assert.rejects(pending, reason('timeout'));
});

test('limits declared length and actual stream bytes', async () => {
  let cancelCount = 0;
  const body = () => new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
    cancel() { cancelCount++; },
  });
  for (const headers of [{ 'Content-Length': '5000000' }, { 'Content-Length': '1' }]) {
    await assert.rejects(discoverPlatformModels(openai, { fetcher: () => new Response(body(), { headers }) }), reason('failed'));
  }
  assert.equal(cancelCount, 2);
});

test('supports cancellation before dispatch and during response read', async () => {
  const pre = AbortSignal.abort(new Error('private-upstream-detail'));
  await assert.rejects(discoverPlatformModels(openai, { signal: pre, fetcher() { assert.fail('aborted request dispatched'); } }), reason('cancelled'));
  const controller = new AbortController();
  let cancelled = false;
  const pending = discoverPlatformModels(openai, { signal: controller.signal, fetcher() {
    return new Response(new ReadableStream({
      pull() { queueMicrotask(() => controller.abort(new Error('private-upstream-detail'))); return new Promise(() => {}); },
      cancel() { cancelled = true; },
    }));
  } });
  await assert.rejects(pending, reason('cancelled'));
  assert.ok(cancelled);
});

test('production path rejects DNS responses with any special-use address', async t => {
  t.mock.method(dns, 'lookup', async host => {
    assert.equal(host, 'models.example.com.');
    return answers;
  });
  t.mock.method(https, 'request', () => assert.fail('must not connect'));
  let answers;
  for (const row of [
    { address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }, { address: '100.64.2.1', family: 4 },
    { address: '::ffff:127.0.0.1', family: 6 }, { address: 'fe80::1', family: 6 }, { address: 'fc00::2', family: 6 },
    { address: '2001:db8::2', family: 6 }, { address: '2002:7f00:1::', family: 6 }, { address: '240.1.2.3', family: 4 },
  ]) {
    answers = [{ address: '8.8.8.8', family: 4 }, row];
    await assert.rejects(discoverPlatformModels(openai, { apiKey: 'fixture' }), reason('unsafe-endpoint'));
  }
  answers = [];
  await assert.rejects(discoverPlatformModels(openai), reason('unsafe-endpoint'));
  assert.equal(https.request.mock.callCount(), 0);
});

test('production path pins validated DNS answers to a fresh HTTPS request', async t => {
  const addresses = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  t.mock.method(dns, 'lookup', async () => addresses);
  t.mock.method(https, 'request', (url, options, callback) => {
    assert.equal(url.hostname, 'models.example.com');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    assert.equal(options.headers.Authorization, 'Bearer fixture');
    assert.equal(options.method, 'GET');
    options.lookup(url.hostname, { all: true }, (error, rows) => { assert.ifError(error); assert.deepEqual(rows, addresses); });
    options.lookup(url.hostname, { family: 6 }, (error, address, family) => { assert.ifError(error); assert.equal(address, addresses[1].address); assert.equal(family, 6); });
    options.lookup('different.example.com', {}, error => assert.equal(error.code, 'unsafe-endpoint'));
    const request = new EventEmitter();
    request.end = () => {
      const response = Readable.from([Buffer.from('{"data":[{"id":"mock-live"}]}')]);
      response.statusCode = 200;
      response.headers = {};
      callback(response);
    };
    return request;
  });
  assert.deepEqual(await discoverPlatformModels(openai, { apiKey: 'fixture' }), [{ id: 'mock-live' }]);
  assert.equal(dns.lookup.mock.callCount(), 1);
  assert.equal(https.request.mock.callCount(), 1);
});
