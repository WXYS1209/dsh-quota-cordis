import { readFile, writeFile } from 'node:fs/promises';
import { BUNDLED_COMPANY_BRAND_MARKS } from '../src/company-brand-marks.js';

if (process.argv.slice(2).some(argument => argument !== '--check')) throw new Error('Usage: sync-company-brand-marks.js [--check]');
const clientPath = new URL('../client.js', import.meta.url);
const client = await readFile(clientPath, 'utf8');
const start = '    // BEGIN GENERATED COMPANY BRAND MARKS';
const end = '    // END GENERATED COMPANY BRAND MARKS';
const first = client.indexOf(start);
const last = client.indexOf(end, first);
if (first < 0 || last < first || client.indexOf(start, first + start.length) !== -1) throw new Error('Company brand generation markers missing or duplicated');
const replacement = `${start}\n    const BUNDLED_COMPANY_BRAND_MARKS = Object.freeze(${JSON.stringify(BUNDLED_COMPANY_BRAND_MARKS)});\n${end}`;
const next = client.slice(0, first) + replacement + client.slice(last + end.length);
if (process.argv.includes('--check')) {
  if (next !== client) throw new Error('Browser company-brand vectors are stale; run npm run sync:company-brand-marks');
  console.log('Browser company-brand vectors match licensed local assets');
} else if (next !== client) {
  await writeFile(clientPath, next, 'utf8');
  console.log('Updated browser company-brand vectors');
} else {
  console.log('Browser company-brand vectors are already current');
}
