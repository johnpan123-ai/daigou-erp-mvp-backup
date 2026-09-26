import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AuthContext } from '../../src/auth/authContext';
import {
  getCloudConnectivitySnapshot,
  markCloudReadFailed,
  markCloudReadFresh,
  markCloudReachable,
} from '../../src/providers/cloud/cloudConnectivity';
import { dataProvider } from '../../src/providers/dataProvider';
import Settings from '../../src/pages/Settings';

type Behavior = 'success' | 'count-read-failure' | 'bootstrap-variant-convergence' | 'bootstrap-all-convergence';
type Dataset = 'old' | 'restored' | 'variant-authoritative' | 'all-authoritative' | 'failure';

const lengths = {
  old: { inventory: 5517, salesOrders: 0, salesOrderItems: 0, productGroups: 705, productCategories: 390, productVariants: 3254 },
  restored: { inventory: 5517, salesOrders: 1, salesOrderItems: 2, productGroups: 847, productCategories: 663, productVariants: 4939 },
  'variant-authoritative': { inventory: 5517, salesOrders: 0, salesOrderItems: 0, productGroups: 705, productCategories: 390, productVariants: 3461 },
  'all-authoritative': { inventory: 6000, salesOrders: 3, salesOrderItems: 4, productGroups: 706, productCategories: 391, productVariants: 3462 },
};
const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `row-${index}` }));

const requestedBehavior = new URLSearchParams(window.location.search).get('behavior');
const behavior: Behavior = requestedBehavior === 'count-read-failure'
  || requestedBehavior === 'bootstrap-variant-convergence'
  || requestedBehavior === 'bootstrap-all-convergence'
  ? requestedBehavior
  : 'success';
let dataset: Dataset = 'old';
let restoreCalls = 0;
let countGetterCalls = 0;
let completionEvents = 0;
let latestRestoreCommand: Parameters<typeof dataProvider.restoreCloudSnapshot>[0] | null = null;
let root: Root | null = null;
let bootstrapPending = behavior === 'bootstrap-variant-convergence' || behavior === 'bootstrap-all-convergence';
let resolveBootstrap: ((converged: boolean) => void) | null = null;
const bootstrapPromise: Promise<boolean> = bootstrapPending
  ? new Promise(resolve => { resolveBootstrap = resolve; })
  : Promise.resolve(false);

const read = async (key: keyof typeof lengths.old) => {
  countGetterCalls += 1;
  if (dataset === 'failure') throw new Error('fixture count read failed');
  return rows(lengths[dataset][key]);
};

dataProvider.getInventory = () => read('inventory') as never;
dataProvider.getSalesOrders = () => read('salesOrders') as never;
dataProvider.getSalesOrderItems = () => read('salesOrderItems') as never;
dataProvider.getProductGroups = () => read('productGroups') as never;
dataProvider.getProductCategories = () => read('productCategories') as never;
dataProvider.getProductVariants = options => {
  if (!options?.raw) throw new Error('Settings fixture expected the raw stored Variant collection');
  return read('productVariants') as never;
};
dataProvider.waitForCloudBootstrapConvergence = () => (
  bootstrapPending ? bootstrapPromise : Promise.resolve(false)
);
dataProvider.getPendingCloudRestoreAttempts = async () => [];
dataProvider.proveCloudRestoreCandidate = async candidate => ({
  ok: true,
  candidateValid: true,
  schemaVersion: 'cloud-restore-candidate-proof-v1',
  policy: candidate.portability?.policyVersion ?? 'strict',
  resourceCount: candidate.manifest.resourceCount,
  coverageCount: 15,
  totalRows: candidate.manifest.totalRows,
  tableCounts: candidate.manifest.counts,
  transformedUpdatedByCount: candidate.portability?.totalTransformedRows ?? 0,
  sourceFingerprint: candidate.portability?.sourceSnapshotFingerprint ?? candidate.manifest.snapshotFingerprint,
  effectiveFingerprint: candidate.manifest.snapshotFingerprint,
  relationshipHash: candidate.manifest.relationshipHash,
  integrity: {
    orphanCount: candidate.manifest.orphanCount,
    duplicateVariantIdCount: candidate.manifest.duplicateVariantIdCount,
    duplicateVariantLocalIdCount: candidate.manifest.duplicateVariantLocalIdCount,
    duplicateCanonicalIdCount: candidate.manifest.duplicateCanonicalIdCount,
    canonicalIdentityAnomalyCount: candidate.manifest.canonicalIdentityAnomalyCount,
    unknownProductCount: candidate.manifest.unknownProductCount,
    optionalMetadataMissingReferenceCount: candidate.manifest.optionalMetadataMissingReferenceCount,
    duplicateInventoryKeyCount: 0,
    missingInventoryKeyCount: 0,
  },
  elapsedMs: 1,
});
dataProvider.prepareCloudRestoreAttempt = async command => ({
  status: 'executing',
  attemptId: command.idempotencyKey,
  traceId: command.attemptCorrelationId,
  executionId: '00000000-0000-4000-8000-000000000097',
  expectedEpoch: 1,
  effectiveFingerprint: command.candidate.manifest.snapshotFingerprint,
  reconcileAfter: '2026-09-21T00:02:15.000Z',
});
dataProvider.restoreCloudSnapshot = async command => {
  restoreCalls += 1;
  latestRestoreCommand = command;
  dataset = behavior === 'count-read-failure' ? 'failure' : 'restored';
  return {
    ok: true,
    replayed: false,
    idempotencyKey: command.idempotencyKey,
    snapshotFingerprint: command.candidate.manifest.snapshotFingerprint,
    rollbackSnapshotId: '00000000-0000-4000-8000-000000000098',
    restoreEpoch: 2,
    manifest: command.candidate.manifest,
    authoritativeRefresh: { status: 'complete' },
  };
};
dataProvider.readCloudRestoreIntegrityAudit = async () => {
  if (!latestRestoreCommand) throw new Error('missing completed Restore');
  const candidate = latestRestoreCommand.candidate;
  const manifest = candidate.manifest;
  return {
    schema_version: 'cloud-restore-integrity-audit-v1',
    audited_at: '2026-09-26T00:00:01.000Z',
    epoch: 2,
    table_counts: manifest.counts,
    total_rows: manifest.totalRows,
    relationship_hash: manifest.relationshipHash,
    integrity: {
      orphan_count: 0, optional_metadata_missing_reference_count: 0,
      duplicate_variant_id_count: 0, duplicate_variant_local_id_count: 0,
      duplicate_canonical_id_count: 0, canonical_identity_anomaly_count: 0,
      unknown_product_count: 0, duplicate_inventory_key_count: 0, missing_inventory_key_count: 0,
    },
    audit_policy: {
      policy: candidate.portability?.policyVersion ?? 'strict',
      covered_updated_by_non_null_count: 0,
      covered_updated_by_null_count: manifest.totalRows,
    },
    expected_manifest: { counts: manifest.counts, total_rows: manifest.totalRows, relationship_hash: manifest.relationshipHash },
    comparison: { counts_match: true, relationship_hash_match: true },
    restore_state: {
      latest_completed: {
        attempt_id: latestRestoreCommand.idempotencyKey, status: 'completed' as const, result_epoch: 2, replayed: false,
        source_fingerprint: candidate.portability?.sourceSnapshotFingerprint ?? manifest.snapshotFingerprint,
        effective_fingerprint: manifest.snapshotFingerprint, completed_at: '2026-09-26T00:00:00.000Z',
        source_transformed_updated_by_count: candidate.portability?.totalTransformedRows ?? 0,
      },
      pending_count: 0, executing_count: 0, processing_request_count: 0,
      active_lock_count: 0, metadata_inconsistency_count: 0, partial_state: 'not_detected' as const,
    },
  };
};

window.addEventListener('cloud-restore-completed', () => { completionEvents += 1; });
localStorage.setItem('erp_provider_mode', 'cloud');
markCloudReachable();
if (bootstrapPending) {
  setTimeout(() => {
    if (bootstrapPending) markCloudReadFailed(new Error('Cloud sync timed out after 4000ms'), true);
  }, 4000);
} else {
  markCloudReadFresh(1);
}

const user = {
  id: '00000000-0000-4000-8000-000000000099', email: 'owner@example.invalid',
  app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-09-13T00:00:00Z',
};

const render = () => {
  root = createRoot(document.getElementById('root')!);
  root.render(
    <AuthContext.Provider value={{
      user,
      profile: { role: 'owner', display_name: 'Restore Owner', is_active: true },
      loading: false, profileLoading: false, authFlow: 'normal',
      signInWithPassword: async () => {}, requestPasswordReset: async () => {},
      setNewPassword: async () => {}, signOut: async () => {},
    }}>
      <Settings />
    </AuthContext.Provider>,
  );
};

declare global {
  interface Window {
    __POST_RESTORE_SETTINGS_TEST__: {
      completeBootstrap: () => void;
      snapshot: () => {
        restoreCalls: number;
        countGetterCalls: number;
        completionEvents: number;
        dataset: Dataset;
        readStatus: string;
      };
      unmount: () => void;
    };
  }
}

window.__POST_RESTORE_SETTINGS_TEST__ = {
  completeBootstrap: () => {
    if (!bootstrapPending) return;
    bootstrapPending = false;
    dataset = behavior === 'bootstrap-variant-convergence' ? 'variant-authoritative' : 'all-authoritative';
    markCloudReadFresh(lengths[dataset].inventory + lengths[dataset].productGroups + lengths[dataset].productCategories + lengths[dataset].productVariants);
    resolveBootstrap?.(true);
  },
  snapshot: () => ({
    restoreCalls,
    countGetterCalls,
    completionEvents,
    dataset,
    readStatus: getCloudConnectivitySnapshot().readStatus,
  }),
  unmount: () => { root?.unmount(); root = null; },
};

render();
