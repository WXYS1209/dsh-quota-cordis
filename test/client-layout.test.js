import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pureBlock = source.split('// BEGIN PURE LAYOUT')[1]?.split('// END PURE LAYOUT')[0];
assert.ok(pureBlock);
// Execute only arithmetic / classification helpers. No React, DOM or browser
// emulation: these checks do not assert real-page layout or visual success.
const { placeQuotaPopup, quotaTone, formatQuotaDate, formatQuotaCountdown, quotaBarTone, dockMetricItems, validColorThresholds, parseThresholdDraft } = vm.runInNewContext(`${pureBlock}\n({placeQuotaPopup,quotaTone,formatQuotaDate,formatQuotaCountdown,quotaBarTone,dockMetricItems,validColorThresholds,parseThresholdDraft})`);
const viewport = { left: 0, top: 0, width: 1280, height: 800 };
const rect = { left: 400, right: 700, top: 740, bottom: 768 };
const normalize = value => JSON.parse(JSON.stringify(value));

test('visible dates use slash separators and year-month-day order independently of locale', () => {
  const date = new Date(2026, 10, 10, 15, 20).getTime();
  assert.equal(formatQuotaDate(date), '2026/11/10 15:20');
  assert.equal(formatQuotaDate(date, { includeYear: false }), '11/10 15:20');
  assert.equal(formatQuotaDate(date, { dateOnly: true }), '2026/11/10');
});

test('billing date preserves UTC while using the same slash-separated YMD format', () => {
  assert.equal(formatQuotaDate(Date.UTC(2026, 0, 2, 0, 5), { utc: true }), '2026/01/02 00:05');
  assert.equal(formatQuotaDate(Date.UTC(2024, 1, 29), { utc: true, dateOnly: true }), '2024/02/29');
});

test('reset countdown uses adaptive minute, hour-minute, and day-hour-minute precision', () => {
  const now = Date.UTC(2026, 10, 10, 0, 0);
  assert.equal(formatQuotaCountdown(now + (4 * 60 + 5) * 60000, now), '4h5m');
  assert.equal(formatQuotaCountdown(now + 59 * 60000 + 30000, now), '1h0m');
  assert.equal(formatQuotaCountdown(now + 1000, now), '1m');
  assert.equal(formatQuotaCountdown(now + (23 * 60 + 59) * 60000, now), '23h59m');
  assert.equal(formatQuotaCountdown(now + (24 * 60) * 60000, now), '1d0h0m');
  assert.equal(formatQuotaCountdown(now + (167 * 60 + 55) * 60000, now), '6d23h55m');
  assert.equal(formatQuotaCountdown(now, now), '0m');
  assert.equal(formatQuotaCountdown(now - 100000, now), '0m');
});

test('invalid dates and countdowns never produce a fabricated timestamp or NaN text', () => {
  for (const value of [NaN, Infinity, null, undefined, '2026/11/10']) {
    assert.equal(formatQuotaDate(value), '—');
    assert.equal(formatQuotaCountdown(value, Date.now()), '—');
  }
  assert.equal(formatQuotaDate(8640000000000001), '—');
});

test('remaining-quota bar colors respect the default 50 and 25 percent boundaries', () => {
  for (const value of [100, 75.00001, 75, 50.00001, 50]) assert.equal(quotaBarTone(value), 'success');
  for (const value of [49.99999, 40, 25]) assert.equal(quotaBarTone(value), 'warn');
  for (const value of [24.99999, 1, 0]) assert.equal(quotaBarTone(value), 'error');
  assert.equal(quotaBarTone(NaN), 'idle');
});

test('dock colors five-hour 60 percent and weekly 10 percent independently', () => {
  const metrics = Object.freeze([
    Object.freeze({ type: 'quota-window', label: 'rolling', usedPercent: 40 }),
    Object.freeze({ type: 'quota-window', label: 'weekly', usedPercent: 90 }),
  ]);
  const items = dockMetricItems(metrics);
  assert.deepEqual(normalize(items.map(item => [item.metric.label, item.remainingPercent, item.tone])), [['rolling', 60, 'success'], ['weekly', 10, 'error']]);
  assert.equal(metrics[0].usedPercent, 40);
  assert.equal(metrics[1].usedPercent, 90);
});

test('all subscription windows, including MCP, retain their own green orange or red tone', () => {
  const items = dockMetricItems([
    { type: 'quota-window', label: 'rolling', usedPercent: 25 },
    { type: 'quota-window', label: 'weekly', usedPercent: 75 },
    { type: 'quota-window', label: 'mcp', usedPercent: 100 },
  ]);
  assert.deepEqual(normalize(items.map(item => item.tone)), ['success', 'warn', 'error']);
});

test('cash and spend remain neutral; invalid quota percentages do not invent a colored reading', () => {
  const items = dockMetricItems([
    { type: 'balance', amount: '0', currency: 'CNY' },
    { type: 'spend', amount: '2.57', currency: 'USD' },
    { type: 'quota-window', label: 'weekly', usedPercent: NaN },
    { type: 'unrecognized' },
  ]);
  assert.deepEqual(normalize(items.map(item => [item.metric.type, item.tone])), [['balance', null], ['spend', null]]);
  assert.deepEqual(normalize(dockMetricItems([])), []);
});

test('each dock item has its own color span and weekly naming is consistent', () => {
  const dock = source.split('function Dock(props)')[1].split("ctx.slots.inject('settings.section'")[0];
  assert.ok(dock.includes('segments.map((segment, index)'));
  assert.ok(dock.includes("className: 'pq-summary-item', 'data-tone': segment.tone"));
  assert.ok(dock.includes("className: 'pq-summary-separator'"));
  assert.ok(source.includes("weekly: '周限'"));
  assert.ok(!source.includes("weekly: '本周'"));
  for (const tone of ['success', 'warn', 'error']) assert.ok(source.includes(`.pq-summary-item[data-tone=${tone}]{color:var(--dsw-alias-state-${tone}-primary)}`));
});

test('reset countdown refreshes while mounted with no extra provider queries', () => {
  const reset = source.split('function ResetTime({ value })')[1].split('function number(value)')[0];
  assert.ok(reset.includes('setInterval(update, 15_000)'));
  assert.ok(reset.includes('clearInterval(clock)'));
  assert.ok(reset.includes("document.removeEventListener('visibilitychange', update)"));
  assert.equal(reset.includes('fetch('), false);
  assert.equal(reset.includes('load('), false);
  assert.ok(source.includes('const tone = quotaBarTone(100 - used, colorThresholds)'));
  assert.ok(!source.includes('toLocaleDateString('));
  assert.ok(!source.includes('toLocaleString('));
  assert.ok(source.includes("next: '重置于'"));
  assert.ok(!source.includes("next: '重制于'"));
});

test('bottom trigger produces an above-only bounded overlay, not extra document-flow height', () => {
  assert.deepEqual(normalize(placeQuotaPopup(rect, viewport)), { left: 280, width: 420, top: 732, maxHeight: 600, above: true });
});

test('narrow viewport clamps width and horizontal edges without overflowing', () => {
  const result = placeQuotaPopup({ left: 10, right: 290, top: 560, bottom: 588 }, { left: 0, top: 0, width: 320, height: 600 });
  assert.equal(result.width, 296);
  assert.equal(result.left, 12);
  assert.equal(result.above, true);
  assert.ok(result.top - result.maxHeight >= 12);
});

test('visual viewport offset and right-edge clamping use one consistent coordinate space', () => {
  const view = { left: 40, top: 200, width: 360, height: 500 };
  const result = placeQuotaPopup({ left: 350, right: 430, top: 650, bottom: 680 }, view);
  assert.equal(result.left, 52);
  assert.equal(result.width, 336);
  assert.ok(result.left + result.width <= view.left + view.width - 12);
  assert.ok(result.top - result.maxHeight >= view.top + 12);
});

test('near-top trigger uses viewport fallback without pushing the dock down', () => {
  const result = placeQuotaPopup({ left: 20, right: 180, top: 30, bottom: 58 }, { left: 0, top: 0, width: 360, height: 220 });
  assert.equal(result.above, false);
  assert.equal(result.top, 12);
  assert.equal(result.maxHeight, 196);
});

test('detached, hidden, invalid and entirely offscreen anchors cannot keep an orphan popup', () => {
  for (const anchor of [null, { ...rect, top: NaN }, { ...rect, top: 900, bottom: 928 }, { ...rect, top: -40, bottom: 0 }, { ...rect, left: 1400, right: 1600 }, { ...rect, right: rect.left }, { ...rect, bottom: rect.top }]) assert.equal(placeQuotaPopup(anchor, viewport), null);
  assert.equal(placeQuotaPopup(rect, { ...viewport, width: 24 }), null);
  assert.equal(placeQuotaPopup(rect, { ...viewport, height: 24 }), null);
});

test('above placement never exceeds viewport bounds across responsive sizes', () => {
  for (const width of [200, 320, 520, 800, 1600]) {
    for (const height of [200, 400, 800, 1200]) {
      for (const x of [0, width / 2, width - 20]) {
        const view = { left: 0, top: 0, width, height };
        const anchor = { left: x, right: Math.min(width, x + 150), top: height - 50, bottom: height - 22 };
        const placed = placeQuotaPopup(anchor, view);
        assert.ok(placed);
        assert.ok(placed.left >= 12);
        assert.ok(placed.left + placed.width <= width - 12);
        assert.ok(placed.maxHeight <= height - 24);
        if (placed.above) assert.ok(placed.top - placed.maxHeight >= 12);
        else assert.ok(placed.top + placed.maxHeight <= height - 12);
      }
    }
  }
});

test('status tones distinguish exhausted quota, query errors, stale readings and harmless zero bonus', () => {
  assert.equal(quotaTone({ status: 'ok', metrics: [{ type: 'quota-window', usedPercent: 96 }] }), 'error');
  assert.equal(quotaTone({ status: 'ok', metrics: [{ type: 'quota-window', usedPercent: 75 }] }), 'warn');
  assert.equal(quotaTone({ status: 'ok', metrics: [{ type: 'quota-window', usedPercent: 85 }] }), 'error');
  assert.equal(quotaTone({ status: 'ok', metrics: [{ type: 'balance', amount: '0', wallet: 'bonus' }] }), 'success');
  assert.equal(quotaTone({ status: 'network', stale: true, metrics: [] }), 'warn');
  assert.equal(quotaTone({ status: 'unauthorized', metrics: [] }), 'error');
  assert.equal(quotaTone({ status: 'unsupported', metrics: [] }), 'idle');
});

test('dock contributes only a dialog trigger; details mount in the root overlay slot', () => {
  const dock = source.split('function Dock(props)')[1].split("ctx.slots.inject('settings.section'")[0];
  assert.ok(dock.includes("'aria-haspopup': 'dialog'"));
  assert.ok(dock.includes("'aria-expanded': isOpen"));
  assert.ok(!dock.includes("h('details'"));
  assert.ok(!dock.includes('h(Row'));
  assert.ok(source.includes("name: 'shell.overlay', id: 'provider-quota.popup'"));
  assert.ok(source.includes('position:fixed'));
  assert.ok(source.includes("transform: position.above ? 'translateY(-100%)' : 'none'"));
  assert.ok(source.includes('height:30px'));
});

test('outside click, focus, Escape and animation tracking all have paired disposal', () => {
  for (const event of ['pointerdown', 'focusin', 'keydown', 'visibilitychange']) {
    assert.ok(source.includes(`document.addEventListener('${event}'`));
    assert.ok(source.includes(`document.removeEventListener('${event}'`));
  }
  assert.ok(source.includes('window.cancelAnimationFrame(frame)'));
  assert.ok(source.includes("event.key === 'Escape'"));
  assert.ok(source.includes('event.stopPropagation()'));
  assert.ok(source.includes('anchor.focus({ preventScroll: true })'));
});

test('styling stays theme-token-only and UI never creates a second app or uses raw HTML', () => {
  const css = source.match(/const css = `([\s\S]*?)`;/)[1];
  assert.equal(/#[a-f\d]{3,8}\b/i.test(css), false);
  for (const match of css.matchAll(/var\((--[^,)]+)/g)) assert.ok(match[1].startsWith('--dsw-alias-'));
  assert.equal(source.includes('dangerouslySetInnerHTML'), false);
  assert.equal(source.includes('document.body'), false);
  assert.equal(source.includes('@deepseek-ai/dsh-client-ui-primitives'), false);
  assert.ok(source.includes("'aria-modal': false"));
});

test('custom green and orange boundaries are inclusive and shared across windows', () => {
  const thresholds = Object.freeze({ greenMin: 60, orangeMin: 10 });
  for (const remaining of [100, 60.001, 60]) assert.equal(quotaBarTone(remaining, thresholds), 'success');
  for (const remaining of [59.999, 30, 10]) assert.equal(quotaBarTone(remaining, thresholds), 'warn');
  for (const remaining of [9.999, 0]) assert.equal(quotaBarTone(remaining, thresholds), 'error');
  const items = dockMetricItems([
    { type: 'quota-window', label: 'rolling', usedPercent: 40 },
    { type: 'quota-window', label: 'weekly', usedPercent: 90 },
    { type: 'quota-window', label: 'quota', usedPercent: 91 },
  ], thresholds);
  assert.deepEqual(normalize(items.map(item => [item.metric.label, item.tone])), [['rolling', 'success'], ['weekly', 'warn'], ['quota', 'error']]);
  assert.equal(items[2].metric.label, 'quota'); // Unknown duration is not relabeled as five hours.
  assert.equal(quotaTone({ status: 'ok', metrics: items.map(item => item.metric) }, thresholds), 'error');
});

test('threshold parser rejects blank, fractional, reversed and out-of-range fields', () => {
  for (const [green, orange] of [['', '25'], ['75', ''], [' ', '0'], ['75.5', '25'], ['1e2', '25'], ['75', '75'], ['25', '75'], ['101', '25'], ['75', '-1'], ['0', '0']]) {
    assert.equal(parseThresholdDraft(green, orange), null, `${green}/${orange}`);
  }
  assert.deepEqual(normalize(parseThresholdDraft('75', '25')), { greenMin: 75, orangeMin: 25 });
  assert.deepEqual(normalize(parseThresholdDraft(' 100 ', '0')), { greenMin: 100, orangeMin: 0 });
  assert.deepEqual(normalize(parseThresholdDraft('1', '0')), { greenMin: 1, orangeMin: 0 });
  for (const value of [null, {}, { greenMin: '75', orangeMin: 25 }, { greenMin: 75, orangeMin: 75 }, { greenMin: 75.5, orangeMin: 25 }, { greenMin: 75, orangeMin: NaN }]) assert.equal(validColorThresholds(value), false);
});

test('invalid configuration falls back safely and edge threshold pairs remain usable', () => {
  assert.equal(quotaBarTone(75, { greenMin: 20, orangeMin: 80 }), 'success');
  assert.equal(quotaBarTone(25, null), 'warn');
  assert.equal(quotaBarTone(0, { greenMin: 100, orangeMin: 0 }), 'warn');
  assert.equal(quotaBarTone(100, { greenMin: 100, orangeMin: 0 }), 'success');
  assert.equal(quotaBarTone(NaN, { greenMin: 60, orangeMin: 10 }), 'idle');
});

test('custom subscription thresholds never recolor cash or spending metrics', () => {
  const thresholds = { greenMin: 100, orangeMin: 99 };
  const cash = { status: 'ok', metrics: [{ type: 'balance', amount: '10', currency: 'USD' }, { type: 'spend', amount: '100', currency: 'USD' }] };
  assert.deepEqual(normalize(dockMetricItems(cash.metrics, thresholds).map(item => item.tone)), [null, null]);
  assert.equal(quotaTone(cash, thresholds), quotaTone(cash));
  assert.equal(quotaTone({ status: 'ok', metrics: [{ type: 'balance', amount: '0', wallet: 'recharge' }] }, thresholds), 'error');
  assert.equal(quotaTone({ status: 'ok', metrics: [{ type: 'balance', amount: '0', wallet: 'bonus' }] }, thresholds), 'success');
});

test('quota page color settings use explicit save and verified readback; defaults only edit draft', () => {
  const settings = source.split('function QuotaSettings()')[1].split('function Page()')[0];
  assert.equal(source.includes("name: 'settings.plugins.tab', id: 'local-provider-quota-settings'"), false);
  assert.ok(source.includes("settingsTitle: '订阅颜色阈值'"));
  assert.ok(settings.includes("new URL('api/provider-quota-settings', document.baseURI)"));
  assert.ok(settings.includes("'X-Quota-Settings-CSRF': csrfRef.current"));
  assert.ok(settings.includes("method: payload ? 'POST' : 'GET'"));
  assert.ok(settings.includes("written.saved !== true"));
  assert.ok(settings.includes('confirmed = await fetchSettings()'));
  assert.ok(settings.includes('confirmed.colorThresholds.greenMin !== candidate.greenMin'));
  assert.ok(settings.includes("setNotice(candidate ? 'saved' : null)"));
  const defaults = settings.split("String(DEFAULT_COLOR_THRESHOLDS.greenMin)")[1].split("t('defaults')")[0];
  assert.equal(defaults.includes('run('), false);
  assert.equal(defaults.includes('fetch('), false);
  assert.equal(source.includes('localStorage'), false);
  assert.equal(source.includes('sessionStorage'), false);
  assert.equal(/type:\s*['"]color['"]/.test(settings), false);
  assert.equal(settings.includes('setInterval('), false);
});

test('supplier quota page separates overview and threshold form into accessible internal tabs', () => {
  const page = source.split('function Page()')[1].split('function PopupSurface')[0];
  assert.ok(source.includes("overviewTab: '额度概览'"));
  assert.ok(source.includes("colorsTab: '颜色设置'"));
  assert.ok(page.includes("role: 'tablist'"));
  assert.ok(page.includes("role: 'tab'"));
  assert.ok(page.includes("'aria-selected': tab === id"));
  assert.ok(page.includes("tabIndex: tab === id ? 0 : -1"));
  assert.ok(page.includes("id: 'pq-panel-overview', role: 'tabpanel'"));
  assert.ok(page.includes("id: 'pq-panel-colors', role: 'tabpanel'"));
  assert.ok(page.includes("tab === 'colors' ? h(QuotaSettings) : null"));
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.ok(page.includes(`'${key}'`));
  assert.ok(page.includes('tabRefs.current[target]?.focus()'));
  assert.equal(source.includes("ctx.slots.inject('settings.plugins.tab'"), false);
});

test('overview company filter groups known brands and filters rows within overview sections', () => {
  const page = source.split('function Page()')[1].split('function PopupSurface')[0];
  assert.ok(source.includes("case 'openai': case 'codex': return 'openai'"));
  assert.ok(source.includes("case 'deepseek': case 'account': return 'deepseek'"));
  assert.ok(source.includes("case 'glm-cn': case 'zai-coding-plan': return 'glm'"));
  assert.ok(source.includes("if (row.reason === 'zai-api-status-only') return 'glm'"));
  assert.ok(source.includes("default: return 'other'"));
  assert.ok(page.includes("const [companyFilter, setCompanyFilter] = React.useState('all')"));
  assert.ok(page.includes("className: 'pq-overview-filter'"));
  assert.ok(page.includes("htmlFor: 'pq-company-filter'"));
  assert.ok(page.includes("id: 'pq-company-filter', className: 'pq-company-select'"));
  assert.ok(page.includes('const group = visibleRows.filter(filter)'));
  assert.ok(page.includes("!['account', 'glm-cn', 'zai-coding-plan', 'codex', 'opencode-go', 'minimax-cn'].includes(row.kind)"));
  assert.ok(page.includes("t('companyNoResults')"));
  assert.ok(source.includes("companyFilter: '供应商公司'"));
  assert.ok(source.includes("companyFilter: 'Provider company'"));
  assert.ok(source.includes('.pq-company-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)'));
});

test('OpenAI Admin Key lives in an explicit API extras tab only when an official OpenAI route exists', () => {
  const page = source.split('function Page()')[1].split('function PopupSurface')[0];
  const extra = source.split('function OpenAIExtraSettings({ routes })')[1].split('function Page()')[0];
  assert.ok(page.includes("rows.filter(row => row.kind === 'openai')"));
  assert.ok(page.includes("openAIProviders.length ? ['apiExtra'] : []"));
  assert.ok(page.includes("h(OpenAIExtraSettings, { routes: openAIProviders })"));
  assert.ok(extra.includes("new URL('api/provider-quota-settings'"));
  assert.ok(extra.includes("action: 'saveAdminKey', adminKey: secret"));
  assert.ok(extra.includes("type: 'password'"));
  assert.ok(extra.includes("setKeyDraft('')"));
  assert.ok(extra.includes('const hasKeyInput = keyDraft.trim().length > 0'));
  assert.ok(extra.includes('disabled: busy || !hasKeyInput'));
  assert.ok(extra.includes('const secret = keyDraft.trim()'));
  assert.equal(extra.includes('const valid = /^sk-admin-'), false);
  assert.equal(extra.includes('localStorage'), false);
  assert.equal(extra.includes('sessionStorage'), false);
  assert.ok(extra.includes("const [keyDraft, setKeyDraft] = React.useState('')"));
  assert.ok(!extra.includes("useState(data?.adminKey"));
});

test('Admin Key status distinguishes checking, missing and configured states and links to key settings', () => {
  const extra = source.split('function OpenAIExtraSettings({ routes })')[1].split('function Page()')[0];
  assert.ok(extra.includes('data || busy ? h(\'p\''));
  assert.ok(extra.includes('pq-admin-key-configured'));
  assert.ok(extra.includes("adminKeyConfigured ? { 'data-tone': 'success' } : {}"));
  assert.ok(extra.includes("t(!data ? 'adminChecking' : adminKeyConfigured ? 'adminConfigured' : 'adminMissing')"));
  assert.ok(source.includes('.pq-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}'));
  assert.ok(source.includes('.pq-admin-key-configured{color:var(--dsw-alias-state-success-primary)}'));
  assert.ok(extra.includes("href: 'https://platform.openai.com/settings/organization/admin-keys'"));
  assert.ok(extra.includes("target: '_blank', rel: 'noopener noreferrer'"));
  assert.ok(source.includes("adminHowToGetKey: '在 OpenAI Platform 的 Organization → Settings → Admin keys 中创建（需组织所有者权限）：'"));
  assert.ok(source.includes("adminHowToGetKey: 'Create one in OpenAI Platform → Organization → Settings → Admin keys (organization owner access required):'"));
});

test('OpenAI spend card selects complete UTC-day ranges and matching key breakdowns', async () => {
  const metric = source.split('function Metric({ metric, colorThresholds })')[1].split('function Row({ row')[0];
  assert.ok(metric.includes('React.useState(\'7d\')'));
  assert.ok(metric.includes("['1d', '7d', '30d']"));
  assert.ok(metric.includes('metric.ranges?.[range]'));
  assert.ok(metric.includes('selected.breakdown'));
  assert.ok(metric.includes("selected.noRecords ? h('div', { className: 'pq-breakdown-list' }"));
  assert.ok(metric.includes("role: 'status'"));
  assert.ok(source.includes('.pq-breakdown-list .pq-breakdown{margin-top:0;padding:8px 10px;border:1px solid'));
  assert.ok(metric.includes("t('completeUtcDays')"));
  assert.ok(metric.includes("t('spendRange')"));
  assert.ok(metric.includes("t('rangeAnnouncement')"));
  assert.ok(metric.includes("'aria-live': 'polite'"));
  assert.ok(metric.includes("t('costsLag')"));
  assert.ok(metric.includes("t('apiSpend')"));
  assert.ok(source.includes('Costs data may lag or be backfilled'));
  assert.ok(source.includes('数据可能延迟或回填'));
  assert.ok(source.includes('不含当天；1d 为昨天。'));
  assert.ok(!source.includes('不含今天'));
  assert.ok(metric.includes("entry.apiKeyName || (entry.apiKeyId ? `${t('apiKey')} ${entry.apiKeyId}` : t('apiKeyUnattributed'))"));
  assert.ok(!metric.includes('metric.daily'));
  assert.ok(!metric.includes("t('todaySpend')"));
  assert.ok(!metric.includes("t('period')"));
  assert.ok(!metric.includes('SpendTrend'));
  assert.ok(!source.includes('function SpendTrend'));
  assert.ok(!source.includes('pq-chart-'));
  assert.ok(metric.includes('role: \'list\''));
  // The grouped request and 30-day aggregation live in the Host costs module.
  const costs = await readFile(new URL('../openai-costs.js', import.meta.url), 'utf8');
  assert.ok(costs.includes("url.searchParams.append('group_by', 'api_key_id')"));
  assert.ok(costs.includes("ranges,\n      ...(monthRecords.get(currency) === undefined ? { noRecords: true } : {})"));
  assert.ok(costs.includes('apiKeyId: apiKeyId || null'));
  assert.ok(costs.includes('historyStart = Math.max(0, historyEnd - 30 * dayMs)'));
});

test('main page, popup and dock use snapshot thresholds; palette stays fixed to theme tokens', () => {
  assert.ok(source.includes('colorThresholds: state.data?.colorThresholds'));
  assert.ok(source.includes('dockMetricItems(row.metrics, colorThresholds)'));
  assert.ok(source.includes('quotaTone(row, colorThresholds)'));
  assert.ok(source.includes('h(Metric, { key: index, metric, colorThresholds })'));
  assert.ok(source.includes('h(Status, { row, colorThresholds })'));
  assert.ok(source.includes('colorThresholds: data.colorThresholds, checkedAt: data.checkedAt'));
  for (const tone of ['success', 'warn', 'error']) assert.ok(source.includes(`--dsw-alias-state-${tone}-primary`));
  assert.equal(source.includes('greenColor'), false);
  assert.equal(source.includes('orangeColor'), false);
  assert.equal(source.includes('redColor'), false);
});

test('Codex joins subscriptions with fixed grant-state guidance and never triggers login', () => {
  assert.ok(source.includes("['subscription', row => ['glm-cn', 'zai-coding-plan', 'codex', 'opencode-go', 'minimax-cn'].includes(row.kind)]"));
  assert.ok(source.includes("['api', row => !['account', 'glm-cn', 'zai-coding-plan', 'codex', 'opencode-go', 'minimax-cn'].includes(row.kind)]"));
  assert.ok(source.includes("opencode-go-only"));
  for (const key of ['codex-usage', 'codex-auth-required', 'codex-auth-expired']) assert.ok(source.includes(`'${key}':`));
  assert.ok(source.includes('本插件不会自动续期或发起推理'));
  assert.equal(quotaTone({ status: 'codex-auth-required', metrics: [] }), 'idle');
  assert.equal(quotaTone({ status: 'codex-auth-expired', metrics: [] }), 'idle');
  assert.equal(source.includes('authorization.begin'), false);
  assert.equal(source.includes("action: 'start'"), false);
});

test('Z.AI Coding Plan is distinguished from Standard API billing rows', () => {
  assert.ok(source.includes("if (row.reason === 'zai-api-status-only') return t('zai-api-status-only-short')"));
  assert.ok(source.includes("['glm-cn', 'zai-coding-plan', 'codex', 'opencode-go', 'minimax-cn'].includes(row.kind)"));
  assert.ok(source.includes("zaiPlan: 'GLM Coding · Global'"));
  assert.ok(source.includes("'zai-api-status-only': 'This is a non-built-in Z.AI Standard API route."));
  assert.ok(source.includes("'zai-api-status-only': '这是非内置 Z.AI Standard API 路由。"));
  assert.ok(source.includes("t(row.reason === 'zai-api-status-only' ? 'zai-api-billing-dashboard' : row.kind === 'zai-coding-plan' ? 'zai-plan-dashboard' : 'dashboard')"));
  assert.ok(source.includes("'zai-plan-dashboard': 'Plan usage'"));
  assert.ok(source.includes("'zai-plan-dashboard': '套餐用量'"));
  assert.ok(source.includes("'zai-api-billing-dashboard': 'Billing console'"));
  assert.ok(source.includes("'zai-api-billing-dashboard': '账单控制台'"));
});
