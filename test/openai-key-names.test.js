import test from 'node:test';
import assert from 'node:assert/strict';
import { queryOpenAIKeyNames } from '../openai-key-names.js';

const KEY = 'synthetic-admin-key';
const ref = (projectId, apiKeyId) => `${projectId}\u0000${apiKeyId}`;

test('looks up key names only through the exact official project-key endpoint', async () => {
  let calls = 0;
  const names = await queryOpenAIKeyNames({ key: KEY, entries: [{ projectId: 'proj_123', apiKeyId: 'key_456' }], fetcher: async (address, options) => {
    calls++;
    assert.equal(address, 'https://api.openai.com/v1/organization/projects/proj_123/api_keys/key_456');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    return Response.json({
      id: 'key_456', object: 'organization.project.api_key', name: 'Production / Main',
      redacted_value: 'must-never-escape', owner: { user: { email: 'private@example.com' } },
    });
  } });
  assert.equal(calls, 1);
  assert.equal(names.get(ref('proj_123', 'key_456')), 'Production / Main');
  assert.equal(JSON.stringify([...names]), JSON.stringify([[ref('proj_123', 'key_456'), 'Production / Main']]));
  assert.ok(!JSON.stringify([...names]).includes(KEY));
  assert.ok(!JSON.stringify([...names]).includes('must-never-escape'));
  assert.ok(!JSON.stringify([...names]).includes('private@example.com'));
});

test('name lookup is best-effort and ignores inaccessible, invalid, and unlabelled keys', async () => {
  let calls = 0;
  const entries = [
    { projectId: 'proj_123', apiKeyId: 'key_forbidden' },
    { projectId: 'proj_123', apiKeyId: 'key_mismatch' },
    { projectId: 'proj_123', apiKeyId: 'key_blank' },
    { projectId: 'bad/project', apiKeyId: 'key_path' },
    { projectId: 'proj_123', apiKeyId: null },
  ];
  const names = await queryOpenAIKeyNames({ key: KEY, entries, fetcher: async address => {
    calls++;
    if (address.endsWith('key_forbidden')) return Response.json({ error: 'private' }, { status: 403 });
    if (address.endsWith('key_mismatch')) return Response.json({ id: 'key_other', name: 'wrong' });
    return Response.json({ id: 'key_blank', name: '   ' });
  } });
  assert.equal(calls, 3);
  assert.equal(names.size, 0);
});

test('key names normalize control characters and cap excess lookups', async () => {
  const entries = Array.from({ length: 45 }, (_, index) => ({ projectId: 'proj_123', apiKeyId: `key_${index}` }));
  let calls = 0;
  const names = await queryOpenAIKeyNames({ key: KEY, entries, fetcher: async address => {
    calls++;
    const id = decodeURIComponent(address.slice(address.lastIndexOf('/') + 1));
    return Response.json({ id, object: 'organization.project.api_key', name: ` key\n${id} ` });
  } });
  assert.equal(calls, 40);
  assert.equal(names.size, 40);
  assert.equal(names.get(ref('proj_123', 'key_0')), 'key key_0');
});
