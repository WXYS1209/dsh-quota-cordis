import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { modelCatalogHost } from '../scripts/snapshot-dsh-provider-catalog.js';

const noRouteEndpoint = { defaultBaseURL: null, baseURLEnv: [] };
const model = (id, baseUrl) => ({ id, baseUrl });

test('complete fixed HTTPS model endpoints agree by exact host, not URL path', () => {
  assert.deepEqual(modelCatalogHost(noRouteEndpoint, [
    model('second', 'https://Catalog.Example.com/inference/v2'),
    model('first', 'https://catalog.example.com:443/inference/v1'),
  ]), { hostname: 'catalog.example.com', modelIds: ['first', 'second'] });
  assert.equal(modelCatalogHost(noRouteEndpoint, [
    model('one', 'https://a.example.com/v1'), model('two', 'https://b.example.com/v1'),
  ]), undefined, 'related but different hosts do not identify one endpoint');
});

test('route-level defaults or deployment-dependent endpoints suppress the directory fallback', () => {
  const models = [model('catalog-model', 'https://catalog.example.com/v1')];
  assert.equal(modelCatalogHost({ ...noRouteEndpoint, defaultBaseURL: 'https://configured.example.com' }, models), undefined);
  assert.equal(modelCatalogHost({ ...noRouteEndpoint, baseURLEnv: ['REGION'] }, models), undefined);
  assert.equal(modelCatalogHost({ defaultBaseURL: null }, models), undefined);
  assert.equal(modelCatalogHost(noRouteEndpoint, []), undefined);
});

test('one unknown, templated or ambiguous model prevents a partial directory fallback', () => {
  const known = model('known', 'https://catalog.example.com/v1');
  for (const base of [
    undefined, 'https://{region}.example.com/v1', 'https://catalog.example.com/{project}/v1',
    'https://catalog.example.com/%7Bproject%7D/v1', 'http://catalog.example.com/v1',
    'https://user@catalog.example.com/v1', 'https://@catalog.example.com/v1',
    'https://127.0.0.1/v1', 'https://[::1]/v1', 'https://localhost/v1',
    'https://catalog.example.com/a?region=one', 'https://catalog.example.com/a#ref',
  ]) assert.equal(modelCatalogHost(noRouteEndpoint, [known, model('other', base)]), undefined, String(base));
  assert.equal(modelCatalogHost(noRouteEndpoint, [known, model('known', 'https://catalog.example.com/v2')]), undefined);
  assert.equal(modelCatalogHost(noRouteEndpoint, [known, model('', 'https://catalog.example.com/v2')]), undefined);
});

test('shipped projection has the fixture versions and preserves distinct OpenCode routes', () => {
  const read = relativePath => JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
  const artifact = read('../src/data/model-catalog-hosts.json');
  const snapshot = read('fixtures/dsh-provider-catalog.json');
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.dshVersion, snapshot.dshVersion);
  assert.equal(artifact.piAiVersion, snapshot.piAiVersion);
  for (const id of ['opencode', 'opencode-go']) {
    assert.equal(artifact.providers[id].hostname, 'opencode.ai');
    assert.ok(artifact.providers[id].modelIds.length);
  }
  assert.notDeepEqual(artifact.providers.opencode.modelIds, artifact.providers['opencode-go'].modelIds);
  for (const id of ['amazon-bedrock', 'azure', 'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'google-vertex']) {
    assert.equal(Object.hasOwn(artifact.providers, id), false);
  }
  for (const [id, row] of Object.entries(artifact.providers)) {
    const source = snapshot.providers.find(entry => entry.id === id);
    assert.ok(source);
    assert.equal(source.defaultBaseURL, null);
    assert.deepEqual(source.baseURLEnv, []);
    assert.ok(source.modelBaseURLs.some(value => new URL(value).hostname === row.hostname));
    assert.deepEqual(Object.keys(row).sort(), ['hostname', 'modelIds']);
    assert.deepEqual(row.modelIds, [...new Set(row.modelIds)].sort());
  }
});
