import { readFileSync } from 'node:fs';

export const LEGACY_COMPANY_ICON_KEYS = Object.freeze(['openai', 'deepseek', 'kimi', 'anthropic', 'google', 'minimax', 'glm', 'opencode']);
const invalid = () => new Error('invalid-company-brand-marks');
const key = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const allowed = (value, fields) => plain(value) && Object.keys(value).every(field => fields.includes(field));
const https = value => {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port; } catch { return false; }
};

// Local build input only. Never evaluate SVG/XML or pass arbitrary attributes to
// React: generated browser data contains viewBox/path geometry and optional hex.
export function validateCompanyBrandMarks(value) {
  if (!allowed(value, ['schemaVersion', 'marks', 'companies', 'sources', 'unavailable']) || value.schemaVersion !== 1 || !plain(value.marks) || !plain(value.companies) || !Array.isArray(value.sources)) throw invalid();
  const entries = Object.entries(value.marks);
  if (!entries.length || entries.length > 100 || JSON.stringify(value).length > 512 * 1024) throw invalid();
  const marks = {};
  for (const [id, mark] of entries) {
    if (!key(id) || !allowed(mark, ['viewBox', 'paths', 'color', 'fillRule']) || typeof mark.viewBox !== 'string') throw invalid();
    const box = mark.viewBox.trim().split(/\s+/).map(Number);
    if (box.length !== 4 || box.some(number => !Number.isFinite(number) || Math.abs(number) > 8192) || box[2] <= 0 || box[3] <= 0) throw invalid();
    if (!Array.isArray(mark.paths) || !mark.paths.length || mark.paths.length > 32 || mark.paths.some(path => typeof path !== 'string' || path.length < 2 || path.length > 100000 || !/^[MmZzLlHhVvCcSsQqTtAa0-9eE+., \t\r\n-]+$/.test(path) || !/^[Mm]/.test(path))) throw invalid();
    if (mark.color !== undefined && (typeof mark.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(mark.color))) throw invalid();
    if (mark.fillRule !== undefined && !['evenodd', 'nonzero'].includes(mark.fillRule)) throw invalid();
    marks[id] = { viewBox: box.join(' '), paths: [...mark.paths], ...(mark.color ? { color: mark.color } : {}), ...(mark.fillRule ? { fillRule: mark.fillRule } : {}) };
  }
  const known = new Set([...LEGACY_COMPANY_ICON_KEYS, ...Object.keys(marks)]);
  for (const [company, icon] of Object.entries(value.companies)) if (!key(company) || !known.has(icon)) throw invalid();
  const referenced = new Set();
  for (const source of value.sources) {
    if (!allowed(source, ['key', 'project', 'version', 'assetUrl', 'license', 'brandUrl']) || !Object.hasOwn(marks, source.key) || referenced.has(source.key) || !https(source.assetUrl) || !https(source.brandUrl) || !['CC0-1.0', 'MIT'].includes(source.license) || typeof source.project !== 'string' || !source.project || typeof source.version !== 'string' || !source.version) throw invalid();
    referenced.add(source.key);
  }
  if (entries.some(([id]) => !referenced.has(id))) throw invalid();
  return { marks, companies: { ...value.companies } };
}

const raw = JSON.parse(readFileSync(new URL('./data/company-brand-marks.json', import.meta.url), 'utf8'));
const bundle = validateCompanyBrandMarks(raw);
export const BUNDLED_COMPANY_BRAND_MARKS = Object.freeze(bundle.marks);
export const BUNDLED_COMPANY_BRAND_ASSIGNMENTS = Object.freeze(bundle.companies);
export const LOCAL_COMPANY_ICON_KEYS = Object.freeze([...new Set([...LEGACY_COMPANY_ICON_KEYS, ...Object.keys(bundle.marks)])]);
