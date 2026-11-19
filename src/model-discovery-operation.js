// Host-only route binding. The protocol transport is shared by built-in and custom routes.
import { discoverPlatformModels, modelDiscoveryTarget } from './model-discovery.js';

const NS = 'llm-pi-ai';
const own = (object, key) => Object.hasOwn(object ?? {}, key);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const refPattern = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
// Explicit discovery contracts, not guesses from an inference URL. An entry also
// bounds ambient credential use to this platform endpoint. Add new contracts
// as data; configured custom routes work without appearing here.
const contracts = new Map([
  ['openai', ['https://api.openai.com/v1', 'openai-responses', 'OPENAI_API_KEY']],
  ['opencode-go', ['https://opencode.ai/inference/go/v1', 'openai-completions', 'OPENCODE_API_KEY', true]],
  ['opencode', ['https://opencode.ai/inference/v1', 'openai-completions', 'OPENCODE_API_KEY', true]],
  ['anthropic', ['https://api.anthropic.com', 'anthropic-messages', 'ANTHROPIC_API_KEY']],
  ['google', ['https://generativelanguage.googleapis.com/v1beta', 'google-generative-ai', 'GEMINI_API_KEY']],
  ['openrouter', ['https://openrouter.ai/api/v1', 'openai-completions', 'OPENROUTER_API_KEY', true]],
  ['deepseek', ['https://api.deepseek.com', 'openai-completions', 'DEEPSEEK_API_KEY']],
]);
const reasonCodes = new Set(['unsupported', 'unsafe-endpoint', 'failed', 'network', 'platform-error', 'timeout', 'authentication', 'missing-credential']);
const fault = code => Object.assign(new Error(code), { code });
const check = signal => { if (signal?.aborted) throw fault('cancelled'); };
const profileAt = (root, path) => path.reduce((node, key) => own(node, key) ? node[key] : undefined, root);
const clean = base => typeof base === 'string' ? base.replace(/\/+$/, '') : undefined;

async function boundedCatalog(read, parent) {
  const budget = AbortSignal.timeout(750);
  const signal = parent ? AbortSignal.any([parent, budget]) : budget;
  check(signal);
  let stop;
  try {
    const deadline = new Promise((_, reject) => {
      stop = () => reject(fault('timeout'));
      signal.addEventListener('abort', stop, { once: true });
    });
    return await Promise.race([read(signal), deadline]);
  } finally { signal.removeEventListener('abort', stop); }
}

function validate(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.keys(draft).some(key => !['settingsNs', 'provider', 'baseURL', 'api', 'apiKey', 'endpointChanged'].includes(key)) || typeof draft.settingsNs !== 'string' || !identifier.test(draft.settingsNs)) throw fault('invalid-request');
  for (const key of ['provider', 'api']) if (own(draft, key) && (typeof draft[key] !== 'string' || !identifier.test(draft[key]))) throw fault('invalid-request');
  if (own(draft, 'baseURL') && (typeof draft.baseURL !== 'string' || !draft.baseURL || draft.baseURL.length > 2048)) throw fault('invalid-request');
  if (own(draft, 'apiKey') && (typeof draft.apiKey !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(draft.apiKey))) throw fault('invalid-request');
  if (own(draft, 'endpointChanged') && typeof draft.endpointChanged !== 'boolean') throw fault('invalid-request');
}

async function publicKey(credentials, contract, provider, signal) {
  const ref = contract[2];
  const recordKey = `${NS}/${provider}`;
  if (typeof credentials.describeRecord === 'function') {
    const info = await credentials.describeRecord(recordKey);
    check(signal);
    if (info?.configured) {
      if (info.kind !== 'api-key' || typeof credentials.readRecord !== 'function') throw fault('unsupported');
      const record = await credentials.readRecord(recordKey);
      check(signal);
      if (record?.kind !== 'api-key') throw fault('unsupported');
      const key = record.key || (own(record.env, ref) ? record.env[ref] : undefined);
      if (!key) throw fault('missing-credential');
      return key;
    }
  }
  return (await credentials.resolve(ref))?.value;
}

const present = (primary, secondary) => {
  const catalog = new Map(secondary.map(model => [model.id, model]));
  return primary.map(model => {
    const known = catalog.get(model.id);
    if (!known) return model;
    const result = { ...model };
    for (const key of ['name', 'contextWindow', 'maxTokens', 'inputModalities']) {
      if (result[key] === undefined && known[key] !== undefined) result[key] = known[key];
    }
    return result;
  });
};

// Only project bounded candidate metadata. Never forward adapter faults or payloads.
function candidates(value) {
  if (!Array.isArray(value) || value.length > 3000) throw fault('failed');
  const models = new Map();
  for (const row of value) {
    if (typeof row?.id !== 'string' || !row.id.trim() || row.id.length > 512 || /[\u0000-\u001f\u007f]/.test(row.id)) continue;
    const id = row.id.trim();
    if (models.has(id)) continue;
    const model = { id };
    if (typeof row.name === 'string' && row.name.trim() && row.name.length <= 512 && !/[\u0000-\u001f\u007f]/.test(row.name)) model.name = row.name.trim();
    for (const key of ['contextWindow', 'maxTokens']) if (Number.isSafeInteger(row[key]) && row[key] > 0) model[key] = row[key];
    const input = row.inputModalities ?? row.input;
    if (Array.isArray(input)) model.inputModalities = ['text', 'image'].filter(value => input.includes(value));
    models.set(id, model);
  }
  return [...models.values()];
}

export async function runModelDiscovery(services, draft, { signal, live = discoverPlatformModels } = {}) {
  validate(draft);
  check(signal);
  const { llm, settings, credentials } = services;
  let entry, profile;
  if (draft.provider !== undefined) {
    const directory = await llm.listConfigurableProviders();
    check(signal);
    const matches = directory.filter(item => item.provider === draft.provider && item.settingsNs === draft.settingsNs);
    if (matches.length !== 1) throw fault('unsupported');
    [entry] = matches;
    if (!Array.isArray(entry.settingsPath) || entry.settingsPath.some(key => typeof key !== 'string')) throw fault('unsupported');
    const docs = await settings.describe({ redactSecrets: true });
    check(signal);
    const section = docs.filter(doc => doc.ns === draft.settingsNs);
    if (section.length !== 1) throw fault('unsupported');
    profile = profileAt(section[0].value, entry.settingsPath);
  }
  // Restrict the legacy call to the verified catalog-only pi-ai branch. It gets
  // neither baseURL nor key, so it cannot retry the failed listing request.
  const standardPath = entry?.settingsPath?.length === 2 && entry.settingsPath[0] === 'providers' && entry.settingsPath[1] === draft.provider;
  const bundled = draft.settingsNs === NS && standardPath && entry.declared === false;
  const fallback = () => boundedCatalog(async catalogSignal => candidates(await llm.discoverModels(draft.settingsNs, { provider: draft.provider }, catalogSignal)), signal);
  const contract = bundled ? contracts.get(draft.provider) : undefined;
  let reason;
  try {
    if (draft.settingsNs !== NS || (entry && !standardPath)) throw fault('unsupported');
    // An OAuth-capable provider can still have a documented API-key listing.
    // Never reinterpret its OAuth-only route as a generic API-key endpoint.
    if (entry?.nativeAuth?.oauth === true && !contract) throw fault('unsupported');
    // A dynamic environment endpoint is ambiguous here; do not assume that the
    // listing host follows the inference transport's environment semantics.
    const configuredBase = profile?.baseURL;
    if (configuredBase !== undefined && (typeof configuredBase !== 'string' || !configuredBase)) throw fault('unsafe-endpoint');
    const storedBase = configuredBase ?? (entry?.baseURLEnv?.length ? undefined : contract?.[0]);
    const api = draft.api ?? profile?.api ?? contract?.[1];
    const baseURL = draft.baseURL ?? (draft.endpointChanged ? undefined : storedBase);
    if (!baseURL || !api) throw fault('unsupported');
    modelDiscoveryTarget({ baseURL, api });
    const sameRoute = !!storedBase && clean(baseURL) === clean(storedBase) && api === (profile?.api ?? contract?.[1]);
    const platformDefault = !!contract && clean(baseURL) === contract[0] && api === contract[1];
    if (profile?.headers && Object.keys(profile.headers).length) throw fault('unsupported');
    let apiKey = draft.apiKey;
    if (!apiKey) {
      if (entry && (!sameRoute || draft.endpointChanged)) throw fault('missing-credential');
      if (entry && own(profile, 'apiKeyEnv') && profile.apiKeyEnv !== undefined) {
        if (typeof profile.apiKeyEnv !== 'string' || !refPattern.test(profile.apiKeyEnv)) throw fault('missing-credential');
        apiKey = (await credentials.resolve(profile.apiKeyEnv))?.value;
        if (!apiKey) throw fault('missing-credential');
      } else if (platformDefault) {
        apiKey = await publicKey(credentials, contract, draft.provider, signal);
        if (!apiKey && !contract[3]) throw fault('missing-credential');
      } else if (entry && bundled) {
        // A remapped built-in must not borrow its ambient provider credential.
        throw fault('missing-credential');
      }
    }
    check(signal);
    // Do not delegate DNS for a browser-supplied or remapped destination to
    // the process proxy. Only an exact, locally shipped contract may use it.
    let models = candidates(await live({ baseURL, api }, { apiKey, signal, useHostProxy: platformDefault }));
    check(signal);
    if (models.length && bundled && platformDefault && sameRoute) {
      try { models = present(models, await fallback()); } catch { /* Optional metadata cannot replace the live result. */ }
      check(signal);
    }
    return { source: 'live', scope: apiKey ? 'credential' : 'public', models };
  } catch (error) {
    check(signal);
    reason = reasonCodes.has(error?.code) ? error.code : 'failed';
  }
  if (bundled && typeof llm.discoverModels === 'function') {
    try {
      const models = await fallback();
      check(signal);
      return { source: 'dsh-catalog', reason, models };
    } catch { check(signal); }
  }
  return { error: reason };
}
