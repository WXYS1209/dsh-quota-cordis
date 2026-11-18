// Development-only public-catalog snapshot. Run with the running DSH runtime:
// ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" scripts/snapshot-dsh-provider-catalog.js [--check]
// Reads shipped package metadata/catalogs only. Never instantiates a DSH profile,
// invokes provider auth/getModels/refreshModels, or reads launch credential values.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as nodeModule from 'node:module';

const fixturePath = new URL('../test/fixtures/dsh-provider-catalog.json', import.meta.url);
const args = process.argv.slice(2);
if (args.some(value => value !== '--check') || args.length > 1) throw new Error('Usage: snapshot-dsh-provider-catalog.js [--check]');
const installation = process.env.DSH_INSTALL_DIR;
const runtime = process.env.DSH_NODE_EXECUTABLE;
if (!installation || !path.isAbsolute(installation) || !runtime || !path.isAbsolute(runtime)) throw new Error('DSH_INSTALL_DIR and DSH_NODE_EXECUTABLE must identify the running installation');
if (realpathSync(process.execPath) !== realpathSync(runtime)) throw new Error('Use ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" to read the running installation');
if (installation.includes('.asar') && !process.versions.electron) throw new Error('Desktop ASAR catalogs require the DSH Electron runtime');
if (typeof nodeModule.stripTypeScriptTypes !== 'function') throw new Error('The running DSH runtime must support TypeScript stripping for its generated public metadata');
const manifest = async (file, name) => {
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (value.name !== name || typeof value.version !== 'string' || !value.version) throw new Error(`Unexpected installed package metadata: ${name}`);
  return value;
};
const cli = await manifest(path.join(installation, 'package.json'), '@deepseek-ai/dsh');
const require = nodeModule.createRequire(path.join(installation, 'package.json'));
const adapterManifest = require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json');
const adapter = await manifest(adapterManifest, '@deepseek-ai/dsh-llm-pi-ai');
if (adapter.version !== cli.version) throw new Error('The installed DSH and pi-ai adapter versions do not match');
const adapterDirectory = path.dirname(adapterManifest);
// pi-ai has import-only exports and does not export package.json. Locate its
// manifest using Node's bounded package-search paths, then honor the import map.
const dependencyRequire = nodeModule.createRequire(adapterManifest);
const search = dependencyRequire.resolve.paths('@earendil-works/pi-ai') ?? [];
let piDirectory;
for (const root of search) {
  const candidate = path.join(root, '@earendil-works/pi-ai/package.json');
  if (existsSync(candidate)) { piDirectory = path.dirname(candidate); break; }
}
if (!piDirectory) throw new Error('The installed adapter public pi-ai dependency could not be located');
const piAi = await manifest(path.join(piDirectory, 'package.json'), '@earendil-works/pi-ai');
const providerImport = piAi.exports?.['./providers/*']?.import;
if (typeof providerImport !== 'string' || !providerImport.startsWith('./') || providerImport.split('*').length !== 2) throw new Error('The installed pi-ai provider import export is unsupported');
const providerModulePath = path.resolve(piDirectory, providerImport.replace('*', 'all'));
if (!providerModulePath.startsWith(`${path.resolve(piDirectory)}${path.sep}`)) throw new Error('The pi-ai public catalog export leaves its package');
const catalog = await import(pathToFileURL(providerModulePath).href);
if (typeof catalog.builtinProviders !== 'function' || typeof catalog.getAllBuiltinModels !== 'function') throw new Error('The installed pi-ai public catalog functions changed');
const generatedSource = await readFile(path.join(adapterDirectory, 'src/provider-data.generated.ts'), 'utf8');
const generatedModule = await import(`data:text/javascript;base64,${Buffer.from(nodeModule.stripTypeScriptTypes(generatedSource)).toString('base64')}`);
const providerData = generatedModule.PROVIDER_DATA;
if (!providerData || typeof providerData !== 'object' || Array.isArray(providerData)) throw new Error('The DSH generated public provider metadata changed');
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const providers = catalog.builtinProviders();
if (!Array.isArray(providers) || !providers.length || providers.length > 1000) throw new Error('Invalid public provider catalog');
const seen = new Set();
const rows = providers.map(provider => {
  if (!provider || typeof provider.id !== 'string' || !provider.id || seen.has(provider.id) || typeof provider.name !== 'string' || !provider.name) throw new Error('Invalid or duplicate public provider identity');
  seen.add(provider.id);
  const data = providerData[provider.id];
  const fallback = typeof provider.baseUrl === 'string' && provider.baseUrl && !provider.baseUrl.includes('{') ? provider.baseUrl : null;
  // Match the adapter's providerDefaultsOf: an existing generated record is
  // authoritative even when it deliberately omits a fixed default endpoint.
  const defaultBaseURL = data === undefined ? fallback : data.defaultBaseURL ?? null;
  if (defaultBaseURL !== null && (typeof defaultBaseURL !== 'string' || !defaultBaseURL)) throw new Error('Invalid public default endpoint metadata');
  const models = catalog.getAllBuiltinModels(provider.id);
  if (!Array.isArray(models)) throw new Error('The public built-in model catalog changed');
  const modelBaseURLs = [...new Set(models.map(model => model.baseUrl).filter(value => typeof value === 'string' && value))].sort(compare);
  const baseURLEnv = [...(data?.baseURLEnv ?? [])];
  if (baseURLEnv.some(value => typeof value !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(value))) throw new Error('Invalid public endpoint environment metadata');
  // Deliberately select these fields; do not serialize provider functions,
  // native-auth environment names or any credential/service/account values.
  return { id: provider.id, name: provider.name, defaultBaseURL, modelBaseURLs, baseURLEnv: [...new Set(baseURLEnv)].sort(compare) };
}).sort((left, right) => compare(left.id, right.id));
const snapshot = { schemaVersion: 1, dshVersion: cli.version, piAiVersion: piAi.version, providers: rows };
const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
let previous;
try { previous = await readFile(fixturePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (args.includes('--check')) {
  if (previous !== serialized) throw new Error('Official provider catalog snapshot differs; regenerate it with the same DSH runtime and review company-rule coverage');
  console.log(`Official provider catalog snapshot matches DSH ${cli.version} / pi-ai ${piAi.version} (${rows.length} providers)`);
} else if (previous !== serialized) {
  await mkdir(new URL('../test/fixtures/', import.meta.url), { recursive: true });
  await writeFile(fixturePath, serialized, 'utf8');
  console.log(`Updated public provider catalog snapshot: DSH ${cli.version} / pi-ai ${piAi.version}, ${rows.length} providers`);
} else {
  console.log(`Official provider catalog snapshot already current (${rows.length} providers)`);
}
