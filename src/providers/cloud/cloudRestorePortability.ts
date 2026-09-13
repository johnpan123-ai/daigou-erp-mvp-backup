import { STAGING_SUPABASE_PROJECT_REF } from '../../lib/supabaseEnvironmentBoundary';
import {
  CLOUD_RESTORE_TABLES,
  rebuildCurrentCloudRestoreCandidate,
  sha256Hex,
  stableCloudRestoreJson,
  CloudRestoreValidationError,
  type CloudRestoreCandidate,
  type CloudRestorePortabilityManifest,
  type CloudRestoreTable,
} from './cloudAtomicRestore';

export const CLOUD_RESTORE_PORTABILITY_POLICY_VERSION = 'cross-environment-audit-null-v1' as const;
export const CLOUD_RESTORE_PORTABILITY_PREFLIGHT_RPC = 'erp_cloud_restore_validate_portability' as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Frozen from the 2026-09-13 Staging pg_catalog audit. Every listed column is
 * uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL and is audit-only.
 * Runtime SQL preflight independently rechecks the same closed contract.
 */
export const CLOUD_RESTORE_AUDIT_IDENTITY_ALLOWLIST = Object.freeze(
  Object.fromEntries(CLOUD_RESTORE_TABLES.map(([, table]) => [table, 'updated_by'])) as Readonly<Record<CloudRestoreTable, 'updated_by'>>,
);

const changedCount = (rows: Record<string, unknown>[]): number => rows.reduce(
  (count, row) => count + (row.updated_by === null || row.updated_by === undefined ? 0 : 1),
  0,
);

const assertSourceAuditIdentityContract = (source: CloudRestoreCandidate['data']): void => {
  for (const [, table] of CLOUD_RESTORE_TABLES) {
    source[table].forEach(row => {
      if (row.updated_by !== null && row.updated_by !== undefined && !UUID_PATTERN.test(String(row.updated_by))) {
        throw new CloudRestoreValidationError(
          'RESTORE_PORTABILITY_AUDIT_IDENTITY_INVALID',
          `${table}.updated_by 必須為 NULL 或合法 UUID。`,
        );
      }
    });
  }
};

const withoutUpdatedBy = (row: Record<string, unknown>): Record<string, unknown> => {
  const businessRow = { ...row };
  delete businessRow.updated_by;
  return businessRow;
};

const assertOnlyAuditIdentityChanged = (
  source: CloudRestoreCandidate['data'],
  candidate: CloudRestoreCandidate['data'],
): void => {
  for (const [, table] of CLOUD_RESTORE_TABLES) {
    if (source[table].length !== candidate[table].length) {
      throw new CloudRestoreValidationError('RESTORE_PORTABILITY_ROW_COUNT_CHANGED', `跨環境政策不可改變 ${table} 筆數。`);
    }
    source[table].forEach((row, index) => {
      const next = candidate[table][index];
      if (stableCloudRestoreJson(withoutUpdatedBy(row)) !== stableCloudRestoreJson(withoutUpdatedBy(next))) {
        throw new CloudRestoreValidationError('RESTORE_PORTABILITY_BUSINESS_DATA_CHANGED', `跨環境政策不可改變 ${table} 業務欄位。`);
      }
      if (next.updated_by !== null) {
        throw new CloudRestoreValidationError('RESTORE_PORTABILITY_AUDIT_FIELD_NOT_NULL', `${table}.updated_by 必須為 NULL。`);
      }
    });
  }
};

export async function prepareCrossEnvironmentCloudRestoreCandidate(
  source: CloudRestoreCandidate,
  targetProjectRef: string,
): Promise<CloudRestoreCandidate> {
  if (source.portability || source.manifest.portability) {
    throw new CloudRestoreValidationError('RESTORE_PORTABILITY_ALREADY_APPLIED', '跨環境政策不可重複套用。');
  }
  if (targetProjectRef !== STAGING_SUPABASE_PROJECT_REF) {
    throw new CloudRestoreValidationError('RESTORE_PORTABILITY_TARGET_BLOCKED', '跨環境 Restore candidate 只允許指定的 Staging target。');
  }
  const verifiedSource = await rebuildCurrentCloudRestoreCandidate(source.data);
  if (stableCloudRestoreJson(verifiedSource.manifest) !== stableCloudRestoreJson(source.manifest)) {
    throw new CloudRestoreValidationError('RESTORE_PORTABILITY_SOURCE_CHANGED', '原始快照驗證後已變更，必須重新 Preflight。');
  }
  assertSourceAuditIdentityContract(verifiedSource.data);

  const transformedCounts = Object.fromEntries(CLOUD_RESTORE_TABLES.map(([, table]) => [
    table,
    changedCount(verifiedSource.data[table]),
  ])) as Record<CloudRestoreTable, number>;
  const transformedData = Object.fromEntries(CLOUD_RESTORE_TABLES.map(([, table]) => [
    table,
    verifiedSource.data[table].map(row => ({ ...row, updated_by: null })),
  ])) as unknown as CloudRestoreCandidate['data'];
  const rebuilt = await rebuildCurrentCloudRestoreCandidate(transformedData);
  assertOnlyAuditIdentityChanged(verifiedSource.data, rebuilt.data);

  const portability: CloudRestorePortabilityManifest = Object.freeze({
    policyVersion: CLOUD_RESTORE_PORTABILITY_POLICY_VERSION,
    mode: 'cross-environment',
    targetProjectRef,
    sourceFileSha256: source.sourceFileSha256,
    sourceSnapshotFingerprint: source.manifest.snapshotFingerprint,
    transformedCounts: Object.freeze({ ...transformedCounts }),
    totalTransformedRows: Object.values(transformedCounts).reduce((sum, count) => sum + count, 0),
  });
  const manifest = Object.freeze({ ...rebuilt.manifest, portability });
  const executionFingerprint = await sha256Hex(stableCloudRestoreJson({
    snapshotFingerprint: manifest.snapshotFingerprint,
    portability,
  }));

  return Object.freeze({
    ...source,
    data: rebuilt.data,
    manifest,
    portability,
    executionFingerprint,
  });
}

export interface CloudRestoreTargetCompatibilityResult {
  ok: true;
  policyVersion: typeof CLOUD_RESTORE_PORTABILITY_POLICY_VERSION;
  targetProjectRef: string;
  policyFingerprint: string;
  externalReferenceCount: number;
}

export function assertCloudRestoreTargetCompatibilityResult(
  value: unknown,
  candidate: CloudRestoreCandidate,
): CloudRestoreTargetCompatibilityResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CloudRestoreValidationError('RESTORE_TARGET_COMPATIBILITY_INVALID', '目標相容性回應無效。');
  }
  const result = value as Record<string, unknown>;
  if (result.ok !== true
    || result.policyVersion !== CLOUD_RESTORE_PORTABILITY_POLICY_VERSION
    || result.targetProjectRef !== candidate.portability?.targetProjectRef
    || typeof result.policyFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(result.policyFingerprint)
    || result.externalReferenceCount !== CLOUD_RESTORE_TABLES.length) {
    throw new CloudRestoreValidationError('RESTORE_TARGET_COMPATIBILITY_MISMATCH', '目標 schema／外部參照契約不相容。');
  }
  return result as unknown as CloudRestoreTargetCompatibilityResult;
}
