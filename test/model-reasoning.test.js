import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pure = source.split('// BEGIN PURE LAYOUT')[1]?.split('// END PURE LAYOUT')[0];
assert.ok(pure);
const { providerReasoningCapabilities, providerReasoningIssue, providerModelDraftRow, providerModelDraftValue } = vm.runInNewContext(`${pure}\n({providerReasoningCapabilities,providerReasoningIssue,providerModelDraftRow,providerModelDraftValue})`, { URL });
const normalize = value => JSON.parse(JSON.stringify(value));
const literal = value => ({ type: 'const', value });
const union = (...list) => ({ type: 'union', list });
const shape = (levels, allowNull = true) => union(literal(false), {
  type: 'dict', sKey: union(...levels.map(literal)), inner: allowNull ? union({ type: 'string' }, literal(null)) : { type: 'string' },
});
const schema = shape(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const capability = providerReasoningCapabilities(schema);

const sample = {
  id: 'model', name: 'Original', input: ['text'], reasoningEfforts: { off: null, high: 'custom-wire' }, compat: { keep: true },
};

test('requires the installed reasoning union and finite literal key dictionary', () => {
  assert.deepEqual(normalize(capability), { levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], levelsOnly: false, allowBlankOff: true });
  assert.deepEqual(normalize(providerReasoningCapabilities(shape(['medium', 'high'], false))), { levels: ['medium', 'high'], levelsOnly: false, allowBlankOff: false });
  for (const missing of [null, {}, { type: 'boolean' }, union(literal(true), schema.list[1]), union(literal(false), { type: 'dict', sKey: { type: 'string' }, inner: { type: 'string' } }), shape(['off']), shape(['constructor', 'low']), shape(['low', 4])]) {
    assert.equal(providerReasoningCapabilities(missing), null);
  }
});

test('opening, editing another field and serializing an untouched row preserve existing reasoning and compat', () => {
  const sourceRow = providerModelDraftRow(sample, 'model-0');
  assert.equal(sourceRow.reasoningMode, 'custom');
  assert.deepEqual(normalize(providerModelDraftValue({ ...sourceRow, name: 'Edited', nameTouched: true })), { ...sample, name: 'Edited' });
  assert.equal(providerReasoningIssue([sourceRow], null), null);
  const partial = { ...sample, reasoningEfforts: { high: 'high', futureLevel: 'new' } };
  const unknown = providerModelDraftRow(partial, 'model-1');
  assert.equal(providerReasoningIssue([unknown], capability), null);
  assert.deepEqual(normalize(providerModelDraftValue(unknown)), partial);
  assert.equal(providerModelDraftRow({ id: 'i' }, 'inherit').reasoningMode, 'inherit');
  assert.equal(providerModelDraftRow({ id: 'd', reasoningEfforts: false }, 'disabled').reasoningMode, 'disabled');
});

test('save distinguishes explicit inherit, disable and configured wire values', () => {
  const row = { ...providerModelDraftRow(sample, 'model-0'), reasoningTouched: true };
  const { reasoningEfforts, ...withoutReasoning } = sample;
  assert.deepEqual(normalize(providerModelDraftValue({ ...row, reasoningMode: 'inherit' })), withoutReasoning);
  assert.deepEqual(normalize(providerModelDraftValue({ ...row, reasoningMode: 'disabled' })), { ...withoutReasoning, reasoningEfforts: false });
  const custom = { ...row, reasoningEntries: { off: null, medium: 'explicit-wire' } };
  assert.deepEqual(normalize(providerModelDraftValue(custom)), { ...withoutReasoning, reasoningEfforts: { off: null, medium: 'explicit-wire' } });
  assert.equal(providerReasoningIssue([custom], capability), null);
  assert.deepEqual(sample.reasoningEfforts, reasoningEfforts);
});

test('selected blank levels serialize to their names while off and explicit aliases retain their meanings', () => {
  const row = { ...providerModelDraftRow(sample, 'model-0'), reasoningTouched: true,
    reasoningEntries: { off: null, low: '', medium: ' \t ', high: 'explicit-wire' } };
  assert.equal(providerReasoningIssue([row], capability), null);
  assert.deepEqual(normalize(providerModelDraftValue(row).reasoningEfforts), { off: null, low: 'low', medium: 'medium', high: 'explicit-wire' });
  assert.equal(row.reasoningEntries.low, '');
  assert.equal(Object.hasOwn(providerModelDraftValue(row).reasoningEfforts, 'max'), false);
  const stringOnly = providerReasoningCapabilities(shape(['off', 'high'], false));
  const ordinaryOff = { ...row, reasoningEntries: { off: '', high: '' } };
  assert.equal(providerReasoningIssue([ordinaryOff], stringOnly), null);
  assert.deepEqual(normalize(providerModelDraftValue(ordinaryOff).reasoningEfforts), { off: 'off', high: 'high' });
});

test('validation blocks malformed touched mappings and fails closed if schema is withdrawn', () => {
  const row = { ...providerModelDraftRow(sample, 'model-0'), reasoningTouched: true };
  const expected = { kind: 'reasoning', index: 1, field: 'reasoningEfforts' };
  for (const reasoningEntries of [{}, { off: null }, { medium: null }, { medium: 1 }, { typo: 'high' }]) {
    assert.deepEqual(normalize(providerReasoningIssue([{}, { ...row, reasoningEntries }], capability)), expected);
  }
  assert.deepEqual(normalize(providerReasoningIssue([{}, row], null)), expected);
  assert.equal(providerReasoningIssue([{ ...row, reasoningMode: 'inherit' }], capability), null);
  assert.equal(providerReasoningIssue([{ ...row, reasoningMode: 'disabled' }], capability), null);
  assert.deepEqual(normalize(providerReasoningIssue([{}, row], providerReasoningCapabilities(shape(['off', 'high'], false)))), expected);
});

test('an explicitly selected Gemini protocol obeys the installed client wire-level restrictions', () => {
  const gemini = providerReasoningCapabilities(schema, 'google-generative-ai');
  assert.deepEqual(normalize(gemini.levels), ['minimal', 'low', 'medium', 'high']);
  const row = { ...providerModelDraftRow(sample, 'model-0'), reasoningTouched: true, reasoningEntries: { high: 'high' } };
  assert.equal(providerReasoningIssue([row], gemini), null);
  assert.deepEqual(normalize(providerReasoningIssue([{ ...row, reasoningEntries: { high: 'highest' } }], gemini)), { kind: 'reasoning', index: 0, field: 'reasoningEfforts' });
  const oldMapping = { ...row, reasoningTouched: false, reasoningEntries: { off: null, high: 'highest' } };
  assert.equal(providerReasoningIssue([oldMapping], gemini), null);
  assert.deepEqual(normalize(providerReasoningIssue([oldMapping], gemini, true)), { kind: 'reasoning', index: 0, field: 'reasoningEfforts' });
});

test('model row and navigation icon use the existing save flow and optional SDK slot', () => {
  assert.match(source, /schema\.nodeAtPath\(modelNode, \['0', 'reasoningEfforts'\]\)/);
  assert.match(source, /reasoningCapability \? h\(ProviderModelReasoning/);
  assert.match(source, /const modelIssue = useDefaultCatalog \? null : providerModelIssue\(modelValue, isCustomRoute\) \?\? providerReasoningIssue\(modelRows, reasoningCapability, protocolTouched && protocol !== openedProfile\.api\)/);
  assert.match(source, /ctx\.slots\.inject\('settings\.section\.icon', \(\) => ctx\.slots\.register\(\{ name: 'settings\.section\.icon', id: 'provider-quota' \}, ProviderQuotaNavIcon\)\)/);
  assert.match(source, /function ProviderQuotaNavIcon\(\{ size = 16 \}\)[\s\S]{0,350}stroke: 'currentColor'/);
});
