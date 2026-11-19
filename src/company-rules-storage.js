import { validateCompanyRulesCache } from './company-rules.js';

// rc.3 DomainFacility and DomainImpl use valueSchema.parse at the durable
// boundary. This plain JS schema adapter avoids a second zod/runtime dependency.
export const COMPANY_RULES_DOMAIN_SPEC = Object.freeze({
  name: 'provider-quota-company-rules',
  version: 1,
  tables: Object.freeze({ cache: Object.freeze({ valueSchema: Object.freeze({ parse: validateCompanyRulesCache }) }) }),
});
const unavailable = () => Object.assign(new Error('cache-unavailable'), { code: 'cache-unavailable' });

// Optional persistent derived-data cache only: no profile files, configuration,
// credentials, or backend handles are accessed directly. A broken/uncertain
// handle is retired for this adapter's entire lifetime, never reused.
export function createCompanyRulesCache(context) {
  let opening;
  let domain = null;
  let table = null;
  let failed = false;
  let closed = false;
  let releasing;
  let closing;
  const release = () => {
    if (releasing) return releasing;
    const handle = domain;
    domain = null;
    table = null;
    releasing = Promise.resolve().then(() => handle?.close()).catch(() => {});
    return releasing;
  };
  const disable = async () => { failed = true; await release(); };
  const open = async () => {
    if (closed || failed) return null;
    if (!opening) opening = (async () => {
      try {
        const facility = context.get('storageDomain');
        if (!facility || typeof facility.open !== 'function') { failed = true; return null; }
        const handle = await facility.open(COMPANY_RULES_DOMAIN_SPEC);
        domain = handle;
        if (closed || failed) { await release(); return null; }
        const cacheTable = handle.table('cache');
        if (!cacheTable || typeof cacheTable.get !== 'function' || typeof cacheTable.put !== 'function' || typeof handle.close !== 'function') throw unavailable();
        table = cacheTable;
        return cacheTable;
      } catch {
        await disable();
        return null;
      }
    })();
    return opening;
  };
  return {
    get persistent() { return Boolean(domain && table && !failed && !closed); },
    async read() {
      const cacheTable = await open();
      if (!cacheTable || closed || failed) return undefined;
      try {
        const value = cacheTable.get('current');
        return value === undefined ? undefined : validateCompanyRulesCache(value);
      } catch {
        await disable();
        throw unavailable();
      }
    },
    async write(value) {
      const validated = validateCompanyRulesCache(value);
      const cacheTable = await open();
      if (!cacheTable || closed || failed) throw unavailable();
      try {
        await cacheTable.put('current', validated);
      } catch {
        await disable();
        throw unavailable();
      }
    },
    close() {
      if (!closing) {
        closed = true;
        closing = Promise.resolve(opening).catch(() => {}).then(release);
      }
      return closing;
    },
  };
}
