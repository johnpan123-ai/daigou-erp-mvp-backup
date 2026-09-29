import { createHash } from 'node:crypto';
import { fingerprintStructuralSnapshot } from '../schema-reconciliation/schemaContract.mjs';

export const RECOVERY_BUNDLE_FORMAT_VERSION = 'erp2-pre-adoption-recovery-bundle-v1';
export const RECOVERY_KIND = 'PRE_ADOPTION_PARTIAL_STATE';
export const RECOVERY_COMPATIBILITY_VERSION = 'erp2-partial-through-044-v1';
export const PARTIAL_STATE_MIGRATIONS = Object.freeze({
  '018': 'APPLIED_COMMITTED',
  '044': 'APPLIED_COMMITTED',
  '045': 'FAILED_ROLLED_BACK',
  '018b': 'NOT_APPLIED',
  '045b': 'NOT_APPLIED',
  '046b': 'NOT_APPLIED',
  '047': 'NOT_APPLIED',
});
export const RETIREMENT_CONDITIONS = Object.freeze([
  'CANONICAL_FINGERPRINT_REACHED',
  'CLOUD_24_RESOURCE_BACKUP_PASS',
  'CLOUD_24_RESOURCE_RESTORE_VALIDATION_PASS',
  'BASELINE_ADOPTED',
]);

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;

export class RecoveryBundleValidationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'RecoveryBundleValidationError';
    this.code = code;
  }
}

const fail = (code, message = code) => { throw new RecoveryBundleValidationError(code, message); };
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, expected, code) => {
  if (!isRecord(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(code);
};
const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
};
export const stableRecoveryJson = value => JSON.stringify(canonicalize(value));
export const recoverySha256 = value => createHash('sha256').update(
  typeof value === 'string' ? value : stableRecoveryJson(value),
).digest('hex');

const normalizeRows = (value, code) => {
  if (!Array.isArray(value) || value.some(row => !isRecord(row))) fail(code);
  return value.map(row => canonicalize(row)).sort((left, right) => (
    stableRecoveryJson(left).localeCompare(stableRecoveryJson(right))
  ));
};

const resourceSets = contracts => {
  const core = contracts.durableResources.filter(row => row.restore === 'core-idb'
    && row.cloud !== 'import_batches' && !row.cloud.startsWith('waca_'));
  const supplement = contracts.durableResources.filter(row => row.restore === 'core-idb'
    && (row.cloud === 'import_batches' || row.cloud.startsWith('waca_')));
  const deadline = contracts.durableResources.filter(row => row.restore === 'deadline-sidecar');
  if (core.length !== 15 || supplement.length !== 8 || deadline.length !== 3) {
    fail('DURABLE_REGISTRY_PARTIAL_STATE_CONTRACT_MISMATCH');
  }
  return { core, supplement, deadline };
};

const normalizeTableSection = (input, resources, code) => {
  exactKeys(input, resources.map(row => row.cloud), `${code}_RESOURCE_COVERAGE`);
  return Object.fromEntries(resources.map(row => [row.cloud, normalizeRows(input[row.cloud], `${code}_${row.cloud}`)]));
};

const normalizeDeadline = (input, resources, contracts) => {
  exactKeys(input, resources.map(row => row.backupKey), 'RECOVERY_DEADLINE_RESOURCE_COVERAGE');
  const normalized = Object.fromEntries(resources.map(row => [
    row.backupKey,
    normalizeRows(input[row.backupKey], `RECOVERY_DEADLINE_${row.backupKey}`),
  ]));
  try { contracts.validateDeadlineDurableBackup(normalized); }
  catch { fail('RECOVERY_DEADLINE_INTEGRITY_FAILED'); }
  return normalized;
};

const assertInventoryIdentity = rows => {
  const ids = rows.map(row => String(row.id ?? '').toLowerCase());
  const keys = rows.map(row => String(row.inventory_key ?? ''));
  if (ids.some(value => !UUID.test(value)) || new Set(ids).size !== ids.length) {
    fail('RECOVERY_INVENTORY_UUID_IDENTITY_INVALID');
  }
  if (keys.some(value => !value) || new Set(keys).size !== keys.length) {
    fail('RECOVERY_INVENTORY_KEY_IDENTITY_INVALID');
  }
};

const assertCaptureEvidence = (evidence, inventoryRows) => {
  exactKeys(evidence, ['current_database', 'core_resource_count', 'inventory_integrity', 'partial_contract'],
    'RECOVERY_CAPTURE_EVIDENCE_INVALID');
  if (Number(evidence.core_resource_count) !== 15 || !evidence.current_database) {
    fail('RECOVERY_CAPTURE_CORE_CONTRACT_INVALID');
  }
  const inventory = evidence.inventory_integrity;
  exactKeys(inventory, ['rows', 'null_id', 'invalid_uuid', 'duplicate_id', 'null_inventory_key',
    'duplicate_inventory_key'], 'RECOVERY_CAPTURE_INVENTORY_EVIDENCE_INVALID');
  if (Number(inventory.rows) !== inventoryRows.length
    || ['null_id', 'invalid_uuid', 'duplicate_id', 'null_inventory_key', 'duplicate_inventory_key']
      .some(key => Number(inventory[key]) !== 0)) fail('RECOVERY_CAPTURE_INVENTORY_INTEGRITY_FAILED');
  const partial = evidence.partial_contract;
  exactKeys(partial, ['import_batches_present', 'waca_state_present', 'waca_validator_absent',
    'waca_recompute_absent', 'migration_ledger_absent'], 'RECOVERY_CAPTURE_PARTIAL_CONTRACT_INVALID');
  if (Object.values(partial).some(value => value !== true)) fail('RECOVERY_CAPTURE_PARTIAL_CONTRACT_FAILED');
};

const tableData = (cloudLegacyBackup, supplement, sets) => Object.fromEntries([
  ...sets.core.map(row => [row.cloud, cloudLegacyBackup.data[row.backupKey]]),
  ...sets.supplement.map(row => [row.cloud, supplement[row.cloud]]),
]);

const assertRelations = (tables, relations) => {
  const ids = new Map(Object.entries(tables).map(([table, rows]) => [
    table,
    new Set(rows.map(row => String(row.id ?? '').toLowerCase())),
  ]));
  for (const relation of relations.filter(row => row.kind === 'blocking')) {
    if (!tables[relation.childTable] || !tables[relation.parentTable]) continue;
    const parents = ids.get(relation.parentTable);
    for (const row of tables[relation.childTable]) {
      const value = String(row[relation.field] ?? '').toLowerCase();
      if (!value || !parents.has(value)) fail('RECOVERY_RELATIONSHIP_INTEGRITY_FAILED');
    }
  }
};

const assertWacaState = supplement => {
  const states = supplement.waca_state;
  if (states.length !== 1) fail('RECOVERY_WACA_STATE_REQUIRED');
  const state = states[0];
  if (String(state.id).toLowerCase() !== '00000000-0000-4000-8000-000000000001'
    || state.mode !== 'LEGACY_QUANTITY_ACTIVE'
    || !Number.isSafeInteger(Number(state.revision)) || Number(state.revision) < 0) {
    fail('RECOVERY_WACA_STATE_INVALID');
  }
};

const assertPartialSchema = snapshot => {
  const tables = snapshot?.tables ?? {};
  for (const table of ['public.import_batches', 'public.waca_orders', 'public.waca_order_items',
    'public.waca_mappings', 'public.waca_master_links', 'public.waca_import_batches',
    'public.waca_cutover_audit', 'public.waca_state']) {
    if (!tables[table]) fail('RECOVERY_PARTIAL_SCHEMA_RESOURCE_MISSING');
  }
  if (tables['public.erp_schema_migration_ledger']) fail('RECOVERY_PARTIAL_SCHEMA_HAS_047_LEDGER');
  const functionNames = Object.keys(snapshot?.functions ?? {});
  if (functionNames.some(name => name.includes('erp_cloud_restore_validate_waca_dataset')
    || name.includes('erp_cloud_restore_recompute_waca_quantities'))) {
    fail('RECOVERY_PARTIAL_SCHEMA_HAS_045_EFFECTS');
  }
  const inventory = tables['public.inventory_items'];
  if (!inventory || inventory.columns?.myacg_parent_product_id
    || Object.keys(inventory.indexes ?? {}).some(name => name.includes('parent_product'))) {
    fail('RECOVERY_PARTIAL_SCHEMA_HAS_046_EFFECTS');
  }
};

const resourceManifest = (cloudLegacyBackup, supplement, deadline, sets) => [
  ...sets.core.map(row => ({
    key: row.backupKey, table: row.cloud, section: 'cloudLegacyBackup.data',
    rowCount: cloudLegacyBackup.data[row.backupKey].length,
    checksum: recoverySha256(cloudLegacyBackup.data[row.backupKey]),
  })),
  ...sets.supplement.map(row => ({
    key: row.backupKey, table: row.cloud, section: 'partialStateSupplement',
    rowCount: supplement[row.cloud].length,
    checksum: recoverySha256(supplement[row.cloud]),
  })),
  ...sets.deadline.map(row => ({
    key: row.backupKey, table: row.cloud, section: 'deadlineSidecar',
    rowCount: deadline[row.backupKey].length,
    checksum: recoverySha256(deadline[row.backupKey]),
  })),
].sort((left, right) => `${left.section}:${left.key}`.localeCompare(`${right.section}:${right.key}`));

const unsignedBundle = bundle => ({
  manifest: Object.fromEntries(Object.entries(bundle.manifest).filter(([key]) => key !== 'bundleChecksum')),
  cloudLegacyBackup: bundle.cloudLegacyBackup,
  partialStateSupplement: bundle.partialStateSupplement,
  deadlineSidecar: bundle.deadlineSidecar,
  schemaEvidence: bundle.schemaEvidence,
});

export async function buildRecoveryBundle(input, contracts) {
  exactKeys(input, ['liveExport', 'deadlineSidecar', 'schemaSnapshot', 'identity',
    'queryChecksums', 'migrationSources'], 'RECOVERY_BUILD_INPUT_INVALID');
  const { liveExport, identity } = input;
  exactKeys(liveExport, ['exportContractVersion', 'recoveryKind', 'capturedAt', 'coreLegacySnapshot',
    'partialStateSupplement', 'captureEvidence'], 'RECOVERY_LIVE_EXPORT_INVALID');
  if (liveExport.exportContractVersion !== 1 || liveExport.recoveryKind !== RECOVERY_KIND) {
    fail('RECOVERY_LIVE_EXPORT_CONTRACT_UNSUPPORTED');
  }
  exactKeys(identity, ['sourceProjectRef', 'sourceEnvironmentRole', 'sourceGitHead', 'checkpoint',
    'canonicalTargetFingerprint'], 'RECOVERY_IDENTITY_INVALID');
  if (!identity.sourceProjectRef || !identity.sourceEnvironmentRole || !GIT_SHA.test(identity.sourceGitHead)
    || !identity.checkpoint || !SHA256.test(identity.canonicalTargetFingerprint)) fail('RECOVERY_IDENTITY_INVALID');

  const sets = resourceSets(contracts);
  const coreByTable = normalizeTableSection(liveExport.coreLegacySnapshot, sets.core, 'RECOVERY_CORE');
  const coreByCollection = Object.fromEntries(sets.core.map(row => [row.backupKey, coreByTable[row.cloud]]));
  const legacy = await contracts.buildLegacyCloudRestoreManifest(coreByCollection);
  if (!legacy || legacy.manifest.resourceCount !== 15 || legacy.manifest.orphanCount !== 0
    || legacy.manifest.duplicateCanonicalIdCount !== 0) fail('RECOVERY_CORE_LEGACY_SNAPSHOT_INVALID');
  assertInventoryIdentity(coreByTable.inventory_items);
  assertCaptureEvidence(liveExport.captureEvidence, coreByTable.inventory_items);
  const cloudLegacyBackup = {
    schemaVersion: 'cloud-erp-snapshot-v1',
    sourceEnvironment: 'cloud-authoritative',
    manifest: legacy.manifest,
    data: coreByCollection,
  };
  const supplement = normalizeTableSection(liveExport.partialStateSupplement, sets.supplement, 'RECOVERY_SUPPLEMENT');
  const deadline = normalizeDeadline(input.deadlineSidecar, sets.deadline, contracts);
  assertWacaState(supplement);
  assertRelations(tableData(cloudLegacyBackup, supplement, sets), contracts.cloudRestoreRelations);

  const sourceFingerprint = fingerprintStructuralSnapshot(input.schemaSnapshot);
  assertPartialSchema(input.schemaSnapshot);
  if (!SHA256.test(sourceFingerprint)) fail('RECOVERY_SCHEMA_FINGERPRINT_INVALID');
  const migrationSources = [...input.migrationSources].map(row => ({ ...row }));
  if (migrationSources.length < 7 || migrationSources.some(row => !row.id || !row.file || !SHA256.test(row.checksum))) {
    fail('RECOVERY_MIGRATION_SOURCE_EVIDENCE_INVALID');
  }
  const queryChecksums = { ...input.queryChecksums };
  if (!SHA256.test(queryChecksums.structuralSnapshot) || !SHA256.test(queryChecksums.partialStateExport)) {
    fail('RECOVERY_QUERY_CHECKSUM_INVALID');
  }
  const schemaEvidence = {
    structuralSnapshot: canonicalize(input.schemaSnapshot),
    captureEvidence: canonicalize(liveExport.captureEvidence),
    sourceSchemaFingerprint: sourceFingerprint,
    canonicalTargetFingerprint: identity.canonicalTargetFingerprint,
    partialStateMigrations: { ...PARTIAL_STATE_MIGRATIONS },
    snapshotQueryChecksums: queryChecksums,
    migrationSources: migrationSources.sort((left, right) => left.id.localeCompare(right.id)),
  };
  const resources = resourceManifest(cloudLegacyBackup, supplement, deadline, sets);
  const sectionChecksums = {
    cloudLegacyBackup: recoverySha256(cloudLegacyBackup),
    partialStateSupplement: recoverySha256(supplement),
    deadlineSidecar: recoverySha256(deadline),
    schemaEvidence: recoverySha256(schemaEvidence),
  };
  const manifest = {
    formatVersion: RECOVERY_BUNDLE_FORMAT_VERSION,
    recoveryKind: RECOVERY_KIND,
    compatibilityVersion: RECOVERY_COMPATIBILITY_VERSION,
    createdAt: new Date().toISOString(),
    capturedAt: liveExport.capturedAt,
    sourceProjectRef: identity.sourceProjectRef,
    sourceEnvironmentRole: identity.sourceEnvironmentRole,
    sourceSchemaFingerprint: sourceFingerprint,
    canonicalTargetFingerprint: identity.canonicalTargetFingerprint,
    sourceGitHead: identity.sourceGitHead,
    checkpoint: identity.checkpoint,
    resources,
    totalRows: resources.reduce((sum, row) => sum + row.rowCount, 0),
    sectionChecksums,
    partialStateMigrations: { ...PARTIAL_STATE_MIGRATIONS },
    retirementConditions: [...RETIREMENT_CONDITIONS],
  };
  const bundle = { manifest, cloudLegacyBackup, partialStateSupplement: supplement, deadlineSidecar: deadline, schemaEvidence };
  bundle.manifest.bundleChecksum = recoverySha256(unsignedBundle(bundle));
  return bundle;
}

export async function verifyRecoveryBundle(bundle, contracts) {
  exactKeys(bundle, ['manifest', 'cloudLegacyBackup', 'partialStateSupplement', 'deadlineSidecar', 'schemaEvidence'],
    'RECOVERY_BUNDLE_TOP_LEVEL_INVALID');
  const manifestKeys = ['formatVersion', 'recoveryKind', 'compatibilityVersion', 'createdAt', 'capturedAt',
    'sourceProjectRef', 'sourceEnvironmentRole', 'sourceSchemaFingerprint', 'canonicalTargetFingerprint',
    'sourceGitHead', 'checkpoint', 'resources', 'totalRows', 'sectionChecksums', 'partialStateMigrations',
    'retirementConditions', 'bundleChecksum'];
  exactKeys(bundle.manifest, manifestKeys, 'RECOVERY_MANIFEST_INVALID');
  if (bundle.manifest.formatVersion !== RECOVERY_BUNDLE_FORMAT_VERSION
    || bundle.manifest.recoveryKind !== RECOVERY_KIND
    || bundle.manifest.compatibilityVersion !== RECOVERY_COMPATIBILITY_VERSION
    || !GIT_SHA.test(bundle.manifest.sourceGitHead)
    || !SHA256.test(bundle.manifest.sourceSchemaFingerprint)
    || !SHA256.test(bundle.manifest.canonicalTargetFingerprint)
    || !SHA256.test(bundle.manifest.bundleChecksum)
    || Number.isNaN(Date.parse(bundle.manifest.createdAt))
    || Number.isNaN(Date.parse(bundle.manifest.capturedAt))) fail('RECOVERY_MANIFEST_IDENTITY_INVALID');
  if (stableRecoveryJson(bundle.manifest.partialStateMigrations) !== stableRecoveryJson(PARTIAL_STATE_MIGRATIONS)) {
    fail('RECOVERY_PARTIAL_STATE_CLASSIFICATION_INVALID');
  }
  if (stableRecoveryJson(bundle.manifest.retirementConditions) !== stableRecoveryJson(RETIREMENT_CONDITIONS)) {
    fail('RECOVERY_RETIREMENT_CONTRACT_INVALID');
  }
  const sets = resourceSets(contracts);
  exactKeys(bundle.cloudLegacyBackup, ['schemaVersion', 'sourceEnvironment', 'manifest', 'data'],
    'RECOVERY_CORE_DOCUMENT_INVALID');
  if (bundle.cloudLegacyBackup.schemaVersion !== 'cloud-erp-snapshot-v1'
    || bundle.cloudLegacyBackup.sourceEnvironment !== 'cloud-authoritative') fail('RECOVERY_CORE_DOCUMENT_INVALID');
  const coreData = bundle.cloudLegacyBackup?.data;
  exactKeys(coreData, sets.core.map(row => row.backupKey), 'RECOVERY_CORE_RESOURCE_COVERAGE');
  const coreByTable = Object.fromEntries(sets.core.map(row => [row.cloud,
    normalizeRows(coreData[row.backupKey], `RECOVERY_CORE_${row.cloud}`)]));
  const supplement = normalizeTableSection(bundle.partialStateSupplement, sets.supplement, 'RECOVERY_SUPPLEMENT');
  const deadline = normalizeDeadline(bundle.deadlineSidecar, sets.deadline, contracts);
  assertInventoryIdentity(coreByTable.inventory_items);
  exactKeys(bundle.schemaEvidence, ['structuralSnapshot', 'captureEvidence', 'sourceSchemaFingerprint',
    'canonicalTargetFingerprint', 'partialStateMigrations', 'snapshotQueryChecksums', 'migrationSources'],
  'RECOVERY_SCHEMA_EVIDENCE_INVALID');
  assertCaptureEvidence(bundle.schemaEvidence.captureEvidence, coreByTable.inventory_items);
  if (bundle.schemaEvidence.canonicalTargetFingerprint !== bundle.manifest.canonicalTargetFingerprint
    || stableRecoveryJson(bundle.schemaEvidence.partialStateMigrations) !== stableRecoveryJson(PARTIAL_STATE_MIGRATIONS)
    || !SHA256.test(bundle.schemaEvidence.snapshotQueryChecksums?.structuralSnapshot)
    || !SHA256.test(bundle.schemaEvidence.snapshotQueryChecksums?.partialStateExport)
    || !Array.isArray(bundle.schemaEvidence.migrationSources)
    || bundle.schemaEvidence.migrationSources.length < 7
    || bundle.schemaEvidence.migrationSources.some(row => !row.id || !row.file || !SHA256.test(row.checksum))) {
    fail('RECOVERY_SCHEMA_EVIDENCE_INVALID');
  }
  assertWacaState(supplement);
  assertRelations(tableData(bundle.cloudLegacyBackup, supplement, sets), contracts.cloudRestoreRelations);
  const legacy = await contracts.buildLegacyCloudRestoreManifest(bundle.cloudLegacyBackup.data);
  if (!legacy || stableRecoveryJson(legacy.manifest) !== stableRecoveryJson(bundle.cloudLegacyBackup.manifest)) {
    fail('RECOVERY_CORE_LEGACY_MANIFEST_MISMATCH');
  }
  assertPartialSchema(bundle.schemaEvidence.structuralSnapshot);
  const fingerprint = fingerprintStructuralSnapshot(bundle.schemaEvidence.structuralSnapshot);
  if (fingerprint !== bundle.manifest.sourceSchemaFingerprint
    || fingerprint !== bundle.schemaEvidence.sourceSchemaFingerprint) fail('RECOVERY_SCHEMA_FINGERPRINT_MISMATCH');
  const resources = resourceManifest(bundle.cloudLegacyBackup, supplement, deadline, sets);
  if (stableRecoveryJson(resources) !== stableRecoveryJson(bundle.manifest.resources)
    || bundle.manifest.totalRows !== resources.reduce((sum, row) => sum + row.rowCount, 0)) {
    fail('RECOVERY_RESOURCE_MANIFEST_MISMATCH');
  }
  const sectionChecksums = {
    cloudLegacyBackup: recoverySha256(bundle.cloudLegacyBackup),
    partialStateSupplement: recoverySha256(bundle.partialStateSupplement),
    deadlineSidecar: recoverySha256(bundle.deadlineSidecar),
    schemaEvidence: recoverySha256(bundle.schemaEvidence),
  };
  if (stableRecoveryJson(sectionChecksums) !== stableRecoveryJson(bundle.manifest.sectionChecksums)) {
    fail('RECOVERY_SECTION_CHECKSUM_MISMATCH');
  }
  if (recoverySha256(unsignedBundle(bundle)) !== bundle.manifest.bundleChecksum) {
    fail('RECOVERY_BUNDLE_CHECKSUM_MISMATCH');
  }
  return {
    manifest: 'PASS', checksums: 'PASS', resourceCoverage: 'PASS', relationships: 'PASS',
    schemaCompatibility: 'PASS', wacaState: 'PASS', deadlineDurable: 'PASS',
    recoveryReady: 'YES', sourceSchemaFingerprint: fingerprint,
    resourceCount: resources.length, totalRows: bundle.manifest.totalRows,
  };
}
