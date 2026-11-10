// Pure data adapters. No network, credentials, clock, or Harness dependencies.
// Shape references (reviewed 2026-11-05):
// https://api-docs.deepseek.com/api/get-user-balance/
// https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs
// https://github.com/steipete/CodexBar/blob/main/docs/zai.md
// https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Resources/Plugins/zai.js

const DASHBOARDS = Object.freeze({
  deepseek: 'https://platform.deepseek.com/usage',
  'glm-cn': 'https://bigmodel.cn/coding-plan/personal/usage',
  'glm-global': 'https://z.ai/manage-apikey/coding-plan/personal/my-plan',
  openai: 'https://platform.openai.com/usage',
  codex: 'https://chatgpt.com/codex/cloud/settings/analytics#usage',
});
const HOSTS = Object.freeze({
  'api.deepseek.com': 'deepseek',
  'open.bigmodel.cn': 'glm-cn',
  'api.z.ai': 'glm-global',
  'api.openai.com': 'openai',
});
const ROUTES = Object.freeze({
  deepseek: 'deepseek',
  'deepseek-official': 'deepseek',
  openai: 'openai',
  zai: 'glm-global',
  'zai-coding-cn': 'glm-cn',
});
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new Error('invalid-response'); };

/** Explicit endpoint identity always wins over a route's display name.
 * Unknown/custom endpoints must never cause a key to be sent to an official API.
 */
export function classifyProvider({ provider, baseURL } = {}) {
  if (provider === 'openai-codex') {
    if (baseURL !== undefined && baseURL !== null) {
      try {
        const url = new URL(baseURL);
        if (typeof baseURL !== 'string' || baseURL.trim() !== baseURL || url.origin !== 'https://chatgpt.com' || url.username || url.password || !/^\/backend-api\/?$/.test(url.pathname) || url.search || url.hash) return { kind: 'unsupported', dashboardUrl: null };
      } catch { return { kind: 'unsupported', dashboardUrl: null }; }
    }
    return { kind: 'codex', dashboardUrl: DASHBOARDS.codex };
  }
  let kind;
  if (baseURL !== undefined && baseURL !== null) {
    if (typeof baseURL !== 'string' || !baseURL || baseURL.trim() !== baseURL) {
      return { kind: 'unsupported', dashboardUrl: null };
    }
    try {
      const url = new URL(baseURL);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && own(HOSTS, url.hostname)) {
        kind = HOSTS[url.hostname];
      }
    } catch { /* Fail closed, including malformed explicit URLs. */ }
  } else if (typeof provider === 'string' && own(ROUTES, provider)) {
    kind = ROUTES[provider];
  }
  return kind
    ? { kind, dashboardUrl: DASHBOARDS[kind] }
    : { kind: 'unsupported', dashboardUrl: null };
}

function money(value, allowNegative) {
  // Keep decimal strings intact: money must not round through binary floats.
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) invalid();
  if (!allowNegative && Number(value) < 0) invalid();
  return value;
}

export function parseDeepSeek(json) {
  if (!object(json) || !Array.isArray(json.balance_infos) || !json.balance_infos.length) invalid();
  if (own(json, 'is_available') && typeof json.is_available !== 'boolean') invalid();
  return json.balance_infos.map(row => {
    if (!object(row) || !['CNY', 'USD'].includes(row.currency)) invalid();
    const metric = { type: 'balance', currency: row.currency, amount: money(row.total_balance, true) };
    if (row.granted_balance !== undefined) metric.granted = money(row.granted_balance, false);
    if (row.topped_up_balance !== undefined) metric.toppedUp = money(row.topped_up_balance, false);
    return metric;
  });
}

function optionalCount(row, key) {
  const value = row[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) invalid();
  return value;
}

function durationOf(row) {
  // In the legacy MCP shape unit=5/number=1 is a monthly marker, NOT a
  // one-minute window. Avoid fabricating a fixed 30-day calendar month.
  if (row.type === 'TIME_LIMIT' && row.unit === 5 && row.number === 1) return undefined;
  const seconds = { 1: 86400, 3: 3600, 5: 60, 6: 604800 };
  if (row.unit === undefined || row.unit === null || row.number === undefined || row.number === null) return undefined;
  if (!Number.isInteger(row.unit) || !Number.isSafeInteger(row.number) || row.number <= 0) invalid();
  if (!own(seconds, row.unit)) return undefined;
  const duration = seconds[row.unit] * row.number;
  if (!Number.isSafeInteger(duration)) invalid();
  return duration;
}

/** Normalize monitor quota responses, retaining only understood limit types.
 * percentage is an explicitly reported used percentage, never a remaining %.
 * usage is the total quota; currentValue is USED, not remaining. Counts take
 * precedence when complete; conflicting counts use the larger used value.
 * resetsAt preserves the API's Unix milliseconds, with no timezone guessing.
 */
export function parseGlm(json) {
  if (!object(json)) invalid();
  if ((own(json, 'success') && json.success !== true) || (own(json, 'code') && json.code !== 200)) invalid();
  const data = own(json, 'data') ? json.data : json;
  if (!object(data) || !Array.isArray(data.limits)) invalid();
  const metrics = [];
  for (const row of data.limits) {
    if (!object(row) || typeof row.type !== 'string') invalid();
    if (!['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(row.type)) continue;
    // The monitor schema requires an actual numeric percentage, including 0.
    // Missing/null/empty-string percentages must never turn into a fake zero.
    if (!Number.isInteger(row.percentage)) invalid();
    const total = optionalCount(row, 'usage');
    const current = optionalCount(row, 'currentValue');
    const remaining = optionalCount(row, 'remaining');
    if (total !== undefined && remaining !== undefined && remaining > total) invalid();
    let used = current;
    if (total !== undefined && remaining !== undefined) {
      used = Math.max(total - remaining, current ?? 0);
    }
    let usedPercent = row.percentage;
    if (total !== undefined && total > 0 && used !== undefined) usedPercent = used / total * 100;
    usedPercent = Math.max(0, Math.min(100, usedPercent));
    const durationSeconds = durationOf(row);
    const metric = {
      type: 'quota-window',
      label: row.type === 'TIME_LIMIT' ? 'mcp' : durationSeconds === 18000 ? 'rolling' : durationSeconds === 604800 ? 'weekly' : 'quota',
      unit: row.type === 'CREDIT_LIMIT' ? 'credits' : row.type === 'TOKENS_LIMIT' ? 'tokens' : 'requests',
      usedPercent,
    };
    if (used !== undefined) metric.used = used;
    if (total !== undefined) metric.total = total;
    if (remaining !== undefined) metric.remaining = remaining;
    else if (total !== undefined && used !== undefined) metric.remaining = Math.max(0, total - used);
    if (durationSeconds !== undefined) metric.durationSeconds = durationSeconds;
    if (row.nextResetTime !== undefined && row.nextResetTime !== null) {
      if (!Number.isSafeInteger(row.nextResetTime) || row.nextResetTime <= 0 || row.nextResetTime > 8640000000000000) invalid();
      metric.resetsAt = row.nextResetTime;
    }
    metrics.push(metric);
  }
  if (!metrics.length) invalid();
  return metrics;
}
