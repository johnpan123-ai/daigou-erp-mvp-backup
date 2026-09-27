import type { CloudReadFreshnessStatus } from '../providers/cloud/cloudConnectivity';
import type {
  CloudReconnectDiagnostic,
  CloudResource,
  CloudSyncMetrics,
} from '../providers/cloud/cloudSyncDomain';
import {
  assertP04HarnessBoundary,
  type P04HarnessBoundaryInput,
} from './stagingP04AuthenticatedHarness';

export type RealtimeChannelState =
  | 'unavailable'
  | 'subscribing'
  | 'subscribed'
  | 'disconnecting'
  | 'unsubscribed'
  | 'error';

export interface StagingRealtimeFaultSnapshot {
  channelState: RealtimeChannelState;
  activeResources: CloudResource[];
  readStatus: CloudReadFreshnessStatus;
  reconnectGeneration: number;
  catchUpAttempt: number;
  retryCount: number;
  lastCatchUpResult: 'none' | 'success' | 'failure';
  targetedRefreshCount: number;
  fullPulls: number;
  diagnostics: CloudReconnectDiagnostic[];
  metrics: Readonly<CloudSyncMetrics>;
}

export interface StagingRealtimeFaultLifecycle {
  disconnect: () => Promise<StagingRealtimeFaultSnapshot>;
  reconnect: () => Promise<StagingRealtimeFaultSnapshot>;
  snapshot: () => StagingRealtimeFaultSnapshot;
}

/**
 * Final safety boundary for the browser-only Realtime fault controls.
 *
 * The immutable environment is asserted during construction and again before
 * every lifecycle operation. A route/UI mistake therefore cannot make these
 * controls operate against Production, Local, or an unknown Supabase project.
 */
export class StagingRealtimeFaultControl {
  private readonly environment: Readonly<P04HarnessBoundaryInput>;
  private readonly lifecycle: StagingRealtimeFaultLifecycle;

  constructor(
    environment: P04HarnessBoundaryInput,
    lifecycle: StagingRealtimeFaultLifecycle,
  ) {
    this.environment = Object.freeze({ ...environment });
    this.assertEnvironment();
    this.lifecycle = lifecycle;
  }

  private assertEnvironment(): void {
    assertP04HarnessBoundary(this.environment);
  }

  disconnect(): Promise<StagingRealtimeFaultSnapshot> {
    this.assertEnvironment();
    return this.lifecycle.disconnect();
  }

  reconnect(): Promise<StagingRealtimeFaultSnapshot> {
    this.assertEnvironment();
    return this.lifecycle.reconnect();
  }

  snapshot(): StagingRealtimeFaultSnapshot {
    this.assertEnvironment();
    return this.lifecycle.snapshot();
  }
}
