import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUNDLED_COMPANY_RULES, COMPANY_RULES_URL, CompanyRulesManager, validateCompanyRules, validateCompanyRulesCache } from '../company-rules.js';

const copy = value => JSON.parse(JSON.stringify(value));
const NOW = Date.parse('2026-11-18T10:00:00.000Z');
const rules = revision => ({ ...copy(BUNDLED_COMPANY_RULES), revision });
const envelope = (value = BUNDLED_COMPANY_RULES, extra = {}) => ({ sourceUrl: COMPANY_RULES_URL, rules: copy(value), lastCheckedAt: NOW, lastUpdatedAt: null, ...extra });
function cacheFixture(initial) {
  let value = initial;
  let closed = 0;
  const writes = [];
  const cache = { persistent: true, async read() { return value; }, async write(next) { value = copy(next); writes.push(copy(next)); }, async close() { closed++; } };
  return { cache, writes, get value() { return value; }, get closed() { return closed; } };
}
const incoming = value => Response.json(value);

test('bundled source preserves baseline families while permitting data-only company expansion', () => {
  assert.equal(COMPANY_RULES_URL, 'https://raw.githubusercontent.com/WXYS1209/dsh-quota-cordis/main/company-rules.json');
  assert.equal(BUNDLED_COMPANY_RULES.schemaVersion, 1);
  assert.ok(BUNDLED_COMPANY_RULES.revision >= 2026111801);
  const ids = new Set(BUNDLED_COMPANY_RULES.companies.map(company => company.id));
  for (const id of ['openai', 'deepseek', 'moonshot-ai', 'anthropic', 'google-gemini', 'minimax', 'zhipu-ai', 'spacexsi-grok']) assert.ok(ids.has(id), id);
  const minimax = BUNDLED_COMPANY_RULES.companies.find(company => company.id === 'minimax');
  for (const domain of ['minimax.cn', 'minimax.io', 'minimaxi.com']) assert.ok(minimax.domains.includes(domain), domain);
  assert.ok(BUNDLED_COMPANY_RULES.companies.find(company => company.id === 'google-gemini').hostSuffixes.includes('googleapis.com'));
  assert.equal(BUNDLED_COMPANY_RULES.companies.find(company => company.id === 'spacexsi-grok').icon, 'xai');
  assert.ok(Object.isFrozen(BUNDLED_COMPANY_RULES.companies[0].names));
  assert.deepEqual(validateCompanyRules(BUNDLED_COMPANY_RULES), BUNDLED_COMPANY_RULES);
  const data = JSON.parse(readFileSync(new URL('../company-rules.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateCompanyRules(data), BUNDLED_COMPANY_RULES);
});

test('new company with null icon is data-only and can be validated without application code changes', () => {
  const value = rules(BUNDLED_COMPANY_RULES.revision + 1);
  value.companies.push({ id: 'future-company', names: { en: 'Future Company', zh: '未来公司' }, domains: ['future-company.org'], icon: null, evidence: ['https://future-company.org/docs/'] });
  const validated = validateCompanyRules(value);
  assert.equal(validated.companies.at(-1).id, 'future-company');
  value.companies.at(-1).names.en = 'Mutated caller';
  assert.equal(validated.companies.at(-1).names.en, 'Future Company');
});

test('strict schema rejects unknown keys, revisions, controls, remote icons and arbitrary URL execution', () => {
  const mutations = [
    value => { value.schemaVersion = 2; }, value => { value.revision = 0; }, value => { value.revision = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.extra = 'unsafe'; }, value => { value.companies[0].extra = true; }, value => { value.companies[0].names.de = 'Name'; },
    value => { value.companies[0].icon = 'https://evil.org/icon.svg'; }, value => { value.companies[0].icon = 'javascript:alert(1)'; },
    value => { value.companies[0].names.en = 'OpenAI\u202eOther'; }, value => { value.companies[0].names.zh = '名称\n伪装'; },
    value => { value.companies[0].names.en = '<script>alert(1)</script>'; }, value => { value.companies[0].names.en = 'javascript:alert(1)'; },
    value => { value.companies[0].id = '__proto__'; }, value => { value.companies[0].evidence = []; },
    value => { value.companies[0].evidence = ['javascript:alert(1)']; }, value => { value.companies[0].evidence = ['https://user:pass@openai.com/']; },
    value => { value.companies[0].evidence = ['https://openai.com/?token=secret']; }, value => { value.companies[0].evidence = ['https://127.0.0.1/']; },
    value => { value.updatedAt = '2026-02-30T00:00:00.000Z'; }, value => { value.companies = []; },
  ];
  for (const mutate of mutations) {
    const value = copy(BUNDLED_COMPANY_RULES); mutate(value);
    assert.throws(() => validateCompanyRules(value), { code: 'invalid-rules' });
  }
});

test('domains use canonical registrable public roots, with PSL wildcard/exception/private boundaries', () => {
  for (const domain of ['127.0.0.1', '2130706433', '[::1]', 'localhost', 'api.local', 'company.internal', 'company.invalid', 'company.unknown-tld', 'co.uk', 'github.io', 'googleapis.com', 'api.openai.com', 'OpenAI.com', 'openai.com.', 'https://openai.com', 'openai.com:443', 'openai.com/path', 'оpenai.com']) {
    const value = copy(BUNDLED_COMPANY_RULES); value.companies[0].domains = [domain];
    assert.throws(() => validateCompanyRules(value), { code: 'invalid-rules' }, domain);
  }
  for (const domain of ['example.co.uk', 'my-company.github.io', 'city.kawasaki.jp', 'foo.bar.ck']) {
    const value = copy(BUNDLED_COMPANY_RULES); value.companies[0].domains = [domain];
    assert.equal(validateCompanyRules(value).companies[0].domains[0], domain);
  }
});

test('overlapping assignments across families and blanket public host suffixes are rejected', () => {
  for (const change of [
    value => { value.companies[1].domains = ['openai.com']; },
    value => { value.companies[1].hostSuffixes = ['openai.com']; },
    value => { value.companies[0].hostSuffixes = ['googleapis.com']; },
    value => { value.companies[0].hostSuffixes = ['co.uk']; },
    value => { value.companies[0].hostSuffixes = ['github.io']; },
    value => { value.companies[0].domains.push('openai.com'); },
    value => { value.companies[1].id = value.companies[0].id; },
  ]) {
    const value = copy(BUNDLED_COMPANY_RULES); change(value);
    assert.throws(() => validateCompanyRules(value), { code: 'invalid-rules' });
  }
});

function exactHostDocument(companies) {
  return { ...rules(BUNDLED_COMPANY_RULES.revision + 1), companies };
}
function family(id, domains, extra = {}) {
  return { id, names: { en: id, zh: id }, domains, icon: null, evidence: [`https://${domains[0]}/docs/`], ...extra };
}

test('exactHosts accepts a precise hosted service without claiming sibling or descendant hosts', () => {
  const value = exactHostDocument([
    family('vercel-test', ['vercel.com'], { exactHosts: ['ai-gateway.vercel.sh'] }),
    family('other-service', ['other-company.org'], { exactHosts: ['another.vercel.sh', 'child.ai-gateway.vercel.sh'] }),
  ]);
  const parsed = validateCompanyRules(value);
  assert.deepEqual(parsed.companies[0].exactHosts, ['ai-gateway.vercel.sh']);
  assert.equal(parsed.companies[0].domains.includes('vercel.sh'), false);
  assert.deepEqual(parsed.companies[1].exactHosts, ['another.vercel.sh', 'child.ai-gateway.vercel.sh']);
  value.companies[0].exactHosts[0] = 'mutation.vercel.sh';
  assert.equal(parsed.companies[0].exactHosts[0], 'ai-gateway.vercel.sh');
  const cached = validateCompanyRulesCache(envelope(parsed));
  assert.equal(cached.rules.companies[0].exactHosts[0], 'ai-gateway.vercel.sh');
});

test('exactHosts requires canonical public hostnames with a PSL registrable root', () => {
  for (const host of ['127.0.0.1', '127.1', '[::1]', 'localhost', 'gateway.local', 'gateway.internal', 'gateway.invalid', 'co.uk', 'github.io', 'vercel.app', 'Gateway.vercel.sh', 'gateway.vercel.sh.', 'https://gateway.vercel.sh', 'gateway.vercel.sh:443', 'gateway.vercel.sh/path', 'gateway.vercel.sh?key=secret', 'gateway.vercel.sh#fragment', 'user@gateway.vercel.sh', 'gateway.vercel.sh\u202e', 'gаteway.vercel.sh']) {
    const value = exactHostDocument([family('host-test', ['future-company.org'], { exactHosts: [host] })]);
    assert.throws(() => validateCompanyRules(value), { code: 'invalid-rules' }, host);
  }
  for (const hosts of [['one.vercel.sh', 'one.vercel.sh'], Array.from({ length: 51 }, (_, index) => `host-${index}.vercel.sh`)]) {
    assert.throws(() => validateCompanyRules(exactHostDocument([family('host-test', ['future-company.org'], { exactHosts: hosts })])), { code: 'invalid-rules' });
  }
  const parsed = validateCompanyRules(exactHostDocument([family('host-test', ['future-company.org'], { exactHosts: ['tenant.github.io', 'gateway.tenant.github.io', 'foo.bar.ck'] })]));
  assert.equal(parsed.companies[0].exactHosts.length, 3);
});

test('exact-only and service-suffix companies do not need broad tenant-domain assignments', () => {
  const value = exactHostDocument([
    family('aws-test', [], {
      exactHosts: ['bedrock.us-east-1.amazonaws.com', 'bedrock-runtime.us-east-1.amazonaws.com'],
      evidence: ['https://docs.aws.amazon.com/bedrock/'],
    }),
    family('microsoft-test', ['microsoft.com'], {
      hostSuffixes: ['openai.azure.com', 'services.ai.azure.com'],
      evidence: ['https://learn.microsoft.com/azure/'],
    }),
    family('suffix-only', [], { hostSuffixes: ['api.future-company.org'], evidence: ['https://future-company.org/docs/'] }),
  ]);
  const parsed = validateCompanyRules(value);
  assert.deepEqual(parsed.companies[0].domains, []);
  assert.equal(parsed.companies[0].exactHosts.length, 2);
  assert.equal(parsed.companies[1].domains.includes('azure.com'), false);
  assert.deepEqual(parsed.companies[1].hostSuffixes, ['openai.azure.com', 'services.ai.azure.com']);
  assert.deepEqual(parsed.companies[2].domains, []);
  assert.doesNotThrow(() => validateCompanyRules(exactHostDocument([family('optional-empty', ['future-company.org'], { hostSuffixes: [], exactHosts: [] })])));
  for (const extra of [{}, { hostSuffixes: [], exactHosts: [] }]) {
    assert.throws(() => validateCompanyRules(exactHostDocument([family('no-selector', [], { ...extra, evidence: ['https://future-company.org/'] })])), { code: 'invalid-rules' });
  }
  for (const suffix of ['co.uk', 'github.io', 'vercel.app', 'gateway.local', 'api.internal', '127.0.0.1']) {
    assert.throws(() => validateCompanyRules(exactHostDocument([family('invalid-suffix', [], { hostSuffixes: [suffix], evidence: ['https://future-company.org/'] })])), { code: 'invalid-rules' }, suffix);
  }
});

test('exactHosts rejects cross-family exact, domain-root and hostSuffix claims in either order', () => {
  const precise = family('precise-service', ['future-company.org'], { exactHosts: ['ai-gateway.vercel.sh'] });
  const conflicts = [
    family('conflicting-service', ['other-company.org'], { exactHosts: ['ai-gateway.vercel.sh'] }),
    family('conflicting-service', ['vercel.sh']),
    family('conflicting-service', ['other-company.org'], { hostSuffixes: ['vercel.sh'] }),
  ];
  for (const conflict of conflicts) {
    assert.throws(() => validateCompanyRules(exactHostDocument([precise, conflict])), { code: 'invalid-rules' });
    assert.throws(() => validateCompanyRules(exactHostDocument([conflict, precise])), { code: 'invalid-rules' });
  }
  // Exact registrations are not suffix registrations: these are independent.
  assert.doesNotThrow(() => validateCompanyRules(exactHostDocument([
    precise, family('sibling-service', ['other-company.org'], { exactHosts: ['vercel.sh', 'child.ai-gateway.vercel.sh'] }),
  ])));
});

test('new exact-host company can arrive online with a null icon and no company ID enumeration', async () => {
  const value = exactHostDocument([family('future-service-not-in-bundle', ['future-company.org'], { exactHosts: ['brand-new.vercel.sh'] })]);
  const manager = new CompanyRulesManager({ now: () => NOW, fetcher: async () => incoming(value) });
  try {
    const snapshot = await manager.refresh();
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.rules.companies[0].id, 'future-service-not-in-bundle');
    assert.equal(snapshot.rules.companies[0].icon, null);
    assert.deepEqual(snapshot.rules.companies[0].exactHosts, ['brand-new.vercel.sh']);
  } finally { await manager.dispose(); }
});

test('cache envelope validates strict source identity, timestamps and rules', () => {
  assert.deepEqual(validateCompanyRulesCache(envelope()), envelope());
  for (const value of [
    envelope(undefined, { sourceUrl: 'https://other.org/company-rules.json' }),
    envelope(undefined, { authorization: 'secret' }), envelope(undefined, { lastCheckedAt: -1 }),
    envelope(undefined, { lastUpdatedAt: NOW + 1 }), envelope(undefined, { lastCheckedAt: null, lastUpdatedAt: NOW }),
    envelope(undefined, { lastCheckedAt: '2026-11-18' }),
  ]) assert.throws(() => validateCompanyRulesCache(value), { code: 'invalid-rules' });
});

test('local read never blocks on network; lazy check launches one fixed anonymous request', async () => {
  const f = cacheFixture(); let resolveFetch; const calls = [];
  const manager = new CompanyRulesManager({ cache: f.cache, now: () => NOW, fetcher: (url, options) => { calls.push({ url, options }); return new Promise(resolve => { resolveFetch = resolve; }); } });
  try {
    const snapshot = await manager.read();
    assert.equal(snapshot.rules.revision, BUNDLED_COMPANY_RULES.revision);
    assert.equal(snapshot.refreshing, true);
    assert.equal(calls.length, 1);
    await manager.read();
    assert.equal(calls.length, 1);
    const { url, options } = calls[0];
    assert.equal(url, COMPANY_RULES_URL);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert.equal('body' in options, false);
    resolveFetch(incoming(rules(BUNDLED_COMPANY_RULES.revision + 1)));
    const done = await manager.refresh();
    assert.equal(done.refreshing, false); assert.equal(done.source, 'online'); assert.equal(done.error, null);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(Object.keys(f.writes[0]).sort(), ['lastCheckedAt', 'lastUpdatedAt', 'rules', 'sourceUrl']);
  } finally { await manager.dispose(); }
  assert.equal(f.closed, 1);
});

test('constructor and unread disposal never initialize optional storage', async () => {
  let reads = 0, writes = 0, closed = 0;
  const manager = new CompanyRulesManager({ cache: { persistent: false, async read() { reads++; }, async write() { writes++; }, async close() { closed++; } } });
  assert.equal(reads, 0);
  await manager.dispose();
  await manager.read(); await manager.refresh();
  assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(closed, 1);
});

test('absent optional storage does not replace a not-published source error with a cache write error', async () => {
  let writes = 0;
  const cache = { persistent: false, async read() {}, async write() { writes++; throw Error('unavailable optional store'); }, async close() {} };
  const manager = new CompanyRulesManager({ cache, now: () => NOW, fetcher: async () => new Response('', { status: 404 }) });
  try {
    const snapshot = await manager.refresh();
    assert.equal(snapshot.error, 'not-published'); assert.equal(snapshot.persistent, false); assert.equal(writes, 0);
  } finally { await manager.dispose(); }
});

test('read check:false has no network, snapshots are detached, and empty cache starts bundled', async () => {
  let calls = 0;
  const manager = new CompanyRulesManager({ fetcher: () => { calls++; throw Error('unexpected'); } });
  try {
    const snapshot = await manager.read({ check: false });
    snapshot.rules.companies[0].names.en = 'Caller mutation';
    assert.equal((await manager.read({ check: false })).rules.companies[0].names.en, 'OpenAI');
    assert.equal(calls, 0); assert.equal(snapshot.source, 'bundled'); assert.equal(snapshot.persistent, false);
  } finally { await manager.dispose(); }
});

test('valid newer cache is immediate; automatic checks are due24h and refresh has60s cooldown', async () => {
  let now = NOW, calls = 0;
  const f = cacheFixture(envelope(rules(BUNDLED_COMPANY_RULES.revision + 1)));
  const manager = new CompanyRulesManager({ cache: f.cache, now: () => now, fetcher: async () => { calls++; return incoming(rules(BUNDLED_COMPANY_RULES.revision + 2)); } });
  try {
    assert.equal((await manager.read()).source, 'cache'); assert.equal(calls, 0);
    await manager.refresh(); assert.equal(calls, 0);
    now += 60_000;
    await manager.refresh(); assert.equal(calls, 1);
    await manager.refresh(); assert.equal(calls, 1);
    now += 24 * 60 * 60 * 1000 - 1;
    await manager.read(); assert.equal(calls, 1);
    now++;
    await manager.read(); await manager.refresh(); assert.equal(calls, 2);
  } finally { await manager.dispose(); }
});

test('404 and network failures keep last-good mapping and persist checks, never raw failures', async () => {
  for (const fetcher of [async () => new Response('', { status: 404 }), async () => { throw Error('https://secret-user:secret-key@private/path'); }]) {
    const f = cacheFixture(envelope(rules(BUNDLED_COMPANY_RULES.revision + 1), { lastCheckedAt: NOW - 24 * 60 * 60 * 1000 }));
    const manager = new CompanyRulesManager({ cache: f.cache, fetcher, now: () => NOW });
    try {
      const snapshot = await manager.refresh();
      assert.equal(snapshot.source, 'cache'); assert.equal(snapshot.rules.revision, BUNDLED_COMPANY_RULES.revision + 1);
      assert.ok(['not-published', 'network'].includes(snapshot.error));
      assert.equal(snapshot.lastCheckedAt, NOW); assert.equal(f.writes[0].lastCheckedAt, NOW);
      assert.equal(JSON.stringify(snapshot).includes('secret-key'), false);
      assert.equal(JSON.stringify(f.writes).includes('secret-key'), false);
      assert.equal('error' in f.writes[0], false);
    } finally { await manager.dispose(); }
    let restartCalls = 0;
    const restart = new CompanyRulesManager({ cache: f.cache, now: () => NOW + 1, fetcher: () => { restartCalls++; } });
    try { await restart.read(); assert.equal(restartCalls, 0); } finally { await restart.dispose(); }
  }
});

test('lower revision or same-revision content changes are rollback, without replacing known rules', async () => {
  for (const changed of [rules(BUNDLED_COMPANY_RULES.revision), (() => { const value = rules(BUNDLED_COMPANY_RULES.revision + 1); value.companies[0].names.en = 'Changed'; return value; })()]) {
    const f = cacheFixture(envelope(rules(BUNDLED_COMPANY_RULES.revision + 1), { lastCheckedAt: NOW - 60_000 }));
    const manager = new CompanyRulesManager({ cache: f.cache, now: () => NOW, fetcher: async () => incoming(changed) });
    try {
      const snapshot = await manager.refresh();
      assert.equal(snapshot.error, 'rollback'); assert.equal(snapshot.rules.companies[0].names.en, 'OpenAI');
      assert.equal(snapshot.rules.revision, BUNDLED_COMPANY_RULES.revision + 1);
    } finally { await manager.dispose(); }
  }
});

test('older or conflicting bundled-revision cache cannot override bundled mappings', async () => {
  for (const cached of [rules(BUNDLED_COMPANY_RULES.revision - 1), (() => { const value = copy(BUNDLED_COMPANY_RULES); value.companies[0].names.en = 'Changed'; return value; })()]) {
    const f = cacheFixture(envelope(cached));
    const manager = new CompanyRulesManager({ cache: f.cache });
    try { const snapshot = await manager.read({ check: false }); assert.equal(snapshot.source, 'bundled'); assert.equal(snapshot.error, 'rollback'); assert.deepEqual(snapshot.rules, BUNDLED_COMPANY_RULES); }
    finally { await manager.dispose(); }
  }
});

test('cache errors retain good in-memory downloads with safe persistent=false status', async () => {
  const cache = { persistent: true, async read() { throw Error('secret storage path'); }, async write() { throw Error('secret cache failure'); }, async close() {} };
  const manager = new CompanyRulesManager({ cache, now: () => NOW, fetcher: async () => incoming(rules(BUNDLED_COMPANY_RULES.revision + 1)) });
  try {
    const initial = await manager.read({ check: false }); assert.equal(initial.error, 'cache-unavailable'); assert.equal(initial.persistent, false);
    const next = await manager.refresh(); assert.equal(next.rules.revision, BUNDLED_COMPANY_RULES.revision + 1); assert.equal(next.source, 'online'); assert.equal(next.error, 'cache-unavailable'); assert.equal(next.persistent, false);
    assert.equal(JSON.stringify(next).includes('secret'), false);
  } finally { await manager.dispose(); }
});

test('streaming cap rejects oversized declared/actual content, empty/malformed JSON and invalid UTF8', async () => {
  const fetchers = [
    async () => new Response('x', { headers: { 'Content-Length': String(128 * 1024 + 1) } }),
    async () => new Response(new Uint8Array(128 * 1024 + 1)),
    async () => new Response(''), async () => new Response('{'), async () => new Response(new Uint8Array([0xff])),
    async () => incoming({}), async () => new Response('', { status: 500 }),
  ];
  for (let index = 0; index < fetchers.length; index++) {
    const manager = new CompanyRulesManager({ now: () => NOW, fetcher: fetchers[index] });
    try { const snapshot = await manager.refresh(); assert.equal(snapshot.error, index === fetchers.length - 1 ? 'http-error' : 'invalid-rules'); assert.equal(snapshot.source, 'bundled'); }
    finally { await manager.dispose(); }
  }
});

test('total deadline bounds ignored fetch cancellation and stalled stream reads with no retries', async () => {
  for (const stallBody of [false, true]) {
    let calls = 0, canceled = false;
    const manager = new CompanyRulesManager({ now: () => NOW, timeoutMs: 5, fetcher: () => {
      calls++;
      return stallBody ? new Response(new ReadableStream({ cancel() { canceled = true; } })) : new Promise(() => {});
    } });
    try { const snapshot = await manager.refresh(); assert.equal(snapshot.error, 'timeout'); assert.equal(calls, 1); if (stallBody) assert.equal(canceled, true); }
    finally { await manager.dispose(); }
  }
});

test('dispose aborts lazy fetch, waits for completion, closes cache once and disallows new traffic', async () => {
  let calls = 0;
  const f = cacheFixture();
  const manager = new CompanyRulesManager({ cache: f.cache, now: () => NOW, fetcher: () => { calls++; return new Promise(() => {}); } });
  await manager.read();
  await manager.dispose(); await manager.dispose();
  const snapshot = await manager.refresh(); await manager.read();
  assert.equal(calls, 1); assert.equal(snapshot.refreshing, false); assert.equal(f.closed, 1); assert.equal(f.writes.length, 0);
});

test('pending cache read cannot launch work after disposal; pending write settles before close', async () => {
  let releaseRead, releaseWrite, closed = 0, calls = 0;
  const readCache = { persistent: true, read: () => new Promise(resolve => { releaseRead = resolve; }), async write() { throw Error('must not write'); }, async close() { closed++; } };
  const manager = new CompanyRulesManager({ cache: readCache, fetcher: () => { calls++; } });
  const reading = manager.read(); const disposing = manager.dispose();
  releaseRead(envelope(rules(BUNDLED_COMPANY_RULES.revision + 1)));
  await reading; await disposing;
  assert.equal(calls, 0); assert.equal(closed, 1); assert.equal((await manager.read({ check: false })).source, 'bundled');
  let beginWrite;
  const writeStarted = new Promise(resolve => { beginWrite = resolve; });
  const writeCache = { persistent: true, async read() {}, write: () => new Promise(resolve => { releaseWrite = resolve; beginWrite(); }), async close() { closed++; } };
  const writing = new CompanyRulesManager({ cache: writeCache, now: () => NOW, fetcher: async () => incoming(rules(BUNDLED_COMPANY_RULES.revision + 1)) });
  const refresh = writing.refresh();
  await writeStarted;
  const closing = writing.dispose(); assert.equal(closed, 1);
  releaseWrite(); await refresh; await closing; assert.equal(closed, 2);
});
