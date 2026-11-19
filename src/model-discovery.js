import dns from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 5000;
const MAX_PAGES = 10;
const TIMEOUT_MS = 8000;
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'home', 'lan', 'corp', 'private', 'onion', 'localdomain', 'invalid', 'test', 'alt', 'arpa'];
const PROTOCOLS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);
const MESSAGES = Object.freeze({
  unsupported: 'This route does not have a supported model listing protocol.',
  'unsafe-endpoint': 'The model listing endpoint is not permitted.',
  failed: 'The platform model listing did not return a usable response.',
  network: 'The connection to the platform model listing failed.',
  'platform-error': 'The platform model listing returned an HTTP error.',
  timeout: 'The platform model listing timed out.',
  authentication: 'The platform refused the model listing credentials.',
  cancelled: 'The platform model listing was cancelled.',
});
const fail = code => Object.assign(new Error(MESSAGES[code]), { code });

export function modelDiscoveryTarget({ baseURL, api } = {}) {
  if (!PROTOCOLS.has(api)) throw fail('unsupported');
  if (typeof baseURL !== 'string' || baseURL.length > 2048 || !/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/i.test(baseURL)
    || /[\u0000-\u0020\u007f\\]|%(?:00|2e|2f|3f|23|5c|25)|(?:^|\/)\.{1,2}(?:\/|$)/i.test(baseURL)) throw fail('unsafe-endpoint');
  const authority = baseURL.slice('https://'.length).split('/')[0];
  if (!/^[a-z0-9.-]+(?::443)?$/i.test(authority)) throw fail('unsafe-endpoint');
  let url;
  try { url = new URL(baseURL); } catch { throw fail('unsafe-endpoint'); }
  const host = url.hostname;
  const labels = host.split('.');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || isIP(host) || host.length > 253
    || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !/[a-z]/.test(labels.at(-1)) || PRIVATE_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) throw fail('unsafe-endpoint');
  let prefix = url.pathname.replace(/\/+$/, '');
  if (api === 'anthropic-messages') {
    if (prefix.endsWith('/v1')) prefix = prefix.slice(0, -3);
    url.pathname = `${prefix}/v1/models`;
    url.searchParams.set('limit', '1000');
  } else {
    url.pathname = `${prefix}/models`;
    if (api === 'google-generative-ai') url.searchParams.set('pageSize', '1000');
  }
  return url;
}

// Reject special-use destinations, not only loopback. For IPv6, only currently
// allocated global unicast space is considered, excluding special assignments.
const blocked = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(ip, bits, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

function publicAddress({ address, family } = {}) {
  if (typeof address !== 'string' || address.includes('%') || isIP(address) !== family) return false;
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function abortable(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const settle = callback => value => {
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    Promise.resolve(promise).then(settle(resolve), settle(reject));
  });
}

async function publicLookup(host, signal) {
  const answers = await abortable(dns.lookup(host + '.', { all: true, verbatim: true }), signal);
  if (!Array.isArray(answers) || !answers.length || answers.length > 64 || !answers.every(publicAddress)) throw fail('unsafe-endpoint');
  return (hostname, options, callback) => {
    if (hostname !== host) return callback(fail('unsafe-endpoint'));
    const eligible = answers.filter(row => !options.family || options.family === row.family);
    if (!eligible.length) return callback(fail('unsafe-endpoint'));
    if (options.all) callback(null, eligible);
    else callback(null, eligible[0].address, eligible[0].family);
  };
}

function checkStatus(status) {
  if (status === 401 || status === 403) throw fail('authentication');
  if (!Number.isInteger(status) || (status >= 300 && status < 400)) throw fail('failed');
  if (status < 200 || status >= 300) throw fail('platform-error');
}

function checkLength(length, limit) {
  if (Number(length) > limit) throw fail('failed');
}

async function pinnedBody(url, headers, signal, limit, lookup) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Fresh socket per request, TLS validates the original SNI/hostname, and
    // lookup supplies only the validated addresses for this operation.
    const request = https.request(url, { method: 'GET', headers, signal, agent: false, lookup, rejectUnauthorized: true, maxHeaderSize: 16 * 1024 }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('error', () => reject(fail('network')));
      try {
        checkStatus(response.statusCode);
        checkLength(response.headers['content-length'], limit);
        const encoding = response.headers['content-encoding'];
        if (encoding && encoding !== 'identity') throw fail('failed');
      } catch (error) {
        reject(error);
        response.destroy();
        return;
      }
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > limit) {
          reject(fail('failed'));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks, bytes)));
    });
    request.on('error', () => reject(fail('network')));
    // Do not let a server switch this connection to a different protocol.
    request.on('upgrade', (_response, socket) => { reject(fail('failed')); socket.destroy(); });
    request.end();
  });
}

async function fetchBody(fetcher, url, headers, signal, limit) {
  const pending = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return fetcher(url, { method: 'GET', headers, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal });
  }).catch(() => { throw fail('network'); });
  // Dispose a late body even if the transport ignores AbortSignal.
  pending.then(response => {
    if (signal.aborted) return response?.body?.cancel();
  }).catch(() => {});
  const response = await abortable(pending, signal);
  let reader;
  try {
    if (response.redirected) throw fail('failed');
    checkStatus(response.status);
    checkLength(response.headers.get('content-length'), limit);
    reader = response.body?.getReader();
    if (!reader) throw fail('failed');
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal).catch(() => { throw fail('network'); });
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw fail('failed');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    try { Promise.resolve(reader ? reader.cancel() : response.body?.cancel()).catch(() => {}); } catch {}
    try { reader?.releaseLock(); } catch {}
  }
}

const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) ? value.trim() || undefined : undefined;
const token = (...values) => values.find(value => Number.isSafeInteger(value) && value > 0);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function addEntries(body, api, result) {
  if (!record(body)) throw fail('failed');
  const gemini = api === 'google-generative-ai';
  let rows;
  if (gemini && Array.isArray(body.models)) rows = body.models.map(value => [undefined, value]);
  else if (!gemini && Array.isArray(body.data)) rows = body.data.map(value => [undefined, value]);
  else if (!gemini && record(body.models)) rows = Object.entries(body.models);
  else throw fail('failed');
  if (rows.length > MAX_MODELS) throw fail('failed');
  let valid = 0;
  for (const [alias, entry] of rows) {
    if (!record(entry)) continue;
    const id = gemini ? text(entry.name, 512)?.replace(/^models\//, '') : text(alias, 512) ?? text(entry.id, 512);
    if (!id) continue;
    valid++;
    if (gemini && Array.isArray(entry.supportedGenerationMethods) && !entry.supportedGenerationMethods.includes('generateContent')) continue;
    if (result.has(id)) continue;
    const name = text(gemini ? entry.displayName : entry.name ?? entry.display_name ?? entry.displayName, 256);
    const contextWindow = token(entry.contextWindow, entry.context_window, entry.context_length, entry.max_input_tokens, entry.limit?.context, gemini ? entry.inputTokenLimit : undefined);
    const maxTokens = token(entry.maxOutputTokens, entry.max_output_tokens, entry.maxTokens, entry.max_tokens, entry.limit?.output, entry.top_provider?.max_completion_tokens, gemini ? entry.outputTokenLimit : undefined);
    const input = entry.inputModalities ?? entry.input ?? entry.modalities?.input;
    const inputModalities = Array.isArray(input) ? [...new Set(input.map(item => typeof item === 'string' && item.startsWith('image/') ? 'image' : item).filter(item => item === 'text' || item === 'image'))] : [];
    result.set(id, { id, ...(name === undefined || name === id ? {} : { name }), ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxTokens === undefined ? {} : { maxTokens }), ...(inputModalities.length ? { inputModalities } : {}) });
    if (result.size > MAX_MODELS) throw fail('failed');
  }
  if (rows.length && !valid) throw fail('failed');
}

function nextPage(body, api, url) {
  const gemini = api === 'google-generative-ai';
  const cursor = gemini ? body.nextPageToken : api === 'anthropic-messages' && body.has_more === true ? body.last_id : undefined;
  if (cursor == null && (gemini || api !== 'anthropic-messages' || body.has_more !== true)) return undefined;
  if (gemini && cursor === '') return undefined;
  const value = text(cursor, 1024);
  if (!value) throw fail('failed');
  const next = new URL(url);
  next.searchParams.set(gemini ? 'pageToken' : 'after_id', value);
  return next;
}

/** useHostProxy is a Host decision for fixed discovery contracts, never a client option.
 * fetcher is an injected test transport; custom production endpoints use pinned HTTPS. */
export async function discoverPlatformModels({ baseURL, api } = {}, { apiKey, signal, useHostProxy = false, fetcher } = {}) {
  let url = modelDiscoveryTarget({ baseURL, api });
  if (signal?.aborted) throw fail('cancelled');
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache, no-store' };
  if (api === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(apiKey)) throw fail('authentication');
    if (api === 'anthropic-messages') headers['x-api-key'] = apiKey;
    else if (api === 'google-generative-ai') headers['x-goog-api-key'] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
  }
  try {
    // Do not supply a custom dispatcher here: DSH installs its launch policy
    // on the global dispatcher. Arbitrary destinations keep pinned direct DNS.
    const transport = fetcher ?? (useHostProxy ? globalThis.fetch : undefined);
    const lookup = transport ? undefined : await publicLookup(url.hostname, combined).catch(error => {
      throw fail(error?.code === 'unsafe-endpoint' ? 'unsafe-endpoint' : 'network');
    });
    const result = new Map();
    const requested = new Set();
    let limit = MAX_BYTES;
    while (url) {
      if (requested.size >= MAX_PAGES || requested.has(url.href)) throw fail('failed');
      requested.add(url.href);
      combined.throwIfAborted();
      const raw = await (transport ? fetchBody(transport, url, headers, combined, limit) : pinnedBody(url, headers, combined, limit, lookup));
      combined.throwIfAborted();
      limit -= raw.byteLength;
      const body = JSON.parse(raw.toString('utf8'));
      addEntries(body, api, result);
      url = nextPage(body, api, url);
    }
    const models = [...result.values()];
    // Even a nominal model-list field must not return an echoed request key.
    if (apiKey && models.some(model => [model.id, model.name].some(value => value === apiKey || (apiKey.length >= 8 && value?.includes(apiKey))))) throw fail('failed');
    return models;
  } catch (error) {
    if (signal?.aborted) throw fail('cancelled');
    if (deadline.aborted) throw fail('timeout');
    throw fail(['unsafe-endpoint', 'authentication', 'network', 'platform-error'].includes(error?.code) ? error.code : 'failed');
  }
}
