import { createHash } from 'node:crypto';

export const SCHEMA_SNAPSHOT_CONTRACT_VERSION = 1;

const TRANSIENT_KEYS = new Set([
  'capturedAt', 'rowEstimate', 'rowCounts', 'integrity', 'migrationHistory',
]);

const normalizeSql = value => String(value ?? '')
  .replace(/\s+/gu, ' ')
  .replace(/\s*([(),=])\s*/gu, '$1')
  .trim()
  .toLowerCase();

const canonicalizeValue = (value, key = '') => {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && /definition|default|expression|qual|check|config/iu.test(key)
      ? normalizeSql(value)
      : value;
  }
  if (Array.isArray(value)) {
    const normalized = value.map(item => canonicalizeValue(item));
    return normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  return Object.fromEntries(Object.keys(value).sort().filter(name => !TRANSIENT_KEYS.has(name)).map(name => [
    name,
    canonicalizeValue(value[name], name),
  ]));
};

export const canonicalizeStructuralSnapshot = snapshot => {
  if (snapshot?.contractVersion !== SCHEMA_SNAPSHOT_CONTRACT_VERSION) {
    throw new Error('SCHEMA_SNAPSHOT_CONTRACT_UNSUPPORTED');
  }
  return canonicalizeValue({
    contractVersion: snapshot.contractVersion,
    schemas: snapshot.schemas ?? [],
    tables: snapshot.tables ?? {},
    functions: snapshot.functions ?? {},
  });
};

export const stableJson = value => JSON.stringify(canonicalizeValue(value));

export const fingerprintStructuralSnapshot = snapshot => createHash('sha256')
  .update(JSON.stringify(canonicalizeStructuralSnapshot(snapshot)))
  .digest('hex');

export const fingerprintValue = value => createHash('sha256')
  .update(stableJson(value))
  .digest('hex');

export const normalizeDefinition = normalizeSql;

export function assertSnapshotShape(snapshot) {
  if (!snapshot || snapshot.contractVersion !== SCHEMA_SNAPSHOT_CONTRACT_VERSION
    || !snapshot.completeness || !snapshot.tables || !snapshot.functions) {
    throw new Error('SCHEMA_SNAPSHOT_INVALID');
  }
  return snapshot;
}
