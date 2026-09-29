import { createHash } from 'node:crypto';

export const SCHEMA_EVIDENCE_CONTRACT_VERSION = 2;

const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
};

export const evidenceHash = value => createHash('sha256')
  .update(JSON.stringify(canonicalize(value)))
  .digest('hex');

export const migrationGuardProjection = migrations => migrations.map(item => ({
  migrationId: item.migrationId,
  sourceFile: item.sourceFile,
  sourceChecksum: item.sourceChecksum,
  canonicalOrder: item.canonicalOrder,
  state: item.state,
  safeToApply: item.safeToApply,
  dependencies: item.dependencies ?? [],
  dependencyBlocker: item.dependencyBlocker ?? null,
  repairClosure: item.repairClosure ?? null,
  repairs: item.repairs ?? [],
  coveredByRepair: item.coveredByRepair ?? null,
  applyMethod: item.applyMethod,
}));

export const applyPlanProjection = applyPlan => applyPlan.map(item => ({
  migrationId: item.migrationId,
  sourceFile: item.sourceFile,
  sourceChecksum: item.sourceChecksum,
  canonicalOrder: item.canonicalOrder,
  applyMethod: item.applyMethod,
}));

export const buildPlannerIdentity = evidence => evidenceHash({
  contractVersion: SCHEMA_EVIDENCE_CONTRACT_VERSION,
  migrations: migrationGuardProjection(evidence.migrations ?? []),
});

export const buildDeltaIdentity = evidence => evidenceHash({
  contractVersion: SCHEMA_EVIDENCE_CONTRACT_VERSION,
  currentFingerprint: evidence.currentFingerprint,
  expectedFingerprint: evidence.expectedFingerprint,
  targetAfterDeltaFingerprint: evidence.targetAfterDeltaFingerprint,
  applyPlan: applyPlanProjection(evidence.applyPlan ?? []),
});

export const buildSchemaEvidenceIdentity = evidence => {
  const { schemaEvidenceIdentity: _ignored, ...unsigned } = evidence;
  return evidenceHash(unsigned);
};

export function sealSchemaEvidence(evidence) {
  const sealed = {
    ...evidence,
    plannerIdentity: buildPlannerIdentity(evidence),
    deltaIdentity: buildDeltaIdentity(evidence),
  };
  return { ...sealed, schemaEvidenceIdentity: buildSchemaEvidenceIdentity(sealed) };
}
