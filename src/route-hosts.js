// Host-only endpoint resolution. Never return these raw values to the Client.
const MAX_ROUTES = 2000;
const MAX_ENV_REFS_PER_ROUTE = 32;
const MAX_RESOLUTIONS = 256;
const unavailable = () => Object.assign(new Error('route-hosts-unavailable'), { code: 'route-hosts-unavailable' });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

function atPath(value, path) {
  for (const key of path) {
    if (!own(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

// The same resolver serves company metadata and quota classification. Native
// DeepSeek endpoints follow the adapter's config / launch-snapshot / default
// precedence, never a managed credential with a matching environment name.
export async function resolveProviderBaseURL(entry, profile, credentials, { launchEnvironment, resolveNativeEndpoint } = {}) {
  if (nativeDeepSeekRoute(entry)) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw unavailable();
    const configured = profile.baseURL;
    const value = configured !== undefined && configured !== null ? configured
      : await (resolveNativeEndpoint ? resolveNativeEndpoint() : nativeEnvironmentBaseURL(launchEnvironment));
    if (!nativeDeepSeekHostname(value)) throw unavailable();
    return value;
  }
  const configured = profile?.baseURL;
  if (configured !== undefined) {
    // pi-ai rejects an explicitly supplied empty/non-string endpoint. It is not
    // absence and must never manufacture an official URL via env/catalog fallback.
    if (typeof configured !== 'string' || !configured.trim()) throw unavailable();
    return configured;
  }
  const refs = entry.baseURLEnv ?? [];
  if (!Array.isArray(refs) || refs.length > MAX_ENV_REFS_PER_ROUTE || refs.some(ref => typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(ref))) throw unavailable();
  for (const ref of new Set(refs)) {
    const found = (await credentials.resolve(ref))?.value;
    if (found) return found;
  }
  return entry.defaultBaseURL;
}

export function providerRouteHostname(value) {
  if (typeof value !== 'string' || !value || value.length > 16_384 || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const authority = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || authority?.includes('@')) return null;
    return url.hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch { return null; }
}

// Installed native adapters share the Messages transport. Their directory rows
// omit endpoint metadata (DSH 0.2.2-rc.3); recognize only the standard namespace
// (including core's llm-deepseek entry ID) and whole-section path, never a
// pi-ai/custom route with the same provider ID.
const nativeDeepSeekRoute = entry => Array.isArray(entry.settingsPath) && entry.settingsPath.length === 0 && (
  entry.provider === 'deepseek-account' && entry.settingsNs === 'llm-deepseek-account' ||
  entry.provider === 'deepseek-official' && ['llm-deepseek', 'llm-deepseek-api-key'].includes(entry.settingsNs)
);
const NATIVE_DEEPSEEK_DEFAULT = 'https://api.deepseek.com/anthropic';
function nativeEnvironmentBaseURL(launchEnvironment) {
  if (typeof launchEnvironment?.get !== 'function') throw unavailable();
  return launchEnvironment.get('DEEPSEEK_BASE_URL')?.value ?? NATIVE_DEEPSEEK_DEFAULT;
}
// Match the public SDK's process fallback when no launch snapshot is provided,
// but lazily read only this endpoint key, never copy the whole environment.
export function nativeDeepSeekEndpointEnvironment(snapshot, readProcessEndpoint) {
  if (snapshot !== undefined && snapshot !== null) return snapshot;
  return { get(ref) {
    if (ref !== 'DEEPSEEK_BASE_URL') throw unavailable();
    const value = readProcessEndpoint();
    return value === undefined ? undefined : { value };
  } };
}
function nativeDeepSeekHostname(value) {
  // Native resolveAdapterOptions rejects query/fragment, unlike generic routes.
  const hostname = providerRouteHostname(value);
  if (!hostname) return null;
  try { const url = new URL(value); return url.search || url.hash ? null : hostname; } catch { return null; }
}

function bounded(operation, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(unavailable()); return; }
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, unavailable());
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(value => finish(resolve, value), () => finish(reject, unavailable()));
  });
}

function routeIdentity(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.provider !== 'string' || !entry.provider || entry.provider.length > 256
    || typeof entry.settingsNs !== 'string' || !entry.settingsNs || entry.settingsNs.length > 256
    || !Array.isArray(entry.settingsPath) || entry.settingsPath.length > 32
    || entry.settingsPath.some(segment => typeof segment !== 'string' || !segment || segment.length > 256)) throw unavailable();
  return { provider: entry.provider, settingsNs: entry.settingsNs, settingsPath: [...entry.settingsPath] };
}

// Configuration metadata only: no inference, model discovery or quota fetch.
// Optional authentication presence uses public descriptors / account state only;
// grant payloads, API-key values, account details and login attempts are not read.
export async function readProviderRouteHosts({ llm, settings, credentials, launchEnvironment, deepseekAccount, catalogGrouping }, { signal, timeoutMs = 5000, resolveTimeoutMs = 1000 } = {}) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    return await bounded(async () => {
      const directory = await llm.listConfigurableProviders();
      if (combined.aborted) throw unavailable();
      if (!Array.isArray(directory) || directory.length > MAX_ROUTES) throw unavailable();
      const identities = directory.map(routeIdentity);
      if (!directory.length) return { routes: [] };
      const descriptors = await settings.describe({ redactSecrets: true });
      if (combined.aborted) throw unavailable();
      if (!Array.isArray(descriptors) || descriptors.length > MAX_ROUTES) throw unavailable();
      const documents = new Map();
      for (const doc of descriptors) {
        if (!doc || typeof doc.ns !== 'string' || documents.has(doc.ns)) throw unavailable();
        documents.set(doc.ns, doc.value);
      }
      const resolutions = new Map();
      const resolver = { resolve(ref) {
        if (combined.aborted) return Promise.reject(unavailable());
        if (!resolutions.has(ref)) {
          if (resolutions.size >= MAX_RESOLUTIONS) return Promise.reject(unavailable());
          resolutions.set(ref, bounded(() => credentials.resolve(ref), combined, resolveTimeoutMs));
        }
        return resolutions.get(ref);
      } };
      let nativeEndpoint;
      const resolveNativeEndpoint = () => {
        if (!nativeEndpoint) nativeEndpoint = bounded(() => nativeEnvironmentBaseURL(launchEnvironment), combined, resolveTimeoutMs);
        return nativeEndpoint;
      };
      const statusReads = new Map();
      const statusRead = (key, operation) => {
        if (!statusReads.has(key)) {
          if (statusReads.size >= MAX_RESOLUTIONS) return Promise.resolve(false);
          statusReads.set(key, bounded(operation, combined, resolveTimeoutMs));
        }
        return statusReads.get(key);
      };
      const authenticationConfigured = async (entry, profile) => {
        if (nativeDeepSeekRoute(entry)) {
          if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
          if (entry.provider === 'deepseek-account') {
            if (typeof deepseekAccount?.getState !== 'function') return false;
            return statusRead('deepseek-account', async () => (await deepseekAccount.getState())?.status === 'credential-stored');
          }
          const ref = profile.apiKeyEnv === undefined ? 'DEEPSEEK_API_KEY' : profile.apiKeyEnv;
          if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(ref) || typeof credentials?.describe !== 'function') return false;
          return statusRead(`reference:${ref}`, async () => (await credentials.describe(ref))?.configured === true);
        }
        // Only the known pi-ai storage scope may describe its advertised OAuth
        // record. A same-name route in another namespace must not borrow it.
        if (entry.settingsNs === 'llm-pi-ai' && entry.settingsPath.length === 2 && entry.settingsPath[0] === 'providers' && entry.settingsPath[1] === entry.provider
          && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(entry.provider) && entry.nativeAuth?.oauth === true && typeof credentials?.describeRecord === 'function') {
          const key = `llm-pi-ai/${entry.provider}`;
          return statusRead(`record:${key}`, async () => {
            const info = await credentials.describeRecord(key);
            return info?.configured === true && (info.kind === 'grant' || info.kind === 'api-key');
          });
        }
        return false;
      };
      const routes = [];
      // Sequential traversal avoids credential fan-out; deadlines bound stalled
      // service calls, which expose no cancellation API of their own.
      for (let index = 0; index < directory.length; index++) {
        if (combined.aborted) throw unavailable();
        const identity = identities[index];
        let hostname = null, groupingHostname = null;
        if (documents.has(identity.settingsNs)) {
          try {
            const document = documents.get(identity.settingsNs);
            const profile = atPath(document, identity.settingsPath);
            const baseURL = await resolveProviderBaseURL(directory[index], profile, resolver, { launchEnvironment, resolveNativeEndpoint });
            hostname = providerRouteHostname(baseURL);
            // Verified catalog hints may fill only a genuinely absent endpoint,
            // never an invalid URL or an endpoint whose resolution failed.
            if (baseURL === undefined && document && typeof document === 'object' && !Array.isArray(document)
              && (!own(document, 'providers') || (document.providers && typeof document.providers === 'object' && !Array.isArray(document.providers)))) {
              groupingHostname = catalogGrouping?.(directory[index], profile) ?? null;
            }
          } catch { /* An uncertain row remains unclassified; never use its default. */ }
        }
        let authConfigured = false;
        if (documents.has(identity.settingsNs)) {
          try { authConfigured = await authenticationConfigured(directory[index], atPath(documents.get(identity.settingsNs), identity.settingsPath)); }
          catch { /* Optional presence failures must not hide a valid hostname. */ }
        }
        routes.push({ ...identity, hostname, ...(groupingHostname ? { groupingHostname, groupingSource: 'model-catalog' } : {}), ...(authConfigured === true ? { authConfigured: true } : {}) });
      }
      return { routes };
    }, signal, timeoutMs);
  } catch { throw unavailable(); }
  finally { controller.abort(); }
}
