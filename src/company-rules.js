import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { LOCAL_COMPANY_ICON_KEYS } from './company-brand-marks.js';

export const COMPANY_RULES_URL = 'https://raw.githubusercontent.com/WXYS1209/dsh-quota-cordis/main/company-rules.json';
const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 8000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const ICONS = new Set(LOCAL_COMPANY_ICON_KEYS);
const SAFE_ERRORS = new Set(['not-published', 'network', 'timeout', 'invalid-rules', 'http-error', 'rollback', 'cache-unavailable']);
const invalid = () => Object.assign(new Error('invalid-rules'), { code: 'invalid-rules' });
const failure = code => Object.assign(new Error(code), { code });
const clone = value => JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const exact = new Set(), wildcard = new Set(), exception = new Set();
for (const raw of readFileSync(new URL('./data/public_suffix_list.dat', import.meta.url), 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('//')) continue;
  const kind = line.startsWith('!') ? exception : line.startsWith('*.') ? wildcard : exact;
  const value = line.replace(/^!|^\*\./, '');
  try { kind.add(new URL(`https://${value}/`).hostname); } catch { throw invalid(); }
}
const knownTlds = new Set([...exact, ...wildcard, ...exception].map(value => value.split('.').at(-1)));
const reserved = /(?:^|\.)(?:local|localhost|internal|invalid|test|example|onion|arpa|lan|home)$/;
function object(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !own(value, key))) throw invalid();
}
function hostname(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase() || reserved.test(value) || isIP(value) || !/^[a-z0-9.-]+$/.test(value)) throw invalid();
  const labels = value.split('.');
  if (labels.length < 2 || !knownTlds.has(labels.at(-1)) || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw invalid();
  try { if (new URL(`https://${value}/`).hostname !== value) throw invalid(); } catch { throw invalid(); }
  return labels;
}
function suffixLength(labels) {
  let best = 1;
  for (let index = 0; index < labels.length; index++) {
    const suffix = labels.slice(index).join('.');
    if (exception.has(suffix)) return labels.length - index - 1;
    if (exact.has(suffix)) best = Math.max(best, labels.length - index);
    if (index < labels.length - 1 && wildcard.has(labels.slice(index + 1).join('.'))) best = Math.max(best, labels.length - index);
  }
  return best;
}
function root(value) {
  const labels = hostname(value);
  if (labels.length !== suffixLength(labels) + 1) throw invalid();
  return value;
}
function hostSuffix(value) {
  const labels = hostname(value);
  // A service-owned PSL delegation such as googleapis.com is allowed, but a
  // bare TLD, private-network suffix or malformed hostname never is.
  if (value !== 'googleapis.com' && labels.length <= suffixLength(labels)) throw invalid();
  return value;
}
function exactHost(value) {
  const labels = hostname(value);
  if (labels.length <= suffixLength(labels)) throw invalid();
  return value;
}
function registrableHostRoot(value) {
  const labels = hostname(value);
  return labels.slice(-(suffixLength(labels) + 1)).join('.');
}
function text(value) {
  if (typeof value !== 'string' || !value || value.length > 80 || value.trim() !== value || /[\p{C}\p{Zl}\p{Zp}<>\\]/u.test(value) || /(?:https?:\/\/|javascript:|data:)/i.test(value)) throw invalid();
  return value;
}
function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== (value.includes('.') ? value : value.replace('Z', '.000Z'))) throw invalid();
  return date.toISOString();
}
function evidenceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\p{C}\s\\]/u.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.href !== value) throw invalid();
  hostname(url.hostname);
  return value;
}
function list(value, check, max, allowEmpty = false) {
  if (!Array.isArray(value) || value.length < (allowEmpty ? 0 : 1) || value.length > max) throw invalid();
  const result = value.map(check);
  if (new Set(result).size !== result.length) throw invalid();
  return result;
}
function overlaps(left, right) { return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`); }
function conflictingAssignments(left, right) {
  if (left.id === right.id) return false;
  if (left.kind === 'exact' && right.kind === 'exact') return left.domain === right.domain;
  const precise = left.kind === 'exact' ? left : right.kind === 'exact' ? right : null;
  if (!precise) return overlaps(left.domain, right.domain);
  const broad = precise === left ? right : left;
  return broad.kind === 'domain'
    ? registrableHostRoot(precise.domain) === broad.domain
    : precise.domain === broad.domain || precise.domain.endsWith(`.${broad.domain}`);
}

export function validateCompanyRules(value) {
  object(value, ['schemaVersion', 'revision', 'updatedAt', 'companies']);
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision <= 0 || !Array.isArray(value.companies) || value.companies.length < 1 || value.companies.length > 100) throw invalid();
  const ids = new Set();
  const assignments = [];
  const companies = value.companies.map(company => {
    object(company, ['id', 'names', 'domains', 'hostSuffixes', 'exactHosts', 'icon', 'evidence'], ['id', 'names', 'domains', 'icon', 'evidence']);
    if (typeof company.id !== 'string' || company.id.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(company.id) || ids.has(company.id)) throw invalid();
    ids.add(company.id);
    object(company.names, ['en', 'zh']);
    if (company.icon !== null && !ICONS.has(company.icon)) throw invalid();
    const domains = list(company.domains, root, 50, true);
    const suffixes = own(company, 'hostSuffixes') ? list(company.hostSuffixes, hostSuffix, 50, true) : undefined;
    const exactHosts = own(company, 'exactHosts') ? list(company.exactHosts, exactHost, 50, true) : undefined;
    if (domains.length + (suffixes?.length ?? 0) + (exactHosts?.length ?? 0) < 1) throw invalid();
    const claims = [
      ...domains.map(domain => ({ domain, kind: 'domain', id: company.id })),
      ...(suffixes ?? []).map(domain => ({ domain, kind: 'suffix', id: company.id })),
      ...(exactHosts ?? []).map(domain => ({ domain, kind: 'exact', id: company.id })),
    ];
    for (const claim of claims) {
      if (assignments.some(assignment => conflictingAssignments(assignment, claim))) throw invalid();
      assignments.push(claim);
    }
    return { id: company.id, names: { en: text(company.names.en), zh: text(company.names.zh) }, domains, ...(suffixes ? { hostSuffixes: suffixes } : {}), ...(exactHosts ? { exactHosts } : {}), icon: company.icon, evidence: list(company.evidence, evidenceUrl, 10) };
  });
  return { schemaVersion: 1, revision: value.revision, updatedAt: isoDate(value.updatedAt), companies };
}
function timestamp(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw invalid();
  return value;
}
export function validateCompanyRulesCache(value) {
  object(value, ['sourceUrl', 'rules', 'lastCheckedAt', 'lastUpdatedAt']);
  if (value.sourceUrl !== COMPANY_RULES_URL) throw invalid();
  const lastCheckedAt = timestamp(value.lastCheckedAt), lastUpdatedAt = timestamp(value.lastUpdatedAt);
  if (lastUpdatedAt !== null && (lastCheckedAt === null || lastUpdatedAt > lastCheckedAt)) throw invalid();
  return { sourceUrl: COMPANY_RULES_URL, rules: validateCompanyRules(value.rules), lastCheckedAt, lastUpdatedAt };
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export const BUNDLED_COMPANY_RULES = freeze(validateCompanyRules(JSON.parse(readFileSync(new URL('../company-rules.json', import.meta.url), 'utf8'))));

function cancelBody(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {}
}
function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('timeout'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function download(fetcher, signal, maxBytes) {
  const response = await fetcher(COMPANY_RULES_URL, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal, headers: { Accept: 'application/json' } });
  if (signal.aborted) { cancelBody(response?.body); throw failure('timeout'); }
  if (!response || typeof response.ok !== 'boolean') throw invalid();
  if (!response.ok) { cancelBody(response.body); throw failure(response.status === 404 ? 'not-published' : 'http-error'); }
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) { cancelBody(response.body); throw invalid(); }
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const parts = [];
  let size = 0;
  const cancel = () => cancelBody(reader);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const item = await reader.read();
      if (signal.aborted) throw failure('timeout');
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw invalid();
      size += item.value.byteLength;
      if (size > maxBytes) throw invalid();
      parts.push(item.value);
    }
    if (!size) throw invalid();
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
    return validateCompanyRules(JSON.parse(raw));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancelBody(reader);
    try { reader.releaseLock(); } catch {}
  }
}

export class CompanyRulesManager {
  constructor({ cache, fetcher = fetch, now = Date.now, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
    this.cache = cache;
    this.fetcher = fetcher;
    this.now = now;
    this.timeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, TIMEOUT_MS) : TIMEOUT_MS;
    this.maxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, MAX_BYTES) : MAX_BYTES;
    this.rules = BUNDLED_COMPANY_RULES;
    this.source = 'bundled';
    this.lastCheckedAt = null;
    this.lastUpdatedAt = null;
    this.error = null;
    this.persistent = Boolean(cache && cache.persistent !== false);
    this.disposed = false;
    this.inflight = null;
    this.controller = null;
    this.initialized = null;
  }
  ensureInitialized() {
    if (!this.initialized) this.initialized = this.initialize();
    return this.initialized;
  }
  async initialize() {
    if (!this.cache) return;
    try {
      const raw = await this.cache.read();
      if (this.disposed) return;
      this.persistent = this.cache.persistent !== false;
      if (raw === undefined) return;
      const cached = validateCompanyRulesCache(raw);
      if (cached.rules.revision < BUNDLED_COMPANY_RULES.revision || cached.rules.revision === BUNDLED_COMPANY_RULES.revision && JSON.stringify(cached.rules) !== JSON.stringify(BUNDLED_COMPANY_RULES)) throw failure('rollback');
      this.rules = freeze(cached.rules);
      this.source = 'cache';
      this.lastCheckedAt = cached.lastCheckedAt;
      this.lastUpdatedAt = cached.lastUpdatedAt;
    } catch (cause) {
      if (this.disposed) return;
      this.error = SAFE_ERRORS.has(cause?.code) ? cause.code : 'cache-unavailable';
      this.persistent = false;
    }
  }
  snapshot() {
    return { rules: clone(this.rules), source: this.source, lastCheckedAt: this.lastCheckedAt, lastUpdatedAt: this.lastUpdatedAt, error: this.error, refreshing: !this.disposed && this.inflight !== null, persistent: this.persistent && this.cache?.persistent !== false };
  }
  async read({ check = true } = {}) {
    if (this.disposed) return this.snapshot();
    await this.ensureInitialized();
    const now = this.now();
    if (check && !this.disposed && (this.lastCheckedAt === null || now < this.lastCheckedAt || now - this.lastCheckedAt >= CHECK_INTERVAL_MS)) this.launch();
    return this.snapshot();
  }
  launch() {
    if (this.disposed || this.inflight) return this.inflight;
    const now = this.now();
    if (this.lastCheckedAt !== null && now >= this.lastCheckedAt && now - this.lastCheckedAt < COOLDOWN_MS) return null;
    // Handle even unexpected failures before publishing the tracked promise, so
    // lazy reads cannot create unhandled rejections and refresh settles idle.
    const work = this.update().catch(() => { if (!this.disposed) this.error = 'network'; });
    const tracked = work.finally(() => { if (this.inflight === tracked) this.inflight = null; });
    this.inflight = tracked;
    return tracked;
  }
  async refresh() {
    if (this.disposed) return this.snapshot();
    await this.ensureInitialized();
    const work = this.inflight ?? this.launch();
    if (work) { try { await work; } catch {} }
    return this.snapshot();
  }
  async update() {
    const checkedAt = this.now();
    this.lastCheckedAt = checkedAt;
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const next = await abortable(() => download(this.fetcher, controller.signal, this.maxBytes), controller.signal);
      if (this.disposed) return;
      if (next.revision < this.rules.revision || next.revision === this.rules.revision && JSON.stringify(next) !== JSON.stringify(this.rules)) throw failure('rollback');
      if (JSON.stringify(next) !== JSON.stringify(this.rules)) this.lastUpdatedAt = checkedAt;
      this.rules = freeze(next);
      this.source = 'online';
      this.error = null;
    } catch (cause) {
      if (this.disposed) return;
      this.error = controller.signal.aborted ? 'timeout' : SAFE_ERRORS.has(cause?.code) ? cause.code : cause instanceof SyntaxError || cause instanceof TypeError && cause.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' ? 'invalid-rules' : 'network';
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (this.controller === controller) this.controller = null;
    }
    if (this.disposed || !this.cache || this.cache.persistent === false) return;
    try {
      await this.cache.write({ sourceUrl: COMPANY_RULES_URL, rules: clone(this.rules), lastCheckedAt: this.lastCheckedAt, lastUpdatedAt: this.lastUpdatedAt });
      if (!this.disposed) this.persistent = this.cache.persistent !== false;
    } catch {
      if (!this.disposed) { this.error = 'cache-unavailable'; this.persistent = false; }
    }
  }
  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.controller?.abort();
    this.disposePromise = (async () => {
      await this.initialized;
      if (this.inflight) { try { await this.inflight; } catch {} }
      try { await this.cache?.close(); } catch {}
    })();
    return this.disposePromise;
  }
}
