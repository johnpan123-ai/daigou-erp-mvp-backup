import { useMemo } from 'react';
import CloudAtomicRestorePanel from '../components/CloudAtomicRestorePanel';
import { useAuth } from '../auth/authContext';
import { dataProvider } from '../providers/dataProvider';
import { supabaseEnvironment } from '../providers/cloud/supabaseClient';
import {
  StagingCloudRestoreHarnessController,
  assertStagingCloudRestoreBoundary,
} from '../lib/stagingCloudRestoreHarness';

const environment = {
  projectRef: supabaseEnvironment.projectRef,
  runtimeRole: supabaseEnvironment.role,
  viteMode: import.meta.env.MODE,
  deploymentEnvironment: import.meta.env.VITE_DEPLOYMENT_ENV,
} as const;

export default function StagingCloudRestoreHarness() {
  const { user, profile } = useAuth();
  let blocked: string | null = null;
  try {
    assertStagingCloudRestoreBoundary(environment);
  } catch (error) {
    blocked = error instanceof Error ? error.message : 'STAGING_CLOUD_RESTORE_HARNESS_DISABLED';
  }
  const controller = useMemo(() => {
    try {
      return new StagingCloudRestoreHarnessController(
        environment,
        command => dataProvider.restoreCloudSnapshot(command),
        command => dataProvider.validateCloudRestoreTarget(command),
      );
    } catch {
      return null;
    }
  }, []);
  if (blocked || !controller) {
    return <main data-testid="cloud-restore-harness-blocked"><h1>Not available</h1><code>{blocked}</code></main>;
  }
  return (
    <main data-testid="staging-cloud-restore-harness" style={{ maxWidth: 1000, margin: '32px auto', padding: 24 }}>
      <h1 style={{ color: '#991b1b' }}>STAGING TEST ONLY — CLOUD ATOMIC RESTORE</h1>
      <dl style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 8 }}>
        <dt>Project</dt><dd data-testid="cloud-restore-harness-project">{controller.environment.projectRef}</dd>
        <dt>Authenticated</dt><dd data-testid="cloud-restore-harness-auth">{user ? 'true' : 'false'}</dd>
        <dt>Role</dt><dd data-testid="cloud-restore-harness-role">{profile?.role ?? 'none'}</dd>
        <dt>Credentials</dt><dd>Normal App session；token exposure = 0</dd>
      </dl>
      <CloudAtomicRestorePanel
        executeRestore={command => controller.execute(command)}
        validateRestoreTarget={command => controller.validateTarget(command)}
      />
    </main>
  );
}
