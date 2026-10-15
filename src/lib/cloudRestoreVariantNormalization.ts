import {
  CloudRestoreValidationError,
  rebuildCurrentCloudRestoreCandidate,
  sha256Hex,
  stableCloudRestoreJson,
  type CloudRestoreCandidate,
} from '../providers/cloud/cloudAtomicRestore';
import {
  normalizeRestoreVariantDuplicates,
  RestoreVariantConflictError,
  RESTORE_VARIANT_NORMALIZATION_POLICY,
  type RestoreTables,
  type VariantConflict,
  type VariantConflictApproval,
  type VariantNormalizationReport,
} from './restoreVariantNormalization';
import { OWNER_APPROVED_VARIANT_CONFLICTS } from './restoreVariantApprovals';

/**
 * Restore-candidate step (before cross-environment portability, before any upload):
 * duplicate Variants are normalized in memory and the manifest is rebuilt from the
 * normalized data, so the existing server proof, the single atomic Restore
 * transaction and the post-commit verification all run on exactly what is written.
 * The source file bytes and its SHA-256 are never modified; both fingerprints are kept.
 */
export interface CloudRestoreVariantNormalizationRecord {
  status: 'UNCHANGED' | 'NORMALIZED' | 'BLOCKED';
  policy: typeof RESTORE_VARIANT_NORMALIZATION_POLICY;
  sourceFileSha256: string;
  sourceSnapshotFingerprint: string;
  normalizedSnapshotFingerprint: string | null;
  duplicateSets: number;
  extraRows: number;
  normalizedSets: number;
  approvedConflictsApplied: number;
  softDeletedVariants: number;
  repointedReferences: number;
  softDeletedBundles: number;
  canonicalFieldChanges: number;
  conflicts: VariantConflict[];
  report: VariantNormalizationReport | null;
}

export type CloudRestoreVariantNormalizationResult =
  | { candidate: CloudRestoreCandidate; record: CloudRestoreVariantNormalizationRecord; error?: undefined }
  | { candidate: null; record: CloudRestoreVariantNormalizationRecord; error: CloudRestoreValidationError };

const fail = (code: string, message: string): never => { throw new CloudRestoreValidationError(code, message); };

export async function normalizeCloudRestoreCandidateVariants(
  candidate: CloudRestoreCandidate,
  approvals: readonly VariantConflictApproval[] = OWNER_APPROVED_VARIANT_CONFLICTS,
): Promise<CloudRestoreVariantNormalizationResult> {
  if (candidate.portability || candidate.sourceData || candidate.manifest.portability) {
    fail('RESTORE_VARIANT_NORMALIZATION_ORDER_INVALID', '重複規格正規化必須在跨環境轉換之前執行。');
  }
  // The candidate must still be exactly what was verified from the file.
  const verified = await rebuildCurrentCloudRestoreCandidate(candidate.data);
  if (stableCloudRestoreJson(verified.manifest) !== stableCloudRestoreJson(candidate.manifest)
    || candidate.executionFingerprint !== candidate.manifest.snapshotFingerprint) {
    fail('RESTORE_VARIANT_NORMALIZATION_SOURCE_CHANGED', '備份候選資料驗證後已變更，請重新選擇檔案。');
  }
  const base = {
    policy: RESTORE_VARIANT_NORMALIZATION_POLICY,
    sourceFileSha256: candidate.sourceFileSha256,
    sourceSnapshotFingerprint: candidate.manifest.snapshotFingerprint,
  };
  let normalized: Awaited<ReturnType<typeof normalizeRestoreVariantDuplicates>>;
  try {
    normalized = await normalizeRestoreVariantDuplicates(candidate.data as unknown as RestoreTables, { approvals, sha256: sha256Hex });
  } catch (error) {
    if (!(error instanceof RestoreVariantConflictError)) throw error;
    const sets = new Set(error.conflicts.map(conflict => conflict.setStateFingerprint)).size;
    return {
      candidate: null,
      record: { ...base, status: 'BLOCKED', normalizedSnapshotFingerprint: null, duplicateSets: sets, extraRows: 0, normalizedSets: 0,
        approvedConflictsApplied: 0, softDeletedVariants: 0, repointedReferences: 0, softDeletedBundles: 0, canonicalFieldChanges: 0,
        conflicts: error.conflicts, report: null },
      error: new CloudRestoreValidationError('RESTORE_VARIANT_DUPLICATE_CONFLICT',
        `備份內有 ${sets} 組重複規格的人工數量無法自動判定，已在寫入雲端前停止（未送出任何資料）。請將衝突明細交給 Owner 確認。`),
    };
  }
  const { report } = normalized;
  const summary = {
    duplicateSets: report.duplicateSets, extraRows: report.extraRows, normalizedSets: report.normalizedSets,
    approvedConflictsApplied: report.approvedConflictsApplied, softDeletedVariants: report.softDeletedVariantIds.length,
    repointedReferences: report.repointedReferences.length, softDeletedBundles: report.softDeletedBundleIds.length,
    canonicalFieldChanges: report.canonicalFieldChanges.length, conflicts: [] as VariantConflict[],
  };
  if (report.duplicateSets === 0) {
    // Already clean (e.g. an ERP2 v2 backup or a repeated Restore): the candidate is returned untouched.
    return { candidate, record: { ...base, ...summary, status: 'UNCHANGED', normalizedSnapshotFingerprint: candidate.manifest.snapshotFingerprint, report } };
  }
  const rebuilt = await rebuildCurrentCloudRestoreCandidate(normalized.data as unknown as CloudRestoreCandidate['data']);
  // Independent post-conditions; any failure blocks the Restore before upload.
  const sourceCounts = candidate.manifest.counts as Record<string, number>;
  const counts = rebuilt.manifest.counts as Record<string, number>;
  if (Object.keys(sourceCounts).some(table => sourceCounts[table] !== counts[table])) {
    fail('RESTORE_VARIANT_NORMALIZATION_ROW_COUNT_CHANGED', '重複規格正規化不可改變任何資料表筆數。');
  }
  if (rebuilt.manifest.orphanCount !== 0 || rebuilt.manifest.duplicateCanonicalIdCount !== 0
    || rebuilt.manifest.orphanCount > candidate.manifest.orphanCount
    || rebuilt.manifest.unknownProductCount !== candidate.manifest.unknownProductCount) {
    fail('RESTORE_VARIANT_NORMALIZATION_INTEGRITY_FAILED', '重複規格正規化後的關聯完整性驗證失敗。');
  }
  const again = await normalizeRestoreVariantDuplicates(rebuilt.data as unknown as RestoreTables, { approvals: [], sha256: sha256Hex });
  if (again.report.duplicateSets !== 0) fail('RESTORE_VARIANT_NORMALIZATION_INCOMPLETE', '重複規格正規化後仍有重複規格。');
  return {
    candidate: Object.freeze({ ...candidate, data: rebuilt.data, manifest: rebuilt.manifest, executionFingerprint: rebuilt.manifest.snapshotFingerprint }),
    record: { ...base, ...summary, status: 'NORMALIZED', normalizedSnapshotFingerprint: rebuilt.manifest.snapshotFingerprint, report },
  };
}
