import { createHash } from 'node:crypto';
import { canonicalSql } from './sqlCanonical.mjs';

// A retained implementation is an exact, source-reviewed function contract,
// not a name/substring exception. Preserve SQL literals and include owner/ACL.
const facts = ['owner', 'strict', 'language', 'parallel', 'leakproof', 'returnType',
  'volatility', 'securityDefiner', 'authenticatedExecute', 'anonExecute', 'publicExecute'];
export function fingerprintFunctionImplementation(fn) {
  if (!fn || facts.some(key => fn[key] === undefined)
    || typeof fn.definition !== 'string' || typeof fn.arguments !== 'string'
    || !Array.isArray(fn.config)) return null;
  try {
    const contract = Object.fromEntries(facts.map(key => [key, fn[key]]));
    contract.arguments = canonicalSql(fn.arguments);
    contract.config = [...fn.config].sort();
    contract.definition = canonicalSql(fn.definition);
    return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
  } catch { return null; }
}
