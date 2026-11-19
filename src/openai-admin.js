// The Admin key is held only in Harness credentials under these dedicated
// references. This module never opens a file or reads a model-inference key.
export const ADMIN_REFS = Object.freeze(['OPENAI_ADMIN_KEY_DSH', 'OPENAI_ADMIN_KEY', 'OPENAI_ADMIN_API_KEY']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
function validate(value) {
  if (typeof value !== 'string' || !/^sk-admin-[A-Za-z0-9_-]{8,8192}$/.test(value)) fail('invalid-admin-key');
  return value;
}

export async function resolveOpenAIAdminKey(credentials) {
  for (let index = 0; index < ADMIN_REFS.length; index++) {
    let resolved;
    try { resolved = await credentials.resolve(ADMIN_REFS[index]); }
    catch { fail('admin-credential-error'); }
    if (resolved?.value) return validate(resolved.value);
  }
  return undefined;
}

// Presence only; credential values never leave this Host module.
export async function describeOpenAIAdminKey(credentials) {
  for (let index = 0; index < ADMIN_REFS.length; index++) {
    let resolved;
    try { resolved = await credentials.resolve(ADMIN_REFS[index]); }
    catch { fail('admin-credential-error'); }
    if (!resolved?.value) continue;
    validate(resolved.value);
    return { configured: true, source: index === 0 ? 'credential-store' : 'credential-ref' };
  }
  return { configured: false, source: null };
}
