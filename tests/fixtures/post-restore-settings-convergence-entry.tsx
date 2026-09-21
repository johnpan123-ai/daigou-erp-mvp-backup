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
