import {
  CLOUD_RESTORE_TABLES,
  CloudRestoreValidationError,
  type CloudRestoreCandidate,
  type CloudRestoreManifest,
  type CloudRestoreTable,
} from './cloudAtomicRestore';

export const CLOUD_RESTORE_CANDIDATE_PROOF_RPC = 'erp_prove_cloud_restore_candidate' as const;
export const CLOUD_RESTORE_CANDIDATE_PROOF_SCHEMA = 'cloud-restore-candidate-proof-v1' as const;

export type CloudRestoreCandidateProofPolicy = 'strict' | 'cross-environment-audit-null-v1';

export interface CloudRestoreCandidateProofIntegrity {
  orphanCount: number;
  duplicateVariantIdCount: number;
  duplicateVariantLocalIdCount: number;
  duplicateCanonicalIdCount: number;
  canonicalIdentityAnomalyCount: number;
  unknownProductCount: number;
  optionalMetadataMissingReferenceCount: number;
  duplicateInventoryKeyCount: number;
  missingInventoryKeyCount: number;
}

export interface CloudRestoreCandidateProofResult {
  ok: true;
  candidateValid: true;
  schemaVersion: typeof CLOUD_RESTORE_CANDIDATE_PROOF_SCHEMA;
  policy: CloudRestoreCandidateProofPolicy;
  resourceCount: number;
  coverageCount: number;
  totalRows: number;
  tableCounts: Record<CloudRestoreTable, number>;
  transformedUpdatedByCount: number;
  sourceFingerprint: string;
  effectiveFingerprint: string;
  relationshipHash: string;
  integrity: CloudRestoreCandidateProofIntegrity;
  elapsedMs: number;
}

export interface CloudRestoreCandidateProofBinding {
  candidateGeneration: number;
  userId: string;
  targetProjectRef: string;
  executionFingerprint: string;
  sourceFingerprint: string;
  effectiveFingerprint: string;
  policy: CloudRestoreCandidateProofPolicy;
  resourceCount: number;
  totalRows: number;
}

export interface CloudRestoreCandidateProofRecord {
  binding: CloudRestoreCandidateProofBinding;
  result: CloudRestoreCandidateProofResult;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const requireInteger = (value: unknown, code: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CloudRestoreValidationError(code, 'Restore proof 回應包含無效整數。');
  }
  return value;
};

const requireHash = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new CloudRestoreValidationError(code, 'Restore proof 回應包含無效 fingerprint。');
  }
  return value;
};

const expectedPolicy = (candidate: CloudRestoreCandidate): CloudRestoreCandidateProofPolicy => (
  candidate.portability?.policyVersion ?? 'strict'
);

const expectedSourceFingerprint = (candidate: CloudRestoreCandidate): string => (
  candidate.portability?.sourceSnapshotFingerprint ?? candidate.manifest.snapshotFingerprint
);

const expectedTransformedCount = (candidate: CloudRestoreCandidate): number => (
  candidate.portability?.totalTransformedRows ?? 0
);

const expectedIntegrity = (manifest: CloudRestoreManifest): CloudRestoreCandidateProofIntegrity => ({
  orphanCount: manifest.orphanCount,
  duplicateVariantIdCount: manifest.duplicateVariantIdCount,
  duplicateVariantLocalIdCount: manifest.duplicateVariantLocalIdCount,
  duplicateCanonicalIdCount: manifest.duplicateCanonicalIdCount,
  canonicalIdentityAnomalyCount: manifest.canonicalIdentityAnomalyCount,
  unknownProductCount: manifest.unknownProductCount,
  optionalMetadataMissingReferenceCount: manifest.optionalMetadataMissingReferenceCount,
  duplicateInventoryKeyCount: 0,
  missingInventoryKeyCount: 0,
});

const parseTableCounts = (
  value: unknown,
  candidate: CloudRestoreCandidate,
): Record<CloudRestoreTable, number> => {
  if (!isRecord(value) || Object.keys(value).length !== CLOUD_RESTORE_TABLES.length) {
    throw new CloudRestoreValidationError('CLOUD_RESTORE_PROOF_TABLE_COUNTS_INVALID', 'Restore proof 資源覆蓋不完整。');
  }
  const counts = {} as Record<CloudRestoreTable, number>;
  for (const [, table] of CLOUD_RESTORE_TABLES) {
    const count = requireInteger(value[table], 'CLOUD_RESTORE_PROOF_TABLE_COUNTS_INVALID');
    if (count !== candidate.manifest.counts[table]) {
      throw new CloudRestoreValidationError('CLOUD_RESTORE_PROOF_TABLE_COUNTS_MISMATCH', 'Restore proof 資源筆數與目前候選不一致。');
    }
    counts[table] = count;
  }
  return counts;
};

const parseIntegrity = (
  value: unknown,
  candidate: CloudRestoreCandidate,
): CloudRestoreCandidateProofIntegrity => {
  if (!isRecord(value)) {
    throw new CloudRestoreValidationError('CLOUD_RESTORE_PROOF_INTEGRITY_INVALID', 'Restore proof 完整性摘要無效。');
  }
  const parsed: CloudRestoreCandidateProofIntegrity = {
    orphanCount: requireInteger(value.orphan_count, 'CLOUD_RESTORE_PROOF_INTEGRITY_INVALID'),
    duplicateVariantIdCount: requireInteger(value.duplicate_variant_id_count, 'CLOUD_RESTORE_PROOF_INTEGRITY_INVALID'),
    duplicateVariantLocalIdCount: requireInteger(value.duplicate_variant_local_id_count, 'CLOUD_RESTORE_PROOF_INTEGRITY_INVALID'),
    duplicateCanonicalIdCount: requireInteger(value.duplicate_canonical_id_count, 'CLOUD_RESTORE_PROOF_INTEGRITY_INVALID'),
    canonicalIdentityAnomalyCount: requireInteger(value.canonical_identity_anomaly_count, 'CLOUD_RESTORE_PROOF_INTEGRITY_INVALID'),
    unknownProductCount: requireInteger(value.unknown_product_count, 'CLOUD_RESTORE_PROOF_INTEGRITY_INVALID'),
    optionalMetadataMissingReferenceCount: requireInteger(value.optional_metadata_missing_reference_count, 'CLOUD_RESTORE_PROOF_INTEGRITY_INVALID'),
    duplicateInventoryKeyCount: requireInteger(value.duplicate_inventory_key_count, 'CLOUD_RESTORE_PROOF_INTEGRITY_INVALID'),
    missingInventoryKeyCount: requireInteger(value.missing_inventory_key_count, 'CLOUD_RESTORE_PROOF_INTEGRITY_INVALID'),
  };
  const expected = expectedIntegrity(candidate.manifest);
  for (const key of Object.keys(expected) as Array<keyof CloudRestoreCandidateProofIntegrity>) {
    if (parsed[key] !== expected[key]) {
      throw new CloudRestoreValidationError('CLOUD_RESTORE_PROOF_INTEGRITY_MISMATCH', 'Restore proof 完整性摘要與目前候選不一致。');
    }
  }
  return parsed;
};

export function assertCloudRestoreCandidateProofResult(
  value: unknown,
  candidate: CloudRestoreCandidate,
): CloudRestoreCandidateProofResult {
  if (!isRecord(value)) {
    throw new CloudRestoreValidationError('CLOUD_RESTORE_PROOF_RESULT_INVALID', 'Restore proof 回應格式無效。');
  }
  if (value.ok !== true || value.candidate_valid !== true
    || value.schema_version !== CLOUD_RESTORE_CANDIDATE_PROOF_SCHEMA) {
    throw new CloudRestoreValidationError('CLOUD_RESTORE_PROOF_RESULT_INVALID', 'Restore proof 未確認目前候選。');
  }
  const policy = value.policy;
  if ((policy !== 'strict' && policy !== 'cross-environment-audit-null-v1')
    || policy !== expectedPolicy(candidate)) {
    throw new CloudRestoreValidationError('CLOUD_RESTORE_PROOF_POLICY_MISMATCH', 'Restore proof 政策與目前候選不一致。');
  }
  const resourceCount = requireInteger(value.resource_count, 'CLOUD_RESTORE_PROOF_RESULT_INVALID');
  const coverageCount = requireInteger(value.coverage_count, 'CLOUD_RESTORE_PROOF_RESULT_INVALID');
  const totalRows = requireInteger(value.total_rows, 'CLOUD_RESTORE_PROOF_RESULT_INVALID');
  const transformedUpdatedByCount = requireInteger(value.transformed_updated_by_count, 'CLOUD_RESTORE_PROOF_RESULT_INVALID');
  const elapsedMs = requireInteger(value.elapsed_ms, 'CLOUD_RESTORE_PROOF_RESULT_INVALID');
  const sourceFingerprint = requireHash(value.source_fingerprint, 'CLOUD_RESTORE_PROOF_RESULT_INVALID');
  const effectiveFingerprint = requireHash(value.effective_fingerprint, 'CLOUD_RESTORE_PROOF_RESULT_INVALID');
  const relationshipHash = requireHash(value.relationship_hash, 'CLOUD_RESTORE_PROOF_RESULT_INVALID');
  const tableCounts = parseTableCounts(value.table_counts, candidate);
  const integrity = parseIntegrity(value.integrity, candidate);
  if (resourceCount !== candidate.manifest.resourceCount
    || resourceCount !== CLOUD_RESTORE_TABLES.length
    || coverageCount !== CLOUD_RESTORE_TABLES.length
    || totalRows !== candidate.manifest.totalRows
    || transformedUpdatedByCount !== expectedTransformedCount(candidate)
    || sourceFingerprint !== expectedSourceFingerprint(candidate)
    || effectiveFingerprint !== candidate.manifest.snapshotFingerprint
    || relationshipHash !== candidate.manifest.relationshipHash) {
    throw new CloudRestoreValidationError('CLOUD_RESTORE_PROOF_CANDIDATE_MISMATCH', 'Restore proof 與目前候選不一致。');
  }
  return {
    ok: true,
    candidateValid: true,
    schemaVersion: CLOUD_RESTORE_CANDIDATE_PROOF_SCHEMA,
    policy,
    resourceCount,
    coverageCount,
    totalRows,
    tableCounts,
    transformedUpdatedByCount,
    sourceFingerprint,
    effectiveFingerprint,
    relationshipHash,
    integrity,
    elapsedMs,
  };
}

export function bindCloudRestoreCandidateProof(
  candidate: CloudRestoreCandidate,
  result: CloudRestoreCandidateProofResult,
  context: { candidateGeneration: number; userId: string; targetProjectRef: string },
): CloudRestoreCandidateProofRecord {
  return {
    binding: {
      ...context,
      executionFingerprint: candidate.executionFingerprint,
      sourceFingerprint: expectedSourceFingerprint(candidate),
      effectiveFingerprint: candidate.manifest.snapshotFingerprint,
      policy: expectedPolicy(candidate),
      resourceCount: candidate.manifest.resourceCount,
      totalRows: candidate.manifest.totalRows,
    },
    result,
  };
}

export function isCloudRestoreCandidateProofCurrent(
  record: CloudRestoreCandidateProofRecord | null,
  candidate: CloudRestoreCandidate | null,
  context: { candidateGeneration: number; userId: string; targetProjectRef: string },
): boolean {
  if (!record || !candidate || !context.userId) return false;
  const binding = record.binding;
  return record.result.candidateValid === true
    && binding.candidateGeneration === context.candidateGeneration
    && binding.userId === context.userId
    && binding.targetProjectRef === context.targetProjectRef
    && binding.executionFingerprint === candidate.executionFingerprint
    && binding.sourceFingerprint === expectedSourceFingerprint(candidate)
    && binding.effectiveFingerprint === candidate.manifest.snapshotFingerprint
    && binding.policy === expectedPolicy(candidate)
    && binding.resourceCount === candidate.manifest.resourceCount
    && binding.totalRows === candidate.manifest.totalRows;
}
