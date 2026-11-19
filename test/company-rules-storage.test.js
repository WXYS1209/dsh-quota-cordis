import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_COMPANY_RULES, COMPANY_RULES_URL, validateCompanyRulesCache } from '../src/company-rules.js';
import { COMPANY_RULES_DOMAIN_SPEC, createCompanyRulesCache } from '../src/company-rules-storage.js';

const envelope = () => {
  const timestamp = Date.parse(BUNDLED_COMPANY_RULES.updatedAt) + 1000;
  return { sourceUrl: COMPANY_RULES_URL, rules: BUNDLED_COMPANY_RULES, lastCheckedAt: timestamp, lastUpdatedAt: timestamp };
};
function fixture(initial, options = {}) {
  const records = new Map(initial === undefined ? [] : [['current', initial]]);
  const calls = { gets: [], opens: 0, closes: 0, reads: 0, puts: 0, specs: [] };
  const table = {
    get(key) { calls.reads++; assert.equal(key, 'current'); if (options.getError) throw options.getError; return records.get(key); },
    async put(key, value) { calls.puts++; assert.equal(key, 'current'); if (options.putError) throw options.putError; records.set(key, value); },
  };
  const domain = { table(name) { assert.equal(name, 'cache'); return table; }, async close() { calls.closes++; if (options.closeError) throw options.closeError; } };
  const facility = { async open(spec) {
    calls.opens++; calls.specs.push(spec);
    if (options.openError) throw options.openError;
    if (options.openWait) await options.openWait;
    for (const [key, value] of records) records.set(key, spec.tables.cache.valueSchema.parse(value));
    return domain;
  } };
  const context = { get(key) { calls.gets.push(key); if (options.contextError) throw options.contextError; return facility; } };
  return { records, calls, context, facility };
}

test('company rule cache declares the rc.3 DomainFacility schema contract and validates records', () => {
  assert.equal(COMPANY_RULES_DOMAIN_SPEC.name, 'provider-quota-company-rules');
  assert.equal(COMPANY_RULES_DOMAIN_SPEC.version, 1);
  assert.deepEqual(Object.keys(COMPANY_RULES_DOMAIN_SPEC.tables), ['cache']);
  assert.deepEqual(COMPANY_RULES_DOMAIN_SPEC.tables.cache.valueSchema.parse(envelope()), validateCompanyRulesCache(envelope()));
  assert.throws(() => COMPANY_RULES_DOMAIN_SPEC.tables.cache.valueSchema.parse({ secret: 'must-not-survive' }));
});

test('optional absent storage stays in memory without opening files or changing profile state', async () => {
  const keys = [];
  const cache = createCompanyRulesCache({ get(key) { keys.push(key); return undefined; } });
  assert.equal(cache.persistent, false);
  assert.deepEqual(keys, [], 'opening is lazy');
  assert.equal(await cache.read(), undefined);
  assert.equal(await cache.read(), undefined);
  await assert.rejects(cache.write(envelope()), { code: 'cache-unavailable' });
  assert.deepEqual(keys, ['storageDomain']);
  assert.equal(cache.persistent, false);
  await Promise.all([cache.close(), cache.close()]);
  assert.equal(await cache.read(), undefined);
});

test('one lazy domain handle reads, writes detached envelopes and closes exactly once', async () => {
  const f = fixture();
  const cache = createCompanyRulesCache(f.context);
  assert.equal(f.calls.opens, 0);
  assert.equal(await cache.read(), undefined);
  assert.equal(cache.persistent, true);
  const value = envelope();
  await cache.write(value);
  value.lastCheckedAt = 0;
  const read = await cache.read();
  assert.notEqual(read.lastCheckedAt, 0);
  read.rules.companies[0].names.en = 'Mutated';
  assert.notEqual((await cache.read()).rules.companies[0].names.en, 'Mutated');
  assert.equal(f.calls.opens, 1);
  assert.deepEqual(f.calls.gets, ['storageDomain']);
  await Promise.all([cache.close(), cache.close()]);
  assert.equal(f.calls.closes, 1);
  assert.equal(cache.persistent, false);
  await assert.rejects(cache.write(envelope()), { code: 'cache-unavailable' });
  assert.equal(f.calls.puts, 1);
});

test('new adapter reopens the same durable cache without network or credential access', async () => {
  const f = fixture();
  const first = createCompanyRulesCache(f.context);
  await first.write(envelope());
  await first.close();
  const second = createCompanyRulesCache(f.context);
  assert.deepEqual(await second.read(), validateCompanyRulesCache(envelope()));
  assert.equal(second.persistent, true);
  await second.close();
  assert.equal(f.calls.opens, 2);
  assert.equal(f.calls.closes, 2);
});

test('context, open and invalid stored-record failures retire persistence for this adapter lifetime', async () => {
  for (const options of [
    { contextError: Error('private profile path') },
    { openError: Error('private backend state') },
    {},
  ]) {
    const f = fixture(Object.keys(options).length ? undefined : { secret: 'invalid cache' }, options);
    const cache = createCompanyRulesCache(f.context);
    assert.equal(await cache.read(), undefined);
    assert.equal(cache.persistent, false);
    const opens = f.calls.opens;
    await assert.rejects(cache.write(envelope()), error => error.code === 'cache-unavailable' && error.message === 'cache-unavailable');
    assert.equal(await cache.read(), undefined);
    assert.equal(f.calls.opens, opens);
    await cache.close();
  }
});

test('read failures close the uncertain handle and never reuse its stale records', async () => {
  const f = fixture(envelope(), { getError: Object.assign(Error('private unknown outcome'), { code: 'unknown-state' }) });
  const cache = createCompanyRulesCache(f.context);
  await assert.rejects(cache.read(), { code: 'cache-unavailable', message: 'cache-unavailable' });
  assert.equal(cache.persistent, false);
  assert.equal(await cache.read(), undefined);
  await assert.rejects(cache.write(envelope()), { code: 'cache-unavailable' });
  await cache.close();
  assert.equal(f.calls.opens, 1);
  assert.equal(f.calls.reads, 1);
  assert.equal(f.calls.puts, 0);
  assert.equal(f.calls.closes, 1);
});

test('unknown write outcome disables and closes cache before any later use', async () => {
  const f = fixture(envelope(), { putError: Object.assign(Error('private commit failure'), { code: 'unknown-state' }), closeError: Error('private close failure') });
  const cache = createCompanyRulesCache(f.context);
  await cache.read();
  await assert.rejects(cache.write(envelope()), { code: 'cache-unavailable', message: 'cache-unavailable' });
  assert.equal(cache.persistent, false);
  assert.equal(await cache.read(), undefined);
  await assert.rejects(cache.write(envelope()), { code: 'cache-unavailable' });
  await cache.close();
  assert.equal(f.calls.puts, 1);
  assert.equal(f.calls.closes, 1);
});

test('invalid writes are rejected before touching persistence and do not poison a healthy handle', async () => {
  const f = fixture(); const cache = createCompanyRulesCache(f.context);
  await assert.rejects(cache.write({ rules: { secret: 'private' } }));
  assert.equal(f.calls.opens, 0);
  assert.equal(await cache.read(), undefined);
  assert.equal(cache.persistent, true);
  await cache.close();
});

test('closing during lazy open releases the late handle once and prevents reads or writes', async () => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const f = fixture(envelope(), { openWait: wait });
  const cache = createCompanyRulesCache(f.context);
  const reading = cache.read();
  const closing = cache.close();
  release();
  assert.equal(await reading, undefined);
  await closing;
  await cache.close();
  assert.equal(f.calls.closes, 1);
  assert.equal(f.calls.reads, 0);
  assert.equal(cache.persistent, false);
});
