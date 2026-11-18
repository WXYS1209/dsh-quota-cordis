import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const guards = vm.runInNewContext(clientSource.slice(clientSource.indexOf('function safeCodexOfficialLink('), clientSource.indexOf('function CodexAuthorizationPanel(')) + ';({safeCodexOfficialLink,validCodexCallback,validCodexSnapshot})', { URL });

const PATH = '/api/provider-quota-codex-oauth';
const ACTION_PATH = PATH + '/action';
const ORIGIN = 'http://127.0.0.1:57620';
function fixture() {
  const routes = new Map(), disposers = [], provided = new Map();
  const state = { configured: false, profile: {}, revision: 1, auth: null, failure: null };
  const native = {
    calls: [], inFlight: false,
    describe(key) {
      assert.equal(this, native); assert.equal(key, 'llm-pi-ai/openai-codex');
      return { key, methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: this.inFlight };
    },
    begin(request) {
      assert.equal(this, native); assert.equal(request.key, 'llm-pi-ai/openai-codex'); assert.equal(request.method, 'oauth');
      this.calls.push(request); this.inFlight = true;
      return new Promise(resolve => {
        const finish = status => { this.inFlight = false; request.signal.removeEventListener('abort', abort); resolve({ status }); };
        const abort = () => finish('cancelled');
        request.signal.addEventListener('abort', abort, { once: true });
        this.finish = finish;
      });
    },
    cancel() { throw Error('A global cancel must never be used'); },
  };
  state.auth = native;
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'openai-codex' }],
      listConfigurableProviders: () => [{ provider: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'], defaultBaseURL: 'https://chatgpt.com/backend-api', baseURLEnv: [], nativeAuth: { oauth: true } }],
    },
    settings: { describe(options) {
      assert.equal(options.redactSecrets, true);
      if (state.failure) throw Error(state.failure);
      return [{ ns: 'llm-pi-ai', revision: state.revision, value: { providers: { 'openai-codex': state.profile } } }];
    } },
    credentials: {
      describeRecord: () => ({ configured: state.configured, kind: state.configured ? 'grant' : undefined }),
      readRecord() { throw Error('No raw credentials in OAuth controller'); },
      resolve() { throw Error('No key resolution in OAuth controller'); },
      writeRecord() { throw Error('Native SDK is the only grant writer'); },
    },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register() { return () => {}; } },
    effect(effect) { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose); },
    provide(key, value) { provided.set(key, value); },
    get(key) { return key === 'authorization' ? state.auth : undefined; },
  };
  apply(ctx);
  async function send({ method = 'GET', body, headers = {}, signal } = {}) {
    const path = method === 'POST' ? ACTION_PATH : PATH;
    return routes.get(path).fetch(new Request(`http://dsh.internal${path}`, {
      method, headers: { Host: '127.0.0.1:57620', Origin: ORIGIN, ...headers }, signal,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }));
  }
  async function post(payload, extra = {}) {
    const data = await (await send()).json();
    return send({ method: 'POST', body: payload, headers: { 'Content-Type': 'application/json', 'X-Quota-Codex-CSRF': data.csrf, ...extra } });
  }
  return { state, native, ctx, routes, provided, send, post, async dispose() { await Promise.all(disposers.reverse().map(fn => fn())); } };
}

test('the bundle owns a namespaced authorization route, not the external plugin endpoint', async () => {
  const f = fixture();
  try {
    assert.ok(f.routes.has(PATH)); assert.equal(f.routes.has('/api/local-codex-oauth'), false);
    assert.deepEqual(f.routes.get(PATH).methods, ['GET']);
    assert.equal(f.routes.get(PATH).requestBody, 'buffered');
    assert.deepEqual(f.routes.get(ACTION_PATH).methods, ['POST']);
    assert.equal(f.routes.get(ACTION_PATH).requestBody, 'streaming');
    const response = await f.send();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const data = await response.json();
    assert.equal(data.flowAvailable, true); assert.equal(data.routeConfigured, true);
    assert.equal(data.active, false); assert.equal(data.attempt, null); assert.match(data.csrf, /^[\w-]{43}$/);
    assert.equal(f.native.calls.length, 0, 'status must never start authentication');
  } finally { await f.dispose(); }
});

test('writes require this controller CSRF token, JSON content type and exact same authority', async () => {
  const f = fixture();
  try {
    for (const headers of [{ 'Content-Type': 'application/json' }, { 'Content-Type': 'text/plain', 'X-Quota-Codex-CSRF': 'x'.repeat(43) }]) {
      assert.equal((await f.send({ method: 'POST', body: { action: 'start', mode: 'browser' }, headers })).status, 403);
    }
    for (const Origin of ['null', 'https://evil.example', 'http://127.0.0.1:1', `${ORIGIN}/`, `http://user@127.0.0.1:57620`]) {
      assert.equal((await f.send({ headers: { Origin } })).status, 403);
    }
    for (const site of ['cross-site', 'same-site']) assert.equal((await f.send({ headers: { 'Sec-Fetch-Site': site } })).status, 403);
    assert.equal(f.native.calls.length, 0);
  } finally { await f.dispose(); }
});

test('real Host survives the SDK synthetic Request URL and proxy HTTPS normalization', async () => {
  const f = fixture();
  try {
    assert.equal((await f.send({ headers: { Origin: 'https://quota.example', Host: 'quota.example:443' } })).status, 200);
    for (const Host of ['evil.example', '127.0.0.1:57620@evil.example', '127.0.0.1:57620/']) assert.equal((await f.send({ headers: { Host } })).status, 403);
  } finally { await f.dispose(); }
});

test('malformed, oversized and foreign-provider action payloads are rejected before native login', async () => {
  const f = fixture();
  try {
    for (const payload of ['{bad', '[]', JSON.stringify({ action: 'start', mode: 'browser', padding: 'x'.repeat(17000) }), { action: 'start', mode: 'browser', key: 'somebody-else' }, { action: 'start', mode: 'api-key' }]) {
      const response = await f.post(payload); assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'invalid-request' });
    }
    assert.equal(f.native.calls.length, 0);
  } finally { await f.dispose(); }
});

test('explicit start is native, scoped to this controller and independent of HTTP disconnect', async () => {
  const f = fixture();
  try {
    const csrf = (await (await f.send()).json()).csrf;
    const transport = new AbortController();
    const response = await f.send({ method: 'POST', body: { action: 'start', mode: 'browser' }, headers: { 'Content-Type': 'application/json', 'X-Quota-Codex-CSRF': csrf }, signal: transport.signal });
    assert.equal(response.status, 200);
    const started = await response.json(); assert.equal(started.active, true); assert.ok(started.attempt.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.native.calls.length, 1);
    transport.abort();
    assert.equal(f.native.calls[0].signal.aborted, false, 'an HTTP disconnect cannot cancel the owned native flow');
    assert.equal((await f.post({ action: 'cancel', attemptId: started.attempt.id })).status, 200);
    assert.equal(f.native.calls[0].signal.aborted, true);
  } finally { await f.dispose(); }
});

test('missing core capability degrades safely and late service availability is detected', async () => {
  const f = fixture();
  try {
    f.state.auth = undefined;
    assert.equal((await (await f.send()).json()).flowAvailable, false);
    assert.deepEqual(await (await f.post({ action: 'start', mode: 'browser' })).json(), { error: 'flow-unavailable' });
    f.state.auth = f.native;
    assert.equal((await (await f.send()).json()).flowAvailable, true);
    assert.equal(f.native.calls.length, 0);
  } finally { await f.dispose(); }
});

test('configuration overrides and other global logins block startup without mutating either', async () => {
  const f = fixture();
  try {
    f.state.profile.apiKeyEnv = 'USER_KEY_REFERENCE';
    assert.deepEqual(await (await f.post({ action: 'start', mode: 'browser' })).json(), { error: 'api-key-override' });
    f.state.profile = { baseURL: 'https://relay.example/backend-api' };
    assert.deepEqual(await (await f.post({ action: 'start', mode: 'browser' })).json(), { error: 'endpoint-override' });
    f.state.profile = {}; f.native.inFlight = true;
    assert.equal((await (await f.send()).json()).otherLoginInFlight, true);
    assert.deepEqual(await (await f.post({ action: 'start', mode: 'browser' })).json(), { error: 'busy' });
    assert.equal(f.native.calls.length, 0);
  } finally { await f.dispose(); }
});

test('source failures never expose native error text or accept a callback for another attempt', async () => {
  const f = fixture();
  try {
    f.state.failure = 'PRIVATE_NATIVE_ERROR_OR_TOKEN';
    const response = await f.send(); const text = await response.text();
    assert.equal(text.includes('PRIVATE_NATIVE_ERROR_OR_TOKEN'), false);
    assert.equal(JSON.parse(text).flowAvailable, false);
    f.state.failure = null;
    const result = await f.post({ action: 'respond', attemptId: 'foreign-attempt-id-0000', promptId: 'foreign-prompt-id-0000', value: 'http://localhost:1455/auth/callback?code=secret&state=wrong' });
    assert.equal(result.status, 409); assert.deepEqual(await result.json(), { error: 'attempt-mismatch' });
    assert.equal(f.native.calls.length, 0);
  } finally { await f.dispose(); }
});


test('real built-in Host snapshots satisfy the client schema through idle, active, success and source failure', async () => {
  const f = fixture();
  try {
    const read = async () => {
      const data = await (await f.send()).json();
      assert.equal(guards.validCodexSnapshot(data), true, JSON.stringify(data));
      return data;
    };
    assert.equal((await read()).phase, 'idle');
    const started = await (await f.post({ action: 'start', mode: 'browser' })).json();
    assert.equal(guards.validCodexSnapshot(started), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await read()).active, true);
    f.state.configured = true;
    f.native.finish('authorized');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await read()).phase, 'succeeded');
    f.state.failure = 'SYNTHETIC_PRIVATE_ERROR';
    const unavailable = await read();
    assert.equal(unavailable.failure, 'service-unavailable');
    assert.equal(JSON.stringify(unavailable).includes('SYNTHETIC_PRIVATE_ERROR'), false);
    assert.equal(guards.validCodexSnapshot({ ...unavailable, grant: { access: 'never-ui' } }), false);
    assert.equal(guards.validCodexSnapshot({ ...unavailable, active: true, attempt: null }), false);
    assert.equal(guards.validCodexSnapshot({ ...unavailable, csrf: [unavailable.csrf] }), false);
  } finally { await f.dispose(); }
});

test('client URL guards reject external destinations, duplicate state and private query fields', () => {
  const valid = new URL('https://auth.openai.com/oauth/authorize');
  valid.searchParams.set('redirect_uri', 'http://localhost:1455/auth/callback');
  valid.searchParams.set('state', 'synthetic-authorization-state-0000');
  assert.ok(guards.safeCodexOfficialLink(valid.href));
  for (const key of ['client_secret', 'code_verifier', 'access_token', 'refresh_token']) {
    const unsafe = new URL(valid); unsafe.searchParams.set(key, 'SYNTHETIC_PRIVATE_VALUE');
    assert.equal(guards.safeCodexOfficialLink(unsafe.href), null);
  }
  for (const change of [url => { url.hash = 'private'; }, url => { url.searchParams.append('state', 'other'); }, url => { url.searchParams.set('redirect_uri', 'https://evil.example/callback'); }, url => { url.hostname = 'auth.openai.com.evil.example'; }]) {
    const unsafe = new URL(valid); change(unsafe); assert.equal(guards.safeCodexOfficialLink(unsafe.href), null);
  }
  assert.equal(guards.validCodexCallback('http://localhost:1455/auth/callback?code=synthetic&state=synthetic'), true);
  for (const callback of ['code-only', 'https://evil.example/?code=a&state=b', 'http://localhost:1455/auth/callback?code=a&state=b&state=c']) assert.equal(guards.validCodexCallback(callback), false);
});


test('streamed mutation bodies stop at the local byte cap without aggregate buffering', async () => {
  const f = fixture();
  let cancelled = false, pulls = 0;
  try {
    const csrf = (await (await f.send()).json()).csrf;
    const body = new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(65_536)); },
      cancel() { cancelled = true; },
    });
    const response = await f.routes.get(ACTION_PATH).fetch(new Request(`http://dsh.internal${ACTION_PATH}`, {
      method: 'POST', duplex: 'half', body,
      headers: { Host: '127.0.0.1:57620', Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Quota-Codex-CSRF': csrf },
    }));
    assert.equal(response.status, 400); assert.equal(cancelled, true);
    assert.ok(pulls <= 2, `read only bounded chunks, got ${pulls}`);
    assert.equal(f.native.calls.length, 0);
  } finally { await f.dispose(); }
});

test('an aborted mutation body is cancelled before any native authorization starts', async () => {
  const f = fixture();
  let cancelled = false;
  try {
    const csrf = (await (await f.send()).json()).csrf;
    const transport = new AbortController();
    const response = f.routes.get(ACTION_PATH).fetch(new Request(`http://dsh.internal${ACTION_PATH}`, {
      method: 'POST', duplex: 'half', signal: transport.signal,
      body: new ReadableStream({ cancel() { cancelled = true; } }),
      headers: { Host: '127.0.0.1:57620', Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Quota-Codex-CSRF': csrf },
    }));
    transport.abort();
    assert.equal((await response).status, 400); assert.equal(cancelled, true);
    assert.equal(f.native.calls.length, 0);
  } finally { await f.dispose(); }
});
