// A catalog host is a display hint, never an effective request endpoint.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const asset = new URL('./data/model-catalog-hosts.json', import.meta.url);
const validHostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const nil = () => null;
function readJSON(file) {
  if (statSync(file).size > 256 * 1024) throw new Error('oversized metadata');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function under(root, child) {
  const path = relative(root, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

// Resolve only public manifests anchored to the installation the running Host
// supplies, not the workspace's packages, global modules or a fallback PATH.
export function resolveModelCatalogVersions(installation = process.env.DSH_INSTALL_DIR) {
  if (typeof installation !== 'string' || !isAbsolute(installation) || typeof nodeModule.findPackageJSON !== 'function') return null;
  try {
    const install = realpathSync(installation);
    let root = dirname(install);
    while (basename(root) !== 'node_modules' && dirname(root) !== root) root = dirname(root);
    if (basename(root) !== 'node_modules') return null;
    const cliPath = join(install, 'package.json');
    const anchor = nodeModule.createRequire(cliPath);
    const adapterPath = realpathSync(anchor.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'));
    if (!under(root, adapterPath)) return null;
    const piPath = realpathSync(nodeModule.findPackageJSON('@earendil-works/pi-ai', pathToFileURL(adapterPath)));
    if (!under(root, piPath)) return null;
    const cli = readJSON(cliPath);
    const adapter = readJSON(adapterPath);
    const pi = readJSON(piPath);
    if (cli.name !== '@deepseek-ai/dsh' || adapter.name !== '@deepseek-ai/dsh-llm-pi-ai' || pi.name !== '@earendil-works/pi-ai'
      || typeof cli.version !== 'string' || cli.version !== adapter.version || typeof pi.version !== 'string') return null;
    return { dshVersion: cli.version, piAiVersion: pi.version };
  } catch { return null; }
}

function compatibleProfile(profile, ids) {
  if (profile === undefined) return true; // Dormant built-in route.
  if (!record(profile) || profile.baseURL !== undefined || profile.api !== undefined) return false;
  const validModel = model => record(model) && model.baseURL === undefined && model.baseUrl === undefined && model.api === undefined;
  if (profile.models !== undefined && (!Array.isArray(profile.models) || profile.models.length > 3000
    || profile.models.some(model => !validModel(model) || !ids.has(model.id))
    || new Set(profile.models.map(model => model.id)).size !== profile.models.length)) return false;
  if (profile.modelOverrides !== undefined) {
    if (!record(profile.modelOverrides)) return false;
    const overrides = Object.entries(profile.modelOverrides);
    if (overrides.length > 3000 || (overrides.length && profile.models?.length)
      || overrides.some(([id, model]) => !ids.has(id) || !validModel(model) || Object.hasOwn(model, 'id'))) return false;
  }
  if (profile.headers !== undefined && (!record(profile.headers) || Object.keys(profile.headers).length !== 0)) return false;
  return true;
}

export function createModelCatalogGrouping(snapshot, versions) {
  if (!versions || snapshot?.schemaVersion !== 1 || typeof snapshot.dshVersion !== 'string' || typeof snapshot.piAiVersion !== 'string'
    || snapshot.dshVersion !== versions.dshVersion || snapshot.piAiVersion !== versions.piAiVersion || !record(snapshot.providers)) return nil;
  const index = new Map();
  const entries = Object.entries(snapshot.providers);
  if (entries.length > 1000) return nil;
  for (const [provider, row] of entries) {
    if (!/^[a-z][a-z0-9-]{0,127}$/.test(provider) || !record(row) || typeof row.hostname !== 'string' || !validHostname.test(row.hostname)
      || !Array.isArray(row.modelIds) || !row.modelIds.length || row.modelIds.length > 3000
      || row.modelIds.some(id => typeof id !== 'string' || !id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id))) return nil;
    const ids = new Set(row.modelIds);
    if (ids.size !== row.modelIds.length) return nil;
    index.set(provider, { hostname: row.hostname, ids });
  }
  return (entry, profile) => {
    if (entry?.declared !== false || entry.settingsNs !== 'llm-pi-ai' || entry.settingsPath?.length !== 2
      || entry.settingsPath[0] !== 'providers' || entry.settingsPath[1] !== entry.provider || entry.defaultBaseURL !== undefined
      || (entry.baseURLEnv !== undefined && (!Array.isArray(entry.baseURLEnv) || entry.baseURLEnv.length !== 0)) || entry.error !== undefined) return null;
    const row = index.get(entry.provider);
    return row && compatibleProfile(profile, row.ids) ? row.hostname : null;
  };
}

export function loadModelCatalogGrouping(installation) {
  try {
    const versions = resolveModelCatalogVersions(installation);
    return versions ? createModelCatalogGrouping(readJSON(asset), versions) : nil;
  } catch { return nil; }
}
