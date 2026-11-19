import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { validateCompanyBrandMarks, BUNDLED_COMPANY_BRAND_MARKS, BUNDLED_COMPANY_BRAND_ASSIGNMENTS, LOCAL_COMPANY_ICON_KEYS } from '../src/company-brand-marks.js';
import { BUNDLED_COMPANY_RULES } from '../src/company-rules.js';

const fixture = () => ({ schemaVersion: 1, marks: { brand: { viewBox: '0 0 24 24', paths: ['M0 0h24v24H0z'] } }, companies: { example: 'brand' }, sources: [{ key: 'brand', project: 'Test Brand Icons', version: '1.0.0', assetUrl: 'https://example.com/1.0.0/brand.svg', license: 'MIT', brandUrl: 'https://example.com/' }] });
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');

test('all assigned company brands resolve to local licensed vectors or preserved local marks', () => {
  assert.ok(Object.keys(BUNDLED_COMPANY_BRAND_MARKS).length >= 15);
  assert.ok(Object.keys(BUNDLED_COMPANY_BRAND_ASSIGNMENTS).length >= 20);
  for (const company of BUNDLED_COMPANY_RULES.companies) {
    if (company.icon !== null) assert.ok(LOCAL_COMPANY_ICON_KEYS.includes(company.icon), company.id);
    if (Object.hasOwn(BUNDLED_COMPANY_BRAND_ASSIGNMENTS, company.id)) assert.equal(company.icon, BUNDLED_COMPANY_BRAND_ASSIGNMENTS[company.id], company.id);
  }
});

test('browser brand geometry matches local source data without embedding source URLs or executable SVG', () => {
  const block = source.split('// BEGIN GENERATED COMPANY BRAND MARKS')[1]?.split('// END GENERATED COMPANY BRAND MARKS')[0];
  assert.ok(block);
  const browser = vm.runInNewContext(`${block}\nBUNDLED_COMPANY_BRAND_MARKS`);
  assert.deepEqual(JSON.parse(JSON.stringify(browser)), BUNDLED_COMPANY_BRAND_MARKS);
  assert.equal(/https?:|<svg|<script|<image|foreignObject|onload|javascript:/i.test(block), false);
  assert.ok(source.includes('...BUNDLED_COMPANY_BRAND_MARKS'));
  assert.ok(source.includes('mark.paths ?? [mark.path]'));
  assert.ok(source.includes('fillRule: mark.fillRule'));
});

test('brand data accepts bounded SVG geometry and preserves multipath cutouts', () => {
  const value = fixture(); value.marks.brand.paths.push('M5 5h14v14H5z'); value.marks.brand.fillRule = 'evenodd';
  assert.equal(validateCompanyBrandMarks(value).marks.brand.fillRule, 'evenodd');
});

test('brand data rejects SVG markup, URL attributes, unsupported fill rules, unsafe colors and absent licensing', () => {
  for (const mutate of [
    value => { value.marks.brand.paths = ['<svg onload="alert(1)">']; },
    value => { value.marks.brand.paths = ['M0 0 url(https://example.com)']; },
    value => { value.marks.brand.image = 'https://example.com/brand.svg'; },
    value => { value.marks.brand.viewBox = '0 0 Infinity 24'; },
    value => { value.marks.brand.fillRule = 'url(https://example.com)'; },
    value => { value.marks.brand.color = 'red; background:url(https://example.com)'; },
    value => { value.companies.example = 'https://example.com/brand.svg'; },
    value => { value.sources = []; },
    value => { value.sources[0].license = 'unverified'; },
    value => { value.sources[0].assetUrl = 'javascript:alert(1)'; },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => validateCompanyBrandMarks(value), /invalid-company-brand-marks/);
  }
});
