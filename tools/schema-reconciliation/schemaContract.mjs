import { createHash } from 'node:crypto';
import {
  isEnvironmentLocalFunction,
  isEnvironmentLocalPolicy,
} from './liveSchemaReconciliationRegistry.mjs';

export const SCHEMA_SNAPSHOT_CONTRACT_VERSION = 1;
export const SCHEMA_FINGERPRINT_CONTRACT_VERSION = 2;

const TRANSIENT_KEYS = new Set([
  'capturedAt', 'rowEstimate', 'rowCounts', 'integrity', 'migrationHistory',
]);
const ENVIRONMENT_LOCAL_KEYS = new Set([
  'owner', 'oid', 'tableOid', 'functionOid', 'relationOid', 'namespaceOid',
]);
const SQL_VALUE_KEYS = /definition|default|expression|qual|using|withCheck|check|config/iu;
const LEGACY_SQL_VALUE_KEYS = /definition|default|expression|qual|check|config/iu;

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');

/**
 * Normalize catalog-rendered SQL without changing quoted string or identifier
 * content. PostgreSQL may change whitespace and keyword case between versions;
 * those presentation differences are not schema drift.
 */
const normalizeSql = value => {
  const source = String(value ?? '').replace(/\r\n?/gu, '\n');
  let result = '';
  let quote = null;
  let pendingSpace = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      result += character;
      if (character === quote) {
        if (source[index + 1] === quote) {
          result += source[index + 1];
          index += 1;
        } else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      if (pendingSpace && result && !/[\s(,=]$/u.test(result)) result += ' ';
      pendingSpace = false;
      quote = character;
      result += character;
      continue;
    }
    if (/\s/u.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (/[(),=]/u.test(character)) {
      result = result.replace(/\s+$/u, '');
      result += character;
      pendingSpace = false;
      continue;
    }
    if (pendingSpace && result && !/[\s(,=]$/u.test(result)) result += ' ';
    pendingSpace = false;
    result += character.toLowerCase();
  }
  return result.trim().replace(/\bextensions\.digest\b/giu, 'digest');
};

// Exact fingerprint-v2 normalizer used before the reconciliation contract.
// Kept only so the original 170-item evidence can be classified reproducibly.
const normalizeObservedSqlV2 = value => {
  const source = String(value ?? '');
  let result = '';
  let quote = null;
  let pendingSpace = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      result += character;
      if (character === quote) {
        if (source[index + 1] === quote) {
          result += source[index + 1];
          index += 1;
        } else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      if (pendingSpace && result && !/[\s(,=]$/u.test(result)) result += ' ';
      pendingSpace = false;
      quote = character;
      result += character;
      continue;
    }
    if (/\s/u.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (/[(),=]/u.test(character)) {
      result = result.replace(/\s+$/u, '');
      result += character;
      pendingSpace = false;
      continue;
    }
    if (pendingSpace && result && !/[\s(,=]$/u.test(result)) result += ' ';
    pendingSpace = false;
    result += character.toLowerCase();
  }
  return result.trim();
};

// Migration-condition matching keeps its historical normalization contract.
// Fingerprint v2 deliberately uses the quote-aware normalizer above instead.
const normalizeConditionSql = value => String(value ?? '')
  .replace(/\s+/gu, ' ')
  .replace(/\s*([(),=])\s*/gu, '$1')
  .trim()
  .toLowerCase();

const shouldSortArray = path => {
  const key = path.at(-1) ?? '';
  return key === 'schemas' || key === 'constraints' || key === 'uniques'
    || key === 'roles' || key === 'config' || path.includes('grants');
};

const canonicalizeValue = (value, key = '', path = []) => {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && LEGACY_SQL_VALUE_KEYS.test(key) ? normalizeConditionSql(value) : value;
  }
  if (Array.isArray(value)) {
    const normalized = value.map(item => canonicalizeValue(item));
    return normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  return Object.fromEntries(Object.keys(value).sort().filter(name => !TRANSIENT_KEYS.has(name)).map(name => [
    name,
    canonicalizeValue(value[name], name, [...path, name]),
  ]));
};

const canonicalizeConstraintArray = value => value
  .filter(item => item?.type !== 'n')
  .map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const { name: _catalogName, ...semantic } = item;
    return semantic;
  });

const canonicalizeSemanticValue = (value, key = '', path = []) => {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && SQL_VALUE_KEYS.test(key) ? normalizeSql(value) : value;
  }
  if (Array.isArray(value)) {
    const projected = key === 'constraints' ? canonicalizeConstraintArray(value) : value;
    const normalized = projected.map(item => canonicalizeSemanticValue(item, key, path));
    return shouldSortArray(path)
      ? normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : normalized;
  }
  return Object.fromEntries(Object.keys(value).sort()
    .filter(name => !TRANSIENT_KEYS.has(name) && !ENVIRONMENT_LOCAL_KEYS.has(name))
    .map(name => [name, canonicalizeSemanticValue(value[name], name, [...path, name])]));
};

const canonicalizeObservedSemanticValueV2 = (value, key = '', path = []) => {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && SQL_VALUE_KEYS.test(key) ? normalizeObservedSqlV2(value) : value;
  }
  if (Array.isArray(value)) {
    const normalized = value.map(item => canonicalizeObservedSemanticValueV2(item, key, path));
    return shouldSortArray(path)
      ? normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : normalized;
  }
  return Object.fromEntries(Object.keys(value).sort()
    .filter(name => !TRANSIENT_KEYS.has(name) && !ENVIRONMENT_LOCAL_KEYS.has(name))
    .map(name => [name, canonicalizeObservedSemanticValueV2(value[name], name, [...path, name])]));
};

const reconciliationProjection = snapshot => {
  const projected = structuredClone(snapshot);
  for (const signature of Object.keys(projected.functions ?? {})) {
    if (isEnvironmentLocalFunction(signature)) delete projected.functions[signature];
  }
  if (projected.functions?.['public.handle_new_user()']) {
    delete projected.functions['public.handle_new_user()'].definition;
  }
  for (const [tableName, table] of Object.entries(projected.tables ?? {})) {
    for (const policyName of Object.keys(table.policies ?? {})) {
      if (isEnvironmentLocalPolicy(policyName)) delete table.policies[policyName];
    }
    if (tableName !== 'public.dashboard_category_images') continue;
    delete table.columns?.local_id;
    delete table.columns?.version;
    delete table.indexes?.['public.idx_dashboard_category_images_deleted_at'];
    if (table.policies?.select_policy) delete table.policies.select_policy.roles;
    if (table.policies?.delete_policy) delete table.policies.delete_policy.using;
    if (table.policies?.insert_policy) delete table.policies.insert_policy.withCheck;
    if (table.policies?.update_policy) {
      delete table.policies.update_policy.using;
      delete table.policies.update_policy.withCheck;
    }
  }
  return projected;
};

/** The only canonical projection used for schema fingerprints. */
export const canonicalizeStructuralSnapshot = snapshot => {
  if (snapshot?.contractVersion !== SCHEMA_SNAPSHOT_CONTRACT_VERSION) {
    throw new Error('SCHEMA_SNAPSHOT_CONTRACT_UNSUPPORTED');
  }
  const projected = reconciliationProjection(snapshot);
  return canonicalizeSemanticValue({
    snapshotContractVersion: snapshot.contractVersion,
    fingerprintContractVersion: SCHEMA_FINGERPRINT_CONTRACT_VERSION,
    schemas: projected.schemas ?? [],
    tables: projected.tables ?? {},
    functions: projected.functions ?? {},
  });
};

// Frozen pre-reconciliation projection used only to classify the 2026-09-30
// evidence set. It must not be used for promotion fingerprints.
export const canonicalizeObservedStructuralSnapshotV2 = snapshot => {
  if (snapshot?.contractVersion !== SCHEMA_SNAPSHOT_CONTRACT_VERSION) {
    throw new Error('SCHEMA_SNAPSHOT_CONTRACT_UNSUPPORTED');
  }
  return canonicalizeObservedSemanticValueV2({
    snapshotContractVersion: snapshot.contractVersion,
    fingerprintContractVersion: SCHEMA_FINGERPRINT_CONTRACT_VERSION,
    schemas: snapshot.schemas ?? [],
    tables: snapshot.tables ?? {},
    functions: snapshot.functions ?? {},
  });
};

export const stableJson = value => JSON.stringify(canonicalizeValue(value));

export const fingerprintStructuralSnapshot = snapshot => createHash('sha256')
  .update(JSON.stringify(canonicalizeStructuralSnapshot(snapshot)))
  .digest('hex');

/** Evidence-only compatibility for snapshots hashed before fingerprint contract v2. */
export const fingerprintLegacyStructuralSnapshotV1 = snapshot => {
  if (snapshot?.contractVersion !== SCHEMA_SNAPSHOT_CONTRACT_VERSION) {
    throw new Error('SCHEMA_SNAPSHOT_CONTRACT_UNSUPPORTED');
  }
  return createHash('sha256').update(JSON.stringify(canonicalizeValue({
    contractVersion: snapshot.contractVersion,
    schemas: snapshot.schemas ?? [],
    tables: snapshot.tables ?? {},
    functions: snapshot.functions ?? {},
  }))).digest('hex');
};

export const fingerprintValue = value => createHash('sha256')
  .update(stableJson(value))
  .digest('hex');

export const normalizeDefinition = normalizeConditionSql;

const summarized = value => {
  if (value === undefined) return { state: 'ABSENT' };
  const serialized = JSON.stringify(value);
  if (serialized.length <= 240) return value;
  return { sha256: sha256(serialized), bytes: Buffer.byteLength(serialized) };
};

const semanticCategory = path => {
  if (path[0] === 'schemas') return 'SCHEMA';
  if (path[0] === 'tables') {
    if (path.length <= 2) return 'TABLE';
    if (path[2] === 'columns') return path.at(-1) === 'dataType' ? 'COLUMN_TYPE'
      : path.at(-1) === 'default' ? 'COLUMN_DEFAULT' : 'COLUMN';
    if (path[2] === 'primaryKey') return 'PRIMARY_KEY';
    if (path[2] === 'constraints') return path.some(value => value === 'referencedTable'
      || value === 'referencedColumns') ? 'FOREIGN_KEY' : 'CONSTRAINT';
    if (path[2] === 'indexes') return 'INDEX';
    if (path[2] === 'triggers') return 'TRIGGER';
    if (path[2] === 'policies' || path[2] === 'rls' || path[2] === 'forceRls') return 'RLS_POLICY';
    if (path[2] === 'grants') return 'TABLE_GRANT';
    return 'TABLE_STRUCTURE';
  }
  if (path[0] === 'functions') {
    if (path.at(-1)?.includes('Execute')) return 'FUNCTION_ACL';
    if (path.at(-1) === 'definition') return 'FUNCTION_DEFINITION';
    return 'FUNCTION';
  }
  return 'STRUCTURAL';
};

const collectDifferences = (before, after, path = [], result = []) => {
  if (JSON.stringify(before) === JSON.stringify(after)) return result;
  if (before === undefined || after === undefined || before === null || after === null
    || typeof before !== 'object' || typeof after !== 'object'
    || Array.isArray(before) || Array.isArray(after)) {
    result.push({ path: path.join('.'), category: semanticCategory(path), before: summarized(before), after: summarized(after) });
    return result;
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) collectDifferences(before[key], after[key], [...path, key], result);
  return result;
};

const environmentProjection = snapshot => ({
  identity: snapshot?.identity ?? {},
  tableOwners: Object.fromEntries(Object.entries(snapshot?.tables ?? {}).map(([name, value]) => [name, value?.owner ?? null])),
  functionOwners: Object.fromEntries(Object.entries(snapshot?.functions ?? {}).map(([name, value]) => [name, value?.owner ?? null])),
});

const evidenceProjection = snapshot => ({
  capturedAt: snapshot?.capturedAt ?? null,
  completeness: snapshot?.completeness ?? null,
  migrationHistory: snapshot?.migrationHistory ?? null,
  integrity: snapshot?.integrity ?? null,
  rowCounts: snapshot?.rowCounts ?? null,
});

const collectNormalizationDifferences = (before, after, path = [], result = []) => {
  if (typeof before === 'string' && typeof after === 'string') {
    const key = path.at(-1) ?? '';
    if (before !== after && SQL_VALUE_KEYS.test(key) && normalizeSql(before) === normalizeSql(after)) {
      result.push({ path: path.join('.'), category: 'SQL_FORMATTING_ONLY' });
    }
    return result;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (shouldSortArray(path)
      && JSON.stringify(before) !== JSON.stringify(after)
      && JSON.stringify(canonicalizeSemanticValue(before, path.at(-1), path))
        === JSON.stringify(canonicalizeSemanticValue(after, path.at(-1), path))) {
      result.push({ path: path.join('.'), category: 'CATALOG_ORDER_ONLY' });
      return result;
    }
    for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
      collectNormalizationDifferences(before[index], after[index], [...path, String(index)], result);
    }
    return result;
  }
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (ENVIRONMENT_LOCAL_KEYS.has(key) || TRANSIENT_KEYS.has(key)) continue;
      collectNormalizationDifferences(before[key], after[key], [...path, key], result);
    }
  }
  return result;
};

export function diffStructuralSnapshots(beforeSnapshot, afterSnapshot) {
  const before = canonicalizeStructuralSnapshot(beforeSnapshot);
  const after = canonicalizeStructuralSnapshot(afterSnapshot);
  const semanticDifferences = collectDifferences(before, after);
  const environmentDifferences = collectDifferences(
    canonicalizeValue(environmentProjection(beforeSnapshot)),
    canonicalizeValue(environmentProjection(afterSnapshot)),
    ['environment'],
  ).map(item => ({ ...item, category: 'ENVIRONMENT_LOCAL' }));
  const evidenceDifferences = collectDifferences(
    canonicalizeValue(evidenceProjection(beforeSnapshot)),
    canonicalizeValue(evidenceProjection(afterSnapshot)),
    ['evidence'],
  ).map(item => ({ ...item, category: 'NON_STRUCTURAL_EVIDENCE' }));
  const normalizationDifferences = collectNormalizationDifferences(
    { schemas: beforeSnapshot.schemas ?? [], tables: beforeSnapshot.tables ?? {}, functions: beforeSnapshot.functions ?? {} },
    { schemas: afterSnapshot.schemas ?? [], tables: afterSnapshot.tables ?? {}, functions: afterSnapshot.functions ?? {} },
  );
  return {
    result: 'PASS',
    classification: semanticDifferences.length ? 'A_TRUE_LIVE_SCHEMA_DIFFERENCE'
      : 'B_CANONICALIZATION_OR_ENVIRONMENT_ONLY',
    beforeFingerprint: fingerprintStructuralSnapshot(beforeSnapshot),
    afterFingerprint: fingerprintStructuralSnapshot(afterSnapshot),
    semanticEqual: semanticDifferences.length === 0,
    semanticDifferences,
    normalizationDifferences,
    environmentDifferences,
    evidenceDifferences,
    excludedFromCanonicalFingerprint: [
      'owners', 'catalog OIDs', 'capturedAt', 'database/user/project identity',
      'server version', 'migration history', 'integrity and row-count evidence',
    ],
  };
}

export function diffObservedStructuralSnapshotsV2(beforeSnapshot, afterSnapshot) {
  const before = canonicalizeObservedStructuralSnapshotV2(beforeSnapshot);
  const after = canonicalizeObservedStructuralSnapshotV2(afterSnapshot);
  return collectDifferences(before, after);
}

export function reconcileFingerprintEvidence({ expectedSnapshot, currentSnapshot, expectedFingerprint }) {
  if (!currentSnapshot) throw new Error('CURRENT_SCHEMA_SNAPSHOT_REQUIRED');
  const currentFingerprint = fingerprintStructuralSnapshot(currentSnapshot);
  const currentLegacyFingerprintV1 = fingerprintLegacyStructuralSnapshotV1(currentSnapshot);
  if (!expectedSnapshot) {
    return {
      result: 'BLOCKED', status: 'OLD_SCHEMA_SNAPSHOT_REQUIRED',
      expectedFingerprint: expectedFingerprint ?? null, currentFingerprint,
      currentLegacyFingerprintV1,
      reason: 'A hash alone cannot identify structural differences; supply the exact old snapshot artifact.',
    };
  }
  const actualExpectedFingerprint = fingerprintStructuralSnapshot(expectedSnapshot);
  const actualExpectedLegacyFingerprintV1 = fingerprintLegacyStructuralSnapshotV1(expectedSnapshot);
  if (expectedFingerprint && actualExpectedFingerprint !== expectedFingerprint
    && actualExpectedLegacyFingerprintV1 !== expectedFingerprint) {
    throw new Error('OLD_SCHEMA_SNAPSHOT_FINGERPRINT_MISMATCH');
  }
  return {
    status: 'COMPARED',
    expectedFingerprintContract: expectedFingerprint === actualExpectedLegacyFingerprintV1
      ? 'V1_LEGACY_EVIDENCE' : 'V2_SEMANTIC',
    expectedLegacyFingerprintV1: actualExpectedLegacyFingerprintV1,
    currentLegacyFingerprintV1,
    ...diffStructuralSnapshots(expectedSnapshot, currentSnapshot),
  };
}

export function assertSnapshotShape(snapshot) {
  if (!snapshot || snapshot.contractVersion !== SCHEMA_SNAPSHOT_CONTRACT_VERSION
    || !snapshot.completeness || !snapshot.tables || !snapshot.functions) {
    throw new Error('SCHEMA_SNAPSHOT_INVALID');
  }
  return snapshot;
}
