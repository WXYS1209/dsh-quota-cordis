// Native OAuth interaction surface only; protocol and credential writes remain SDK-owned.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const KEY = 'llm-pi-ai/openai-codex';
const PROVIDER = 'openai-codex';
const NAMESPACE = 'llm-pi-ai';
const ENDPOINT = 'https://chatgpt.com/backend-api';
const CALLBACK = 'http://localhost:1455/auth/callback';
const LIMIT = 15 * 60_000;
const AUTH_PARAMETERS = new Set(['response_type', 'client_id', 'redirect_uri', 'scope', 'code_challenge', 'code_challenge_method', 'state', 'id_token_add_organizations', 'codex_cli_simplified_flow', 'originator']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => Object.assign(new Error(code), { code });
const aborted = () => Object.assign(new Error('authorization-withdrawn'), { name: 'AbortError' });
const text = (value, max = 16384) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u0020\u007f]/.test(value);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const one = (url, key) => url.searchParams.getAll(key).length === 1 ? url.searchParams.get(key) : null;
function urlOf(value) {
  if (!text(value) || value.includes('#') || !/^[a-z]+:\/\//.test(value)) return null;
  try {
    const url = new URL(value);
    const authority = value.match(/^[a-z]+:\/\/([^/?#]*)/)?.[1];
    return url.username || url.password || authority?.includes('@') || url.hash ? null : url;
  } catch { return null; }
}
function endpoint(value) {
  const url = urlOf(value);
  return Boolean(url && url.origin === 'https://chatgpt.com' && !url.port && /^\/backend-api\/?$/.test(url.pathname) && !url.search);
}
function deadline(operation) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail('service-unavailable')), 2000);
    Promise.resolve().then(operation).then(resolve, () => reject(fail('service-unavailable'))).finally(() => clearTimeout(timer));
  });
}
function allowed(payload, keys) {
  return object(payload) && Object.keys(payload).length === keys.length && keys.every(key => Object.hasOwn(payload, key));
}

export class CodexOAuthController {
  constructor({ llm, settings, credentials, authorization }, { now = Date.now, timeoutMs = LIMIT } = {}) {
    if (typeof now !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMIT) throw fail('invalid-request');
    this.services = { llm, settings, credentials, authorization };
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.csrf = randomBytes(32).toString('base64url');
    this.current = null;
    this.starting = false;
    this.disposed = false;
    this.phase = 'idle';
    this.failure = null;
  }
  csrfMatches(value) { return !this.disposed && typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && equal(value, this.csrf); }
  _authorization() {
    const value = this.services.authorization;
    return typeof value === 'function' ? value() : value;
  }
  async _inspect() {
    return deadline(async () => {
      const { llm, settings, credentials } = this.services;
      const authorization = this._authorization();
      const [directory, registered, documents, credential, flow] = await Promise.all([
        llm.listConfigurableProviders(), llm.listProviders(), settings.describe({ redactSecrets: true }), credentials.describeRecord(KEY),
        typeof authorization?.describe === 'function' ? authorization.describe(KEY) : undefined,
      ]);
      if (![directory, registered, documents].every(value => Array.isArray(value) && value.length <= 2000)) throw fail('service-unavailable');
      const entries = directory.filter(row => row?.provider === PROVIDER && row.settingsNs === NAMESPACE && Array.isArray(row.settingsPath) && row.settingsPath.length === 2 && row.settingsPath[0] === 'providers' && row.settingsPath[1] === PROVIDER);
      const docs = documents.filter(doc => doc?.ns === NAMESPACE);
      const entry = entries.length === 1 ? entries[0] : null;
      const doc = docs.length === 1 ? docs[0] : null;
      const providers = object(doc?.value) && Object.hasOwn(doc.value, 'providers') ? doc.value.providers : null;
      const profile = object(providers) && Object.hasOwn(providers, PROVIDER) ? providers[PROVIDER] : undefined;
      const clean = value => value?.error === undefined || value.error === null || value.error === false;
      const ready = value => value?.status === undefined || value.status === 'ready';
      const routeConfigured = Boolean(entry && doc && object(profile) && clean(entry) && clean(doc) && ready(entry) && ready(doc) && registered.some(row => row?.id === PROVIDER && clean(row) && ready(row)));
      const apiKeyOverride = Boolean(object(profile) && (profile.apiKeyEnv !== undefined || (profile.headers !== undefined && (!object(profile.headers) || Object.keys(profile.headers).length > 0))));
      const explicit = profile?.baseURL;
      const baseURL = explicit === undefined ? (entry?.defaultBaseURL === undefined || entry.defaultBaseURL === null ? ENDPOINT : entry.defaultBaseURL) : explicit;
      const advertised = entry?.baseURLEnv;
      const environmentSafe = explicit !== undefined || advertised === undefined || (Array.isArray(advertised) && advertised.length === 0);
      const endpointSupported = Boolean(routeConfigured && endpoint(baseURL) && environmentSafe && (profile.api === undefined || profile.api === 'openai-codex-responses'));
      const flowAvailable = Boolean(authorization && typeof authorization.begin === 'function' && object(flow) && flow.key === KEY && Array.isArray(flow.methods) && flow.methods.some(method => method?.id === 'oauth'));
      const kind = credential?.kind === 'grant' || credential?.kind === 'api-key' ? credential.kind : null;
      const revision = doc?.revision;
      if (revision !== undefined && !(typeof revision === 'string' && revision.length <= 256) && !(Number.isSafeInteger(revision) && revision >= 0)) throw fail('service-unavailable');
      const fingerprint = createHash('sha256').update(JSON.stringify({ revision: revision ?? null, routeConfigured, apiKeyOverride, endpointSupported, api: profile?.api === undefined ? null : profile.api === 'openai-codex-responses' ? profile.api : 'unsupported', baseURL: endpointSupported ? baseURL : null, explicit: explicit !== undefined, environmentSafe })).digest('hex');
      return { authorization, fingerprint, flowAvailable, routeConfigured, apiKeyOverride, endpointSupported, credentialConfigured: credential?.configured === true && kind !== null, credentialKind: credential?.configured === true ? kind : null, inFlight: flow?.inFlight === true };
    });
  }
  _live(attempt) { return !this.disposed && this.current === attempt && attempt.running && !attempt.stopped && !attempt.controller.signal.aborted; }
  _clear(attempt) {
    attempt.authUrl = undefined;
    attempt.deviceCode = undefined;
    attempt.state = undefined;
    if (attempt.prompt) { const prompt = attempt.prompt; attempt.prompt = null; prompt.cleanup(); prompt.reject(aborted()); }
    clearTimeout(attempt.timer);
  }
  _stop(attempt, phase, failure = null) {
    if (this.current !== attempt || !attempt.running || attempt.stopped) return;
    attempt.stopped = true;
    this.phase = phase;
    this.failure = failure;
    this._clear(attempt);
    attempt.controller.abort();
  }
  _matches(attempt, meta) { return meta.fingerprint === attempt.fingerprint && meta.flowAvailable && meta.routeConfigured && !meta.apiKeyOverride && meta.endpointSupported; }
  _snapshot(meta = this.lastMeta ?? {}) {
    const attempt = this.current?.running ? this.current : null;
    return {
      flowAvailable: meta.flowAvailable === true, routeConfigured: meta.routeConfigured === true, apiKeyOverride: meta.apiKeyOverride === true,
      endpointSupported: meta.endpointSupported === true, credentialConfigured: meta.credentialConfigured === true, credentialKind: meta.credentialKind ?? null,
      otherLoginInFlight: meta.inFlight === true && !attempt, active: Boolean(attempt), csrf: this.csrf,
      phase: this.starting ? 'starting' : this.phase, ...(this.failure ? { failure: this.failure } : {}),
      attempt: attempt ? { id: attempt.id, mode: attempt.mode, expiresAt: attempt.expiresAt,
        ...(attempt.authUrl ? { authUrl: attempt.authUrl } : {}), ...(attempt.deviceCode ? { deviceCode: attempt.deviceCode } : {}),
        ...(attempt.prompt ? { pending: { kind: 'callback', id: attempt.prompt.id } } : {}) } : null,
    };
  }
  async read() {
    if (this.disposed) throw fail('disposed');
    try {
      const meta = await this._inspect();
      const attempt = this.current;
      if (attempt?.running && !attempt.stopped) {
        if (this.now() >= attempt.expiresAt) this._stop(attempt, 'expired', 'expired');
        else if (!this._matches(attempt, meta)) this._stop(attempt, 'failed', 'conflict');
      }
      this.lastMeta = meta;
      return this._snapshot(meta);
    } catch {
      if (this.current?.running) this._stop(this.current, 'failed', 'service-unavailable');
      return { ...this._snapshot({}), failure: 'service-unavailable' };
    }
  }
  _notice(attempt, notice) {
    if (!this._live(attempt)) return;
    try {
      if (!object(notice)) throw fail('unsafe-auth-link');
      const value = notice.url;
      const code = notice.code;
      if (value === undefined && code === undefined) return; // Never copy upstream messages.
      if (!attempt.selected) throw fail('unsupported-prompt');
      const url = urlOf(value);
      if (!url || url.origin !== 'https://auth.openai.com' || url.port) throw fail('unsafe-auth-link');
      if (attempt.mode === 'device_code') {
        if (url.pathname !== '/codex/device' || url.search || typeof code !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(code)) throw fail('unsafe-auth-link');
        attempt.authUrl = value;
        attempt.deviceCode = code;
      } else {
        const state = one(url, 'state');
        if ([...url.searchParams.keys()].some(key => !AUTH_PARAMETERS.has(key) || url.searchParams.getAll(key).length !== 1)
          || url.pathname !== '/oauth/authorize' || code !== undefined || one(url, 'redirect_uri') !== CALLBACK || one(url, 'response_type') !== 'code'
          || one(url, 'code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(one(url, 'code_challenge') ?? '') || !/^[A-Za-z0-9_-]{16,256}$/.test(state ?? '')
          || !text(one(url, 'client_id'), 256) || (attempt.state !== undefined && !equal(attempt.state, state))) throw fail('unsafe-auth-link');
        attempt.state = state;
        attempt.authUrl = value;
      }
      this.phase = 'pending';
    } catch (error) { this._stop(attempt, 'failed', ['unsupported-prompt', 'unsafe-auth-link'].includes(error?.code) ? error.code : 'auth-failed'); }
  }
  _prompt(attempt, prompt) {
    if (!this._live(attempt) || prompt?.signal?.aborted) return Promise.reject(aborted());
    if (prompt?.kind === 'select' && !attempt.selected && !attempt.authUrl && Array.isArray(prompt.options)
      && prompt.options.length === 2 && new Set(prompt.options.map(option => option?.id)).size === 2
      && prompt.options.some(option => option?.id === 'browser') && prompt.options.some(option => option?.id === 'device_code')) {
      attempt.selected = true;
      return Promise.resolve(attempt.mode);
    }
    if (prompt?.kind !== 'text' || attempt.mode !== 'browser' || !attempt.authUrl || !attempt.state || attempt.prompt) {
      this._stop(attempt, 'failed', 'unsupported-prompt');
      return Promise.reject(aborted());
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const withdraw = () => { if (attempt.prompt?.id === id) attempt.prompt = null; cleanup(); reject(aborted()); };
      const cleanup = () => prompt.signal?.removeEventListener('abort', withdraw);
      attempt.prompt = { id, resolve, reject, cleanup };
      prompt.signal?.addEventListener('abort', withdraw, { once: true });
      if (prompt.signal?.aborted || !this._live(attempt)) withdraw();
      this.phase = 'pending';
    });
  }
  async _settle(attempt, outcome, errorCode) {
    if (this.current !== attempt) return;
    if (!attempt.stopped && !errorCode && outcome?.status === 'authorized') {
      try {
        const meta = await this._inspect();
        if (!this._matches(attempt, meta)) this._stop(attempt, 'failed', 'conflict');
        else this.lastMeta = meta;
      } catch { this._stop(attempt, 'failed', 'service-unavailable'); }
    }
    attempt.running = false;
    this._clear(attempt);
    if (!attempt.stopped && !this.disposed) {
      if (errorCode) { this.phase = 'failed'; this.failure = errorCode; }
      else if (outcome?.status === 'authorized') { this.phase = 'succeeded'; this.failure = null; }
      else if (outcome?.status === 'cancelled') { this.phase = 'cancelled'; this.failure = null; }
      else { this.phase = 'failed'; this.failure = 'auth-failed'; }
    }
  }
  _callback(attempt, value) {
    const url = urlOf(value);
    if (!url || value.length > 8192 || url.origin !== 'http://localhost:1455' || url.pathname !== '/auth/callback'
      || [...url.searchParams.keys()].some(key => !['code', 'state', 'scope'].includes(key)) || !text(one(url, 'code'), 4096)
      || !equal(one(url, 'state'), attempt.state)) throw fail('invalid-callback');
    const canonical = new URL(CALLBACK);
    canonical.searchParams.set('code', one(url, 'code'));
    canonical.searchParams.set('state', one(url, 'state'));
    return canonical.href;
  }
  async mutate(payload) {
    if (this.disposed) throw fail('disposed');
    const action = payload?.action;
    if (action === 'start') {
      if (!allowed(payload, ['action', 'mode']) || !['browser', 'device_code'].includes(payload.mode)) throw fail('invalid-request');
      if (this.starting || this.current?.running) throw fail('busy');
      this.starting = true;
      try {
        const meta = await this._inspect();
        if (this.disposed) throw fail('disposed');
        if (!meta.flowAvailable) throw fail('flow-unavailable');
        if (!meta.routeConfigured) throw fail('route-missing');
        if (meta.apiKeyOverride) throw fail('api-key-override');
        if (!meta.endpointSupported) throw fail('endpoint-override');
        if (meta.inFlight) throw fail('busy');
        const attempt = { id: randomUUID(), mode: payload.mode, expiresAt: this.now() + this.timeoutMs, controller: new AbortController(),
          authorization: meta.authorization, fingerprint: meta.fingerprint, selected: false, running: true, stopped: false, prompt: null };
        this.current = attempt;
        this.lastMeta = meta;
        this.phase = 'starting';
        this.failure = null;
        attempt.timer = setTimeout(() => this._stop(attempt, 'expired', 'expired'), this.timeoutMs);
        attempt.timer.unref?.();
        attempt.promise = Promise.resolve().then(() => {
          if (!this._live(attempt)) return { status: 'cancelled' };
          return attempt.authorization.begin({ key: KEY, method: 'oauth', signal: attempt.controller.signal,
            interaction: { notify: notice => this._notice(attempt, notice), prompt: prompt => this._prompt(attempt, prompt) } });
        }).then(outcome => this._settle(attempt, outcome), error => {
          const code = error?.code;
          this._settle(attempt, null, code === 'ALREADY_IN_FLIGHT' ? 'busy' : code === 'NOT_COMMITTED' ? 'not-committed'
            : code === 'NO_FLOW' || code === 'UNKNOWN_METHOD' ? 'flow-unavailable' : 'auth-failed');
        });
        return this._snapshot(meta);
      } catch (error) {
        const code = error?.code;
        throw fail(this.disposed ? 'disposed' : ['busy', 'flow-unavailable', 'route-missing', 'api-key-override', 'endpoint-override', 'service-unavailable'].includes(code) ? code : 'service-unavailable');
      }
      finally { this.starting = false; }
    }
    if (action !== 'cancel' && action !== 'respond') throw fail('invalid-request');
    if (!allowed(payload, action === 'cancel' ? ['action', 'attemptId'] : ['action', 'attemptId', 'promptId', 'value'])) throw fail('invalid-request');
    if (!text(payload.attemptId, 64) || (action === 'respond' && (!text(payload.promptId, 64) || typeof payload.value !== 'string' || payload.value.length > 8192))) throw fail('invalid-request');
    const attempt = this.current;
    if (!attempt?.running || attempt.id !== payload.attemptId) throw fail('attempt-mismatch');
    if (action === 'cancel') { this._stop(attempt, 'cancelled'); return this._snapshot(); }
    let meta;
    try { meta = await this._inspect(); }
    catch { this._stop(attempt, 'failed', 'service-unavailable'); throw fail('service-unavailable'); }
    this.lastMeta = meta;
    if (!this._live(attempt) || this.now() >= attempt.expiresAt || !this._matches(attempt, meta)) {
      this._stop(attempt, 'failed', 'conflict'); throw fail('conflict');
    }
    if (!attempt.prompt || attempt.prompt.id !== payload.promptId) throw fail('prompt-mismatch');
    const value = this._callback(attempt, payload.value);
    const pending = attempt.prompt;
    attempt.prompt = null;
    pending.cleanup();
    pending.resolve(value);
    return this._snapshot(meta);
  }
  dispose() {
    if (this.disposed) return;
    if (this.current?.running) this._stop(this.current, 'cancelled');
    this.disposed = true;
  }
}
