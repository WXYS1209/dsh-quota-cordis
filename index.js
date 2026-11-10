import { QuotaManager } from './manager.js';
import { describeOpenAIAdminKey, resolveOpenAIAdminKey } from './openai-admin.js';
import { QuotaColorSettings, readSmallSettingsBody } from './quota-settings.js';

export const name = 'provider-quota';
export const inject = ['llm', 'settings', 'credentials', 'connection', 'tools'];
const ADMIN_KEY_REF = 'OPENAI_ADMIN_KEY_DSH';
const validAdminKey = value => typeof value === 'string' && /^sk-admin-[A-Za-z0-9_-]{8,8192}$/.test(value);
async function readSettingsPayload(request) {
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('invalid-request'), { code: 'invalid-request' });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const item = await new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('invalid-request')); };
        if (signal.aborted) { reject(new Error('invalid-request')); return; }
        signal.addEventListener('abort', abort, { once: true });
        reader.read().then(value => { signal.removeEventListener('abort', abort); resolve(value); }, () => { signal.removeEventListener('abort', abort); reject(new Error('invalid-request')); });
      });
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 16_384) throw Object.assign(new Error('invalid-request'), { code: 'invalid-request' });
      chunks.push(item.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-request');
    return value;
  } catch { throw Object.assign(new Error('invalid-request'), { code: 'invalid-request' }); }
  finally {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

export function apply(ctx, config = {}) {
  const editor = ctx.get('configEditor');
  const entry = ctx.fiber?.entry;
  const colors = new QuotaColorSettings(config.colorThresholds, editor && entry ? async colorThresholds => {
    await editor.edit(entry, current => ({ ...current, colorThresholds }));
  } : undefined);
  const manager = new QuotaManager({
    llm: ctx.llm, settings: ctx.settings, credentials: ctx.credentials,
    deepseekAccount: ctx.get('deepseekAccount'), agentDefaultModel: ctx.get('agentDefaultModel'),
  }, { colorThresholdsProvider: () => colors.read().colorThresholds });
  ctx.effect(() => () => manager.dispose());
  ctx.provide('providerQuota', manager);
  const colorOperation = async ({ action = 'read', greenMin, orangeMin } = {}) => {
    if (action === 'read') return colors.read();
    if (action !== 'set') throw Object.assign(new Error('invalid-thresholds'), { code: 'invalid-thresholds' });
    return colors.save({ greenMin, orangeMin });
  };
  const adminStatus = async () => {
    try { return await describeOpenAIAdminKey(ctx.credentials); }
    catch (cause) {
      const code = ['invalid-admin-key', 'admin-credential-error'].includes(cause?.code) ? cause.code : 'admin-credential-error';
      // An unavailable optional credential reference must not prevent users from
      // viewing or saving unrelated color thresholds.
      return { configured: false, source: null, error: code };
    }
  };
  const settingsSnapshot = async () => ({ ...colors.browserRead(), adminKey: await adminStatus() });
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/provider-quota-settings', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      try {
        if (request.method === 'GET') return Response.json(await settingsSnapshot(), { headers });
        if (!colors.csrfMatches(request.headers.get('X-Quota-Settings-CSRF')) || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) return Response.json({ error: 'forbidden' }, { status: 403, headers });
        const raw = await readSettingsPayload(request);
        if (raw.action === 'saveAdminKey') {
          if (Object.keys(raw).some(key => !['action', 'adminKey'].includes(key)) || !validAdminKey(raw.adminKey)) throw Object.assign(new Error('invalid-admin-key'), { code: 'invalid-admin-key' });
          await ctx.credentials.set(ADMIN_KEY_REF, raw.adminKey);
          const status = await adminStatus();
          if (!status.configured) throw Object.assign(new Error('save-failed'), { code: 'save-failed' });
          return Response.json({ ...(await settingsSnapshot()), saved: true, savedItem: 'adminKey' }, { headers });
        }
        const value = raw.action === undefined ? raw : (() => { throw Object.assign(new Error('invalid-thresholds'), { code: 'invalid-thresholds' }); })();
        await colorOperation({ action: 'set', ...value });
        return Response.json({ ...(await settingsSnapshot()), saved: true, savedItem: 'colorThresholds' }, { headers });
      } catch (cause) {
        const allowed = ['invalid-thresholds', 'invalid-admin-key', 'admin-credential-error', 'invalid-request', 'settings-unavailable', 'settings-conflict', 'save-failed'];
        const code = allowed.includes(cause?.code) ? cause.code : 'save-failed';
        return Response.json({ error: code }, { status: ['invalid-thresholds', 'invalid-admin-key', 'invalid-request'].includes(code) ? 400 : code === 'settings-conflict' ? 409 : 503, headers });
      }
    },
  }));
  ctx.effect(() => ctx.tools.register({
    name: 'quota_color_settings',
    description: 'Read or persist remaining-quota color thresholds for every session in the current profile. Colors stay fixed green/orange/red; only percentage boundaries change.',
    deferLoading: true,
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['read', 'set'], description: 'Default read. Set persists both boundaries.' },
      greenMin: { type: 'integer', description: 'For set: green when remaining percentage is at least this value; 1–100 and greater than orangeMin.' },
      orangeMin: { type: 'integer', description: 'For set: orange at or above this value but below greenMin; 0–99. Below this is red.' },
    }, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 15_000,
    isConcurrencySafe: args => args?.action !== 'set',
    async execute(args) {
      try { return { ok: true, ...await colorOperation(args ?? {}) }; }
      catch (cause) { return { ok: false, error: ['invalid-thresholds', 'settings-unavailable', 'settings-conflict', 'save-failed'].includes(cause?.code) ? cause.code : 'save-failed' }; }
    },
  }));
  const operation = async ({ refresh = false, provider } = {}) => {
    if (typeof refresh !== 'boolean' || (provider !== undefined && (typeof provider !== 'string' || provider.length > 200))) throw new Error('Invalid quota request');
    return manager.snapshot({ refresh, provider });
  };
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/provider-quota', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && Number(request.headers.get('content-length') || 0) > 1024) return new Response(null, { status: 413 });
      try {
        const result = await operation({ refresh: request.method === 'POST', provider: url.searchParams.get('provider') || undefined });
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
      } catch {
        return Response.json({ error: 'quota-service-unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
    },
  }));
  ctx.effect(() => ctx.tools.register({
    name: 'provider_quota',
    description: 'Read balances and subscription quota windows for providers configured in this app. Returns normalized balances, subscription windows, OpenAI organization month-to-date API spend, freshness and per-provider errors; never returns credentials. Spend is not remaining balance.',
    parameters: {
      type: 'object', properties: {
        provider: { type: 'string', description: 'Optional exact provider route ID from an earlier result; omit for all configured providers.' },
        refresh: { type: 'boolean', description: 'Request a refresh instead of a recent success cache. Default false; cooldowns and error backoff still apply.' },
      }, additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: args => operation(args ?? {}),
  }));
}
