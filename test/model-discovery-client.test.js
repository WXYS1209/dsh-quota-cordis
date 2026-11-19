import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pure = source.split('// BEGIN PURE LAYOUT')[1].split('// END PURE LAYOUT')[0];
const requestDiscovery = vm.runInNewContext(`${pure}\nrequestProviderModelDiscovery`, { URL });
const baseURI = 'https://dsh.example.test/custom-prefix/';
const csrf = 'a'.repeat(43);
const plain = value => JSON.parse(JSON.stringify(value));
const json = (value, status = 200) => Response.json(value, { status });

function fixture(reply, { settings = () => json({ csrf }) } = {}) {
  const calls = [];
  const controller = new AbortController();
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1 ? settings() : reply();
  };
  return { calls, controller, run: (request = {}) => requestDiscovery(baseURI, fetcher, 'llm-test', request, controller.signal) };
}

test('settings CSRF and discovery POST share the real abort signal and preserve the GUI base path', async () => {
  const model = { id: 'next-release', name: 'Next release' };
  const harness = fixture(() => json({ source: 'live', scope: 'credential', models: [model] }));
  const result = await harness.run({ provider: 'custom', api: 'openai-responses', baseURL: 'https://models.example.test', apiKey: 'temporary-test-key', endpointChanged: true, headers: { extra: 'not allowed' }, extra: 'not allowed' });
  assert.deepEqual(plain(result), { kind: 'found', source: 'live', scope: 'credential', models: [model], reason: null });
  assert.deepEqual(harness.calls.map(({ url, init }) => [url, init.method]), [
    [baseURI + 'api/provider-quota-settings', 'GET'],
    [baseURI + 'api/provider-quota-model-discovery', 'POST'],
  ]);
  for (const { init } of harness.calls) {
    assert.equal(init.signal, harness.controller.signal);
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
  }
  assert.equal(harness.calls[0].init.body, undefined);
  assert.equal(harness.calls[1].init.headers['X-Quota-Settings-CSRF'], csrf);
  assert.deepEqual(JSON.parse(harness.calls[1].init.body), { settingsNs: 'llm-test', provider: 'custom', api: 'openai-responses', baseURL: 'https://models.example.test', apiKey: 'temporary-test-key', endpointChanged: true });
});

test('empty live results, public scope and successful DSH fallback retain distinct metadata', async () => {
  const live = fixture(() => json({ source: 'live', scope: 'public', models: [] }));
  assert.deepEqual(plain(await live.run()), { kind: 'found', source: 'live', scope: 'public', reason: null, models: [] });
  assert.deepEqual(JSON.parse(live.calls[1].init.body), { settingsNs: 'llm-test' });
  for (const source of ['dsh-catalog', 'dsh-discovery']) {
    const fallback = fixture(() => json({ source, reason: 'timeout', models: [{ id: 'built-in' }] }));
    assert.deepEqual(plain(await fallback.run()), { kind: 'found', source, scope: null, reason: 'timeout', models: [{ id: 'built-in' }] });
  }
});

test('platform connection and HTTP errors stay distinct in fallback and terminal results', async () => {
  const cases = [
    ['network', 'providerManagerDiscoveryFallbackNetwork', '连接平台失败，请检查网络连接。', 'Could not reach the platform. Check your network connection.'],
    ['platform-error', 'providerManagerDiscoveryFallbackPlatformError', '平台返回错误，未能获取模型列表。', 'The platform returned an error instead of a model list.'],
  ];
  const localizedReasons = vm.runInNewContext(`${pure}\nPROVIDER_DISCOVERY_FALLBACK`);
  for (const [reason, label, zh, en] of cases) {
    const fallback = fixture(() => json({ source: 'dsh-catalog', reason, models: [{ id: 'built-in' }] }));
    assert.deepEqual(plain(await fallback.run()), { kind: 'found', source: 'dsh-catalog', scope: null, reason, models: [{ id: 'built-in' }] });
    const refused = fixture(() => json({ error: reason, internal: 'private-upstream-content' }, 502));
    assert.deepEqual(plain(await refused.run()), { kind: 'refused', reason });
    assert.equal(refused.calls.length, 2);
    assert.equal(localizedReasons[reason], label);
    assert.ok(source.includes(`${label}: '${zh}'`));
    assert.ok(source.includes(`${label}: '${en}'`));
  }
});

test('HTTP failure, unsafe output, and transport errors do not retry or bypass Host discovery', async () => {
  for (const [reply, expected] of [
    [() => json({ error: 'forbidden' }, 403), { kind: 'refused', reason: 'forbidden' }],
    [() => json({ error: 'private-upstream-content' }, 500), { kind: 'refused' }],
    [() => json({ source: '__proto__', models: [] }), { kind: 'refused' }],
    [() => json({ source: 'live', models: null }), { kind: 'refused' }],
    [() => json({ source: 'live', models: [] }, 500), { kind: 'refused' }],
    [() => { throw new Error('private-upstream-content'); }, { kind: 'refused' }],
  ]) {
    const harness = fixture(reply);
    assert.deepEqual(plain(await harness.run()), expected);
    assert.equal(harness.calls.length, 2);
  }
  assert.ok(source.includes("discoverModels: (namespace, request, signal) => requestProviderModelDiscovery(document.baseURI, fetch, namespace, request, signal)"));
  assert.equal(source.includes('remoteLlm.discoverModels('), false);
});

test('a malformed CSRF token or cancellation before POST prevents the request with a key', async () => {
  const malformed = fixture(() => assert.fail('unexpected POST'), { settings: () => json({ csrf: ['a'.repeat(43)] }) });
  assert.equal((await malformed.run({ apiKey: 'temporary-test-key' })).kind, 'refused');
  assert.equal(malformed.calls.length, 1);
  let resolveSettings;
  const cancelled = fixture(() => assert.fail('unexpected POST'), { settings: () => new Promise(resolve => { resolveSettings = resolve; }) });
  const pending = cancelled.run({ apiKey: 'temporary-test-key' });
  cancelled.controller.abort();
  resolveSettings(json({ csrf }));
  assert.equal((await pending).kind, 'refused');
  assert.equal(cancelled.calls.length, 1);
});

test('a late parsed success after cancellation is ignored; modal invalidates on route and draft changes', async () => {
  let posted;
  const post = new Promise(resolve => { posted = resolve; });
  const harness = fixture(() => new Promise(resolve => { posted(resolve); }));
  const pending = harness.run();
  const reply = await post;
  harness.controller.abort();
  reply(json({ source: 'live', models: [{ id: 'late' }] }));
  assert.equal((await pending).kind, 'refused');
  assert.match(source, /useLayoutEffect\(\(\) => \{\s+if \(discoveryOpen\) closeDiscovery\(\);\s+\}, \[namespaceId, routeId, baseURL, protocol, keyDraft, currentRevision, profileDisabled\]\)/);
  assert.ok(source.includes("discoveryCompleted?.source === 'live' ? t('providerManagerDiscoveryEmptyLive')"));
});

test('the Fetch button describes temporary-key destination before the dialog is opened', () => {
  assert.ok(source.includes("ref: fetchModelsButtonRef, 'aria-describedby': `${discoveryTitleId}-help`"));
  const help = source.indexOf("h('p', { id: `${discoveryTitleId}-help`, className: 'pq-manager-note' }, t('providerManagerUiDiscoveryHelp'))");
  assert.ok(help > 0 && help < source.indexOf('discoveryOpen ? h(ProviderDiscoveryDialog'));
  assert.ok(source.includes('A temporary key is sent to the API address you enter'));
  assert.ok(source.includes('临时 Key 会发送到所填 API 地址'));
});
