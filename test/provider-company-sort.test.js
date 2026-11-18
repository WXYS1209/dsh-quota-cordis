import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pureBlock = source.split('// BEGIN PURE LAYOUT')[1]?.split('// END PURE LAYOUT')[0];
assert.ok(pureBlock, 'production company sorting must remain pure and testable');
const { sortModelProviderCompanyGroups } = vm.runInNewContext(
  `${pureBlock}\n({sortModelProviderCompanyGroups})`,
  { URL },
);
const group = (key, title, entries = []) => ({ key, title, icon: null, entries });
const keys = groups => Array.from(groups, item => item.key);
const saved = () => ({ savedConfiguration: true });
const collator = locale => new Intl.Collator(locale, { usage: 'sort', sensitivity: 'base', numeric: true });

// Pure sorting and row-provenance invariants only; no React, DOM or account simulation.
test('companies with saved user configuration come first, with both tiers sorted by displayed company name', () => {
  const groups = [
    group('company:mistral-ai', 'Mistral', [{ configured: true, entry: { active: true } }]),
    group('company:openai', 'OpenAI', [saved()]),
    group('company:google-gemini', 'Google'),
    group('company:deepseek', 'DeepSeek', [saved()]),
    group('company:anthropic', 'Anthropic', [{ configured: true }]),
  ];
  assert.deepEqual(keys(sortModelProviderCompanyGroups(groups, 'en')), [
    'company:deepseek', 'company:openai', 'company:anthropic', 'company:google-gemini', 'company:mistral-ai',
  ]);
});

test('sorting consumes precomputed saved flags rather than guessing from base data, activity or arbitrary credential fields', () => {
  const groups = [
    group('company:anthropic', 'Anthropic', [{ configured: true, removable: true, entry: { active: true, declared: true }, credential: { configured: true } }]),
    group('company:openai', 'OpenAI', [saved()]),
    group('company:deepseek', 'DeepSeek', [{ savedConfiguration: false, configured: true, namespace: { base: { providers: { deepseek: {} } }, user: {} } }]),
  ];
  assert.deepEqual(keys(sortModelProviderCompanyGroups(groups, 'en')), ['company:openai', 'company:anthropic', 'company:deepseek']);
});

test('one strictly true saved flag promotes a mixed company; truthy non-booleans do not', () => {
  const groups = [
    group('company:anthropic', 'Anthropic', [{ savedConfiguration: 'true' }, { savedConfiguration: 1 }]),
    group('company:openai', 'OpenAI', [{ savedConfiguration: false }, {}, saved()]),
    group('company:deepseek', 'DeepSeek', [{ savedConfiguration: null }, { savedConfiguration: undefined }]),
  ];
  assert.deepEqual(keys(sortModelProviderCompanyGroups(groups, 'en')), ['company:openai', 'company:anthropic', 'company:deepseek']);
});

test('only the unclassified card is always last, including when it has a saved profile and an early title', () => {
  const groups = [
    group('unclassified', 'AAA Unclassified', [saved()]),
    group('company:openai', 'OpenAI'),
    group('domain:aaa.example', 'aaa.example'),
    group('domain:zzz.example', 'zzz.example', [saved()]),
  ];
  assert.deepEqual(keys(sortModelProviderCompanyGroups(groups, 'en')), [
    'domain:zzz.example', 'domain:aaa.example', 'company:openai', 'unclassified',
  ]);
});

test('each priority tier uses the requested locale and numeric display-name collation', () => {
  for (const locale of ['zh', 'en']) {
    const savedGroups = [
      group('company:zhipu-ai', '智谱 AI', [saved()]),
      group('company:xiaomi', '小米', [saved()]),
      group('company:alibaba-cloud', '阿里云', [saved()]),
      group('company:moonshot-ai', '月之暗面', [saved()]),
      group('company:ant-group', '蚂蚁集团', [saved()]),
    ];
    const unsavedGroups = [
      group('domain:gateway10.example', 'gateway10.example'),
      group('domain:gateway2.example', 'gateway2.example'),
      group('company:anthropic', 'Anthropic'),
    ];
    const compare = collator(locale).compare;
    const expected = [...savedGroups].sort((a, b) => compare(a.title, b.title))
      .concat([...unsavedGroups].sort((a, b) => compare(a.title, b.title)));
    const input = [unsavedGroups[0], ...savedGroups, ...unsavedGroups.slice(1)];
    assert.deepEqual(keys(sortModelProviderCompanyGroups(input, locale)), keys(expected), locale);
    assert.ok(keys(sortModelProviderCompanyGroups(input, locale)).indexOf('domain:gateway2.example') < keys(sortModelProviderCompanyGroups(input, locale)).indexOf('domain:gateway10.example'));
  }
  const numeric = [group('domain:gateway10.example', 'gateway10.example'), group('domain:gateway2.example', 'gateway2.example')];
  assert.deepEqual(keys(sortModelProviderCompanyGroups(numeric)), ['domain:gateway2.example', 'domain:gateway10.example']);
});

test('collation-equal titles use raw ASCII keys, while identical keys retain stable input order', () => {
  const firstSameKey = group('company:openai', 'Same');
  const secondSameKey = group('company:openai', 'same');
  const groups = [
    group('domain:gateway2.example', 'SAME'),
    secondSameKey,
    group('domain:gateway10.example', 'sáme'),
    firstSameKey,
  ];
  const result = sortModelProviderCompanyGroups(groups, 'en');
  assert.deepEqual(keys(result), ['company:openai', 'company:openai', 'domain:gateway10.example', 'domain:gateway2.example']);
  assert.equal(result[0], secondSameKey);
  assert.equal(result[1], firstSameKey);
});

test('sorting frozen input creates a new array without changing groups, entries or their metadata', () => {
  const row = Object.freeze({ savedConfiguration: true, profile: Object.freeze({ name: 'untouched' }) });
  const savedGroup = Object.freeze(group('company:openai', 'OpenAI', Object.freeze([row])));
  const otherGroup = Object.freeze(group('company:anthropic', 'Anthropic', Object.freeze([])));
  const groups = Object.freeze([otherGroup, savedGroup]);
  const before = JSON.stringify(groups);
  const result = sortModelProviderCompanyGroups(groups, 'en');
  assert.notEqual(result, groups);
  assert.equal(result[0], savedGroup);
  assert.equal(result[1], otherGroup);
  assert.equal(result[0].entries[0], row);
  assert.equal(JSON.stringify(groups), before);
  for (const input of [Object.freeze([]), Object.freeze([savedGroup])]) {
    const sorted = sortModelProviderCompanyGroups(input, 'en');
    assert.notEqual(sorted, input);
    assert.deepEqual(Array.from(sorted), Array.from(input));
  }
});

test('sort priority uses the precomputed saved flag without inspecting credentials, namespaces or profile data', () => {
  const row = { savedConfiguration: true };
  for (const key of ['configured', 'namespace', 'profile', 'credential', 'entry']) {
    Object.defineProperty(row, key, { get() { throw new Error(`${key} must not be inspected for ordering`); } });
  }
  Object.freeze(row);
  const groups = [group('company:anthropic', 'Anthropic'), group('company:openai', 'OpenAI', [row])];
  assert.deepEqual(keys(sortModelProviderCompanyGroups(groups, 'en')), ['company:openai', 'company:anthropic']);
});

test('manager combines exact saved-settings paths with public credential and identity-bound native presence', () => {
  const manager = source.split('function createProviderManager(context,')[1].split('function providerGroupSummary')[0];
  assert.ok(manager.includes('hasSavedProviderSettings(namespace.user, path, (value, keys) => schema.hasPath(value, keys))'));
  assert.equal(manager.includes('hasSavedProviderSettings(namespace.user, path, schema.hasPath)'), false, 'never pass a receiver-dependent SDK method unbound');
  assert.ok(manager.includes('providerRowSavedState(row.savedConfiguration, credential, authConfiguredRoutes.has(routeIdentity(row.entry)))'));
  assert.ok(manager.includes('route.authConfigured === true'));
  const builder = manager.split('const rows = directory.map(entry => {')[1].split('const allRefs')[0];
  const returned = builder.slice(builder.indexOf('return {'));
  assert.match(returned, /\bsavedConfiguration\s*[:,]/);
});
