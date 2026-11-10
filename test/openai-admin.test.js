import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_REFS, resolveOpenAIAdminKey, describeOpenAIAdminKey } from '../openai-admin.js';

const key = 'sk-admin-fixture-secret-A';
const other = 'sk-admin-fixture-secret-B';
function credentialMock(values = {}) {
  const refs = [];
  return { refs, async resolve(ref) { refs.push(ref); if (values.error) throw Error('private-credential-diagnostic'); return values[ref] ? { value: values[ref], source: 'test-source' } : undefined; } };
}

test('only dedicated Admin Key references are queried, in explicit precedence order', async () => {
  const credentials = credentialMock({ [ADMIN_REFS[0]]: key, [ADMIN_REFS[1]]: other });
  assert.equal(await resolveOpenAIAdminKey(credentials), key);
  assert.deepEqual(credentials.refs, ['OPENAI_ADMIN_KEY_DSH']);
});

test('generic Admin aliases remain compatible only through DSH credentials', async () => {
  const credentials = credentialMock({ OPENAI_ADMIN_API_KEY: other });
  assert.equal(await resolveOpenAIAdminKey(credentials), other);
  assert.deepEqual(credentials.refs, [...ADMIN_REFS]);
});

test('missing Admin references never fall back to inference keys or a local file', async () => {
  const credentials = credentialMock({ OPENAI_API_KEY: 'sk-proj-inference-fixture' });
  assert.equal(await resolveOpenAIAdminKey(credentials), undefined);
  assert.deepEqual(credentials.refs, [...ADMIN_REFS]);
  assert.equal('readLocal' in resolveOpenAIAdminKey, false);
});

test('malformed Admin credential fails without exposing the value or trying another account', async () => {
  const credentials = credentialMock({ OPENAI_ADMIN_KEY_DSH: 'sk-proj-not-admin', OPENAI_ADMIN_KEY: other });
  await assert.rejects(resolveOpenAIAdminKey(credentials), error => error.message === 'invalid-admin-key');
  assert.deepEqual(credentials.refs, ['OPENAI_ADMIN_KEY_DSH']);
});

test('credential service errors are sanitized and do not disclose diagnostics', async () => {
  const credentials = credentialMock({ error: true });
  await assert.rejects(resolveOpenAIAdminKey(credentials), error => error.message === 'admin-credential-error' && !error.message.includes('private-credential-diagnostic'));
});

test('admin status returns only configured bit and coarse reference class', async () => {
  const status = await describeOpenAIAdminKey(credentialMock({ OPENAI_ADMIN_KEY_DSH: key }));
  assert.deepEqual(status, { configured: true, source: 'credential-store' });
  assert.equal(JSON.stringify(status).includes(key), false);
  assert.deepEqual(await describeOpenAIAdminKey(credentialMock()), { configured: false, source: null });
});

test('Admin key format rejects inference, quoted, whitespace and command-like values', async () => {
  for (const value of ['sk-proj-example-key', ` ${key}`, `${key} `, `'${key}'`, '$(command)', 'sk-admin-short']) {
    await assert.rejects(resolveOpenAIAdminKey(credentialMock({ OPENAI_ADMIN_KEY_DSH: value })), error => error.message === 'invalid-admin-key');
  }
});
