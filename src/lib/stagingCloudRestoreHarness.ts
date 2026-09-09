import { STAGING_SUPABASE_PROJECT_REF, type SupabaseRuntimeRole } from './supabaseEnvironmentBoundary';
import type { CloudRestoreCommand, CloudRestoreResult } from '../providers/cloud/cloudAtomicRestore';

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
  private readonly restore: (command: CloudRestoreCommand) => Promise<CloudRestoreResult>;

  constructor(
    environment: StagingCloudRestoreBoundary,
    restore: (command: CloudRestoreCommand) => Promise<CloudRestoreResult>,
  ) {
    this.environment = Object.freeze({ ...environment });
    assertStagingCloudRestoreBoundary(this.environment);
    this.restore = restore;
  }

  async execute(command: CloudRestoreCommand): Promise<CloudRestoreResult> {
    assertStagingCloudRestoreBoundary(this.environment);
    return this.restore(command);
  }
}
