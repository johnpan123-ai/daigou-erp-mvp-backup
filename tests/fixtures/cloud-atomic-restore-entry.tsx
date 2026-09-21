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
  getCloudRestoreSubmitDiagnostics,
  resetCloudRestoreSubmitDiagnosticsForTests,
} from '../../src/providers/cloud/cloudRestoreSubmit';
import { dataProvider } from '../../src/providers/dataProvider';

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
      reset: () => void;
      releaseDeferred: () => void;
      snapshot: () => {
        calls: number;
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
    };
  }
}

type RestoreFixtureBehavior = 'success' | 'completed-replay' | 'plain-error' | 'plain-error-variant' | 'timeout' | 'lost-response-success' | 'lost-response-failure' | 'refresh-pending' | 'deferred-success' | 'guard-race' | 'target-fail';

let behavior: RestoreFixtureBehavior = 'success';
let calls = 0;
let prepareCalls = 0;
let prepareAttemptIds: string[] = [];
let reconcileCalls = 0;
let targetValidationCalls = 0;
let idempotencyKeys: string[] = [];
let traceIds: string[] = [];
let candidates: Array<{ portability: unknown; fingerprint: string; executionFingerprint: string; allUpdatedByNull: boolean }> = [];
let deferredRelease: (() => void) | null = null;
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
  setBehavior: next => { behavior = next; },
  reset: () => {
    behavior = 'success';
    calls = 0;
    prepareCalls = 0;
    prepareAttemptIds = [];
    reconcileCalls = 0;
    targetValidationCalls = 0;
    idempotencyKeys = [];
    traceIds = [];
    candidates = [];
    latestCommand = null;
    deferredRelease = null;
    resetCloudRestoreSubmitDiagnosticsForTests();
  },
  releaseDeferred: () => deferredRelease?.(),
  snapshot: () => ({
    calls,
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
const user = {
  id: '00000000-0000-4000-8000-000000000099', email: 'owner@example.invalid',
  app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-09-09T00:00:00Z',
};
const root = createRoot(document.getElementById('root')!);
let mountVersion = 0;
const renderFixture = () => {
  mountVersion += 1;
  root.render(
    <React.StrictMode>
      <AuthContext.Provider value={{
        user,
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
window.__CLOUD_RESTORE_SUBMIT_TEST__.remount = renderFixture;
renderFixture();
