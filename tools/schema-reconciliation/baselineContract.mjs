import { fingerprintValue, SCHEMA_FINGERPRINT_CONTRACT_VERSION, SCHEMA_CANONICAL_CONTRACT,
  SQL_CANONICAL_ALGORITHM } from './schemaContract.mjs';

export const BASELINE_EVENT_TYPES = Object.freeze(['BASELINE_ADOPTED', 'MIGRATION_APPLIED']);
export const OPS_METADATA_CLASSIFICATION = 'ENVIRONMENT_LOCAL_NON_PORTABLE_OPS_METADATA';

const fullSha = value => /^[0-9a-f]{40}$/iu.test(value ?? '');
const fingerprint = value => /^[0-9a-f]{64}$/iu.test(value ?? '');

export function createBaselineAdoptionRecord({ plan, baselineId, sourceHead, checkpoint, environmentRole, projectRef }) {
  if (!plan?.readyForApply || plan.blockers?.length || !plan.currentFingerprint || !plan.expectedFingerprint
    || plan.fingerprintContractVersion !== SCHEMA_FINGERPRINT_CONTRACT_VERSION
    || plan.canonicalContract !== SCHEMA_CANONICAL_CONTRACT || plan.canonicalAlgorithm !== SQL_CANONICAL_ALGORITHM
    || plan.currentFingerprint !== plan.expectedFingerprint) throw new Error('BASELINE_ADOPTION_RECONCILIATION_REQUIRED');
  if (!baselineId || !fullSha(sourceHead) || !checkpoint?.startsWith('checkpoint-')
    || !environmentRole || !projectRef || !fingerprint(plan.currentFingerprint)) {
    throw new Error('BASELINE_ADOPTION_IDENTITY_INVALID');
  }
  const record = {
    eventType: 'BASELINE_ADOPTED', eventKey: baselineId,
    sourceChecksum: fingerprintValue(plan.migrations.map(item => ({
      migrationId: item.migrationId, sourceChecksum: item.sourceChecksum,
    }))),
    sourceHead, checkpoint, schemaFingerprintBefore: plan.currentFingerprint,
    schemaFingerprintAfter: plan.currentFingerprint, environmentRole, supabaseProjectRef: projectRef,
    result: 'PASS', metadata: {
      historicalMigrationExecutionClaimed: false,
      canonicalContract: SCHEMA_CANONICAL_CONTRACT,
      canonicalAlgorithm: SQL_CANONICAL_ALGORITHM,
      fingerprintContractVersion: SCHEMA_FINGERPRINT_CONTRACT_VERSION,
      verifiedMigrationEffects: plan.migrations.map(item => ({ migrationId: item.migrationId,
        sourceChecksum: item.sourceChecksum, state: item.state })),
      reconciliationEvidenceFingerprint: plan.evidenceFingerprint,
      classification: OPS_METADATA_CLASSIFICATION,
    },
  };
  return { ...record, evidenceFingerprint: fingerprintValue(record) };
}

export function createMigrationAppliedRecord({ migration, sourceHead, checkpoint, environmentRole, projectRef,
  fingerprintBefore, fingerprintAfter, metadata = {} }) {
  if (!migration?.migrationId || !fingerprint(migration.sourceChecksum) || !fullSha(sourceHead)
    || !checkpoint?.startsWith('checkpoint-') || !environmentRole || !projectRef
    || !fingerprint(fingerprintBefore) || !fingerprint(fingerprintAfter)) throw new Error('MIGRATION_EVENT_INVALID');
  return {
    eventType: 'MIGRATION_APPLIED', eventKey: migration.migrationId, sourceChecksum: migration.sourceChecksum,
    sourceHead, checkpoint, schemaFingerprintBefore: fingerprintBefore, schemaFingerprintAfter: fingerprintAfter,
    environmentRole, supabaseProjectRef: projectRef, result: 'PASS', metadata,
  };
}
