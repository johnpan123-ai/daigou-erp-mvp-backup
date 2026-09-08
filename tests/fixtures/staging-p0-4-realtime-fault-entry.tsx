import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthContext } from '../../src/auth/authContext';
import { CloudRealtimeSyncBoundary } from '../../src/contexts/CloudRealtimeSyncContext';
import StagingP04AuthenticatedHarness from '../../src/pages/StagingP04AuthenticatedHarness';

localStorage.setItem('erp_provider_mode', 'cloud');

const user = {
  id: '00000000-0000-4000-8000-000000000099',
  email: 'staging-fault-control@example.invalid',
  app_metadata: {},
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-09-08T00:00:00.000Z',
};

createRoot(document.getElementById('root')!).render(
  <AuthContext.Provider value={{
    user,
    profile: { role: 'owner', display_name: 'Staging Fault Control Owner', is_active: true },
    loading: false,
    profileLoading: false,
    authFlow: 'normal',
    signInWithPassword: async () => {},
    requestPasswordReset: async () => {},
    setNewPassword: async () => {},
    signOut: async () => {},
  }}>
    <CloudRealtimeSyncBoundary>
      <StagingP04AuthenticatedHarness />
    </CloudRealtimeSyncBoundary>
  </AuthContext.Provider>,
);
