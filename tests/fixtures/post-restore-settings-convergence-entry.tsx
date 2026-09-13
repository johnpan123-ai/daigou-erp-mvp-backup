import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AuthContext } from '../../src/auth/authContext';
import { markCloudReadFresh, markCloudReachable } from '../../src/providers/cloud/cloudConnectivity';
import { dataProvider } from '../../src/providers/dataProvider';
import Settings from '../../src/pages/Settings';

type Behavior = 'success' | 'count-read-failure';
type Dataset = 'old' | 'new' | 'failure';

const lengths = {
  old: { inventory: 2, salesOrders: 0, salesOrderItems: 0, productGroups: 3, productCategories: 4, productVariants: 5 },
  new: { inventory: 7, salesOrders: 1, salesOrderItems: 2, productGroups: 8, productCategories: 9, productVariants: 10 },
};
const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `row-${index}` }));

let behavior: Behavior = 'success';
let dataset: Dataset = 'old';
let restoreCalls = 0;
let countGetterCalls = 0;
let completionEvents = 0;
let root: Root | null = null;

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
dataProvider.getProductVariants = () => read('productVariants') as never;
dataProvider.restoreCloudSnapshot = async command => {
  restoreCalls += 1;
  dataset = behavior === 'count-read-failure' ? 'failure' : 'new';
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
markCloudReadFresh(1);

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
      reset: (next: Behavior) => void;
      snapshot: () => { restoreCalls: number; countGetterCalls: number; completionEvents: number; dataset: Dataset };
      unmount: () => void;
    };
  }
}

window.__POST_RESTORE_SETTINGS_TEST__ = {
  reset: next => {
    behavior = next;
    dataset = 'old';
    restoreCalls = 0;
    countGetterCalls = 0;
    completionEvents = 0;
  },
  snapshot: () => ({ restoreCalls, countGetterCalls, completionEvents, dataset }),
  unmount: () => { root?.unmount(); root = null; },
};

render();
