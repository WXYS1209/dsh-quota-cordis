import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pureBlock = source.split('// BEGIN PURE LAYOUT')[1]?.split('// END PURE LAYOUT')[0];
assert.ok(pureBlock, 'production model draft helpers must remain pure and testable');
const { providerModelDraftRow, providerModelDraftValue, filterProviderModelDraftRows, moveProviderModelDraftRow, providerModelIssue } = vm.runInNewContext(
  `${pureBlock}\n({providerModelDraftRow,providerModelDraftValue,filterProviderModelDraftRows,moveProviderModelDraftRow,providerModelIssue})`,
  { URL },
);
const normalized = value => JSON.parse(JSON.stringify(value));

// These are draft/serialization tests, not React, DOM or official-page mocks.
test('new manual model drafts have stable supplied keys, empty fields and untouched flags', () => {
  for (const value of [undefined, null, [], 12, 'not a model']) {
    const row = providerModelDraftRow(value, 'draft-manual-1');
    assert.deepEqual(normalized(row), {
      draftKey: 'draft-manual-1', source: {}, id: '', name: '', contextWindow: '', maxTokens: '', modalities: [],
      inputTouched: false, nameTouched: false, contextTouched: false, maxTokensTouched: false,
    });
    assert.deepEqual(normalized(providerModelDraftValue(row)), { id: '' });
  }
});

test('discovered model drafts round-trip supported values and preserve advanced metadata', () => {
  const model = {
    id: 'discovered-model', name: 'Discovered Model', contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'],
    api: 'openai-responses', reasoning: true, baseURL: 'https://models.example.com/v1',
    compat: { supportsStore: false, custom: ['unchanged'] },
    thinkingLevelMap: { high: 'deep' }, cost: { input: 0, output: 2.5 },
  };
  const before = JSON.stringify(model);
  const row = providerModelDraftRow(model, 'draft-discovered-2');
  assert.notEqual(row.source, model, 'the top-level source is detached');
  assert.equal(row.source.compat, model.compat, 'unknown nested metadata is retained without inventing a new schema');
  assert.equal(row.contextWindow, '128000');
  assert.equal(row.maxTokens, '8192');
  assert.deepEqual(normalized(providerModelDraftValue(row)), model);
  assert.equal(JSON.stringify(model), before);
  const value = providerModelDraftValue(row);
  for (const key of ['draftKey', 'inputTouched', 'nameTouched', 'contextTouched', 'maxTokensTouched']) assert.equal(Object.hasOwn(value, key), false, key);
});

test('untouched input metadata is preserved even when draft checkboxes recognize only text and image', () => {
  const input = ['text', 'future-modality', 'image'];
  const model = { id: 'future-input', input, custom: { flag: true } };
  const row = providerModelDraftRow(model, 'draft-future-input');
  assert.deepEqual(normalized(row.modalities), ['text', 'image']);
  assert.notEqual(row.modalities, input);
  const value = providerModelDraftValue(row);
  assert.equal(value.input, input, 'untouched serialization must not silently erase unrecognized source metadata');
  assert.deepEqual(value.input, ['text', 'future-modality', 'image']);
  assert.deepEqual(model.input, ['text', 'future-modality', 'image']);
});

test('edited known fields are trimmed/converted while unrelated metadata and original drafts stay intact', () => {
  const model = { id: 'old-id', name: 'Old Name', contextWindow: 8000, maxTokens: 1024, input: ['text'], compat: { marker: 'keep' } };
  const original = providerModelDraftRow(model, 'draft-edit-3');
  const row = { ...original, id: ' new-id ', name: ' New Name ', contextWindow: ' 64000 ', maxTokens: ' 4096 ', modalities: ['text', 'image'], nameTouched: true, contextTouched: true, maxTokensTouched: true, inputTouched: true };
  const before = JSON.stringify(row);
  const value = providerModelDraftValue(row);
  assert.deepEqual(normalized(value), { ...model, id: 'new-id', name: 'New Name', contextWindow: 64000, maxTokens: 4096, input: ['text', 'image'] });
  assert.equal(value.compat, model.compat);
  assert.notEqual(value.input, row.modalities, 'changed modalities are cloned for serialization');
  value.input.push('not-a-draft-edit');
  assert.deepEqual(row.modalities, ['text', 'image']);
  assert.equal(JSON.stringify(row), before);
  assert.equal(original.id, 'old-id');
  assert.equal(model.id, 'old-id');
});

test('blank optional fields are removed only when touched; clearing modalities removes only input', () => {
  const model = { id: 'model', name: 'Original', contextWindow: 4096, maxTokens: 1024, input: ['text'], advanced: { retained: true } };
  const original = providerModelDraftRow(model, 'draft-clear-4');
  const blank = { ...original, name: ' ', contextWindow: '', maxTokens: '\t', modalities: [] };
  assert.deepEqual(normalized(providerModelDraftValue(blank)), model, 'untouched blank draft fields keep inherited/source values');
  const cleared = providerModelDraftValue({ ...blank, nameTouched: true, contextTouched: true, maxTokensTouched: true, inputTouched: true });
  assert.deepEqual(normalized(cleared), { id: 'model', advanced: { retained: true } });
  assert.deepEqual(model, { id: 'model', name: 'Original', contextWindow: 4096, maxTokens: 1024, input: ['text'], advanced: { retained: true } });
});

test('source capacities are represented as raw strings; invalid values still fail the existing validator', () => {
  const row = providerModelDraftRow({ id: 123, name: false, contextWindow: 'unknown-capacity', maxTokens: null }, 'draft-invalid-5');
  assert.equal(row.id, '');
  assert.equal(row.name, '');
  assert.equal(row.contextWindow, 'unknown-capacity');
  assert.equal(row.maxTokens, 'null');
  const value = providerModelDraftValue({ ...row, id: 'fixed-id' });
  assert.equal(Number.isNaN(value.contextWindow), true);
  assert.equal(Number.isNaN(value.maxTokens), true);
  assert.equal(providerModelIssue([value]).kind, 'capacity');
});

test('supplied draft keys survive immutable model-ID edits, deletion and reordering without leaking into values', () => {
  const rows = ['first', 'second', 'third'].map((id, index) => providerModelDraftRow({ id }, `model-draft-${index}`));
  const edited = rows.map((row, index) => index === 1 ? { ...row, id: 'renamed-second' } : row);
  const remaining = edited.filter((_, index) => index !== 0);
  const reordered = [...remaining].reverse();
  assert.deepEqual(reordered.map(row => row.draftKey), ['model-draft-2', 'model-draft-1']);
  assert.equal(reordered[1].id, 'renamed-second');
  assert.equal(reordered[1].draftKey, rows[1].draftKey);
  assert.equal(rows[1].id, 'second');
  for (const row of reordered) assert.equal(Object.hasOwn(providerModelDraftValue(row), 'draftKey'), false);
});

test('model search uses literal NFKC/case-folded AND tokens over ID/name and retains original indexes and references', () => {
  const rows = [
    providerModelDraftRow({ id: 'alpha-model', name: 'Ｍｏｄｅｌ Ａ' }, 'a'),
    providerModelDraftRow({ id: 'mimo-v2', name: '小米 编程' }, 'b'),
    providerModelDraftRow({ id: 'deepseek-chat', name: 'DeepSeek Chat' }, 'c'),
  ];
  const before = JSON.stringify(rows);
  const result = filterProviderModelDraftRows(rows, '小米 MIMO');
  assert.equal(result.length, 1);
  assert.equal(result[0].row, rows[1]);
  assert.equal(result[0].index, 1);
  assert.equal(filterProviderModelDraftRows(rows, 'model a')[0].row, rows[0]);
  assert.equal(filterProviderModelDraftRows(rows, 'ＤＥＥＰＳＥＥＫ')[0].row, rows[2]);
  assert.equal(filterProviderModelDraftRows(rows, 'deepseek mimo').length, 0);
  assert.equal(filterProviderModelDraftRows(rows, '.*').length, 0, 'query strings are not regular expressions');
  assert.equal(filterProviderModelDraftRows(rows, `mimo${' '.repeat(201)}missing-term`).length, 1, 'search is capped before token matching');
  for (const query of ['', ' \t\n ', undefined, null, 123]) {
    const all = filterProviderModelDraftRows(rows, query);
    assert.deepEqual(normalized(all.map(item => item.index)), [0, 1, 2]);
    all.forEach((item, index) => assert.equal(item.row, rows[index]));
  }
  const updated = rows.map((row, index) => index === result[0].index ? { ...row, name: 'Edited via original index', nameTouched: true } : row);
  assert.equal(updated[1].name, 'Edited via original index');
  assert.equal(updated[0], rows[0]);
  assert.equal(JSON.stringify(rows), before);
});

function modelOrderFixture() {
  return ['alpha', 'beta', 'gamma', 'delta'].map((id, index) => {
    const advanced = Object.freeze({ slot: index, nested: Object.freeze({ retained: true }) });
    const row = providerModelDraftRow({ id, name: `Model ${id}`, input: ['text'], advanced }, `order-draft-${index}`);
    Object.freeze(row.modalities);
    Object.freeze(row.source);
    return Object.freeze(row);
  });
}

test('model ordering supports adjacent keyboard moves in either direction without mutating rows', () => {
  const rows = Object.freeze(modelOrderFixture());
  const before = JSON.stringify(rows);
  for (const [from, to, expected] of [
    [1, 0, ['beta', 'alpha', 'gamma', 'delta']],
    [1, 2, ['alpha', 'gamma', 'beta', 'delta']],
    [2, 1, ['alpha', 'gamma', 'beta', 'delta']],
    [2, 3, ['alpha', 'beta', 'delta', 'gamma']],
  ]) {
    const next = moveProviderModelDraftRow(rows, from, to);
    assert.notEqual(next, rows);
    assert.deepEqual(normalized(next.map(row => row.id)), expected);
    assert.equal(next[to], rows[from]);
    assert.equal(JSON.stringify(rows), before);
  }
});

test('absolute drag/drop indexes move to the requested final position with stable row, key and metadata references', () => {
  const rows = Object.freeze(modelOrderFixture());
  for (const [from, to, expected] of [
    [0, 3, ['beta', 'gamma', 'delta', 'alpha']],
    [3, 0, ['delta', 'alpha', 'beta', 'gamma']],
    [1, 3, ['alpha', 'gamma', 'delta', 'beta']],
    [3, 1, ['alpha', 'delta', 'beta', 'gamma']],
  ]) {
    const next = moveProviderModelDraftRow(rows, from, to);
    assert.notEqual(next, rows);
    assert.deepEqual(normalized(next.map(row => row.id)), expected);
    for (const row of rows) {
      const retained = next.find(candidate => candidate.draftKey === row.draftKey);
      assert.equal(retained, row, row.draftKey);
      assert.equal(retained.source, row.source);
      assert.equal(retained.source.advanced, row.source.advanced);
      assert.equal(retained.modalities, row.modalities);
    }
  }
});

test('invalid, out-of-bounds and no-op move indexes preserve the original array identity', () => {
  const rows = Object.freeze(modelOrderFixture());
  for (const invalid of [-1, rows.length, 999, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity, 1.5, '1', null, undefined, true, {}]) {
    assert.equal(moveProviderModelDraftRow(rows, invalid, 0), rows);
    assert.equal(moveProviderModelDraftRow(rows, 0, invalid), rows);
  }
  for (let index = 0; index < rows.length; index++) assert.equal(moveProviderModelDraftRow(rows, index, index), rows);
  const empty = Object.freeze([]);
  const single = Object.freeze([rows[0]]);
  assert.equal(moveProviderModelDraftRow(empty, 0, 0), empty);
  assert.equal(moveProviderModelDraftRow(single, 0, 0), single);
  assert.equal(moveProviderModelDraftRow(single, 0, 1), single);
});

test('filtered model rows keep global indexes before and after reordering so hidden rows are not accidentally edited or dragged', () => {
  const rows = modelOrderFixture();
  const visible = filterProviderModelDraftRows(rows, 'gamma');
  assert.equal(visible.length, 1);
  assert.equal(visible[0].index, 2);
  assert.equal(visible[0].row, rows[2]);
  const next = moveProviderModelDraftRow(rows, visible[0].index, 0);
  assert.deepEqual(normalized(next.map(row => row.id)), ['gamma', 'alpha', 'beta', 'delta']);
  const filteredAgain = filterProviderModelDraftRows(next, 'gamma');
  assert.equal(filteredAgain[0].index, 0);
  assert.equal(filteredAgain[0].row, rows[2]);
  assert.equal(next[2], rows[1], 'the previously hidden beta row retains its identity');
  assert.deepEqual(rows.map(row => row.id), ['alpha', 'beta', 'gamma', 'delta']);
});

test('reordered serialization persists only model values in draft order and never UI identities or touched flags', () => {
  const rows = modelOrderFixture();
  const edited = rows.map((row, index) => index === 1 ? { ...row, id: 'renamed-beta', name: 'Renamed Beta', nameTouched: true } : row);
  const next = moveProviderModelDraftRow(edited, 1, 3);
  const values = next.map(providerModelDraftValue);
  assert.deepEqual(normalized(values.map(value => value.id)), ['alpha', 'gamma', 'delta', 'renamed-beta']);
  assert.equal(next[3].draftKey, 'order-draft-1');
  assert.equal(values[3].name, 'Renamed Beta');
  assert.equal(values[3].advanced, rows[1].source.advanced);
  for (const value of values) {
    for (const field of ['draftKey', 'inputTouched', 'nameTouched', 'contextTouched', 'maxTokensTouched']) assert.equal(Object.hasOwn(value, field), false, field);
  }
});

test('moving models does not inspect or clone private source payloads', () => {
  const first = { id: 'first', draftKey: 'private-a' }, second = { id: 'second', draftKey: 'private-b' };
  for (const row of [first, second]) {
    Object.defineProperty(row, 'source', { get() { throw new Error('move must not inspect source'); } });
    Object.freeze(row);
  }
  const rows = Object.freeze([first, second]);
  const next = moveProviderModelDraftRow(rows, 0, 1);
  assert.equal(next[0], second);
  assert.equal(next[1], first);
  assert.equal(rows[0], first);
});

test('model search never indexes source-private metadata or reads the source object', () => {
  const row = providerModelDraftRow({ id: 'visible-model', name: 'Visible Name', headers: { Authorization: 'PRIVATE_SOURCE_ONLY' } }, 'safe');
  Object.defineProperty(row, 'source', { get() { throw new Error('source must not be indexed'); } });
  Object.freeze(row);
  const rows = Object.freeze([row]);
  assert.equal(filterProviderModelDraftRows(rows, 'PRIVATE_SOURCE_ONLY').length, 0);
  const matches = filterProviderModelDraftRows(rows, 'visible');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].row, row);
  assert.equal(matches[0].index, 0);
});
