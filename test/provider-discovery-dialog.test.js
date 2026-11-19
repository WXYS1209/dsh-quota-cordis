import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pure = source.split('// BEGIN PURE LAYOUT')[1].split('// END PURE LAYOUT')[0];
const { selectVisibleProviderCandidates, dedupeDiscoveredModels } = vm.runInNewContext(`${pure}\n({selectVisibleProviderCandidates,dedupeDiscoveredModels})`, { URL });
const editor = source.split('function ProviderManagerEditor({ manager, target, mode, onBack, onSaved })')[1].split('function ProviderSettings')[0];
const help = source.split('function ProviderKeyHelp(')[1].split('function ProviderDiscoveryDialog(')[0];
const dialog = source.split('function ProviderDiscoveryDialog(')[1].split('function ProviderModelIcon(')[0];
const discoverBody = editor.split('async function discover()')[1].split('function appendSelectedCandidates()')[0];
const closeBody = editor.split('function closeDiscovery()')[1].split('React.useEffect')[0];
// Run actual async action functions with injected callbacks, not React hooks or a DOM simulation.
const actions = vm.runInNewContext(`env => {
  const { namespace, namespaceId, discoveryBusy, profileDisabled, isNewCustom, isCustomRoute, routeId, urlText, endpointChanged, protocol, keyDraft, manager, discoveryController,
    setDiscoveryOpen, setDiscoveryBusy, setDiscoveryCompleted, setDiscoveryError, setCandidateQuery, setCandidates, setSelectedCandidates } = env;
  function closeDiscovery() ${closeBody}
  async function discover() ${discoverBody}
  return { discover, closeDiscovery };
}`, { AbortController, dedupeDiscoveredModels });
const normalize = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(discoverModels, overrides = {}) {
  const events = [];
  const env = { namespace: {}, namespaceId: 'test', discoveryBusy: false, profileDisabled: false, isNewCustom: false, isCustomRoute: false, routeId: 'test-provider', urlText: 'https://models.example.test/v1', protocol: 'openai-completions', keyDraft: '', manager: { discoverModels }, discoveryController: { current: null }, ...overrides };
  for (const name of ['setDiscoveryOpen', 'setDiscoveryBusy', 'setDiscoveryCompleted', 'setDiscoveryError', 'setCandidateQuery', 'setCandidates', 'setSelectedCandidates']) env[name] = value => { events.push([name, value]); };
  return { env, events, ...actions(env) };
}

test('visible-only selection preserves hidden choices and never changes already-added model membership', () => {
  const original = new Set(['hidden-selected', 'visible-old']);
  const visible = Object.freeze([{ id: 'visible-new' }, { id: 'visible-old' }, { id: 'already-added' }]);
  const added = new Set(['already-added']);
  const selected = selectVisibleProviderCandidates(original, visible, added, true);
  assert.deepEqual([...selected], ['hidden-selected', 'visible-old', 'visible-new']);
  assert.deepEqual([...original], ['hidden-selected', 'visible-old']);
  assert.deepEqual([...selectVisibleProviderCandidates(selected, visible, added, false)], ['hidden-selected']);
  assert.deepEqual([...added], ['already-added']);
});

test('selection uses only visible model IDs and does not inspect source-private metadata', () => {
  const model = { id: 'model' };
  Object.defineProperty(model, 'source', { get() { throw new Error('private metadata must not be read'); } });
  assert.deepEqual([...selectVisibleProviderCandidates(new Set(), [model, { id: 123 }], new Set(), true)], ['model']);
});

test('discovery opens the modal before the explicit request and copies only the typed temporary key', async () => {
  let captured;
  const h = fixture(async (...args) => { captured = args; return { kind: 'found', models: [{ id: 'model' }] }; }, { keyDraft: ' temporary-test-key ' });
  await h.discover();
  assert.deepEqual(h.events[0], ['setDiscoveryOpen', true]);
  assert.equal(captured[0], 'test');
  assert.deepEqual(normalize(captured[1]), { provider: 'test-provider', baseURL: 'https://models.example.test/v1', apiKey: 'temporary-test-key' });
  assert.equal(captured[2], h.env.discoveryController.current.signal);
  assert.deepEqual([...h.events.filter(([name]) => name === 'setCandidates').at(-1)[1].map(model => model.id)], ['model']);
  assert.deepEqual(h.events.at(-1), ['setDiscoveryBusy', false]);
});

test('discovery signals an intentionally cleared route endpoint without sending a blank URL', async () => {
  let captured;
  const h = fixture(async (_, request) => { captured = request; return { kind: 'found', source: 'dsh-catalog', reason: 'unsafe-endpoint', models: [] }; }, { urlText: '', endpointChanged: true });
  await h.discover();
  assert.deepEqual(normalize(captured), { provider: 'test-provider', endpointChanged: true });
  assert.deepEqual(normalize(h.events.filter(([name]) => name === 'setDiscoveryCompleted').at(-1)[1]), { source: 'dsh-catalog', reason: 'unsafe-endpoint' });
});

test('cancel aborts the real signal, discards selection and ignores a late successful response', async () => {
  const late = deferred();
  const h = fixture(() => late.promise);
  const pending = h.discover();
  const signal = h.env.discoveryController.current.signal;
  h.closeDiscovery();
  assert.equal(signal.aborted, true);
  late.resolve({ kind: 'found', models: [{ id: 'late-result' }] });
  await pending;
  assert.equal(h.events.some(([name, value]) => name === 'setCandidates' && value.length > 0), false);
  assert.deepEqual(h.events.filter(([name]) => name === 'setDiscoveryBusy').map(([, value]) => value), [true, false]);
  assert.deepEqual(h.events.filter(([name]) => name === 'setDiscoveryOpen').map(([, value]) => value), [true, false]);
  assert.equal(h.events.filter(([name]) => name === 'setSelectedCandidates').at(-1)[1].size, 0);
  assert.equal(h.events.some(([name]) => name === 'setModelsTouched'), false);
});

test('an older canceled query cannot populate or clear the busy state of a newer open modal', async () => {
  const old = deferred(), fresh = deferred();
  let calls = 0;
  const h = fixture(() => ++calls === 1 ? old.promise : fresh.promise);
  const first = h.discover();
  h.closeDiscovery();
  const second = h.discover();
  const count = h.events.length;
  old.resolve({ kind: 'found', models: [{ id: 'old' }] });
  await first;
  assert.equal(h.events.length, count, 'old response produces no callbacks after cancellation');
  fresh.resolve({ kind: 'found', models: [{ id: 'fresh' }] });
  await second;
  assert.deepEqual(h.events.filter(([name, value]) => name === 'setCandidates' && value.length > 0).map(([, value]) => [...value.map(model => model.id)]), [['fresh']]);
  assert.equal(calls, 2);
});

test('busy or unavailable profiles do not open or send discovery requests', async () => {
  for (const override of [{ namespace: null }, { discoveryBusy: true }, { profileDisabled: true }]) {
    const h = fixture(() => { throw new Error('must not query'); }, override);
    await h.discover();
    assert.deepEqual(h.events, []);
  }
});

test('discovery failures expose a fixed error state and never an upstream exception or secret', async () => {
  const h = fixture(async () => { throw new Error('PRIVATE_UPSTREAM_ERROR'); });
  await h.discover();
  assert.ok(h.events.some(([name, value]) => name === 'setDiscoveryError' && value === true));
  assert.equal(JSON.stringify(h.events).includes('PRIVATE_UPSTREAM_ERROR'), false);
  assert.deepEqual(h.events.at(-1), ['setDiscoveryBusy', false]);
});

test('key help is an actual button with hover, focus, click-pinning, Escape and outside dismissal', () => {
  assert.ok(help.includes("h('button', { type: 'button'"));
  assert.ok(help.includes("role: 'tooltip'"));
  assert.ok(help.includes("'aria-describedby': open ? tooltipId : undefined"));
  assert.ok(help.includes('onPointerEnter:'));
  assert.ok(help.includes('onFocus:'));
  assert.ok(help.includes('if (pinned) close(); else setPinned(true)'));
  assert.ok(help.includes('}, 180)'));
  for (const name of ['pointerdown', 'keydown']) {
    assert.ok(help.includes(`document.addEventListener('${name}'`));
    assert.ok(help.includes(`document.removeEventListener('${name}'`));
  }
  assert.ok(help.includes("event.key === 'Escape'"));
  assert.ok(editor.includes("h('label', { htmlFor: apiKeyInputId }"));
  assert.ok(editor.includes('h(ProviderKeyHelp,'));
  assert.ok(editor.includes('disabled: discoveryOpen'));
});

test('native modal owns focus and Escape, closes on cleanup and restores only its own trigger or heading', () => {
  assert.ok(dialog.includes('if (!dialog.open) dialog.showModal()'));
  assert.ok(dialog.includes('if (dialog.open) dialog.close()'));
  assert.ok(dialog.includes('closingRef.current = true'));
  assert.ok(dialog.includes('event.preventDefault(); dismissRef.current()'));
  assert.ok(dialog.includes('if (!closingRef.current && !event.currentTarget.open) dismissRef.current()'));
  assert.ok(dialog.includes('trigger?.isConnected && !trigger.disabled'));
  assert.ok(dialog.includes('fallbackRef.current?.focus'));
  assert.equal(/createPortal|document\.body|querySelector/.test(dialog), false);
  assert.ok(source.includes('.pq-model-dialog:not([open]){display:none}'));
  assert.ok(source.includes('.pq-model-dialog-body{min-height:0;overflow-y:auto;'));
});

test('discovery results exist only in the modal and confirmation remains additive and draft-only', () => {
  assert.equal(editor.includes("candidates.length ? h('div', { className: 'pq-manager-discovery'"), false);
  assert.ok(editor.includes('discoveryOpen ? h(ProviderDiscoveryDialog,'));
  assert.ok(editor.includes('onDismiss: closeDiscovery'));
  assert.ok(editor.includes('if (profileDisabled || discoveryBusy || !discoveryOpen) return'));
  assert.ok(editor.includes('candidates.filter(model => selectedCandidates.has(model.id) && !currentIds.has(model.id))'));
  assert.ok(editor.includes('checked: alreadyAdded || selectedCandidates.has(model.id)'));
  assert.ok(editor.includes('disabled: alreadyAdded || profileDisabled || discoveryBusy'));
  assert.ok(editor.includes('selectVisibleProviderCandidates(current, visibleCandidates.map'));
  assert.ok(editor.includes('if (discoveryOpen) closeDiscovery();'));
  assert.ok(closeBody.includes('discoveryController.current?.abort()'));
  const append = editor.split('function appendSelectedCandidates()')[1].split('function addFieldOperation')[0];
  assert.equal(/manager\.(?:writeSettings|storeCredential)/.test(append), false);
  assert.ok(append.includes('setDiscoveryOpen(false)'));
});
