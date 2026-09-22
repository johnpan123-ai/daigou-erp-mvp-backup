import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthContext } from '../../src/auth/authContext';
import {
  assertCloudWriteAllowed,
  markCloudReadFresh,
  markCloudReadLoading,
  markCloudReachable,
} from '../../src/providers/cloud/cloudConnectivity';
import {
  clearCloudRestoreUnresolvedAttempt,
  getCloudRestoreSubmitDiagnostics,
  resetCloudRestoreSubmitDiagnosticsForTests,
} from '../../src/providers/cloud/cloudRestoreSubmit';
import { dataProvider } from '../../src/providers/dataProvider';
import type { CloudRestoreRecoveryAttempt } from '../../src/providers/cloud/cloudRestoreRecovery';
import { assertCloudRestoreCandidateProofResult } from '../../src/providers/cloud/cloudRestoreCandidateProof';

localStorage.setItem('erp_provider_mode', 'cloud');
markCloudReachable();
markCloudReadFresh(1);

declare global {
  interface Window {
    __CLOUD_RESTORE_CONNECTIVITY_TEST__: {
      loading: () => void;
      fresh: (rowCount?: number) => void;
    };
    __CLOUD_RESTORE_SUBMIT_TEST__: {
      setBehavior: (behavior: RestoreFixtureBehavior) => void;
      setProofBehavior: (behavior: ProofFixtureBehavior) => void;
      reset: () => void;
      releaseDeferred: () => void;
      releaseProofDeferred: () => void;
      snapshot: () => {
        mountVersion: number;
        calls: number;
        proofCalls: number;
        prepareCalls: number;
        prepareAttemptIds: string[];
        reconcileCalls: number;
        targetValidationCalls: number;
        idempotencyKeys: string[];
        traceIds: string[];
        candidates: Array<{ portability: unknown; fingerprint: string; executionFingerprint: string; allUpdatedByNull: boolean }>;
        diagnostics: ReturnType<typeof getCloudRestoreSubmitDiagnostics>;
      };
      remount: () => void;
      setUserId: (userId: string) => void;
      setRecovery: (attempts: CloudRestoreRecoveryAttempt[] | 'error') => void;
    };
  }
}

type RestoreFixtureBehavior = 'success' | 'completed-replay' | 'plain-error' | 'plain-error-variant' | 'timeout' | 'lost-response-success' | 'lost-response-failure' | 'refresh-pending' | 'deferred-success' | 'guard-race' | 'target-fail';
type ProofFixtureBehavior = 'success' | 'error' | 'fingerprint-mismatch' | 'deferred-success';

let behavior: RestoreFixtureBehavior = 'success';
let proofBehavior: ProofFixtureBehavior = 'success';
let serverPending: CloudRestoreRecoveryAttempt[] | 'error' = [];
let calls = 0;
let proofCalls = 0;
let prepareCalls = 0;
let prepareAttemptIds: string[] = [];
let reconcileCalls = 0;
let targetValidationCalls = 0;
let idempotencyKeys: string[] = [];
let traceIds: string[] = [];
let candidates: Array<{ portability: unknown; fingerprint: string; executionFingerprint: string; allUpdatedByNull: boolean }> = [];
let deferredRelease: (() => void) | null = null;
let proofDeferredRelease: (() => void) | null = null;
let currentUserId = '00000000-0000-4000-8000-000000000099';
let completedEnvelope: {
  attemptId: string;
  traceId: string;
  effectiveFingerprint: string;
  result: ReturnType<typeof restoreResult> & { authoritativeRefresh: { status: 'complete' } };
} | null = null;

window.__CLOUD_RESTORE_CONNECTIVITY_TEST__ = {
  loading: markCloudReadLoading,
  fresh: markCloudReadFresh,
};

window.__CLOUD_RESTORE_SUBMIT_TEST__ = {
  setUserId: userId => { currentUserId = userId; renderFixture(false); },
  setRecovery: attempts => { serverPending = attempts; },
  setBehavior: next => { behavior = next; },
  setProofBehavior: next => { proofBehavior = next; },
  reset: () => {
    clearCloudRestoreUnresolvedAttempt();
    behavior = 'success';
    proofBehavior = 'success';
    calls = 0;
    proofCalls = 0;
    prepareCalls = 0;
    prepareAttemptIds = [];
    reconcileCalls = 0;
    targetValidationCalls = 0;
    idempotencyKeys = [];
    traceIds = [];
    candidates = [];
    latestCommand = null;
    deferredRelease = null;
    proofDeferredRelease = null;
    resetCloudRestoreSubmitDiagnosticsForTests();
  },
  releaseDeferred: () => deferredRelease?.(),
  releaseProofDeferred: () => proofDeferredRelease?.(),
  snapshot: () => ({
    mountVersion,
    calls,
    proofCalls,
    prepareCalls,
    prepareAttemptIds: [...prepareAttemptIds],
    reconcileCalls,
    targetValidationCalls,
    idempotencyKeys: [...idempotencyKeys],
    traceIds: [...traceIds],
    candidates: structuredClone(candidates),
    diagnostics: getCloudRestoreSubmitDiagnostics(),
  }),
};

dataProvider.proveCloudRestoreCandidate = async candidate => {
  proofCalls += 1;
  if (proofBehavior === 'error') {
    throw { code: 'CLOUD_RESTORE_OWNER_REQUIRED', message: 'must-not-render owner identity' };
  }
  if (proofBehavior === 'deferred-success') {
    await new Promise<void>(resolve => { proofDeferredRelease = resolve; });
  }
  const proof = {
    ok: true,
    candidate_valid: true,
    schema_version: 'cloud-restore-candidate-proof-v1',
    policy: candidate.portability?.policyVersion ?? 'strict',
    resource_count: candidate.manifest.resourceCount,
    coverage_count: 15,
    total_rows: candidate.manifest.totalRows,
    table_counts: candidate.manifest.counts,
    transformed_updated_by_count: candidate.portability?.totalTransformedRows ?? 0,
    source_fingerprint: candidate.portability?.sourceSnapshotFingerprint ?? candidate.manifest.snapshotFingerprint,
    effective_fingerprint: proofBehavior === 'fingerprint-mismatch'
      ? 'f'.repeat(64)
      : candidate.manifest.snapshotFingerprint,
    relationship_hash: candidate.manifest.relationshipHash,
    integrity: {
      orphan_count: candidate.manifest.orphanCount,
      duplicate_variant_id_count: candidate.manifest.duplicateVariantIdCount,
      duplicate_variant_local_id_count: candidate.manifest.duplicateVariantLocalIdCount,
      duplicate_canonical_id_count: candidate.manifest.duplicateCanonicalIdCount,
      canonical_identity_anomaly_count: candidate.manifest.canonicalIdentityAnomalyCount,
      unknown_product_count: candidate.manifest.unknownProductCount,
      optional_metadata_missing_reference_count: candidate.manifest.optionalMetadataMissingReferenceCount,
      duplicate_inventory_key_count: 0,
      missing_inventory_key_count: 0,
    },
    elapsed_ms: 42,
  };
  return assertCloudRestoreCandidateProofResult(proof, candidate);
};

const restoreResult = (command: Parameters<typeof dataProvider.restoreCloudSnapshot>[0]) => ({
  ok: true as const,
  replayed: false,
  idempotencyKey: command.idempotencyKey,
  snapshotFingerprint: command.candidate.manifest.snapshotFingerprint,
  rollbackSnapshotId: '00000000-0000-4000-8000-000000000098',
  restoreEpoch: 1,
  manifest: command.candidate.manifest,
  timingsMs: { auth: 1, lockIdempotency: 2, inputValidation: 3, beforeSnapshot: 4, rollbackRow: 1, delete: 2, insert: 8, integrity: 5, epochIdempotency: 1, total: 27 },
});

let latestCommand: Parameters<typeof dataProvider.restoreCloudSnapshot>[0] | null = null;

dataProvider.getPendingCloudRestoreAttempts = async () => {
  if (serverPending === 'error') throw new Error('lookup failed');
  return structuredClone(serverPending);
};

dataProvider.prepareCloudRestoreAttempt = async command => {
  prepareCalls += 1;
  prepareAttemptIds.push(command.idempotencyKey);
  traceIds.push(command.attemptCorrelationId);
  if (behavior === 'completed-replay' && completedEnvelope) {
    if (completedEnvelope.attemptId !== command.idempotencyKey
      || completedEnvelope.traceId !== command.attemptCorrelationId
      || completedEnvelope.effectiveFingerprint !== command.candidate.manifest.snapshotFingerprint) {
      throw { code: 'CLOUD_RESTORE_ATTEMPT_PAYLOAD_MISMATCH' };
    }
    return {
      status: 'completed',
      attemptId: completedEnvelope.attemptId,
      traceId: completedEnvelope.traceId,
      expectedEpoch: 0,
      effectiveFingerprint: completedEnvelope.effectiveFingerprint,
      resultEpoch: completedEnvelope.result.restoreEpoch,
      restoreResult: completedEnvelope.result,
    };
  }
  return {
    status: 'executing',
    attemptId: command.idempotencyKey,
    traceId: command.attemptCorrelationId,
    executionId: '00000000-0000-4000-8000-000000000097',
    expectedEpoch: 0,
    effectiveFingerprint: command.candidate.manifest.snapshotFingerprint,
    reconcileAfter: '2026-09-21T00:02:15.000Z',
  };
};

dataProvider.reconcileCloudRestoreAttempt = async command => {
  reconcileCalls += 1;
  if (Array.isArray(serverPending)) serverPending = serverPending.filter(row => row.attemptId !== command.attemptId);
  const fingerprint = latestCommand?.candidate.manifest.snapshotFingerprint ?? 'a'.repeat(64);
  if (behavior === 'lost-response-success' && latestCommand) {
    return {
      status: 'completed', attemptId: command.attemptId, traceId: command.traceId,
      expectedEpoch: 0, effectiveFingerprint: fingerprint, resultEpoch: 1,
      restoreResult: restoreResult(latestCommand),
    };
  }
  return {
    status: 'not_committed', attemptId: command.attemptId, traceId: command.traceId,
    expectedEpoch: 0, effectiveFingerprint: fingerprint,
  };
};

dataProvider.validateCloudRestoreTarget = async command => {
  targetValidationCalls += 1;
  if (behavior === 'target-fail') {
    throw { code: 'CLOUD_RESTORE_TARGET_COMPATIBILITY_BLOCKED', message: 'must-not-render raw target detail' };
  }
  return {
    ok: true,
    policyVersion: 'cross-environment-audit-null-v1',
    targetProjectRef: command.candidate.portability?.targetProjectRef ?? '',
    policyFingerprint: 'a'.repeat(64),
    externalReferenceCount: 15,
  };
};

dataProvider.restoreCloudSnapshot = async command => {
  latestCommand = command;
  if (behavior === 'guard-race') markCloudReadLoading();
  assertCloudWriteAllowed();
  calls += 1;
  idempotencyKeys.push(command.idempotencyKey);
  candidates.push({
    portability: command.candidate.portability,
    fingerprint: command.candidate.manifest.snapshotFingerprint,
    executionFingerprint: command.candidate.executionFingerprint,
    allUpdatedByNull: Object.values(command.candidate.data).every(rows => rows.every(row => row.updated_by === null)),
  });
  if (behavior === 'plain-error' || behavior === 'plain-error-variant') {
    throw {
      code: '23505',
      message: behavior === 'plain-error'
        ? 'Restore request was refused at https://fake-project.supabase.co/rest/v1/rpc/restore?apikey=fake-public-key.'
        : 'Entirely different 外部錯誤 jdbc%253Apostgresql%253A%252F%252Fother-user%253Aother-password%2540other-db.internal%252Fother-database',
      details: behavior === 'plain-error'
        ? 'host=fake-db.internal user=fake-user password=fake-password dbname=fake-database'
        : 'host=other-db.internal user=other-user password=other-password dbname=other-database',
      hint: 'jdbc%3Apostgresql%3A%2F%2Ffake-user%3Afake-password%40fake-db.internal%2Ffake-database',
      access_token: 'must-not-render',
      cause: { stack: 'Bearer fake-token owner@example.invalid {"snapshot":{"customer":"private-business-value"}}' },
    };
  }
  if (behavior === 'timeout' || behavior === 'lost-response-success' || behavior === 'lost-response-failure') {
    throw { code: 'ETIMEDOUT', message: 'Network timed out', details: 'access_token=must-not-render' };
  }
  if (behavior === 'deferred-success') {
    await new Promise<void>(resolve => { deferredRelease = resolve; });
  }
  const result = restoreResult(command);
  const response = behavior === 'refresh-pending'
    ? { ...result, authoritativeRefresh: { status: 'pending' as const, errorCode: 'REFRESH_TEST', errorMessage: 'Refresh pending' } }
    : { ...result, authoritativeRefresh: { status: 'complete' as const } };
  if (response.authoritativeRefresh.status === 'complete') {
    completedEnvelope = {
      attemptId: command.idempotencyKey,
      traceId: command.attemptCorrelationId,
      effectiveFingerprint: command.candidate.manifest.snapshotFingerprint,
      result: response,
    };
  }
  return response;
};

const { default: StagingCloudRestoreHarness } = await import('../../src/pages/StagingCloudRestoreHarness');
const baseUser = {
  email: 'owner@example.invalid',
  app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-09-09T00:00:00Z',
};
const root = createRoot(document.getElementById('root')!);
let mountVersion = 0;
const renderFixture = (remount = true) => {
  if (remount) mountVersion += 1;
  root.render(
    <React.StrictMode>
      <AuthContext.Provider value={{
        user: { ...baseUser, id: currentUserId },
        profile: { role: 'owner', display_name: 'Restore Owner', is_active: true },
        loading: false, profileLoading: false, authFlow: 'normal',
        signInWithPassword: async () => {}, requestPasswordReset: async () => {},
        setNewPassword: async () => {}, signOut: async () => {},
      }}>
        <StagingCloudRestoreHarness key={mountVersion} />
      </AuthContext.Provider>
    </React.StrictMode>,
  );
};
window.__CLOUD_RESTORE_SUBMIT_TEST__.remount = () => renderFixture(true);
renderFixture();
