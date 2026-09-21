import { STAGING_SUPABASE_PROJECT_REF, type SupabaseRuntimeRole } from './supabaseEnvironmentBoundary';
import type { CloudRestoreCommand, CloudRestoreExecutionCommand, CloudRestoreResult } from '../providers/cloud/cloudAtomicRestore';
import type { CloudRestoreTargetCompatibilityResult } from '../providers/cloud/cloudRestorePortability';

export interface StagingCloudRestoreBoundary {
  projectRef: string;
  runtimeRole: SupabaseRuntimeRole;
  viteMode?: string | null;
  deploymentEnvironment?: string | null;
}

export function assertStagingCloudRestoreBoundary(input: StagingCloudRestoreBoundary): void {
  const mode = input.viteMode?.trim().toLowerCase();
  const deployment = input.deploymentEnvironment?.trim().toLowerCase();
  if (input.projectRef !== STAGING_SUPABASE_PROJECT_REF
    || !['staging', 'experimental', 'test'].includes(input.runtimeRole)
    || !mode || !['staging', 'experimental', 'development', 'test'].includes(mode)
    || !deployment || !['staging', 'experimental', 'development', 'test'].includes(deployment)) {
    throw new Error('STAGING_CLOUD_RESTORE_HARNESS_DISABLED');
  }
}

export class StagingCloudRestoreHarnessController {
  readonly environment: Readonly<StagingCloudRestoreBoundary>;
  private readonly restore: (command: CloudRestoreExecutionCommand) => Promise<CloudRestoreResult>;
  private readonly preflight: (command: CloudRestoreCommand) => Promise<CloudRestoreTargetCompatibilityResult>;

  constructor(
    environment: StagingCloudRestoreBoundary,
    restore: (command: CloudRestoreExecutionCommand) => Promise<CloudRestoreResult>,
    preflight: (command: CloudRestoreCommand) => Promise<CloudRestoreTargetCompatibilityResult> = async () => {
      throw new Error('CLOUD_RESTORE_PORTABILITY_PREFLIGHT_REQUIRED');
    },
  ) {
    this.environment = Object.freeze({ ...environment });
    assertStagingCloudRestoreBoundary(this.environment);
    this.restore = restore;
    this.preflight = preflight;
  }

  async execute(command: CloudRestoreExecutionCommand): Promise<CloudRestoreResult> {
    assertStagingCloudRestoreBoundary(this.environment);
    return this.restore(command);
  }

  async validateTarget(command: CloudRestoreCommand): Promise<CloudRestoreTargetCompatibilityResult> {
    assertStagingCloudRestoreBoundary(this.environment);
    return this.preflight(command);
  }
}
