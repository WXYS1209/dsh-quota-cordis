import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexOAuthController } from '../src/codex-oauth.js';

const KEY = 'llm-pi-ai/openai-codex';
const PROVIDER = 'openai-codex';
const BASE = 'https://chatgpt.com/backend-api';
const CALLBACK = 'http://localhost:1455/auth/callback';
const STATE = 'synthetic-state-01234567890123456789';
function authURL(overrides = {}) {
  const url = new URL('https://auth.openai.com/oauth/authorize');
  const params = { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', response_type: 'code', redirect_uri: CALLBACK, scope: 'openid profile email offline_access', state: STATE, code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', ...overrides };
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}
const callbackURL = (state = STATE) => `${CALLBACK}?code=synthetic-authorization-code&state=${encodeURIComponent(state)}`;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };
function protectedObject(fields, privateFields, reads) {
  const result = { ...fields };
  for (const field of privateFields) Object.defineProperty(result, field, { enumerable: true, get() { reads.push(field); throw Error(`PRIVATE_${field}`); } });
  return result;
}
function fixture({ profile = {}, timeoutMs = 60_000, authorizationGetter = false, freshAuthorizationFacade = false } = {}) {
  const calls = { begin: [], descriptions: [], records: [], forbidden: [], private: [], selected: [], facades: [] };
  const state = {
    now: 1_000_000, profile, available: true, globalBusy: false, ignoreAbort: false, descriptor: { configured: false, kind: 'grant' },
    directory: [{ provider: PROVIDER, displayName: 'Synthetic Codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', PROVIDER], defaultBaseURL: BASE, nativeAuth: { oauth: true } }],
    registered: [{ id: PROVIDER, name: 'Synthetic Codex' }], docs: null,
  };
  const forbidden = name => () => { calls.forbidden.push(name); throw Error(`FORBIDDEN_${name}`); };
  const native = {
    describe(key) {
      assert.equal(this, native, 'native service receiver must be preserved');
      assert.equal(key, KEY); calls.descriptions.push(key);
      return state.available ? { key, methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: state.globalBusy } : undefined;
    },
    begin(request) {
      assert.equal(this, native, 'native begin receiver must be preserved');
      assert.equal(request.key, KEY); assert.equal(request.method, 'oauth');
      assert.ok(request.signal instanceof AbortSignal);
      if (state.globalBusy) return Promise.reject(Object.assign(Error('PRIVATE_OTHER_ATTEMPT'), { code: 'ALREADY_IN_FLIGHT' }));
      state.globalBusy = true;
      const finish = deferred();
      const run = { request, finish, selected: null };
      calls.begin.push(run);
      const select = request.interaction.prompt({ kind: 'select', message: 'Synthetic mode choice', options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }] });
      run.selection = Promise.resolve(select).then(mode => { run.selected = mode; calls.selected.push(mode); return mode; });
      run.selection.catch(() => {});
      const abort = () => { if (!state.ignoreAbort) finish.resolve({ status: 'cancelled' }); };
      request.signal.addEventListener('abort', abort, { once: true });
      return finish.promise.then(outcome => {
        // Only the fake native SDK writes the synthetic descriptor. The plugin
        // receives no record payload and must not implement a second writer.
        if (outcome.status === 'authorized') state.descriptor = { configured: true, kind: 'grant' };
        return outcome;
      }).finally(() => { request.signal.removeEventListener('abort', abort); state.globalBusy = false; });
    },
    cancel: forbidden('global-cancel'),
    list: forbidden('enumerate-flows'),
  };
  const services = {
    llm: {
      listProviders() { assert.equal(this, services.llm); return state.registered; },
      listConfigurableProviders() { assert.equal(this, services.llm); return state.directory; },
      getModels: forbidden('getModels'), refreshModels: forbidden('refreshModels'),
    },
    settings: { describe(options) { assert.equal(this, services.settings); assert.deepEqual(options, { redactSecrets: true }); return state.docs ?? [{ ns: 'llm-pi-ai', value: { providers: { [PROVIDER]: state.profile } } }]; } },
    credentials: {
      describeRecord(key) { assert.equal(this, services.credentials); assert.equal(key, KEY); calls.records.push(key); return protectedObject(state.descriptor, ['payload', 'access', 'refresh', 'key', 'value', 'accountId'], calls.private); },
      resolve: forbidden('resolve'), readRecord: forbidden('readRecord'), writeRecord: forbidden('writeRecord'), storeRecord: forbidden('storeRecord'), deleteRecord: forbidden('deleteRecord'), modify: forbidden('modify'), clearRecord: forbidden('clearRecord'), set: forbidden('set'),
    },
    authorization: authorizationGetter ? () => {
      if (!state.available) return undefined;
      if (!freshAuthorizationFacade) return native;
      const facade = {
        describe(key) { return native.describe(key); },
        begin(request) { return native.begin(request); },
      };
      calls.facades.push(facade);
      return facade;
    } : native,
  };
  const controller = new CodexOAuthController(services, { now: () => state.now, timeoutMs });
  const close = async () => {
    const disposing = controller.dispose();
    for (const run of calls.begin) run.finish.resolve({ status: 'cancelled' });
    await disposing; await flush();
    assert.deepEqual(calls.forbidden, []); assert.deepEqual(calls.private, []);
  };
  return { controller, services, native, calls, state, close };
}
const fail = async (promise, expected) => {
  await assert.rejects(promise, error => {
    assert.equal(typeof error?.code, 'string', 'failure must expose only a safe domain category');
    if (expected) assert.equal(error.code, expected);
    assert.equal(String(error.message).includes('PRIVATE_'), false);
    return true;
  });
};
const start = async (f, mode = 'browser') => {
  await f.controller.mutate({ action: 'start', mode }); await flush();
  assert.equal(f.calls.begin.length, 1);
  const run = f.calls.begin[0];
  assert.equal(await run.selection, mode);
  return run;
};
const notify = async (f, notice) => { f.calls.begin[0].request.interaction.notify(notice); await flush(); return f.controller.read(); };
const privateNotice = fields => ({ ...fields, get message() { throw Error('PRIVATE_NATIVE_MESSAGE'); }, get payload() { throw Error('PRIVATE_NATIVE_PAYLOAD'); } });
const hasNoPrivate = data => {
  const fields = new Set(['flowAvailable', 'routeConfigured', 'apiKeyOverride', 'endpointSupported', 'credentialConfigured', 'credentialKind', 'otherLoginInFlight', 'active', 'csrf', 'phase', 'failure', 'attempt']);
  for (const key of Object.keys(data)) assert.ok(fields.has(key), `unexpected top-level projection field: ${key}`);
  if (data.attempt) {
    const allowed = new Set(['id', 'mode', 'expiresAt', 'authUrl', 'deviceCode', 'pending']);
    for (const key of Object.keys(data.attempt)) assert.ok(allowed.has(key), `unexpected attempt field: ${key}`);
    if (data.attempt.pending) assert.deepEqual(Object.keys(data.attempt.pending).sort(), ['id', 'kind']);
  }
  const serialized = JSON.stringify(data);
  for (const marker of ['PRIVATE_', 'synthetic-authorization-code', 'refresh-token', 'access-token', 'native-client-secret']) assert.equal(serialized.includes(marker), false, marker);
};

// All services, SDK conversations and credential state below are synthetic.
// These domain tests never start real OAuth, read local records or use a network.
test('reading capability and credential presence never starts authorization or touches raw records', async () => {
  const f = fixture();
  try {
    const view = await f.controller.read();
    for (const key of ['flowAvailable', 'routeConfigured', 'apiKeyOverride', 'endpointSupported', 'credentialConfigured', 'active']) assert.equal(typeof view[key], 'boolean', key);
    assert.equal(view.flowAvailable, true); assert.equal(view.routeConfigured, true); assert.equal(view.endpointSupported, true);
    assert.equal(view.active, false); assert.equal(view.attempt, null); assert.equal(view.credentialConfigured, false);
    assert.equal(f.calls.begin.length, 0); assert.ok(typeof view.csrf === 'string' && view.csrf.length >= 32);
    assert.equal(f.controller.csrfMatches(view.csrf), true);
    for (const token of [null, undefined, '', 'wrong', `${view.csrf}x`, '☃'.repeat(43)]) assert.equal(f.controller.csrfMatches(token), false);
    hasNoPrivate(view);
  } finally { await f.close(); }
});

test('both UI modes use one native oauth method and answer only the native mode selector', async () => {
  for (const mode of ['browser', 'device_code']) {
    const f = fixture();
    try {
      const run = await start(f, mode);
      assert.equal(run.request.key, KEY); assert.equal(run.request.method, 'oauth'); assert.equal(run.request.signal.aborted, false);
      const view = await f.controller.read(); assert.equal(view.active, true); assert.equal(view.attempt.mode, mode);
      assert.ok(typeof view.attempt.id === 'string' && view.attempt.id.length <= 128);
      assert.ok(Number.isFinite(view.attempt.expiresAt) && view.attempt.expiresAt > f.state.now);
    } finally { await f.close(); }
  }
});

test('public descriptor presence is separate from a newly completed native authorization outcome', async () => {
  const f = fixture(); f.state.descriptor = { configured: true, kind: 'grant' };
  try {
    const initial = await f.controller.read(); assert.equal(initial.credentialConfigured, true);
    const run = await start(f); assert.notEqual((await f.controller.read()).phase, 'succeeded');
    run.finish.resolve({ status: 'authorized' }); await flush();
    const done = await f.controller.read(); assert.equal(done.phase, 'succeeded'); assert.equal(done.active, false); assert.equal(done.credentialConfigured, true);
    hasNoPrivate(done);
  } finally { await f.close(); }
});

test('late-mounted native capability can become available without constructing a new controller', async () => {
  const f = fixture({ authorizationGetter: true }); f.state.available = false;
  try {
    assert.equal((await f.controller.read()).flowAvailable, false);
    await fail(f.controller.mutate({ action: 'start', mode: 'browser' }), 'flow-unavailable');
    assert.equal(f.calls.begin.length, 0);
    f.state.available = true;
    assert.equal((await f.controller.read()).flowAvailable, true);
    await start(f);
  } finally { await f.close(); }
});

test('fresh Cordis authorization facades do not invalidate the same owned native flow', async () => {
  const f = fixture({ authorizationGetter: true, freshAuthorizationFacade: true });
  try {
    const run = await start(f);
    await notify(f, { message: 'open', url: authURL() });
    const answer = run.request.interaction.prompt({ kind: 'text', message: 'manual' }); answer.catch(() => {});
    await flush();
    const waiting = await f.controller.read();
    assert.equal(waiting.active, true); assert.equal(waiting.phase, 'pending');
    await f.controller.mutate({ action: 'respond', attemptId: waiting.attempt.id, promptId: waiting.attempt.pending.id, value: callbackURL() });
    assert.equal(await answer, callbackURL());
    run.finish.resolve({ status: 'authorized' }); await flush();
    const done = await f.controller.read();
    assert.equal(done.phase, 'succeeded'); assert.equal(done.active, false); assert.equal(done.credentialConfigured, true);
    assert.ok(f.calls.facades.length >= 4, 'start, read, respond and settlement inspect the native seam independently');
    assert.equal(new Set(f.calls.facades).size, f.calls.facades.length, 'every inspection receives a fresh facade object');
    assert.equal(f.calls.begin.length, 1); hasNoPrivate(done);
  } finally { await f.close(); }
});

test('global native busy status is visible but never joins, exposes or cancels another surface attempt', async () => {
  const f = fixture(); f.state.globalBusy = true;
  try {
    const view = await f.controller.read(); assert.equal(view.otherLoginInFlight, true); assert.equal(view.active, false); assert.equal(view.attempt, null);
    await fail(f.controller.mutate({ action: 'start', mode: 'browser' }), 'busy');
    assert.equal(f.calls.begin.length, 0);
    await fail(f.controller.mutate({ action: 'cancel', attemptId: 'another-surface-attempt' }));
    assert.equal(f.state.globalBusy, true);
  } finally { await f.close(); }
});

test('an atomic native busy rejection cannot expose or overwrite another surface attempt', async () => {
  const f = fixture();
  const original = f.native.begin;
  f.native.begin = function (request) { f.state.globalBusy = true; return original.call(this, request); };
  try {
    await f.controller.mutate({ action: 'start', mode: 'browser' }); await flush();
    const view = await f.controller.read();
    assert.equal(view.phase, 'failed'); assert.equal(view.failure, 'busy'); assert.equal(view.active, false);
    assert.equal(view.otherLoginInFlight, true); assert.equal(view.attempt, null); assert.equal(f.calls.begin.length, 0); hasNoPrivate(view);
  } finally { await f.close(); }
});

test('missing native methods and non-oauth registered methods report unavailable without beginning any flow', async () => {
  for (const change of [
    f => { f.native.begin = undefined; },
    f => { f.native.describe = undefined; },
    f => { f.native.describe = function () { return { key: KEY, methods: [{ id: 'api-key' }], inFlight: false }; }; },
    f => { f.native.describe = function () { return { key: 'foreign/provider', methods: [{ id: 'oauth' }], inFlight: false }; }; },
  ]) {
    const f = fixture(); change(f);
    try {
      assert.equal((await f.controller.read()).flowAvailable, false);
      await fail(f.controller.mutate({ action: 'start', mode: 'browser' }), 'flow-unavailable');
      assert.equal(f.calls.begin.length, 0);
    } finally { await f.close(); }
  }
});

test('metadata failure before start cannot authorize, and failure while waiting clears the owned challenge', async () => {
  const blocked = fixture(); blocked.services.settings.describe = function () { throw Error('PRIVATE_SETTINGS_ERROR'); };
  try {
    const view = await blocked.controller.read(); assert.equal(view.failure, 'service-unavailable'); hasNoPrivate(view);
    await fail(blocked.controller.mutate({ action: 'start', mode: 'browser' }), 'service-unavailable');
    assert.equal(blocked.calls.begin.length, 0);
  } finally { await blocked.close(); }
  const f = fixture();
  try {
    const run = await start(f); await notify(f, { url: authURL(), message: 'open' });
    const answer = run.request.interaction.prompt({ kind: 'text', message: 'manual' }); answer.catch(() => {}); await flush();
    const view = await f.controller.read();
    f.services.settings.describe = function () { throw Error('PRIVATE_SETTINGS_ERROR'); };
    await fail(f.controller.mutate({ action: 'respond', attemptId: view.attempt.id, promptId: view.attempt.pending.id, value: callbackURL() }), 'service-unavailable');
    await assert.rejects(answer); assert.equal(run.request.signal.aborted, true); await flush();
    const after = await f.controller.read(); assert.equal(after.failure, 'service-unavailable'); assert.equal(after.attempt?.authUrl, undefined); hasNoPrivate(after);
  } finally { await f.close(); }
});

test('a start in metadata inspection is exclusive and disposal prevents its delayed native begin', async () => {
  const f = fixture(); const metadata = deferred();
  f.services.settings.describe = function () { return metadata.promise; };
  try {
    const first = f.controller.mutate({ action: 'start', mode: 'browser' }); first.catch(() => {});
    await Promise.resolve();
    await fail(f.controller.mutate({ action: 'start', mode: 'device_code' }), 'busy');
    const disposal = f.controller.dispose();
    metadata.resolve([{ ns: 'llm-pi-ai', value: { providers: { [PROVIDER]: {} } } }]);
    await fail(first, 'disposed'); await disposal;
    assert.equal(f.calls.begin.length, 0);
  } finally { await f.close(); }
});

test('exact provider namespace/path and configured route identity are required for login', async () => {
  for (const change of [
    f => { f.state.directory[0].settingsNs = 'renamed-pi-ai'; },
    f => { f.state.directory[0].settingsPath = ['providers', 'another-route']; },
    f => { f.state.directory[0].provider = 'another-provider'; },
    f => { f.state.directory[0].error = 'PRIVATE_OWNER_FAILURE'; },
    f => { f.state.registered = []; },
    f => { f.state.docs = []; },
    f => { f.state.docs = [{ ns: 'llm-pi-ai', value: { providers: {} } }]; },
  ]) {
    const f = fixture(); change(f);
    try {
      await fail(f.controller.mutate({ action: 'start', mode: 'browser' }));
      assert.equal(f.calls.begin.length, 0); hasNoPrivate(await f.controller.read());
    } finally { await f.close(); }
  }
});

test('explicit API-key overrides, unsafe endpoint/protocol/header configuration never start OAuth', async () => {
  for (const profile of [
    { apiKeyEnv: 'CUSTOM_KEY' }, { apiKeyEnv: '' }, { apiKeyEnv: false },
    { baseURL: 'https://relay.example.test/backend-api' }, { baseURL: '' }, { baseURL: null },
    { baseURL: 'http://chatgpt.com/backend-api' }, { baseURL: 'https://chatgpt.com/backend-api?x=1' },
    { baseURL: 'https://user@chatgpt.com/backend-api' }, { baseURL: 'https://chatgpt.com:8443/backend-api' },
    { headers: { Authorization: 'must-not-be-read-or-sent' } }, { headers: { 'X-Relay': 'custom' } },
    { api: 'openai-completions' },
  ]) {
    const f = fixture({ profile });
    try { await fail(f.controller.mutate({ action: 'start', mode: 'browser' })); assert.equal(f.calls.begin.length, 0); }
    finally { await f.close(); }
  }
});

test('unsupported payload fields, modes and private provider/key overrides are rejected', async () => {
  const f = fixture();
  try {
    for (const raw of [null, [], {}, { action: 'unknown' }, { action: 'start', mode: 'api-key' }, { action: 'start', mode: 'browser', key: 'foreign/key' }, { action: 'start', mode: 'browser', provider: 'other' }, { action: 'start', mode: 'browser', url: 'https://evil.example' }, { action: 'cancel' }, { action: 'respond', attemptId: 'a', promptId: 'b', value: 'x', secret: 'not-allowed' }]) await fail(f.controller.mutate(raw));
    assert.equal(f.calls.begin.length, 0);
  } finally { await f.close(); }
});

test('browser notices project only a safe official URL and never native messages or payloads', async () => {
  const f = fixture();
  try {
    await start(f);
    const view = await notify(f, privateNotice({ url: authURL() }));
    assert.equal(view.attempt.authUrl, authURL()); hasNoPrivate(view);
    assert.equal(JSON.stringify(view).includes('Synthetic mode choice'), false);
  } finally { await f.close(); }
});

test('unsafe authorization links, callback targets, states and PKCE challenges fail closed', async () => {
  const cases = [
    'https://evil.example/oauth/authorize', 'http://auth.openai.com/oauth/authorize',
    'https://auth.openai.com:8443/oauth/authorize', `https://user@auth.openai.com/oauth/authorize`,
    `${authURL()}#fragment`, authURL({ redirect_uri: 'https://evil.example/callback' }),
    authURL({ redirect_uri: 'http://localhost:9999/auth/callback' }), authURL({ state: undefined }),
    authURL({ code_challenge: undefined }), authURL({ code_challenge_method: 'plain' }),
    `${authURL()}&state=duplicate-state`, `${authURL()}&redirect_uri=${encodeURIComponent(CALLBACK)}`,
    authURL({ client_secret: 'native-client-secret' }), authURL({ code_verifier: 'native-client-secret' }),
  ];
  for (const [index, url] of cases.entries()) {
    const f = fixture();
    try {
      await start(f); await notify(f, { message: 'PRIVATE_UNSAFE_URL_MESSAGE', url });
      const view = await f.controller.read(); assert.equal(view.active, false, `unsafe-link-case-${index}`); assert.equal(view.phase, 'failed');
      assert.equal(view.attempt?.authUrl ?? null, null); hasNoPrivate(view);
    } finally { await f.close(); }
  }
});

test('manual callback is bound to owned attempt, prompt and native state and is never echoed', async () => {
  const f = fixture();
  try {
    const run = await start(f); await notify(f, { message: 'Open page', url: authURL() });
    const answer = run.request.interaction.prompt({ kind: 'text', message: 'PRIVATE_PROMPT_MESSAGE', placeholder: CALLBACK }); answer.catch(() => {});
    await flush(); const view = await f.controller.read();
    assert.equal(view.attempt.pending.kind, 'callback');
    const ids = { attemptId: view.attempt.id, promptId: view.attempt.pending.id };
    for (const value of ['bare-code', callbackURL('wrong-state'), callbackURL().replace('localhost:1455', '127.0.0.1:9999'), `${callbackURL()}#fragment`, `${callbackURL()}&state=second`]) await fail(f.controller.mutate({ action: 'respond', ...ids, value }));
    await fail(f.controller.mutate({ action: 'respond', ...ids, attemptId: 'foreign-attempt', value: callbackURL() }));
    await fail(f.controller.mutate({ action: 'respond', ...ids, promptId: 'foreign-prompt', value: callbackURL() }));
    await f.controller.mutate({ action: 'respond', ...ids, value: callbackURL() });
    assert.equal(await answer, callbackURL());
    hasNoPrivate(await f.controller.read());
    await fail(f.controller.mutate({ action: 'respond', ...ids, value: callbackURL() }));
  } finally { await f.close(); }
});

test('native automatic callback withdraws only its manual prompt and leaves the owned flow active', async () => {
  const f = fixture();
  try {
    const run = await start(f); await notify(f, { message: 'Open page', url: authURL() });
    const promptSignal = new AbortController();
    const answer = run.request.interaction.prompt({ kind: 'text', message: 'manual', signal: promptSignal.signal }); answer.catch(() => {});
    await flush(); const before = await f.controller.read(); const promptId = before.attempt.pending.id;
    promptSignal.abort(); await assert.rejects(answer); await flush();
    const after = await f.controller.read(); assert.equal(after.active, true); assert.equal(after.attempt.pending ?? null, null); assert.equal(run.request.signal.aborted, false);
    await fail(f.controller.mutate({ action: 'respond', attemptId: after.attempt.id, promptId, value: callbackURL() }));
    run.finish.resolve({ status: 'authorized' }); await flush(); assert.equal((await f.controller.read()).phase, 'succeeded');
  } finally { await f.close(); }
});

test('device login exposes only the official short-code challenge and never a browser callback prompt', async () => {
  const f = fixture();
  try {
    const run = await start(f, 'device_code');
    const view = await notify(f, privateNotice({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH' }));
    assert.equal(view.attempt.authUrl, 'https://auth.openai.com/codex/device'); assert.equal(view.attempt.deviceCode, 'ABCD-EFGH'); hasNoPrivate(view);
    await assert.rejects(run.request.interaction.prompt({ kind: 'text', message: 'unexpected callback' }));
  } finally { await f.close(); }
});

test('unexpected selectors, secret prompts and repeated mode selectors are never guessed or exposed', async () => {
  for (const prompt of [
    { kind: 'select', message: 'PRIVATE_LABEL', options: [{ id: 'other', label: 'PRIVATE_OTHER' }] },
    { kind: 'secret', message: 'PRIVATE_SECRET_PROMPT' },
    { kind: 'select', message: 'repeated', options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }] },
  ]) {
    const f = fixture();
    try {
      const run = await start(f); await assert.rejects(run.request.interaction.prompt(prompt));
      const view = await f.controller.read(); hasNoPrivate(view); assert.equal(view.active, false);
    } finally { await f.close(); }
  }
});

test('repeated starts are refused and cancellation aborts only the signal owned by this controller', async () => {
  const f = fixture();
  try {
    const run = await start(f); const before = await f.controller.read();
    await fail(f.controller.mutate({ action: 'start', mode: 'device_code' })); assert.equal(f.calls.begin.length, 1);
    await fail(f.controller.mutate({ action: 'cancel', attemptId: 'foreign-attempt' })); assert.equal(run.request.signal.aborted, false);
    await f.controller.mutate({ action: 'cancel', attemptId: before.attempt.id }); await flush();
    assert.equal(run.request.signal.aborted, true); const after = await f.controller.read(); assert.equal(after.active, false); assert.equal(after.phase, 'cancelled');
    hasNoPrivate(after);
  } finally { await f.close(); }
});

test('late native commits remain visible as presence without changing a cancelled attempt into fresh success', async () => {
  const f = fixture(); f.state.ignoreAbort = true;
  try {
    const run = await start(f); const view = await f.controller.read();
    await f.controller.mutate({ action: 'cancel', attemptId: view.attempt.id });
    run.request.interaction.notify({ url: authURL(), message: 'late notice' });
    run.finish.resolve({ status: 'authorized' }); await flush();
    const after = await f.controller.read(); assert.equal(after.active, false); assert.equal(after.phase, 'cancelled'); assert.equal(after.credentialConfigured, true);
    assert.equal(after.attempt?.authUrl ?? null, null); hasNoPrivate(after);
  } finally { await f.close(); }
});

test('route changes before callback response abort the owned attempt rather than feeding a changed configuration', async () => {
  const f = fixture();
  try {
    const run = await start(f); await notify(f, { url: authURL(), message: 'open' });
    const answer = run.request.interaction.prompt({ kind: 'text', message: 'manual' }); answer.catch(() => {});
    await flush(); const view = await f.controller.read();
    f.state.profile = { baseURL: 'https://relay.example.test/backend-api' };
    await fail(f.controller.mutate({ action: 'respond', attemptId: view.attempt.id, promptId: view.attempt.pending.id, value: callbackURL() }));
    assert.equal(run.request.signal.aborted, true); await assert.rejects(answer);
    assert.equal((await f.controller.read()).active, false);
  } finally { await f.close(); }
});

test('an SDK commit after profile changes is retained without claiming success for the changed route', async () => {
  const f = fixture();
  try {
    const run = await start(f);
    f.state.profile = { baseURL: 'https://relay.example.test/backend-api' };
    run.finish.resolve({ status: 'authorized' }); await flush();
    const view = await f.controller.read();
    assert.equal(view.phase, 'failed'); assert.equal(view.failure, 'conflict'); assert.equal(view.active, false);
    assert.equal(view.credentialConfigured, true, 'a native write already committed is not rolled back by this plugin');
    assert.equal(view.attempt, null); hasNoPrivate(view);
  } finally { await f.close(); }
});

test('native failure messages are reduced to safe failure categories, never SDK error text', async () => {
  const f = fixture();
  try {
    const run = await start(f);
    run.finish.reject(Object.assign(Error('PRIVATE_access-token_refresh-token_native-client-secret'), { code: 'NOT_COMMITTED' })); await flush();
    const view = await f.controller.read(); assert.equal(view.phase, 'failed'); assert.equal(view.failure, 'not-committed'); hasNoPrivate(view);
  } finally { await f.close(); }
});

test('owned timeouts reject pending callbacks and ignore late notices and completion', async () => {
  const f = fixture({ timeoutMs: 15 }); f.state.ignoreAbort = true;
  try {
    const run = await start(f); await notify(f, { url: authURL(), message: 'open' });
    const answer = run.request.interaction.prompt({ kind: 'text', message: 'manual' }); answer.catch(() => {});
    f.state.now += 16;
    await new Promise(resolve => setTimeout(resolve, 25)); await flush();
    await assert.rejects(answer);
    const expired = await f.controller.read(); assert.equal(expired.active, true, 'an uncooperative native promise retains the slot until settlement'); assert.equal(expired.phase, 'expired'); assert.equal(run.request.signal.aborted, true);
    assert.equal(expired.attempt.authUrl, undefined); assert.equal(expired.attempt.pending, undefined);
    await fail(f.controller.mutate({ action: 'start', mode: 'browser' }), 'busy');
    run.request.interaction.notify({ url: authURL(), message: 'late' }); run.finish.resolve({ status: 'authorized' }); await flush();
    const settled = await f.controller.read(); assert.equal(settled.phase, 'expired'); assert.equal(settled.active, false);
  } finally { await f.close(); }
});

test('dispose cancels the owned signal and never calls global cancellation or exposes late challenges', async () => {
  const f = fixture(); f.state.ignoreAbort = true;
  const run = await start(f); await notify(f, { url: authURL(), message: 'open' });
  const answer = run.request.interaction.prompt({ kind: 'text', message: 'manual' }); answer.catch(() => {});
  try {
    const disposal = f.controller.dispose();
    assert.equal(run.request.signal.aborted, true); await assert.rejects(answer);
    run.request.interaction.notify({ url: authURL(), message: 'late' }); run.finish.resolve({ status: 'authorized' }); await disposal; await flush();
    await fail(f.controller.mutate({ action: 'start', mode: 'browser' }));
    assert.deepEqual(f.calls.forbidden, []); assert.deepEqual(f.calls.private, []);
  } finally { await f.close(); }
});
