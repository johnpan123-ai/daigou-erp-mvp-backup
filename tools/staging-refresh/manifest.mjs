import { createHash, randomUUID } from 'node:crypto';
import {
  LOGICAL_RELATIONSHIPS,
  SNAPSHOT_SCHEMA_CONTRACT_VERSION,
  TABLE_KEY_COLUMNS,
  assertNoSecrets,
  assertPiiMode,
  classifyPublicTables,
} from './policy.mjs';

export const SNAPSHOT_FORMAT_VERSION = 1;

const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
};

export const stableStringify = value => JSON.stringify(canonicalize(value));
export const sha256 = value => createHash('sha256').update(
  typeof value === 'string' ? value : stableStringify(value),
).digest('hex');

const rowKey = (table, row) => {
  const columns = TABLE_KEY_COLUMNS[table] || ['id'];
  return columns.map(column => String(row?.[column] ?? '')).join('::');
};

const sortedRows = (table, rows) => [...rows].sort((left, right) => (
  rowKey(table, left).localeCompare(rowKey(table, right))
));

const relationName = ([childTable, childColumn, parentTable, parentColumn]) => (
  `${childTable}.${childColumn}->${parentTable}.${parentColumn}`
);

const buildRelationshipState = data => Object.fromEntries(LOGICAL_RELATIONSHIPS
  .filter(([childTable, , parentTable]) => data[childTable] && data[parentTable])
  .map(relation => {
    const [childTable, childColumn, parentTable, parentColumn] = relation;
    const parentIds = new Set(data[parentTable].map(row => String(row[parentColumn] ?? '')));
    const pairs = [];
    const orphanRowKeys = [];
    for (const row of data[childTable]) {
      const foreignValue = row[childColumn];
      if (foreignValue === null || foreignValue === undefined || foreignValue === '') continue;
      const pair = `${rowKey(childTable, row)}=>${String(foreignValue)}`;
      pairs.push(pair);
      if (!parentIds.has(String(foreignValue))) orphanRowKeys.push(rowKey(childTable, row));
    }
    pairs.sort();
    orphanRowKeys.sort();
    return [relationName(relation), {
      relationshipHash: sha256(pairs),
      orphanCount: orphanRowKeys.length,
      orphanRowKeys,
      orphanRowKeysHash: sha256(orphanRowKeys),
    }];
  }));

const duplicateValues = (rows, column) => {
  const seen = new Set();
  const duplicates = new Set();
  for (const row of rows) {
    const value = row?.[column];
    if (value === null || value === undefined || value === '') continue;
    const normalized = String(value);
    if (seen.has(normalized)) duplicates.add(normalized);
    seen.add(normalized);
  }
  return [...duplicates].sort();
};

const unknownProductIds = data => [
  ...(data.product_groups || []).filter(row => String(row.title || '').trim().toLowerCase() === 'unknown product'),
  ...(data.product_variants || []).filter(row => String(row.product_title || '').trim().toLowerCase() === 'unknown product'),
].map(row => String(row.id || row.local_id || '')).filter(Boolean).sort();

const identityProjection = data => ({
  productGroups: sortedRows('product_groups', data.product_groups || []).map(row => ({
    id: row.id ?? null,
    local_id: row.local_id ?? null,
  })),
  productVariants: sortedRows('product_variants', data.product_variants || []).map(row => ({
    id: row.id ?? null,
    local_id: row.local_id ?? null,
    product_group_id: row.product_group_id ?? null,
    product_category_id: row.product_category_id ?? null,
    myacg_item_code: row.myacg_item_code ?? null,
    sku: row.sku ?? null,
    raw_variant_name: row.raw_variant_name ?? null,
  })),
});

const FOREIGN_KEY_ACTIONS = Object.freeze({
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
});
const NORMALIZED_FOREIGN_KEY_ACTIONS = new Set(Object.values(FOREIGN_KEY_ACTIONS));

const normalizeForeignKeyAction = value => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().replace(/\s+/g, ' ').toUpperCase();
  return FOREIGN_KEY_ACTIONS[normalized.toLowerCase()] || normalized;
};

const schemaContractUnsupported = () => {
  throw new Error('SNAPSHOT_SCHEMA_CONTRACT_UNSUPPORTED');
};

export function assertSnapshotSchemaContract(schema) {
  const evidence = schema?.schemaContract;
  const foreignKeys = schema?.foreignKeys;
  const primaryUniqueConstraints = schema?.constraints;
  if (evidence?.version !== SNAPSHOT_SCHEMA_CONTRACT_VERSION
      || evidence?.foreignKeysComplete !== true
      || !Number.isSafeInteger(evidence?.foreignKeyConstraintCount)
      || evidence.foreignKeyConstraintCount < 0
      || !Number.isSafeInteger(evidence?.foreignKeyColumnCount)
      || evidence.foreignKeyColumnCount < 0
      || !Array.isArray(foreignKeys)
      || evidence.foreignKeyColumnCount !== foreignKeys.length
      || evidence?.primaryUniqueConstraintsComplete !== true
      || !Number.isSafeInteger(evidence?.primaryUniqueConstraintCount)
      || evidence.primaryUniqueConstraintCount < 0
      || !Number.isSafeInteger(evidence?.primaryUniqueConstraintColumnCount)
      || evidence.primaryUniqueConstraintColumnCount < 0
      || !Array.isArray(primaryUniqueConstraints)
      || evidence.primaryUniqueConstraintColumnCount !== primaryUniqueConstraints.length) {
    schemaContractUnsupported();
  }

  const constraints = new Map();
  for (const reference of foreignKeys) {
    const requiredStrings = [
      reference.constraintName,
      reference.childSchema,
      reference.childTable,
      reference.childColumn,
      reference.parentSchema,
      reference.parentTable,
      reference.parentColumn,
    ];
    const onDelete = normalizeForeignKeyAction(reference.onDelete);
    const onUpdate = normalizeForeignKeyAction(reference.onUpdate);
    if (requiredStrings.some(value => typeof value !== 'string' || value.length === 0)
        || !Number.isSafeInteger(reference.ordinalPosition)
        || reference.ordinalPosition < 1
        || !NORMALIZED_FOREIGN_KEY_ACTIONS.has(onDelete)
        || !NORMALIZED_FOREIGN_KEY_ACTIONS.has(onUpdate)
        || reference.onDelete !== onDelete
        || reference.onUpdate !== onUpdate
        || typeof reference.validated !== 'boolean') {
      schemaContractUnsupported();
    }

    const constraintKey = `${reference.childSchema}.${reference.constraintName}`;
    const contract = constraints.get(constraintKey) || {
      identity: stableStringify({
        childSchema: reference.childSchema,
        childTable: reference.childTable,
        parentSchema: reference.parentSchema,
        parentTable: reference.parentTable,
        onDelete,
        onUpdate,
        validated: reference.validated,
      }),
      ordinals: [],
    };
    if (contract.identity !== stableStringify({
      childSchema: reference.childSchema,
      childTable: reference.childTable,
      parentSchema: reference.parentSchema,
      parentTable: reference.parentTable,
      onDelete,
      onUpdate,
      validated: reference.validated,
    })) {
      schemaContractUnsupported();
    }
    contract.ordinals.push(reference.ordinalPosition);
    constraints.set(constraintKey, contract);
  }

  if (constraints.size !== evidence.foreignKeyConstraintCount) schemaContractUnsupported();
  for (const contract of constraints.values()) {
    const ordinals = [...contract.ordinals].sort((left, right) => left - right);
    if (ordinals.some((ordinal, index) => ordinal !== index + 1)) schemaContractUnsupported();
  }

  const primaryUniqueConstraintContracts = new Map();
  for (const constraint of primaryUniqueConstraints) {
    const requiredStrings = [
      constraint.tableName,
      constraint.constraintName,
      constraint.columnName,
    ];
    if (requiredStrings.some(value => typeof value !== 'string' || value.length === 0)
        || !['PRIMARY KEY', 'UNIQUE'].includes(constraint.constraintType)
        || !Number.isSafeInteger(constraint.ordinalPosition)
        || constraint.ordinalPosition < 1) {
      schemaContractUnsupported();
    }

    const constraintKey = `${constraint.tableName}.${constraint.constraintName}`;
    const contract = primaryUniqueConstraintContracts.get(constraintKey) || {
      constraintType: constraint.constraintType,
      ordinals: [],
    };
    if (contract.constraintType !== constraint.constraintType) schemaContractUnsupported();
    contract.ordinals.push(constraint.ordinalPosition);
    primaryUniqueConstraintContracts.set(constraintKey, contract);
  }

  if (primaryUniqueConstraintContracts.size !== evidence.primaryUniqueConstraintCount) {
    schemaContractUnsupported();
  }
  for (const contract of primaryUniqueConstraintContracts.values()) {
    const ordinals = [...contract.ordinals].sort((left, right) => left - right);
    if (ordinals.some((ordinal, index) => ordinal !== index + 1)) schemaContractUnsupported();
  }
  return schema;
}

const foreignKeyContractProjection = schema => (schema.foreignKeys || [])
  .map(reference => ({
    constraintName: reference.constraintName ?? null,
    childSchema: reference.childSchema ?? null,
    childTable: reference.childTable,
    childColumn: reference.childColumn,
    parentSchema: reference.parentSchema,
    parentTable: reference.parentTable,
    parentColumn: reference.parentColumn,
    ordinalPosition: reference.ordinalPosition ?? null,
    onDelete: normalizeForeignKeyAction(reference.onDelete),
    onUpdate: normalizeForeignKeyAction(reference.onUpdate),
    validated: typeof reference.validated === 'boolean' ? reference.validated : null,
  }))
  .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));

// PostgreSQL ALTER TABLE appends new columns and has no safe in-place column
// reorder. The restore contract addresses JSON fields by name, and
// assertSchemaCompatible already compares the complete column definition by
// name. Keep the manifest fingerprint equally strict while making catalog array
// order deterministic; constraint ordinalPosition remains part of each entry.
const schemaFingerprintProjection = schema => ({
  columns: [...(schema.columns || [])]
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
  foreignKeys: foreignKeyContractProjection(schema),
  constraints: [...(schema.constraints || [])]
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
});

export function createSnapshotEnvelope({ sourceProjectRef, schema, data, piiMode = 'internal-preserve', capturedAt, snapshotId }) {
  assertPiiMode(piiMode);
  assertNoSecrets(data);
  assertSnapshotSchemaContract(schema);
  const envelope = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    schemaContractVersion: SNAPSHOT_SCHEMA_CONTRACT_VERSION,
    snapshotId: snapshotId || randomUUID(),
    sourceProjectRef,
    capturedAt: capturedAt || new Date().toISOString(),
    piiMode,
    schema: canonicalize(schema),
    data: Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, sortedRows(table, rows)])),
  };
  return { ...envelope, snapshotHash: sha256(envelope) };
}

export function validateSnapshotEnvelope(snapshot) {
  if (!snapshot || snapshot.formatVersion !== SNAPSHOT_FORMAT_VERSION) throw new Error('SNAPSHOT_FORMAT_UNSUPPORTED');
  if (snapshot.schemaContractVersion !== SNAPSHOT_SCHEMA_CONTRACT_VERSION) schemaContractUnsupported();
  assertSnapshotSchemaContract(snapshot.schema);
  const { snapshotHash, ...unsigned } = snapshot;
  if (sha256(unsigned) !== snapshotHash) throw new Error('SNAPSHOT_HASH_MISMATCH');
  assertNoSecrets(snapshot.data);
  assertPiiMode(snapshot.piiMode);
  return snapshot;
}

export function buildSnapshotManifest(snapshot) {
  validateSnapshotEnvelope(snapshot);
  const classification = classifyPublicTables(snapshot.schema.publicTables || Object.keys(snapshot.data));
  const tables = Object.fromEntries(Object.entries(snapshot.data).map(([table, rows]) => {
    const keys = sortedRows(table, rows).map(row => rowKey(table, row));
    return [table, {
      count: rows.length,
      keyColumns: TABLE_KEY_COLUMNS[table] || ['id'],
      idSetHash: sha256([...keys].sort()),
      rowHash: sha256(sortedRows(table, rows)),
    }];
  }));
  const variantRows = snapshot.data.product_variants || [];
  const duplicateVariantIds = duplicateValues(variantRows, 'id');
  const duplicateVariantLocalIds = duplicateValues(variantRows, 'local_id');
  const unknownIds = unknownProductIds(snapshot.data);
  const catalogMissingIds = variantRows
    .filter(row => row.catalog_missing === true)
    .map(row => String(row.id || row.local_id || ''))
    .filter(Boolean)
    .sort();
  const missingLocalIdIds = variantRows
    .filter(row => !row.local_id)
    .map(row => String(row.id || ''))
    .filter(Boolean)
    .sort();
  const relationships = buildRelationshipState(snapshot.data);
  const manifest = {
    formatVersion: snapshot.formatVersion,
    schemaContractVersion: snapshot.schemaContractVersion,
    snapshotId: snapshot.snapshotId,
    sourceProjectRef: snapshot.sourceProjectRef,
    capturedAt: snapshot.capturedAt,
    piiMode: snapshot.piiMode,
    snapshotHash: snapshot.snapshotHash,
    schemaFingerprint: sha256(schemaFingerprintProjection(snapshot.schema)),
    schemaClassification: classification,
    tables,
    relationships,
    productVariantIdentityHash: sha256(identityProjection(snapshot.data)),
    anomalies: {
      unknownProduct: { count: unknownIds.length, ids: unknownIds, hash: sha256(unknownIds) },
      duplicateVariantId: { count: duplicateVariantIds.length, ids: duplicateVariantIds, hash: sha256(duplicateVariantIds) },
      duplicateVariantLocalId: { count: duplicateVariantLocalIds.length, ids: duplicateVariantLocalIds, hash: sha256(duplicateVariantLocalIds) },
      catalogMissing: { count: catalogMissingIds.length, ids: catalogMissingIds, hash: sha256(catalogMissingIds) },
      missingVariantLocalId: { count: missingLocalIdIds.length, ids: missingLocalIdIds, hash: sha256(missingLocalIdIds) },
    },
  };
  return { ...manifest, manifestHash: sha256(manifest) };
}

export function compareManifests(expected, actual) {
  const differences = [];
  const check = (label, left, right) => {
    if (stableStringify(left) !== stableStringify(right)) differences.push(label);
  };
  check('schemaFingerprint', expected.schemaFingerprint, actual.schemaFingerprint);
  check('schemaContractVersion', expected.schemaContractVersion, actual.schemaContractVersion);
  check('tables', expected.tables, actual.tables);
  check('relationships', expected.relationships, actual.relationships);
  check('productVariantIdentityHash', expected.productVariantIdentityHash, actual.productVariantIdentityHash);
  check('anomalies', expected.anomalies, actual.anomalies);
  return { accepted: differences.length === 0, differences, newAnomalyDelta: differences.some(item => item === 'relationships' || item === 'anomalies') ? 'NON_ZERO' : 0 };
}

export function assertSchemaCompatible(sourceSchema, targetSchema, tables) {
  assertSnapshotSchemaContract(sourceSchema);
  assertSnapshotSchemaContract(targetSchema);
  const columnsFor = (schema, table) => (schema.columns || [])
    .filter(column => column.tableName === table)
    .map(column => ({
      columnName: column.columnName,
      dataType: column.dataType,
      udtName: column.udtName,
      nullable: column.nullable,
      defaultValue: column.defaultValue ?? null,
      generated: column.generated ?? null,
      identityGeneration: column.identityGeneration ?? null,
    }))
    .sort((left, right) => left.columnName.localeCompare(right.columnName));
  const relationsFor = schema => foreignKeyContractProjection(schema)
    .filter(reference => tables.includes(reference.childTable))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  const constraintsFor = schema => (schema.constraints || [])
    .filter(constraint => tables.includes(constraint.tableName))
    .map(constraint => ({
      tableName: constraint.tableName,
      constraintName: constraint.constraintName,
      constraintType: constraint.constraintType,
      columnName: constraint.columnName,
      ordinalPosition: constraint.ordinalPosition,
    }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  const mismatches = [];
  for (const table of tables) {
    if (stableStringify(columnsFor(sourceSchema, table)) !== stableStringify(columnsFor(targetSchema, table))) {
      mismatches.push(table);
    }
  }
  if (stableStringify(relationsFor(sourceSchema)) !== stableStringify(relationsFor(targetSchema))) {
    mismatches.push('foreign_keys');
  }
  if (stableStringify(constraintsFor(sourceSchema)) !== stableStringify(constraintsFor(targetSchema))) {
    mismatches.push('constraints');
  }
  if (mismatches.length) throw new Error(`SCHEMA_MISMATCH:${mismatches.join(',')}`);
  return true;
}

export function applyAuthAttributionPolicy(snapshot, targetSchema, policy) {
  const clone = structuredClone(snapshot);
  const authReferences = (targetSchema.foreignKeys || []).filter(reference => (
    reference.parentSchema === 'auth' && reference.parentTable === 'users'
  ));
  for (const reference of authReferences) {
    if (!clone.data[reference.childTable]) continue;
    const column = (targetSchema.columns || []).find(candidate => (
      candidate.tableName === reference.childTable && candidate.columnName === reference.childColumn
    ));
    if (policy.mode === 'null') {
      if (!column?.nullable) throw new Error(`AUTH_ATTRIBUTION_NOT_NULLABLE:${reference.childTable}.${reference.childColumn}`);
      clone.data[reference.childTable] = clone.data[reference.childTable].map(row => ({ ...row, [reference.childColumn]: null }));
    } else if (policy.mode === 'staging-actor') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(policy.actorId || '')) {
        throw new Error('STAGING_ACTOR_UUID_INVALID');
      }
      clone.data[reference.childTable] = clone.data[reference.childTable].map(row => ({ ...row, [reference.childColumn]: policy.actorId }));
    } else {
      throw new Error('AUTH_ATTRIBUTION_POLICY_REQUIRED');
    }
  }
  const { snapshotHash: _discardedHash, ...unsigned } = clone;
  return { ...unsigned, snapshotHash: sha256(unsigned) };
}
