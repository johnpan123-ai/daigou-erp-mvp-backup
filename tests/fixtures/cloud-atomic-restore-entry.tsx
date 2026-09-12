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
        idempotencyKeys: string[];
        diagnostics: ReturnType<typeof getCloudRestoreSubmitDiagnostics>;
      };
    };
  }
}

type RestoreFixtureBehavior = 'success' | 'plain-error' | 'timeout' | 'refresh-pending' | 'deferred-success' | 'guard-race';

let behavior: RestoreFixtureBehavior = 'success';
let calls = 0;
let idempotencyKeys: string[] = [];
let deferredRelease: (() => void) | null = null;

window.__CLOUD_RESTORE_CONNECTIVITY_TEST__ = {
  loading: markCloudReadLoading,
  fresh: markCloudReadFresh,
};

window.__CLOUD_RESTORE_SUBMIT_TEST__ = {
  setBehavior: next => { behavior = next; },
  reset: () => {
    behavior = 'success';
    calls = 0;
    idempotencyKeys = [];
    deferredRelease = null;
    resetCloudRestoreSubmitDiagnosticsForTests();
  },
  releaseDeferred: () => deferredRelease?.(),
  snapshot: () => ({ calls, idempotencyKeys: [...idempotencyKeys], diagnostics: getCloudRestoreSubmitDiagnostics() }),
};

dataProvider.restoreCloudSnapshot = async command => {
  if (behavior === 'guard-race') markCloudReadLoading();
  assertCloudWriteAllowed();
  calls += 1;
  idempotencyKeys.push(command.idempotencyKey);
  if (behavior === 'plain-error') {
    throw {
      code: 'PGRST_TEST',
      message: 'Restore request was refused at https://fake-project.supabase.co/rest/v1/rpc/restore?apikey=fake-public-key.',
      details: 'host=fake-db.internal user=fake-user password=fake-password dbname=fake-database',
      hint: 'postgresql://fake-user:fake-password@fake-db.internal/fake-database?sslmode=require',
      access_token: 'must-not-render',
    };
  }
  if (behavior === 'timeout') {
    throw { code: 'ETIMEDOUT', message: 'Network timed out', details: 'access_token=must-not-render' };
  }
  if (behavior === 'deferred-success') {
    await new Promise<void>(resolve => { deferredRelease = resolve; });
  }
  const result = {
    ok: true as const,
    replayed: false,
    idempotencyKey: command.idempotencyKey,
    snapshotFingerprint: command.candidate.manifest.snapshotFingerprint,
    rollbackSnapshotId: '00000000-0000-4000-8000-000000000098',
    restoreEpoch: 1,
    manifest: command.candidate.manifest,
    timingsMs: { auth: 1, lockIdempotency: 2, inputValidation: 3, beforeSnapshot: 4, rollbackRow: 1, delete: 2, insert: 8, integrity: 5, epochIdempotency: 1, total: 27 },
  };
  return behavior === 'refresh-pending'
    ? { ...result, authoritativeRefresh: { status: 'pending' as const, errorCode: 'REFRESH_TEST', errorMessage: 'Refresh pending' } }
    : { ...result, authoritativeRefresh: { status: 'complete' as const } };
};

const { default: StagingCloudRestoreHarness } = await import('../../src/pages/StagingCloudRestoreHarness');
const user = {
  id: '00000000-0000-4000-8000-000000000099', email: 'owner@example.invalid',
  app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-09-09T00:00:00Z',
};
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthContext.Provider value={{
      user,
      profile: { role: 'owner', display_name: 'Restore Owner', is_active: true },
      loading: false, profileLoading: false, authFlow: 'normal',
      signInWithPassword: async () => {}, requestPasswordReset: async () => {},
      setNewPassword: async () => {}, signOut: async () => {},
    }}>
      <StagingCloudRestoreHarness />
    </AuthContext.Provider>
  </React.StrictMode>,
);
