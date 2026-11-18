import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLUGIN_VERSION, resolveDshRuntimeVersion } from '../version.js';
import { QuotaManager } from '../manager.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(await readFile(new URL('./fixtures/dsh-provider-catalog.json', import.meta.url), 'utf8'));
const emptyServices = {
  llm: { listProviders: () => [], listConfigurableProviders: () => [] },
  settings: { describe: () => [] },
  credentials: { resolve() { throw Error('release metadata must not resolve credentials'); } },
};

test('release identity, compatibility boundary and shipped metadata module are consistent', () => {
  assert.equal(manifest.version, '0.7.3');
  assert.equal(PLUGIN_VERSION, manifest.version);
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.1 <0.2.3-0');
  assert.ok(manifest.files.includes('version.js'));
  assert.ok(manifest.files.includes('codex-oauth.js'));
  assert.ok(manifest.scripts.check.includes('node --check codex-oauth.js'));
  assert.ok(manifest.scripts.check.includes('node --check version.js'));
  for (const name of ['dependencies', 'optionalDependencies', 'peerDependencies']) assert.equal(Object.keys(manifest[name] ?? {}).length, 0);
  for (const script of ['preinstall', 'install', 'postinstall', 'prepublishOnly', 'prepack', 'postpack']) assert.equal(manifest.scripts[script], undefined);
});

test('quota snapshots report the actual plugin package version without a stale literal', async () => {
  const manager = new QuotaManager(emptyServices);
  try {
    assert.equal((await manager.snapshot()).pluginVersion, manifest.version);
    assert.equal(manager.version, 'unknown', 'standalone use must not pretend to run an older DSH');
  } finally { await manager.dispose(); }
});

test('runtime version reads only the exact CLI manifest and preserves prerelease/build identity', () => {
  for (const version of ['0.2.2-rc.1', '0.2.2-rc.5', '0.2.2', '0.2.2-rc.5+build.001']) {
    const reads = [];
    const result = resolveDshRuntimeVersion({ installation: '/synthetic/dsh', read(filename) {
      reads.push(filename);
      return { name: '@deepseek-ai/dsh', version, get credentials() { throw Error('private data must not be inspected'); } };
    } });
    assert.equal(result, version);
    assert.deepEqual(reads, [join('/synthetic/dsh', 'package.json')]);
  }
});

test('missing or relative runtime anchors never trigger file discovery', () => {
  for (const installation of [null, '', 'relative/dsh', '../dsh', 123]) {
    assert.equal(resolveDshRuntimeVersion({ installation, read() { throw Error('no file access is allowed'); } }), 'unknown');
  }
});

test('wrapper packages and malformed versions never masquerade as a DSH runtime', () => {
  const invalid = [
    { name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.2-rc.5' },
    { name: 'dsh-quota-cordis', version: '0.7.3' },
    ...[undefined, null, 5, '', ' 0.2.2', '0.2.2\r\nX-Secret: no', '0.2.2-01', '00.2.2', '0.2.2-rc..5', 'x'.repeat(257)].map(version => ({ name: '@deepseek-ai/dsh', version })),
  ];
  for (const value of invalid) assert.equal(resolveDshRuntimeVersion({ installation: '/synthetic/dsh', read: () => value }), 'unknown');
});

test('runtime metadata read failures remain sanitized and never substitute plugin/minimum versions', () => {
  const result = resolveDshRuntimeVersion({ installation: '/synthetic/dsh', read() { throw Error('PRIVATE_LOCAL_PATH'); } });
  assert.equal(result, 'unknown');
  assert.notEqual(result, PLUGIN_VERSION);
  assert.notEqual(result, '0.2.2-rc.1');
});

test('account client metadata receives the explicit runtime version without exposing it as the plugin version', async () => {
  const calls = [];
  const manager = new QuotaManager({ ...emptyServices, deepseekAccount: {
    getPlatformSession: () => ({ token: 'synthetic-release-session' }),
    getBalance: options => { calls.push(options); return { status: 'ready', value: [{ currency: 'CNY', balance: '1.00' }], bonusWallets: [] }; },
  } }, { version: '0.2.2-rc.5', fetcher() { throw Error('no network requests are permitted'); } });
  try {
    const result = await manager.readRow({ id: 'deepseek-account', name: 'Synthetic account', kind: 'account', dashboardUrl: null }, false);
    assert.equal(result.status, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].version, '0.2.2-rc.5');
    assert.equal(JSON.stringify(result).includes('synthetic-release-session'), false);
  } finally { await manager.dispose(); }
});

test('Host construction wires runtime metadata explicitly rather than changing standalone manager behavior', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(source.includes('version: resolveDshRuntimeVersion()'));
  assert.equal(source.includes("version: '0.2.2-rc.1'"), false);
});

test('release documentation has one complete 0.7.3 entry and no new Requirements section', async () => {
  const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.equal((changelog.match(/^## 0\.7\.3\b/gm) ?? []).length, 1);
  assert.match(changelog, /^## 0\.7\.3 — 2026-11-19$/m);
  assert.equal(/^## Unreleased$/m.test(changelog), false);
  for (const file of ['README.md', 'README.zh.md']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(text.includes('>=0.2.2-rc.1 <0.2.3-0'));
    assert.ok(text.includes('0.2.2-rc.5'));
    assert.equal(/^#{1,6}\s+(?:Requirements|系统要求|环境要求|依赖要求)\s*$/im.test(text), false);
  }
});

test('public catalog baseline records actual rc.5 extraction, not a relabeled older fixture', () => {
  assert.equal(catalog.dshVersion, '0.2.2-rc.5');
  assert.equal(catalog.piAiVersion, '1.3.0');
  assert.equal(catalog.providers.length, 42);
});
