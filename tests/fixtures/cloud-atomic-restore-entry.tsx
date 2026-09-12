import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthContext } from '../../src/auth/authContext';
import { markCloudReadFresh, markCloudReadLoading, markCloudReachable } from '../../src/providers/cloud/cloudConnectivity';
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
  }
}

window.__CLOUD_RESTORE_CONNECTIVITY_TEST__ = {
  loading: markCloudReadLoading,
  fresh: markCloudReadFresh,
};

dataProvider.restoreCloudSnapshot = async command => ({
  ok: true,
  replayed: false,
  idempotencyKey: command.idempotencyKey,
  snapshotFingerprint: command.candidate.manifest.snapshotFingerprint,
  rollbackSnapshotId: '00000000-0000-4000-8000-000000000098',
  restoreEpoch: 1,
  manifest: command.candidate.manifest,
  timingsMs: { auth: 1, lockIdempotency: 2, inputValidation: 3, beforeSnapshot: 4, rollbackRow: 1, delete: 2, insert: 8, integrity: 5, epochIdempotency: 1, total: 27 },
});

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
