import { readFile, writeFile } from 'node:fs/promises';
import { validateCompanyRules } from '../company-rules.js';

const rulesPath = new URL('../company-rules.json', import.meta.url);
const clientPath = new URL('../client.js', import.meta.url);
const rules = JSON.parse(await readFile(rulesPath, 'utf8'));
validateCompanyRules(rules);
const client = await readFile(clientPath, 'utf8');
const start = '    // BEGIN GENERATED COMPANY RULES';
const end = '    // END GENERATED COMPANY RULES';
const first = client.indexOf(start);
const last = client.indexOf(end, first);
if (first < 0 || last < first || client.indexOf(start, first + start.length) !== -1) throw new Error('Company rule generation markers missing or duplicated');
const replacement = `${start}\n    const BUNDLED_CLIENT_COMPANY_RULES = Object.freeze(${JSON.stringify(rules)});\n${end}`;
const next = client.slice(0, first) + replacement + client.slice(last + end.length);
if (process.argv.includes('--check')) {
  if (next !== client) throw new Error('Browser company-rule fallback is stale; run npm run sync:company-rules');
  console.log('Browser company-rule fallback matches company-rules.json');
} else if (next !== client) {
  await writeFile(clientPath, next, 'utf8');
  console.log('Updated browser company-rule fallback');
} else {
  console.log('Browser company-rule fallback is already current');
}
