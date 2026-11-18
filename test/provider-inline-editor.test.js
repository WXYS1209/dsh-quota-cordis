import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pure = source.split('// BEGIN PURE LAYOUT')[1]?.split('// END PURE LAYOUT')[0];
const { providerEditorCompany, providerRetryPolicyBranches, providerRetryPolicyOperations, providerCredentialPlaceholder } = vm.runInNewContext(`${pure}\n({providerEditorCompany,providerRetryPolicyBranches,providerRetryPolicyOperations,providerCredentialPlaceholder})`, { URL });
const normal = { dict: { mode: { value: 'normal' }, maxRetries: {}, retryableCodes: {}, backoff: {} } };
const always = { dict: { mode: { value: 'always' }, backoff: {} } };
const retryNode = { list: [normal, always] };
const path = Object.freeze(['providers', 'example', 'retryPolicy']);
const normalize = value => JSON.parse(JSON.stringify(value));
const manager = source.split('function ProviderManager({ manager })')[1].split('function ProviderModelIcon')[0];
const editor = source.split('function ProviderManagerEditor({ manager, target, mode, onBack, onSaved })')[1].split('function ProviderSettings')[0];

// Pure state/schema tests and source invariants only: not a React/DOM or visual-page simulation.
test('inline editor pins its original company through regrouping, route removal and conflict refreshes', () => {
  const row = { entry: { provider: 'example', settingsNs: 'test' } };
  const opened = { key: 'company-a', entries: [row] };
  const refreshed = { key: 'company-a', entries: [] };
  assert.equal(providerEditorCompany([refreshed], 'company-a', row, 'edit', opened), opened);
  assert.equal(providerEditorCompany([], 'company-a', row, 'edit', opened), opened);
  assert.equal(providerEditorCompany([refreshed], 'company-a', null, 'edit', opened), refreshed);
  assert.equal(providerEditorCompany([], 'company-a', null, 'edit', opened), null);
  assert.equal(providerEditorCompany([], 'company-a', {}, 'custom', opened), null);
  assert.ok(manager.includes('editingCompanyRef.current = selectedCompany'));
  assert.ok(manager.includes("const isEditing = target === row && formMode !== 'custom'"));
  assert.ok(editor.includes('const liveNamespace = state.namespaces.get(namespaceId)'));
  assert.ok(editor.includes('const namespace = liveNamespace ?? openedNamespace'));
  assert.ok(editor.includes("const readOnly = !state.writable || state.status !== 'ready' || !liveNamespace"));
  assert.ok(editor.includes('if (busy || readOnly || stale || validationKey) return'));
  assert.ok(editor.includes('if (!namespace || discoveryBusy || profileDisabled) return'));
});

test('editing opens within the same provider article, without returning a replacement page', () => {
  assert.equal(manager.includes('if (target) return'), false);
  assert.ok(manager.includes("className: 'pq-manager-card pq-manager-provider-entry'"));
  assert.ok(manager.includes("h('div', { id: editorId, hidden: !isEditing }, isEditing ? renderEditor() : null)"));
  assert.ok(manager.includes("'aria-expanded': isEditing, 'aria-controls': editorId"));
  assert.ok(manager.includes('disabled: !state.writable || Boolean(target) || Boolean(removingId)'));
  assert.ok(manager.includes("target && formMode === 'custom' ? h('article'"));
  assert.ok(editor.includes('pq-manager-inline-editor'));
  assert.equal(editor.includes("t('providerManagerEditorBack')"), false);
  assert.ok(editor.includes("disabled: busy, onClick: onBack"));
});

test('address, retry selector and model catalog live inside one custom-settings fold above the footer', () => {
  const start = editor.indexOf("h('details', { className: 'pq-manager-connection'");
  const footer = editor.indexOf("className: 'pq-manager-actions pq-manager-footer'");
  const fold = editor.slice(start, footer);
  assert.ok(start > editor.indexOf("className: 'pq-manager-form-section'"));
  assert.ok(fold.includes('providerManagerUiBaseUrlLabel'));
  assert.ok(fold.includes('providerManagerRetryPolicy'));
  assert.ok(fold.includes("className: 'pq-manager-model-section'"));
  assert.ok(source.includes('.pq-manager-inline-editor .pq-manager-model-list{display:flex;flex-direction:column;gap:8px}'), 'model rows stay full-width in one vertical list, not the legacy multi-column grid');
  assert.ok(fold.includes('onClick: useDefaultCatalog ? customizeCatalog : restoreCatalog'));
  assert.ok(fold.includes("t(discoveryBusy ? 'providerManagerUiDiscovering' : 'providerManagerFetchModels')"));
  assert.ok(editor.includes('if (urlInvalid || modelFailure) setConnectionOpen(true)'));
  assert.ok(source.includes("providerManagerConnectionSettings: '自定义设置'"));
});

test('safe credential preview uses only configured public masked metadata, never a secret value', () => {
  const fallback = 'Enter a new key';
  assert.equal(providerCredentialPlaceholder(undefined, fallback), fallback);
  assert.equal(providerCredentialPlaceholder({ configured: false, masked: 'not applicable' }, fallback), fallback);
  assert.equal(providerCredentialPlaceholder({ configured: true, masked: 'prefix-••••' }, fallback), 'prefix-••••');
  for (const masked of [undefined, '', 123, 'x'.repeat(513)]) assert.equal(providerCredentialPlaceholder({ configured: true, masked }, fallback), '••••••••••••••••');
  const credential = { configured: true, masked: '••••' };
  Object.defineProperty(credential, 'value', { get() { throw new Error('secret must not be read'); } });
  assert.equal(providerCredentialPlaceholder(credential, fallback), '••••');
  assert.ok(editor.includes("const [keyDraft, setKeyDraft] = React.useState('')"));
  assert.ok(editor.includes('placeholder: providerCredentialPlaceholder(target.credential'));
  assert.equal(/setKeyDraft\([^)]*(?:credential|masked)/.test(editor), false);
});

test('configured native status can beat an absent convention ref without borrowing past an explicit key ref', () => {
  const code = source.split('const enriched = rows.map(row => {')[1].split('return { ...row, credential')[0];
  const choose = vm.runInNewContext(`(row, credentials) => { ${code}\nreturn credential; }`);
  const missing = { configured: false };
  const present = { configured: true, masked: '••••' };
  const row = { profile: {}, credentialRef: 'CONVENTION', entry: { nativeAuth: { env: ['NATIVE'] } } };
  assert.equal(choose(row, { CONVENTION: missing, NATIVE: present }), present);
  assert.equal(choose(row, { CONVENTION: present, NATIVE: { configured: true } }), present);
  assert.equal(choose({ ...row, profile: { apiKeyEnv: 'EXPLICIT' }, credentialRef: 'EXPLICIT' }, { EXPLICIT: missing, NATIVE: present }), missing);
});

test('retry modes come from schema branches rather than a guessed global list', () => {
  assert.deepEqual(normalize(providerRetryPolicyBranches(retryNode).map(entry => entry.mode)), ['normal', 'always']);
  assert.deepEqual(normalize(providerRetryPolicyBranches(undefined)), []);
  assert.deepEqual(normalize(providerRetryPolicyBranches({ list: [null, {}, normal, normal] }).map(entry => entry.mode)), ['normal']);
  assert.equal(providerRetryPolicyBranches({ list: [{ dict: { mode: { value: 'future' }, custom: {} } }] })[0].mode, 'future');
});

test('retry inheritance only removes an existing user override and does not materialize defaults', () => {
  assert.deepEqual(normalize(providerRetryPolicyOperations(undefined, 'inherit', retryNode, path)), []);
  assert.deepEqual(normalize(providerRetryPolicyOperations({ mode: 'normal', maxRetries: 8 }, 'inherit', retryNode, path)), [{ op: 'unset', path: [...path] }]);
  assert.deepEqual(normalize(providerRetryPolicyOperations(undefined, 'normal', retryNode, path)), [{ op: 'set', path: [...path, 'mode'], value: 'normal' }]);
  assert.deepEqual(normalize(providerRetryPolicyOperations(undefined, 'invalid', retryNode, path)), []);
});

test('switching to always uses leaf operations, drops normal-only overrides and keeps backoff intact', () => {
  const backoff = Object.freeze({ initialDelayMs: 900, maxDelayMs: 20000, jitterRatio: 0.2 });
  const policy = Object.freeze({ mode: 'normal', maxRetries: 8, retryableCodes: Object.freeze(['CUSTOM_CODE']), backoff });
  assert.deepEqual(normalize(providerRetryPolicyOperations(policy, 'always', retryNode, path)), [
    { op: 'set', path: [...path, 'mode'], value: 'always' },
    { op: 'unset', path: [...path, 'maxRetries'] },
    { op: 'unset', path: [...path, 'retryableCodes'] },
  ]);
  assert.equal(policy.backoff, backoff);
  assert.deepEqual(normalize(providerRetryPolicyOperations(policy, 'normal', retryNode, path)), []);
  assert.deepEqual([...path], ['providers', 'example', 'retryPolicy']);
});

test('normal selection preserves existing backoff and omitted-mode user fields without copying inherited values', () => {
  assert.deepEqual(normalize(providerRetryPolicyOperations({ mode: 'always', backoff: { maxDelayMs: 40000 } }, 'normal', retryNode, path)), [{ op: 'set', path: [...path, 'mode'], value: 'normal' }]);
  assert.deepEqual(normalize(providerRetryPolicyOperations({ maxRetries: 12, backoff: { jitterRatio: 0 } }, 'normal', retryNode, path)), [{ op: 'set', path: [...path, 'mode'], value: 'normal' }]);
  assert.ok(editor.includes('schema.getPath(openedNamespace.user'));
  assert.ok(editor.includes('schema.getPath(namespace.base'));
  assert.ok(editor.includes('if (retryTouched && retryNode !== undefined) ops.push(...providerRetryPolicyOperations'));
  assert.ok(editor.includes('manager.writeSettings(namespaceId, ops, openedRevision.current)'));
  assert.ok(editor.includes('providerManagerRetryAlwaysHint'));
});

test('ordering is UID-based and keyboard-accessible, and filtering cannot silently move hidden rows', () => {
  assert.ok(editor.includes("'aria-keyshortcuts': 'ArrowUp ArrowDown'"));
  assert.ok(editor.includes("if (editorDisabled || useDefaultCatalog || modelQuery.trim()) return"));
  assert.ok(editor.includes('disabled: disabled || Boolean(modelQuery.trim())'));
  assert.ok(editor.includes('modelRows.findIndex(model => model.draftKey === draggedModelKey.current)'));
  assert.ok(editor.includes('modelRows.findIndex(model => model.draftKey === row.draftKey)'));
  assert.ok(editor.includes('moveProviderModelDraftRow(modelRows, from, to)'));
  assert.ok(editor.includes("fieldRef('order')"));
  assert.ok(editor.includes("h(ProviderModelIcon, { name: 'trash' })"));
  assert.ok(editor.includes("h(ProviderModelIcon, { name: expanded ? 'down' : 'right' })"));
});
