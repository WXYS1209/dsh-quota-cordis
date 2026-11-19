import test from 'node:test';
import assert from 'node:assert/strict';
import { queryOpenCodeUsage, parseOpenCodeUsage } from '../src/opencode-usage.js';

const KEY = 'synthetic-opencode-key';
const NOW = Date.UTC(2026, 11, 12, 6);
const usage = windows => ({ usage: windows });
const response = body => Response.json(body);
const rejects = async (promise, code = 'invalid-response') => assert.rejects(promise, err => {
  assert.equal(err.message, code);
  assert.equal(err.code, code);
  assert.equal(err.cause, undefined);
  assert.ok(!JSON.stringify(err).includes(KEY));
  return true;
});
const run = (body, args = {}) => queryOpenCodeUsage({ key: KEY, now: NOW, fetcher: async () => response(body), ...args });

test('queries only the official Zen usage endpoint with Bearer auth and no extra filters', async () => {
  let calls = 0;
  const metrics = await queryOpenCodeUsage({ key: KEY, now: NOW, fetcher: async (address, options) => {
    calls++;
    assert.equal(address, 'https://opencode.ai/zen/go/v1/usage');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    assert.ok(options.signal instanceof AbortSignal);
    return response(usage({
      rolling: { status: 'ok', percent: 11, resetsAt: '2026-12-17T17:10:09.580Z' },
      weekly: { status: 'ok', percent: 4, resetsAt: '2026-12-24T00:00:00.580Z' },
      monthly: { status: 'ok', percent: 2, resetsAt: '2027-01-13T04:26:00.580Z' },
    }));
  } });
  assert.equal(calls, 1);
  assert.deepEqual(metrics, [
    { type: 'quota-window', label: 'rolling', unit: 'percent', usedPercent: 11, resetsAt: Date.parse('2026-12-17T17:10:09.580Z') },
    { type: 'quota-window', label: 'weekly', unit: 'percent', usedPercent: 4, resetsAt: Date.parse('2026-12-24T00:00:00.580Z') },
    { type: 'quota-window', label: 'monthly', unit: 'percent', usedPercent: 2, resetsAt: Date.parse('2027-01-13T04:26:00.580Z') },
  ]);
  assert.ok(!JSON.stringify(metrics).includes(KEY));
});

test('fractional percents are preserved and missing windows are skipped without zeros', () => {
  assert.deepEqual(parseOpenCodeUsage(usage({ rolling: { percent: 0.5 }, weekly: null })), [
    { type: 'quota-window', label: 'rolling', unit: 'percent', usedPercent: 0.5 },
  ]);
  assert.deepEqual(parseOpenCodeUsage(usage({ monthly: { percent: 100 } })), [
    { type: 'quota-window', label: 'monthly', unit: 'percent', usedPercent: 100 },
  ]);
  assert.deepEqual(parseOpenCodeUsage(usage({ rolling: { percent: 3, resetsAt: null } })), [
    { type: 'quota-window', label: 'rolling', unit: 'percent', usedPercent: 3 },
  ]);
});

test('epoch-millisecond and epoch-second style numeric resets are handled strictly', () => {
  const ms = NOW + 3600000;
  assert.equal(parseOpenCodeUsage(usage({ rolling: { percent: 1, resetsAt: ms } }))[0].resetsAt, ms);
  fails(() => parseOpenCodeUsage(usage({ rolling: { percent: 1, resetsAt: ms / 1000 } })));
  function fails(fn) { assert.throws(fn, /invalid-response/); }
});

test('unknown window names, malformed percents and bad timestamps fail safely', () => {
  for (const body of [
    usage({ rolling: { percent: '11' } }),
    usage({ rolling: { percent: NaN } }),
    usage({ rolling: { percent: 101 } }),
    usage({ rolling: { percent: -1 } }),
    usage({ rolling: { percent: 5, resetsAt: 'not-a-date' } }),
    usage({ rolling: { percent: 5, resetsAt: 0 } }),
    usage({ rolling: 'ok' }),
    usage({}),
    {},
    null,
    [],
    'percent 11',
  ]) assert.throws(() => parseOpenCodeUsage(body), /invalid-response/);
});

test('unrelated extra fields are ignored and upstream objects are not mutated', () => {
  const body = usage({ rolling: { percent: 7, resetsAt: '2026-12-17T17:10:09.580Z', status: 'ok', unknown: 'x' }, extra: 'y' });
  const before = JSON.stringify(body);
  parseOpenCodeUsage(body);
  assert.equal(JSON.stringify(body), before);
});

test('invalid input fails before any request and never includes the key', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return response(usage({})); };
  for (const key of ['', undefined, 'bad\r\nkey', ' ', 'x'.repeat(8193)]) await rejects(queryOpenCodeUsage({ key, now: NOW, fetcher }), 'unauthorized');
  for (const now of [NaN, Infinity, -1, '123', 0.5]) await rejects(queryOpenCodeUsage({ key: KEY, now, fetcher }));
  for (const signal of [null, {}, 'abort']) await rejects(queryOpenCodeUsage({ key: KEY, now: NOW, signal, fetcher }));
  const controller = new AbortController(); controller.abort();
  await rejects(queryOpenCodeUsage({ key: KEY, now: NOW, signal: controller.signal, fetcher }), 'timeout');
  assert.equal(calls, 0);
});

test('fetch and stream failures have distinct fixed statuses; upstream details never appear', async () => {
  await rejects(queryOpenCodeUsage({ key: KEY, now: NOW, fetcher: async () => { throw new Error(`private fetch ${KEY}`); } }), 'network-connect');
  const broken = new ReadableStream({ start(controller) { controller.error(new Error(`private stream ${KEY}`)); } });
  await rejects(queryOpenCodeUsage({ key: KEY, now: NOW, fetcher: async () => new Response(broken) }), 'network-read');
});

test('HTTP statuses map to fixed codes and body content is never echoed', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate-limited'], [500, 'upstream']]) {
    await rejects(queryOpenCodeUsage({ key: KEY, now: NOW, fetcher: async () => Response.json({ error: `private-upstream-${status}` }, { status }) }), code);
  }
  await rejects(queryOpenCodeUsage({ key: KEY, now: NOW, fetcher: async () => new Response(null, { status: 301, headers: { location: 'https://evil.example' } }) }), 'upstream');
  await rejects(queryOpenCodeUsage({ key: KEY, now: NOW, fetcher: async () => new Response('{broken-json') }), 'invalid-response');
});
