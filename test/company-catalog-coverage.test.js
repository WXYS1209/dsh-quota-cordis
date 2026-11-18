import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Normal tests are installation-independent: the separate extractor refreshes
// this public shipped-catalog fixture using the running DSH Electron runtime.
const catalog = JSON.parse(await readFile(new URL('./fixtures/dsh-provider-catalog.json', import.meta.url), 'utf8'));
const rules = JSON.parse(await readFile(new URL('../company-rules.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pureBlock = source.split('// BEGIN PURE LAYOUT')[1]?.split('// END PURE LAYOUT')[0];
assert.ok(pureBlock, 'the production pure classifier must be testable without browser emulation');
const { modelProviderCompanyFamilyFromUrl } = vm.runInNewContext(`${pureBlock}\n({modelProviderCompanyFamilyFromUrl})`, { URL });

function endpointFact(value) {
  assert.equal(typeof value, 'string');
  const authority = value.match(/^https:\/\/([^/?#]+)/)?.[1];
  assert.ok(authority && !authority.includes('@'), `invalid public endpoint: ${value}`);
  const labels = authority.split('.');
  const lastTemplateLabel = labels.findLastIndex(label => /[{}]/.test(label));
  if (lastTemplateLabel >= 0) {
    // Only complete literal DNS labels after the final templated label are
    // evidence. Never substitute dummy location/account/region values.
    const suffix = labels.slice(lastTemplateLabel + 1).join('.');
    if (suffix.split('.').length < 2) return { kind: 'no-fixed-host', value };
    assert.match(suffix, /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/);
    return { kind: 'templated-host', suffix, value };
  }
  const url = new URL(value);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  return { kind: 'fixed-host', hostname: url.hostname, value };
}
function coverageFor(endpoints) {
  const unmatched = [], fixedHosts = new Set(), templateSuffixes = new Set();
  let withoutFixedHost = 0;
  for (const { provider, endpoint } of endpoints) {
    const fact = endpointFact(endpoint);
    if (fact.kind === 'no-fixed-host') { withoutFixedHost++; continue; }
    if (fact.kind === 'fixed-host') {
      fixedHosts.add(fact.hostname);
      if (!modelProviderCompanyFamilyFromUrl(endpoint, rules.companies)) unmatched.push(`${provider}: ${fact.hostname}`);
    } else {
      templateSuffixes.add(fact.suffix);
      const matches = rules.companies.filter(company => (company.hostSuffixes ?? []).some(suffix => fact.suffix === suffix || fact.suffix.endsWith(`.${suffix}`)));
      if (matches.length !== 1) unmatched.push(`${provider}: templated-host trusted suffix ${fact.suffix}`);
    }
  }
  return { unmatched: [...new Set(unmatched)].sort(), fixedHosts: [...fixedHosts].sort(), templateSuffixes: [...templateSuffixes].sort(), withoutFixedHost };
}

test('official public catalog fixture contains canonical metadata only, not auth or profile values', () => {
  assert.deepEqual(Object.keys(catalog), ['schemaVersion', 'dshVersion', 'piAiVersion', 'providers']);
  assert.equal(catalog.schemaVersion, 1);
  assert.match(catalog.dshVersion, /^\d+\.\d+\.\d+/);
  assert.match(catalog.piAiVersion, /^\d+\.\d+\.\d+/);
  assert.ok(catalog.providers.length >= 42, 'fixture must retain all current built-in providers');
  const ids = catalog.providers.map(provider => provider.id);
  assert.deepEqual(ids, [...new Set(ids)].sort());
  for (const provider of catalog.providers) {
    assert.deepEqual(Object.keys(provider), ['id', 'name', 'defaultBaseURL', 'modelBaseURLs', 'baseURLEnv']);
    assert.equal(typeof provider.id, 'string');
    assert.equal(typeof provider.name, 'string');
    assert.ok(provider.defaultBaseURL === null || typeof provider.defaultBaseURL === 'string');
    assert.deepEqual(provider.modelBaseURLs, [...new Set(provider.modelBaseURLs)].sort());
    assert.deepEqual(provider.baseURLEnv, [...new Set(provider.baseURLEnv)].sort());
    for (const name of provider.baseURLEnv) assert.match(name, /^[A-Z_][A-Z0-9_]*$/);
    for (const endpoint of [provider.defaultBaseURL, ...provider.modelBaseURLs].filter(Boolean)) endpointFact(endpoint);
  }
});

test('company rules cover every fixed official DSH catalog default endpoint', t => {
  const endpoints = catalog.providers.filter(provider => provider.defaultBaseURL !== null).map(provider => ({ provider: provider.id, endpoint: provider.defaultBaseURL }));
  const coverage = coverageFor(endpoints);
  assert.deepEqual(coverage.unmatched, [], `Add verified company rules for new official defaults: ${coverage.unmatched.join('; ')}`);
  t.diagnostic(`${endpoints.length} default endpoints / ${coverage.fixedHosts.length} distinct fixed hosts covered`);
});

test('company rules cover every official model endpoint or explicit trusted hostname-template suffix', t => {
  const endpoints = catalog.providers.flatMap(provider => provider.modelBaseURLs.map(endpoint => ({ provider: provider.id, endpoint })));
  const coverage = coverageFor(endpoints);
  assert.deepEqual(coverage.unmatched, [], `Add verified company rules for new official model endpoints: ${coverage.unmatched.join('; ')}`);
  assert.equal(coverage.withoutFixedHost, 0, 'new fully variable-host model endpoints need explicit review, never invented sample hosts');
  t.diagnostic(`${endpoints.length} model endpoint patterns / ${coverage.fixedHosts.length} distinct fixed hosts / ${coverage.templateSuffixes.length} trusted template suffixes covered`);
});

test('no-fixed-endpoint catalog entries are distinct from unmapped official hostnames', () => {
  const noEndpoint = catalog.providers.filter(provider => provider.defaultBaseURL === null && provider.modelBaseURLs.length === 0).map(provider => provider.id);
  assert.deepEqual(noEndpoint, ['azure']);
  assert.deepEqual(endpointFact('https://{location}-aiplatform.googleapis.com'), { kind: 'templated-host', suffix: 'googleapis.com', value: 'https://{location}-aiplatform.googleapis.com' });
  assert.equal(coverageFor([{ provider: 'new-provider', endpoint: 'https://api.not-in-company-rules.example.com/v1' }]).unmatched.length, 1, 'future unknown registrations fail coverage rather than inherit a brand by provider name');
});

test('multi-tenant gateway exact-host coverage never brands sibling tenants', () => {
  const official = modelProviderCompanyFamilyFromUrl('https://ai-gateway.vercel.sh', rules.companies);
  assert.ok(official, 'the shipped Vercel gateway must be covered explicitly');
  assert.ok((official.exactHosts ?? []).includes('ai-gateway.vercel.sh'), 'multi-tenant gateway coverage must use exactHosts');
  assert.equal(modelProviderCompanyFamilyFromUrl('https://unrelated-tenant.vercel.sh', rules.companies), null);
  assert.equal(modelProviderCompanyFamilyFromUrl('https://api.ai-gateway.vercel.sh', rules.companies), null, 'exactHosts does not claim descendants');
});
