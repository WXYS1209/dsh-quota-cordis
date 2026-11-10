window.__ModuleLoader__.load({
  id: 'dsh-provider-quota',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-provider-quota';
    const POPUP_ID = 'pq-provider-popup';

    // BEGIN PURE LAYOUT
    // Geometry uses only this plugin's trigger and viewport. No host DOM lookup.
    function placeQuotaPopup(rect, viewport) {
      if (!rect || !viewport || ![rect.left, rect.right, rect.top, rect.bottom, viewport.left, viewport.top, viewport.width, viewport.height].every(Number.isFinite)) return null;
      const margin = 12, gap = 8;
      if (viewport.width <= margin * 2 || viewport.height <= margin * 2 || rect.right <= rect.left || rect.bottom <= rect.top) return null;
      if (rect.bottom <= viewport.top || rect.top >= viewport.top + viewport.height || rect.right <= viewport.left || rect.left >= viewport.left + viewport.width) return null;
      const width = Math.min(420, viewport.width - margin * 2);
      const left = Math.max(viewport.left + margin, Math.min(rect.right - width, viewport.left + viewport.width - margin - width));
      const availableAbove = rect.top - gap - viewport.top - margin;
      if (availableAbove >= 160) return { left, width, top: rect.top - gap, maxHeight: Math.min(600, availableAbove), above: true };
      // An exceptionally short viewport gets a bounded overlay, never flow content.
      return { left, width, top: viewport.top + margin, maxHeight: viewport.height - margin * 2, above: false };
    }
    const DEFAULT_COLOR_THRESHOLDS = Object.freeze({ greenMin: 50, orangeMin: 25 });
    function validColorThresholds(value) {
      return Boolean(value && Number.isInteger(value.greenMin) && Number.isInteger(value.orangeMin) && value.orangeMin >= 0 && value.orangeMin < value.greenMin && value.greenMin <= 100);
    }
    function parseThresholdDraft(greenMin, orangeMin) {
      if (![greenMin, orangeMin].every(value => typeof value === 'string' && /^\d{1,3}$/.test(value.trim()))) return null;
      const thresholds = { greenMin: Number(greenMin.trim()), orangeMin: Number(orangeMin.trim()) };
      return validColorThresholds(thresholds) ? thresholds : null;
    }
    function quotaTone(row, thresholds = DEFAULT_COLOR_THRESHOLDS) {
      if (!row) return 'idle';
      if (row.stale) return 'warn';
      if (row.status !== 'ok') return ['unsupported', 'admin-key-required', 'unsupported-auth', 'account-changed', 'codex-auth-required', 'codex-auth-expired'].includes(row.status) ? 'idle' : 'error';
      const tones = dockMetricItems(row.metrics, thresholds).filter(item => item.metric.type === 'quota-window').map(item => item.tone);
      if (tones.includes('error') || row.metrics.some(metric => metric.type === 'balance' && Number(metric.amount) <= 0 && metric.wallet !== 'bonus')) return 'error';
      return tones.includes('warn') ? 'warn' : 'success';
    }
    function formatQuotaDate(value, { includeYear = true, utc = false, dateOnly = false } = {}) {
      if (!Number.isFinite(value)) return '—';
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return '—';
      const field = name => date[`${utc ? 'getUTC' : 'get'}${name}`]();
      const pad = number => String(number).padStart(2, '0');
      const day = `${includeYear ? String(field('FullYear')).padStart(4, '0') + '/' : ''}${pad(field('Month') + 1)}/${pad(field('Date'))}`;
      return dateOnly ? day : `${day} ${pad(field('Hours'))}:${pad(field('Minutes'))}`;
    }
    function formatQuotaCountdown(value, now) {
      if (!Number.isFinite(value) || !Number.isFinite(now)) return '—';
      const minutes = Math.max(0, Math.ceil((value - now) / 60_000));
      if (minutes < 60) return `${minutes}m`;
      if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
      const days = Math.floor(minutes / (24 * 60));
      const hours = Math.floor(minutes / 60) % 24;
      const remainder = minutes % 60;
      return `${days}d${hours}h${remainder}m`;
    }
    function quotaBarTone(remainingPercent, thresholds = DEFAULT_COLOR_THRESHOLDS) {
      if (!Number.isFinite(remainingPercent)) return 'idle';
      const { greenMin, orangeMin } = validColorThresholds(thresholds) ? thresholds : DEFAULT_COLOR_THRESHOLDS;
      return remainingPercent >= greenMin ? 'success' : remainingPercent >= orangeMin ? 'warn' : 'error';
    }
    function dockMetricItems(metrics, thresholds = DEFAULT_COLOR_THRESHOLDS) {
      return metrics.flatMap(metric => {
        if (metric.type === 'quota-window') {
          if (!Number.isFinite(metric.usedPercent)) return [];
          const remainingPercent = 100 - Math.max(0, Math.min(100, metric.usedPercent));
          return [{ metric, remainingPercent, tone: quotaBarTone(remainingPercent, thresholds) }];
        }
        return ['balance', 'spend'].includes(metric.type) ? [{ metric, tone: null }] : [];
      });
    }
    // END PURE LAYOUT

    const dictionaries = {
      zh: {
        title: '供应商额度', subtitle: '余额、订阅额度与 API 支出，分开查看。', refresh: '刷新全部', refreshOne: '刷新', loading: '正在查询…', empty: '尚未发现已配置的供应商。请先在「模型」设置中添加供应商。',
        api: 'API 余额与支出', subscription: '订阅额度', account: 'App 登录账户', current: '当前供应商额度', details: '额度详情', close: '关闭额度详情',
        balance: '可用余额', recharge: '充值余额', bonus: '赠送余额', rolling: '五小时', weekly: '周限', mcp: 'MCP 工具', quota: '额度窗口',
        used: '已用', left: '剩余', credits: '积分', tokens: 'Tokens', requests: '次', percent: '百分比', next: '重置于', updated: '更新于', stale: '数据已过期', staleDetail: '查询未成功，以下为上次成功数据。', never: '尚无成功数据', dashboard: '官方控制台',
        healthy: '正常', low: '额度偏低', exhausted: '额度不足', queryError: '查询异常', unavailable: '暂不可用', partial: '部分额度', scope: '统计范围', organizationShort: '组织总额', apiKeyBreakdown: '按 API Key 细分', apiKey: 'Key', apiKeyUnattributed: '组织级 / 未归属', kindBalance: '余额', kindSpend: 'API 支出', kindPlan: '订阅', kindOther: '查询状态',
        ok: '已更新', unsupported: '尚不支持此供应商或中转端点；不会自动向官方发送其凭据。', 'admin-key-required': '未找到 Admin Key。请在 API 额外配置 Tab 输入并保存；不会使用模型调用 Key 查询费用。', 'invalid-admin-key': 'Admin Key 格式无效，需要 sk-admin- 开头的组织管理密钥；不会回退到其他密钥。', 'admin-credential-error': 'DSH 凭据服务暂不可用；请稍后重试。', adminTitle: 'OpenAI Admin Key', adminIntro: '仅用于查询 OpenAI 官方组织 API 支出。该凭据独立保存在 DSH 安全凭据存储中，不会替代模型调用 Key。', adminKeyLabel: 'Admin Key', adminKeyPlaceholder: '输入 sk-admin-… 组织管理密钥', adminConfigured: '已检测到 Admin Key；为保护密钥不回显当前值。', adminMissing: '尚未配置 Admin Key。', adminSourceCredential: '当前从 DSH 凭据服务读取。', adminSave: '安全保存 Admin Key', adminSaved: 'Admin Key 已保存并确认可用。', adminSaveFailed: '未能确认 Admin Key 已安全保存，请刷新状态后重试。', adminUseOfficial: '仅官方 OpenAI API 路由可使用此设置。花费显示组织总支出，不按单一模型路由归因。', spend: '本月 API 支出', spendShort: '本月支出', organization: '整个组织，非当前路由专属', billingLag: '账单统计可能延迟；这不是预付余额，也不包含 ChatGPT/Codex 订阅。', noRecords: '该时间段暂无账单记录', period: '账期（UTC）', 'official-costs': 'OpenAI 官方 Costs API',
        'missing-credential': '未找到该路由使用的有效 API Key，请检查模型设置。', 'unsupported-auth': '此认证方式暂不支持。Codex 仅支持内置 openai-codex 的订阅授权，请检查「设置 → Codex 授权」；不会读取其他授权记录或猜测认证方式。', unauthorized: '认证失败（401），请检查该区域的 API Key。', forbidden: '无查询权限（403），请检查账户与套餐。', 'rate-limited': '供应商限流，已暂停重试约 2 分钟。', timeout: '查询超时，稍后可重试。', network: '无法连接供应商，请检查网络。', 'invalid-response': '额度响应暂无法识别，请以官方控制台为准。', upstream: '供应商查询失败或尚未订阅，请以官方控制台为准。',
        'account-changed': '账户身份正在更新，本次余额已丢弃；请稍后刷新。', serviceError: '额度服务暂不可用，请刷新页面后重试。', 'official-balance': '官方余额 API', 'provider-monitor': '供应商监控端点 · 个人套餐', 'harness-account': 'Harness 账户服务', none: '暂未查询',
        overviewTab: '额度概览', colorsTab: '颜色设置', apiExtraTab: 'API额外配置', settingsTitle: '订阅颜色阈值', settingsIntro: '在此直接调整数值并保存，无需编辑配置文件。每个订阅窗口独立计算，现金余额颜色不受影响。', greenMin: '绿色最低剩余百分比', orangeMin: '橙色最低剩余百分比', thresholdRules: '剩余 ≥ 绿色阈值为绿色；否则剩余 ≥ 橙色阈值为橙色；其余为红色。颜色固定跟随主题，不可编辑。', save: '保存设置', defaults: '恢复默认到草稿', saved: '设置已保存并回读确认。', settingsLoading: '正在读取设置…', readOnly: '当前配置不可写；可以查看，但不能保存。', settingsRefresh: '重新载入已保存值', defaultsNote: '默认绿色 50%、橙色 25%。恢复默认只修改草稿，仍需点击保存。',
        'invalid-thresholds': '请输入非空整数，满足 0 ≤ 橙色阈值 < 绿色阈值 ≤ 100。', 'settings-unavailable': '额度设置暂不可用，请重新载入后重试。', 'settings-conflict': '设置已变化，保存未获确认。请重新载入后重试。', 'save-failed': '保存未获确认，请重新载入检查实际已保存值。', settingsForbidden: '设置校验已过期或无写入权限，请重新载入后重试。',
        'codex-usage': 'Codex 订阅用量', 'codex-auth-required': '尚未保存 Codex 订阅授权，请在「设置 → Codex 授权」中登录。', 'codex-auth-expired': 'Codex 订阅授权已过期。可正常使用内置 openai-codex 模型让原生适配器续期，或前往「设置 → Codex 授权」重新登录；本插件不会自动续期或发起推理。',
        note: '余额 / 额度约 2 分钟刷新，组织费用缓存 15 分钟。隐藏页面时暂停；密钥仅在 Host 使用。', notFound: '当前供应商尚无额度数据', counts: '用量 / 总额', sourceDetails: '数据说明', route: '供应商路由', exact: '精确金额', cnPlan: 'GLM Coding · 国内', globalPlan: 'GLM Coding · 国际', accountName: 'DeepSeek 登录账户',
      },
      en: {
        title: 'Provider quota', subtitle: 'Balances, subscription quotas and API spend — kept separate.', refresh: 'Refresh all', refreshOne: 'Refresh', loading: 'Checking…', empty: 'No configured providers found. Add one in Models settings first.',
        overviewTab: 'Overview', colorsTab: 'Color settings', apiExtraTab: 'API extras', settingsTitle: 'Subscription color thresholds', settingsIntro: 'Edit and save the values here without opening a configuration file. Each subscription window is evaluated independently; cash colors are unchanged.', greenMin: 'Minimum remaining percentage for green', orangeMin: 'Minimum remaining percentage for orange', thresholdRules: 'Remaining ≥ green threshold is green; otherwise remaining ≥ orange threshold is orange; the rest is red. Colors are fixed theme colors and cannot be edited.', save: 'Save settings', defaults: 'Restore defaults to draft', saved: 'Settings saved and confirmed by reading them back.', settingsLoading: 'Loading settings…', readOnly: 'This configuration is read-only. Values can be viewed but not saved.', settingsRefresh: 'Reload saved values', defaultsNote: 'Defaults are green 50%, orange 25%. Restoring defaults only edits the draft; click Save to persist.',
        'invalid-thresholds': 'Enter non-empty integers satisfying 0 ≤ orange < green ≤ 100.', 'settings-unavailable': 'Quota settings are unavailable. Reload and try again.', 'settings-conflict': 'Settings changed; saving was not confirmed. Reload and try again.', 'save-failed': 'Saving was not confirmed. Reload to check the actual saved values.', settingsForbidden: 'The settings check expired or write access is unavailable. Reload and try again.',
        'codex-usage': 'Codex subscription usage', 'codex-auth-required': 'No Codex subscription grant is saved. Sign in under Settings → Codex authorization.', 'codex-auth-expired': 'The Codex grant expired. Normal use of the built-in openai-codex model lets its native adapter renew it, or sign in again under Settings → Codex authorization. This plugin never refreshes grants or sends inference probes.',
        api: 'API balances & spend', subscription: 'Subscriptions', account: 'App account', current: 'Current provider quota', details: 'Quota details', close: 'Close quota details',
        balance: 'Available balance', recharge: 'Recharge balance', bonus: 'Bonus balance', rolling: '5-hour', weekly: 'Weekly limit', mcp: 'MCP tools', quota: 'Quota window', used: 'Used', left: 'Left', credits: 'credits', tokens: 'tokens', requests: 'requests', percent: 'percent', next: 'Reset at', updated: 'Updated', stale: 'Stale data', staleDetail: 'The query failed. Showing the last successful data.', never: 'No successful data yet', dashboard: 'Official dashboard',
        healthy: 'Healthy', low: 'Running low', exhausted: 'Quota low', queryError: 'Query failed', unavailable: 'Unavailable', partial: 'Partial quota', scope: 'Scope', organizationShort: 'Organization', apiKeyBreakdown: 'By API key', apiKey: 'Key', apiKeyUnattributed: 'Organization-level / unattributed', kindBalance: 'Balance', kindSpend: 'API spend', kindPlan: 'Subscription', kindOther: 'Query status',
        ok: 'Updated', unsupported: 'This provider or relay endpoint is not supported. Its credentials are not sent to an official provider automatically.', 'admin-key-required': 'No Admin key is configured. Enter and save one in the API extras tab. Inference keys are never used for billing.', 'invalid-admin-key': 'Invalid Admin key format. An organization key starting with sk-admin- is required; no other key is tried.', 'admin-credential-error': 'The DSH credential service is unavailable. Try again later.', adminTitle: 'OpenAI Admin key', adminIntro: 'Used only for OpenAI organization API spend. Stored separately in the DSH credential store; it never replaces your inference key.', adminKeyLabel: 'Admin key', adminKeyPlaceholder: 'Enter organization key starting with sk-admin-', adminConfigured: 'An Admin key is configured. Its value is never shown again.', adminMissing: 'No Admin key is configured.', adminSourceCredential: 'Currently read from DSH credentials.', adminSave: 'Save Admin key securely', adminSaved: 'The Admin key was saved and confirmed.', adminSaveFailed: 'Could not confirm the Admin key was securely saved. Refresh status and try again.', adminUseOfficial: 'Only official OpenAI API routes use this setting. Spend is organization-wide and is not attributed to an individual model route.', spend: 'Month-to-date API spend', spendShort: 'Month to date', organization: 'Entire organization, not exclusive to this route', billingLag: 'Billing data may lag. This is not prepaid balance and excludes ChatGPT/Codex subscriptions.', noRecords: 'No billing records for this range', period: 'Billing period (UTC)', 'official-costs': 'Official OpenAI Costs API',
        'missing-credential': 'No valid API key was found for this route. Check Models settings.', 'unsupported-auth': 'This authentication method is unsupported. Codex requires the built-in openai-codex subscription grant; check Settings → Codex authorization. Other grants are not read and authentication is never guessed.', unauthorized: 'Authentication failed (401). Check the key and region.', forbidden: 'Quota access denied (403). Check the account and plan.', 'rate-limited': 'Rate limited. Retrying is paused for about 2 minutes.', timeout: 'The quota query timed out. Try again later.', network: 'Could not reach the provider. Check the network.', 'invalid-response': 'Unrecognized quota response. Check the official dashboard.', upstream: 'Quota query failed or no active plan. Check the official dashboard.',
        'account-changed': 'Account identity is changing. This balance was discarded; refresh shortly.', serviceError: 'Quota service is unavailable. Reload the page and try again.', 'official-balance': 'Official balance API', 'provider-monitor': 'Provider monitor · Personal plan', 'harness-account': 'Harness account service', none: 'Not queried', note: 'Balances / quotas refresh about every 2 minutes; organization costs cache for 15 minutes. Paused while hidden. Keys stay on the Host.', notFound: 'No quota data for the current provider', counts: 'Used / total', sourceDetails: 'Data details', route: 'Provider route', exact: 'Exact amount', cnPlan: 'GLM Coding · China', globalPlan: 'GLM Coding · Global', accountName: 'DeepSeek account',
      },
    };
    const css = `
.pq-page,.pq-popup{color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.55;box-sizing:border-box}.pq-page{width:100%;max-width:820px;padding:24px}.pq-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px}.pq-page h2{margin:0 0 6px;font-size:20px;font-weight:600}.pq-page h3{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;margin:24px 0 12px}.pq-group-count{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.pq-muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}.pq-row{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:18px;margin-bottom:12px;min-width:0}.pq-row-head,.pq-row-title,.pq-tags,.pq-footer,.pq-metric-head{display:flex;align-items:center;gap:10px}.pq-row-head,.pq-footer,.pq-metric-head{justify-content:space-between}.pq-row-title{min-width:0;flex-wrap:wrap}.pq-name{font-size:15px;font-weight:600;overflow-wrap:anywhere}.pq-tags{flex-wrap:wrap;gap:8px;margin-top:12px}.pq-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);line-height:18px}.pq-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}.pq-dot[data-tone=success]{background:var(--dsw-alias-state-success-primary)}.pq-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}.pq-dot[data-tone=error]{background:var(--dsw-alias-state-error-primary)}
.pq-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px;margin-top:16px}.pq-metric{min-width:0;background:var(--dsw-alias-bg-layer-2);border-radius:9px;padding:14px 16px}.pq-metric-label{font-size:12px;color:var(--dsw-alias-label-secondary)}.pq-amount{font-size:28px;line-height:1.25;font-weight:600;letter-spacing:-.4px;margin:7px 0 10px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.pq-quota-value{font-size:24px;line-height:1.3;font-weight:600;font-variant-numeric:tabular-nums}.pq-quota-value small{font-size:12px;font-weight:400;margin-right:6px;color:var(--dsw-alias-label-secondary)}.pq-track{height:6px;overflow:hidden;background:var(--dsw-alias-border-l1);border-radius:4px;margin:12px 0 8px}.pq-fill{height:100%;border-radius:4px;background:var(--dsw-alias-brand-primary)}.pq-breakdown{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:5px}.pq-breakdown strong{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}.pq-breakdown-list{margin-top:10px;display:flex;flex-direction:column;gap:6px}.pq-breakdown-list .pq-breakdown{margin-top:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow-wrap:anywhere}.pq-scope{font-size:12px;font-weight:500;margin:8px 0}.pq-footnote{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary);margin-top:10px}.pq-success{color:var(--dsw-alias-state-success-primary)}.pq-reset{display:block;font-variant-numeric:tabular-nums}.pq-warn{color:var(--dsw-alias-state-warn-primary)}.pq-error{color:var(--dsw-alias-state-error-primary)}.pq-status{font-size:12px;line-height:1.7;margin:12px 0 0;overflow-wrap:anywhere;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}.pq-footer{gap:12px;flex-wrap:wrap;margin-top:16px}.pq-link{font-size:12px;color:var(--dsw-alias-brand-primary);text-decoration:none}.pq-link:hover{text-decoration:underline}.pq-meta{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:12px}.pq-meta summary{cursor:pointer;width:max-content}.pq-meta dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 12px;margin:10px 0 0}.pq-meta dt,.pq-meta dd{margin:0;overflow-wrap:anywhere}.pq-meta dd{color:var(--dsw-alias-label-primary)}
.pq-button{font:inherit;font-size:12px;line-height:20px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 11px;cursor:pointer;flex-shrink:0}.pq-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.pq-button:disabled{opacity:.55;cursor:default}.pq-button:focus-visible,.pq-link:focus-visible,.pq-trigger:focus-visible,.pq-meta summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.pq-note{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:20px;line-height:1.7}.pq-empty{padding:24px 0;color:var(--dsw-alias-label-secondary)}
.pq-dock{display:flex;min-width:0;max-width:100%;padding:1px 4px;height:30px;box-sizing:border-box;align-items:center}.pq-trigger{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%;height:28px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:3px 9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;cursor:pointer;text-align:left}.pq-trigger:hover,.pq-trigger[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}.pq-trigger-name{max-width:125px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:0 1 auto}.pq-trigger-value{font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1 1 auto}.pq-summary-item[data-tone=success]{color:var(--dsw-alias-state-success-primary)}.pq-summary-item[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}.pq-summary-item[data-tone=error]{color:var(--dsw-alias-state-error-primary)}.pq-summary-separator{color:var(--dsw-alias-label-secondary)}.pq-chevron{width:12px;height:12px;flex:none;transition:transform .12s}.pq-trigger[aria-expanded=true] .pq-chevron{transform:rotate(180deg)}
.pq-popup{position:fixed;display:flex;flex-direction:column;pointer-events:auto;z-index:1;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}.pq-popup-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}.pq-popup-actions{display:flex;align-items:center;gap:6px}.pq-close{font-size:20px;line-height:20px;width:30px;height:30px;padding:2px;border-color:transparent;background:transparent}.pq-popup-scroll{overflow:auto;overscroll-behavior:contain;min-height:0}.pq-popup .pq-row{border:none;border-radius:0;background:transparent;margin:0;padding:0 16px 16px}.pq-popup .pq-metrics{grid-template-columns:1fr;margin-top:12px}.pq-popup .pq-amount{font-size:27px}.pq-popup .pq-tags{margin-top:14px}.pq-popup .pq-name{font-size:14px}.pq-popup .pq-meta{margin-top:12px}
.pq-tabs{display:flex;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:20px}.pq-tab{font:inherit;font-size:13px;padding:8px 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.pq-tab[aria-selected=true]{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:600}.pq-tab:focus-visible,.pq-tab-panel:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.pq-admin-panel{box-sizing:border-box;max-width:660px;padding:16px 18px;margin:0 0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.pq-admin-route{display:inline-flex;margin:6px 6px 4px 0}.pq-admin-form{margin-top:14px}.pq-admin-panel .pq-settings-input{max-width:440px}.pq-threshold-panel{box-sizing:border-box;margin:0 0 24px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}.pq-threshold-panel .pq-top{margin-bottom:0}.pq-threshold-panel h3{margin:0 0 6px;font-size:14px;font-weight:600}.pq-settings-form{max-width:520px;margin-top:12px}.pq-settings-label{display:block;font-size:13px;font-weight:500;margin:16px 0 6px}.pq-settings-input{box-sizing:border-box;width:100%;max-width:220px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}.pq-settings-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.pq-settings-input:disabled{opacity:.55}.pq-settings-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
@media(max-width:520px){.pq-page{padding:16px}.pq-metrics{grid-template-columns:1fr}.pq-row{padding:14px}.pq-trigger-name{max-width:100px}.pq-trigger{gap:6px}.pq-metric{padding:12px 14px}}@media(prefers-reduced-motion:reduce){.pq-chevron{transition:none}}
`;
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries));
        const t = ctx.locale.bind(NS);
        let snapshot = { data: null, loading: false, error: false };
        const listeners = new Set();
        let pending, controller, timer, active = true;
        const publish = update => { snapshot = { ...snapshot, ...update }; for (const listener of listeners) listener(); };
        const load = (refresh = false, provider) => {
          if (!active || pending) return pending;
          controller = new AbortController();
          const signal = controller.signal;
          publish({ loading: true, error: false });
          pending = (async () => {
            try {
              const url = new URL('api/provider-quota', document.baseURI);
              if (provider) url.searchParams.set('provider', provider);
              const response = await fetch(url, { method: refresh ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal });
              if (!response.ok) throw new Error('quota-service');
              const data = await response.json();
              if (!Array.isArray(data.rows)) throw new Error('quota-shape');
              if (active && !signal.aborted) {
                if (provider && snapshot.data) {
                  const updates = new Map(data.rows.map(row => [row.id, row]));
                  publish({ data: { ...snapshot.data, rows: snapshot.data.rows.map(row => updates.get(row.id) || row), colorThresholds: data.colorThresholds, checkedAt: data.checkedAt }, error: false });
                } else publish({ data, error: false });
              }
            } catch {
              if (active && !signal.aborted) publish({ error: true });
            } finally {
              pending = undefined;
              if (active && !signal.aborted) publish({ loading: false });
            }
          })();
          return pending;
        };
        const visibleRefresh = () => {
          if (document.visibilityState === 'visible' && listeners.size && (!snapshot.data || Date.now() - snapshot.data.checkedAt >= 120000)) load();
        };
        const subscribe = listener => {
          listeners.add(listener);
          if (listeners.size === 1) {
            visibleRefresh();
            timer = setInterval(visibleRefresh, 15000);
          }
          return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
        };
        ctx.effect(() => {
          document.addEventListener('visibilitychange', visibleRefresh);
          return () => { active = false; controller?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visibleRefresh); listeners.clear(); };
        });

        let popup = null, popupGeneration = 0;
        const popupListeners = new Set();
        const popupSubscribe = listener => { popupListeners.add(listener); return () => popupListeners.delete(listener); };
        const publishPopup = next => { popup = next; for (const listener of popupListeners) listener(); };
        const closePopup = (restoreFocus = false) => {
          const anchor = popup?.anchor;
          publishPopup(null);
          if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
        };
        ctx.effect(() => () => { closePopup(false); popupListeners.clear(); });
        const viewport = () => {
          const visual = window.visualViewport;
          return { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0, width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight };
        };
        function useQuota() {
          React.useSyncExternalStore(callback => ctx.locale.subscribe(callback), () => ctx.locale.getSnapshot());
          return React.useSyncExternalStore(subscribe, () => snapshot);
        }
        function time(value) {
          return formatQuotaDate(value);
        }
        function ResetTime({ value }) {
          const [now, setNow] = React.useState(() => Date.now());
          React.useEffect(() => {
            const update = () => { if (document.visibilityState === 'visible') setNow(Date.now()); };
            const clock = setInterval(update, 15_000);
            document.addEventListener('visibilitychange', update);
            update();
            return () => { clearInterval(clock); document.removeEventListener('visibilitychange', update); };
          }, []);
          return h('time', { className: 'pq-footnote pq-reset', dateTime: new Date(value).toISOString(), title: time(value) }, `${t('next')}: ${formatQuotaDate(value, { includeYear: false })} (${formatQuotaCountdown(value, now)})`);
        }
        function number(value) {
          return new Intl.NumberFormat(ctx.locale.getLocale().active, { maximumFractionDigits: 2 }).format(value);
        }
        function money(metric) {
          const amount = Number(metric.amount);
          if (!Number.isFinite(amount)) return '—';
          const precision = amount !== 0 && Math.abs(amount) < 0.01 ? 6 : 2;
          try { return new Intl.NumberFormat(ctx.locale.getLocale().active, { style: 'currency', currency: metric.currency, maximumFractionDigits: precision }).format(amount); }
          catch { return `${metric.currency} ${number(amount)}`; }
        }
        function percent(value) { return number(Math.round(value * 10) / 10); }
        function providerName(row) {
          if (row.name === 'zai-coding-cn') return t('cnPlan');
          if (row.name === 'zai') return t('globalPlan');
          if (row.name === 'DeepSeek Account') return t('accountName');
          return row.name;
        }
        function kindLabel(row) {
          if (row.metrics.some(metric => metric.type === 'spend') || row.kind === 'openai') return t('kindSpend');
          if (['glm-cn', 'glm-global', 'codex'].includes(row.kind)) return t('kindPlan');
          return t(row.metrics.some(metric => metric.type === 'balance') || ['deepseek', 'account'].includes(row.kind) ? 'kindBalance' : 'kindOther');
        }
        function statusLabel(row, colorThresholds) {
          if (row.stale) return t('stale');
          if (row.status !== 'ok') return t(quotaTone(row, colorThresholds) === 'error' ? 'queryError' : 'unavailable');
          return t(quotaTone(row, colorThresholds) === 'error' ? 'exhausted' : quotaTone(row, colorThresholds) === 'warn' ? 'low' : 'healthy');
        }
        function Status({ row, colorThresholds }) {
          return h('span', { className: 'pq-pill' }, h('span', { className: 'pq-dot', 'data-tone': quotaTone(row, colorThresholds), 'aria-hidden': true }), statusLabel(row, colorThresholds));
        }
        function Breakdown({ label, value }) {
          return h('div', { className: 'pq-breakdown' }, h('span', null, label), h('strong', null, value));
        }
        function Metric({ metric, colorThresholds }) {
          if (metric.type === 'spend') {
            const date = value => formatQuotaDate(value, { utc: true, dateOnly: true });
            const breakdown = Array.isArray(metric.breakdown) ? metric.breakdown : [];
            return h('div', { className: 'pq-metric' },
              h('div', { className: 'pq-metric-label' }, t('spend')),
              h('div', { className: 'pq-amount', title: `${metric.currency} ${metric.amount}` }, money(metric)),
              h('div', { className: 'pq-scope' }, t('organization')),
              h('div', { className: 'pq-muted' }, `${t('period')} ${date(metric.periodStart)} — ${date(metric.periodEnd)}`),
              breakdown.length > 1 ? h('div', { className: 'pq-breakdown-list', role: 'list', 'aria-label': t('apiKeyBreakdown') },
                ...breakdown.map(entry => h('div', { className: 'pq-breakdown', role: 'listitem', key: entry.apiKeyId ?? 'org' },
                  h('span', { title: entry.apiKeyId ?? '' }, entry.apiKeyId ? `${t('apiKey')} ${entry.apiKeyId}` : t('apiKeyUnattributed')),
                  h('strong', null, money(entry))))) : null,
              metric.noRecords ? h('div', { className: 'pq-muted' }, t('noRecords')) : null,
              h('div', { className: 'pq-footnote' }, t('billingLag')));
          }
          if (metric.type === 'balance') return h('div', { className: 'pq-metric' },
            h('div', { className: 'pq-metric-label' }, t(metric.wallet === 'bonus' ? 'bonus' : metric.wallet === 'recharge' ? 'recharge' : 'balance')),
            h('div', { className: `pq-amount${Number(metric.amount) <= 0 && metric.wallet !== 'bonus' ? ' pq-error' : ''}`, title: `${metric.currency} ${metric.amount}` }, money(metric)),
            metric.toppedUp !== undefined ? h(Breakdown, { label: t('recharge'), value: money({ ...metric, amount: metric.toppedUp }) }) : null,
            metric.granted !== undefined ? h(Breakdown, { label: t('bonus'), value: money({ ...metric, amount: metric.granted }) }) : null);
          const used = Math.min(100, Math.max(0, metric.usedPercent));
          const tone = quotaBarTone(100 - used, colorThresholds);
          return h('div', { className: 'pq-metric' },
            h('div', { className: 'pq-metric-head' }, h('span', { className: 'pq-metric-label' }, t(metric.label)), h('span', { className: `pq-quota-value${tone ? ` pq-${tone}` : ''}` }, h('small', null, t('left')), `${percent(100 - used)}%`)),
            h('div', { className: 'pq-track', role: 'progressbar', 'aria-label': `${t(metric.label)} · ${t('used')}`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': used }, h('div', { className: 'pq-fill', style: { width: `${used}%`, ...(tone ? { background: `var(--dsw-alias-state-${tone}-primary)` } : {}) } })),
            h('div', { className: 'pq-breakdown' }, h('span', null, `${t('used')} ${percent(used)}%`), metric.total !== undefined ? h('strong', null, `${metric.remaining !== undefined ? number(metric.remaining) : '—'} / ${number(metric.total)} ${t(metric.unit)} ${t('left')}`) : null),
            metric.resetsAt ? h(ResetTime, { value: metric.resetsAt }) : null);
        }
        function Row({ row, loading, compact = false, colorThresholds }) {
          return h('article', { className: 'pq-row' },
            !compact ? h('div', { className: 'pq-row-head' }, h('div', { className: 'pq-row-title' }, h('div', { className: 'pq-name' }, providerName(row)), h('span', { className: 'pq-pill' }, kindLabel(row))), h('button', { className: 'pq-button', type: 'button', disabled: loading, onClick: () => load(true, row.id), 'aria-label': `${t('refreshOne')} ${providerName(row)}` }, t('refreshOne'))) : null,
            h('div', { className: 'pq-tags' }, compact ? h('span', { className: 'pq-pill' }, kindLabel(row)) : null, h(Status, { row, colorThresholds }), row.kind === 'openai' ? h('span', { className: 'pq-pill' }, t('organizationShort')) : null),
            row.status !== 'ok' ? h('p', { className: `pq-status${quotaTone(row, colorThresholds) === 'error' ? ' pq-error' : ''}`, role: 'status' }, t(row.status)) : null,
            row.stale ? h('p', { className: 'pq-status pq-warn' }, t('staleDetail')) : null,
            row.metrics.length ? h('div', { className: 'pq-metrics' }, row.metrics.map((metric, index) => h(Metric, { key: index, metric, colorThresholds }))) : null,
            h('div', { className: 'pq-footer' }, h('span', { className: 'pq-muted' }, row.fetchedAt ? `${t('updated')} ${time(row.fetchedAt)}` : t('never')), row.dashboardUrl ? h('a', { className: 'pq-link', href: row.dashboardUrl, target: '_blank', rel: 'noopener noreferrer' }, t('dashboard')) : null),
            h('details', { className: 'pq-meta' }, h('summary', null, t('sourceDetails')), h('dl', null,
              h('dt', null, t('route')), h('dd', null, row.id),
              h('dt', null, t('sourceDetails')), h('dd', null, t(row.source)),
              ...row.metrics.filter(metric => ['balance', 'spend'].includes(metric.type)).flatMap((metric, index) => [h('dt', { key: `l${index}` }, `${t('exact')} ${metric.currency}`), h('dd', { key: `v${index}` }, metric.amount)]))));
        }
        function QuotaSettings() {
          React.useSyncExternalStore(callback => ctx.locale.subscribe(callback), () => ctx.locale.getSnapshot());
          const [settings, setSettings] = React.useState(null);
          const [draft, setDraft] = React.useState({ greenMin: '', orangeMin: '' });
          const [busy, setBusy] = React.useState(true);
          const [notice, setNotice] = React.useState(null);
          const serviceRef = React.useRef(null);
          React.useEffect(() => {
            let live = true, pending = false, requestController;
            const fail = code => { throw new Error(code); };
            const publicErrors = ['invalid-thresholds', 'settings-unavailable', 'settings-conflict', 'save-failed', 'forbidden'];
            const decode = data => {
              if (!data || !validColorThresholds(data.colorThresholds) || typeof data.writable !== 'boolean' || typeof data.csrf !== 'string' || !data.csrf || data.csrf.length > 4096) fail('settings-unavailable');
              return data;
            };
            let current = null;
            const run = async candidate => {
              if (!live || !active || pending) return;
              pending = true;
              requestController = new AbortController();
              const signal = AbortSignal.any([requestController.signal, AbortSignal.timeout(20000)]);
              setBusy(true);
              setNotice(null);
              const fetchSettings = async payload => {
                const response = await fetch(new URL('api/provider-quota-settings', document.baseURI), {
                  method: payload ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
                  headers: payload ? { 'Content-Type': 'application/json', 'X-Quota-Settings-CSRF': csrfRef.current } : { Accept: 'application/json' },
                  ...(payload ? { body: JSON.stringify(payload) } : {}),
                });
                const data = await response.json();
                if (!response.ok) fail(publicErrors.includes(data?.error) ? data.error : candidate ? 'save-failed' : 'settings-unavailable');
                return decode(data);
              };
              try {
                let confirmed;
                if (candidate) {
                  if (!validColorThresholds(candidate)) fail('invalid-thresholds');
                  if (!current?.writable || !current.csrf) fail('forbidden');
                  const written = await fetchSettings(candidate);
                  if (written.saved !== true) fail('save-failed');
                  // A write can recompose this plugin. Never claim success merely
                  // because a POST was dispatched: verify the persisted readback.
                  confirmed = await fetchSettings();
                  if (confirmed.colorThresholds.greenMin !== candidate.greenMin || confirmed.colorThresholds.orangeMin !== candidate.orangeMin) fail('settings-conflict');
                } else confirmed = await fetchSettings();
                if (!live || !active || signal.aborted) return;
                current = confirmed;
                setSettings(confirmed);
                setDraft({ greenMin: String(confirmed.colorThresholds.greenMin), orangeMin: String(confirmed.colorThresholds.orangeMin) });
                setNotice(candidate ? 'saved' : null);
                if (snapshot.data) publish({ data: { ...snapshot.data, colorThresholds: confirmed.colorThresholds } });
              } catch (error) {
                if (live && active && !requestController.signal.aborted) setNotice(publicErrors.includes(error.message) ? error.message : candidate ? 'save-failed' : 'settings-unavailable');
              } finally {
                pending = false;
                if (live && active) setBusy(false);
              }
            };
            serviceRef.current = { run };
            run();
            return () => { live = false; requestController?.abort(); if (serviceRef.current?.run === run) serviceRef.current = null; };
          }, []);
          const candidate = parseThresholdDraft(draft.greenMin, draft.orangeMin);
          const editable = Boolean(settings?.writable) && !busy;
          const change = (key, value) => { setDraft(previous => ({ ...previous, [key]: value })); setNotice(null); };
          const noticeText = notice === 'forbidden' ? 'settingsForbidden' : notice;
          return h('section', { className: 'pq-threshold-panel', 'aria-label': t('settingsTitle') }, h('style', null, css),
            h('header', { className: 'pq-top' }, h('div', null, h('h3', null, t('settingsTitle')), h('p', { className: 'pq-muted' }, t('settingsIntro')))),
            !settings && busy ? h('p', { role: 'status', className: 'pq-muted' }, t('settingsLoading')) : null,
            settings && !settings.writable ? h('p', { className: 'pq-status pq-warn' }, t('readOnly')) : null,
            h('form', { className: 'pq-settings-form', onSubmit: event => {
              event.preventDefault();
              if (!editable) return;
              if (!candidate) { setNotice('invalid-thresholds'); return; }
              serviceRef.current?.run(candidate);
            } },
              h('label', { className: 'pq-settings-label', htmlFor: 'pq-green-min' }, t('greenMin')),
              h('input', { id: 'pq-green-min', className: 'pq-settings-input', type: 'number', min: 1, max: 100, step: 1, required: true, inputMode: 'numeric', value: draft.greenMin, disabled: !editable, onChange: event => change('greenMin', event.target.value), 'aria-describedby': 'pq-threshold-rules' }),
              h('label', { className: 'pq-settings-label', htmlFor: 'pq-orange-min' }, t('orangeMin')),
              h('input', { id: 'pq-orange-min', className: 'pq-settings-input', type: 'number', min: 0, max: 99, step: 1, required: true, inputMode: 'numeric', value: draft.orangeMin, disabled: !editable, onChange: event => change('orangeMin', event.target.value), 'aria-describedby': 'pq-threshold-rules' }),
              h('p', { id: 'pq-threshold-rules', className: 'pq-note' }, t('thresholdRules')),
              !candidate && settings ? h('p', { className: 'pq-status pq-error' }, t('invalid-thresholds')) : null,
              h('div', { className: 'pq-settings-actions' },
                h('button', { type: 'submit', className: 'pq-button', disabled: !editable || !candidate }, t(busy ? 'loading' : 'save')),
                h('button', { type: 'button', className: 'pq-button', disabled: !editable, onClick: () => {
                  setDraft({ greenMin: String(DEFAULT_COLOR_THRESHOLDS.greenMin), orangeMin: String(DEFAULT_COLOR_THRESHOLDS.orangeMin) });
                  setNotice(null);
                } }, t('defaults')),
                h('button', { type: 'button', className: 'pq-button', disabled: busy, onClick: () => serviceRef.current?.run() }, t('settingsRefresh')))),
            notice ? h('p', { className: `pq-status ${notice === 'saved' ? 'pq-success' : 'pq-error'}`, role: notice === 'saved' ? 'status' : 'alert' }, t(noticeText)) : null,
            h('p', { className: 'pq-note' }, t('defaultsNote')));
        }
        function OpenAIExtraSettings({ routes }) {
          React.useSyncExternalStore(callback => ctx.locale.subscribe(callback), () => ctx.locale.getSnapshot());
          const [data, setData] = React.useState(null);
          const [keyDraft, setKeyDraft] = React.useState('');
          const [busy, setBusy] = React.useState(true);
          const [notice, setNotice] = React.useState(null);
          const controllerRef = React.useRef(null), csrfRef = React.useRef(null), saveRef = React.useRef(null);
          React.useEffect(() => {
            let live = true, pending = false;
            const fail = code => { throw new Error(code); };
            const errors = ['invalid-admin-key', 'admin-credential-error', 'forbidden', 'save-failed'];
            const read = async payload => {
              if (!live || pending) return;
              if (payload && !csrfRef.current) { setNotice('adminFileError'); return; }
              pending = true;
              const controller = new AbortController(); controllerRef.current = controller;
              const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
              setBusy(true); setNotice(null);
              try {
                const response = await fetch(new URL('api/provider-quota-settings', document.baseURI), {
                  method: payload ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
                  headers: payload ? { 'Content-Type': 'application/json', 'X-Quota-Settings-CSRF': csrfRef.current } : { Accept: 'application/json' },
                  ...(payload ? { body: JSON.stringify(payload) } : {}),
                });
                const body = await response.json();
                if (!response.ok) fail(errors.includes(body?.error) ? body.error : payload ? 'save-failed' : 'admin-credential-error');
                if (!body || !body.adminKey || typeof body.adminKey.configured !== 'boolean' || ![null, 'credential-store', 'credential-ref'].includes(body.adminKey.source) || body.adminKey.error !== undefined && !['invalid-admin-key', 'admin-credential-error'].includes(body.adminKey.error)) fail('admin-credential-error');
                if (!live || signal.aborted) return;
                if (payload && (body.saved !== true || body.savedItem !== 'adminKey' || !body.adminKey.configured || body.adminKey.source !== 'credential-store')) fail('save-failed');
                csrfRef.current = body.csrf;
                setData(body); setKeyDraft(''); setNotice(payload ? 'adminSaved' : null);
              } catch (error) {
                if (live && !controller.signal.aborted) setNotice(errors.includes(error.message) ? error.message : payload ? 'adminSaveFailed' : 'adminFileError');
              } finally { pending = false; if (live) setBusy(false); }
            };
            saveRef.current = secret => read({ action: 'saveAdminKey', adminKey: secret });
            read();
            const refresh = () => { if (document.visibilityState === 'visible') read(); };
            document.addEventListener('visibilitychange', refresh);
            return () => { live = false; controllerRef.current?.abort(); csrfRef.current = null; saveRef.current = null; document.removeEventListener('visibilitychange', refresh); };
          }, []);
          const hasKeyInput = keyDraft.trim().length > 0;
          const sourceKey = ['credential-store', 'credential-ref'].includes(data?.adminKey?.source) ? 'adminSourceCredential' : 'adminMissing';
          return h('section', { className: 'pq-admin-panel', 'aria-label': t('adminTitle') }, h('style', null, css),
            h('h3', null, t('adminTitle')),
            h('p', { className: 'pq-muted' }, t('adminIntro')),
            h('div', { className: 'pq-tags', 'aria-label': t('route') }, routes.map(row => h('span', { key: row.id, className: 'pq-pill pq-admin-route' }, providerName(row), ' · ', row.id))),
            h('p', { className: `pq-note${data?.adminKey?.configured ? '' : ' pq-warn'}`, role: 'status' }, t(data?.adminKey?.configured ? 'adminConfigured' : 'adminMissing')),
            data?.adminKey?.error ? h('p', { className: 'pq-status pq-error', role: 'alert' }, t(data.adminKey.error)) : null,
            data?.adminKey?.source ? h('p', { className: 'pq-muted' }, t(sourceKey)) : null,
            h('form', { className: 'pq-admin-form', autoComplete: 'off', onSubmit: event => {
              event.preventDefault();
              if (!hasKeyInput || busy) return;
              const secret = keyDraft.trim();
              setKeyDraft('');
              // The secret lives only in this handler, one POST body and Host setter.
              saveRef.current?.(secret);
            } },
              h('label', { className: 'pq-settings-label', htmlFor: 'pq-openai-admin-key' }, t('adminKeyLabel')),
              h('input', { id: 'pq-openai-admin-key', className: 'pq-settings-input', type: 'password', value: keyDraft, onChange: event => setKeyDraft(event.target.value), autoComplete: 'new-password', autoCapitalize: 'none', spellCheck: false, maxLength: 8192, placeholder: t('adminKeyPlaceholder'), disabled: busy }),
              h('div', { className: 'pq-settings-actions' }, h('button', { type: 'submit', className: 'pq-button', disabled: busy || !hasKeyInput }, t(busy ? 'loading' : 'adminSave')))),
            notice ? h('p', { className: `pq-status ${notice === 'adminSaved' ? 'pq-success' : 'pq-error'}`, role: notice === 'adminSaved' ? 'status' : 'alert' }, t(notice)) : null,
            h('p', { className: 'pq-note' }, t('adminUseOfficial')));
        }
        function Page() {
          const state = useQuota();
          const rows = state.data?.rows ?? [];
          const openAIProviders = rows.filter(row => row.kind === 'openai');
          const [tab, setTab] = React.useState('overview');
          const tabRefs = React.useRef({});
          const tabs = ['overview', 'colors', ...(openAIProviders.length ? ['apiExtra'] : [])];
          React.useEffect(() => { if (!tabs.includes(tab)) setTab('overview'); }, [tab, openAIProviders.length]);
          const tabKey = event => {
            let target;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') target = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
            else if (event.key === 'Home') target = tabs[0];
            else if (event.key === 'End') target = tabs[tabs.length - 1];
            if (target) { event.preventDefault(); setTab(target); tabRefs.current[target]?.focus(); }
          };
          const groups = [
            ['subscription', row => ['glm-cn', 'glm-global', 'codex'].includes(row.kind)],
            ['account', row => row.kind === 'account'],
            ['api', row => !['account', 'glm-cn', 'glm-global', 'codex'].includes(row.kind)],
          ];
          const tabLabel = id => t(id === 'overview' ? 'overviewTab' : id === 'colors' ? 'colorsTab' : 'apiExtraTab');
          return h('section', { className: 'pq-page', 'aria-label': t('title') }, h('style', null, css),
            h('header', { className: 'pq-top' }, h('div', null, h('h2', null, t('title')), h('div', { className: 'pq-muted' }, t('subtitle'))), tab === 'overview' ? h('button', { type: 'button', className: 'pq-button', disabled: state.loading, onClick: () => load(true) }, t(state.loading ? 'loading' : 'refresh')) : null),
            h('div', { className: 'pq-tabs', role: 'tablist', 'aria-label': t('title'), onKeyDown: tabKey }, ...tabs.map(id => h('button', {
              key: id, id: `pq-tab-${id}`, type: 'button', role: 'tab', className: 'pq-tab',
              ref: node => { tabRefs.current[id] = node; }, 'aria-selected': tab === id, 'aria-controls': `pq-panel-${id}`,
              tabIndex: tab === id ? 0 : -1, onClick: () => setTab(id),
            }, tabLabel(id)))),
            h('div', { id: 'pq-panel-overview', role: 'tabpanel', 'aria-labelledby': 'pq-tab-overview', className: 'pq-tab-panel', hidden: tab !== 'overview', tabIndex: 0 }, tab === 'overview' ? h(React.Fragment, null,
              state.error ? h('p', { role: 'alert', className: 'pq-error' }, t('serviceError')) : null,
              !rows.length ? h('p', { className: 'pq-empty', role: 'status' }, t(state.loading ? 'loading' : 'empty')) : null,
              ...groups.map(([label, filter]) => {
                const group = rows.filter(filter);
                return group.length ? h('section', { key: label }, h('h3', null, t(label), h('span', { className: 'pq-group-count' }, group.length)), ...group.map(row => h(Row, { key: row.id, row, loading: state.loading, colorThresholds: state.data?.colorThresholds }))) : null;
              }), h('p', { className: 'pq-note' }, t('note'))) : null),
            h('div', { id: 'pq-panel-colors', role: 'tabpanel', 'aria-labelledby': 'pq-tab-colors', className: 'pq-tab-panel', hidden: tab !== 'colors', tabIndex: 0 }, tab === 'colors' ? h(QuotaSettings) : null),
            openAIProviders.length ? h('div', { id: 'pq-panel-apiExtra', role: 'tabpanel', 'aria-labelledby': 'pq-tab-apiExtra', className: 'pq-tab-panel', hidden: tab !== 'apiExtra', tabIndex: 0 }, tab === 'apiExtra' ? h(OpenAIExtraSettings, { routes: openAIProviders }) : null) : null);
        }
        function PopupSurface({ opened }) {
          const state = useQuota();
          const row = state.data?.rows.find(item => item.id === opened.provider);
          const panelRef = React.useRef(null), closeRef = React.useRef(null);
          const [position, setPosition] = React.useState(() => placeQuotaPopup(opened.anchor.getBoundingClientRect(), viewport()));
          React.useLayoutEffect(() => {
            let frame;
            const anchor = opened.anchor;
            const update = () => {
              if (!anchor.isConnected || !anchor.getClientRects().length) { closePopup(false); return; }
              const next = placeQuotaPopup(anchor.getBoundingClientRect(), viewport());
              if (!next) { closePopup(false); return; }
              setPosition(previous => previous && Object.keys(next).every(key => previous[key] === next[key]) ? previous : next);
              frame = window.requestAnimationFrame(update);
            };
            update();
            closeRef.current?.focus({ preventScroll: true });
            const outside = event => {
              if (!panelRef.current?.contains(event.target) && !anchor.contains(event.target)) closePopup(false);
            };
            const escape = event => {
              if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); closePopup(true); }
            };
            const hidden = () => { if (document.visibilityState !== 'visible') closePopup(false); };
            document.addEventListener('pointerdown', outside, true);
            document.addEventListener('focusin', outside, true);
            document.addEventListener('keydown', escape, true);
            document.addEventListener('visibilitychange', hidden);
            return () => {
              window.cancelAnimationFrame(frame);
              document.removeEventListener('pointerdown', outside, true);
              document.removeEventListener('focusin', outside, true);
              document.removeEventListener('keydown', escape, true);
              document.removeEventListener('visibilitychange', hidden);
            };
          }, [opened]);
          React.useEffect(() => { if (!row) closePopup(false); }, [row]);
          if (!row || !position) return null;
          return h('section', { id: POPUP_ID, className: 'pq-popup', ref: panelRef, role: 'dialog', 'aria-modal': false, 'aria-labelledby': `${POPUP_ID}-title`, style: { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, transform: position.above ? 'translateY(-100%)' : 'none' } },
            h('style', null, css),
            h('header', { className: 'pq-popup-head' }, h('div', null, h('div', { className: 'pq-muted' }, t('details')), h('div', { id: `${POPUP_ID}-title`, className: 'pq-name' }, providerName(row))), h('div', { className: 'pq-popup-actions' }, h('button', { className: 'pq-button', type: 'button', disabled: state.loading, onClick: () => load(true, row.id) }, t(state.loading ? 'loading' : 'refreshOne')), h('button', { ref: closeRef, className: 'pq-button pq-close', type: 'button', 'aria-label': t('close'), onClick: () => closePopup(true) }, '×'))),
            h('div', { className: 'pq-popup-scroll' }, state.error ? h('p', { className: 'pq-status pq-error', role: 'alert' }, t('serviceError')) : null, h(Row, { row, loading: state.loading, compact: true, colorThresholds: state.data?.colorThresholds })));
        }
        function Popup() {
          const opened = React.useSyncExternalStore(popupSubscribe, () => popup);
          return opened ? h(PopupSurface, { key: opened.generation, opened }) : null;
        }
        function Dock(props) {
          const state = useQuota();
          const colorThresholds = state.data?.colorThresholds;
          const opened = React.useSyncExternalStore(popupSubscribe, () => popup);
          const anchorRef = React.useRef(null);
          const projectedProvider = props.useProjection('modelSelection', value => value?.next?.provider);
          const provider = projectedProvider ?? state.data?.defaultProvider;
          const row = state.data?.rows.find(item => item.id === provider);
          React.useEffect(() => () => {
            if (popup?.sessionId === props.sessionId && popup?.provider === provider) closePopup(false);
          }, [props.sessionId, provider]);
          if (!row) return state.error ? h('div', { className: 'pq-dock pq-muted' }, t('serviceError')) : null;
          const segments = dockMetricItems(row.metrics, colorThresholds).map(item => {
            const { metric } = item;
            const text = metric.type === 'spend' ? `${t('spendShort')} ${money(metric)} · ${t('organizationShort')}` : metric.type === 'balance' ? `${metric.wallet === 'bonus' ? t('bonus') + ' ' : ''}${money(metric)}` : `${t(metric.label)} ${t('left')} ${percent(item.remainingPercent)}%`;
            return { text, tone: item.tone };
          });
          const text = segments.map(segment => segment.text).join(' · ');
          const isOpen = opened?.anchor === anchorRef.current;
          return h('div', { className: 'pq-dock' }, h('style', null, css),
            h('button', { ref: anchorRef, type: 'button', className: 'pq-trigger', 'aria-haspopup': 'dialog', 'aria-expanded': isOpen, 'aria-controls': isOpen ? POPUP_ID : undefined, 'aria-label': `${t('current')} · ${providerName(row)} · ${text || statusLabel(row, colorThresholds)} · ${statusLabel(row, colorThresholds)}`, title: t('details'), onClick: () => {
              if (popup?.anchor === anchorRef.current) closePopup(true);
              else publishPopup({ provider, sessionId: props.sessionId, anchor: anchorRef.current, generation: ++popupGeneration });
            } }, h('span', { className: 'pq-dot', 'data-tone': state.error ? 'error' : quotaTone(row, colorThresholds), 'aria-hidden': true }), h('span', { className: 'pq-trigger-name' }, providerName(row)), h('span', { className: 'pq-trigger-value' }, segments.length ? segments.map((segment, index) => h(React.Fragment, { key: index }, index ? h('span', { className: 'pq-summary-separator', 'aria-hidden': true }, ' · ') : null, h('span', { className: 'pq-summary-item', 'data-tone': segment.tone }, segment.text))) : statusLabel(row, colorThresholds), row.stale ? ` · ${t('stale')}` : state.error || row.status !== 'ok' && text ? ` · ${t('queryError')}` : ''), h('svg', { className: 'pq-chevron', viewBox: '0 0 16 16', 'aria-hidden': true }, h('path', { d: 'm4 10 4-4 4 4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))));
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'provider-quota', order: 12, label: () => t('title') }, Page));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'provider-quota', order: 5 }, Dock));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'provider-quota.popup', order: 5 }, Popup));
      },
    };
  },
});
