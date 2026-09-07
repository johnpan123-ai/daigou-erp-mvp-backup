import { isSandboxProviderMode } from '../providers/providerMode';
import type { CloudTargetedQuery } from '../providers/cloud/cloudTargetedCache';
import type { CloudResource, CloudSyncCoordinator } from '../providers/cloud/cloudSyncDomain';

export interface CloudRealtimeTestPayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
  commit_timestamp?: string;
}

export interface CloudRealtimeTestController {
  emit: (table: string, payload: CloudRealtimeTestPayload) => Promise<void>;
  emitMany: (events: Array<{ table: string; payload: CloudRealtimeTestPayload }>) => Promise<void>;
  fallback: (reason: 'focus' | 'visibility' | 'reconnect', resources?: CloudResource[]) => Promise<boolean>;
  metrics: () => ReturnType<CloudSyncCoordinator['snapshotMetrics']>;
}

export interface CloudRealtimeTestBridge {
  query: CloudTargetedQuery;
  attach: (controller: CloudRealtimeTestController) => void;
  detach?: () => void;
}

let installedTestBridge: CloudRealtimeTestBridge | null = null;

/** Test-only dependency boundary. It is unavailable in builds and outside an isolated Sandbox mode. */
export const installCloudRealtimeTestBridge = (bridge: CloudRealtimeTestBridge): (() => void) => {
  if (!import.meta.env.DEV || typeof window === 'undefined' || !isSandboxProviderMode()) {
    throw new Error('CLOUD_REALTIME_TEST_BRIDGE_SANDBOX_REQUIRED');
  }
  installedTestBridge = bridge;
  return () => {
    if (installedTestBridge === bridge) installedTestBridge = null;
  };
};

export const getCloudRealtimeTestBridge = (): CloudRealtimeTestBridge | null => installedTestBridge;
