import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import Purchasing from '../../src/pages/Purchasing';
import { ViewportProvider } from '../../src/contexts/ViewportContext';
import { dataProvider, StaleDataError } from '../../src/providers/dataProvider';
import type { PurchaseBatchTransactionCommand } from '../../src/providers/cloud/purchaseBatchTransaction';
import { PurchaseBatchSubmitBoundaryError } from '../../src/providers/cloud/purchaseBatchTransaction';
import { CloudOfflineWriteError } from '../../src/providers/cloud/cloudConnectivity';
import type { ProductGroup, ProductVariant, PurchaseBatch, PurchaseBatchItem } from '../../src/lib/db';

type Scenario = 'success' | 'stale' | 'readiness' | 'conflict' | 'server-rejected' | 'unknown' | 'postcommit' | 'pending' | 'convergence';

const groupId = '60000000-0000-4000-8000-000000000001';
const variantId = '60000000-0000-4000-8000-000000000002';
const group = {
  id: groupId,
  local_id: groupId,
  title: 'F2 Real UI Group',
  normalized_title: 'F2 Real UI Group',
  listing_type: '日版',
  show_in_purchase_list: true,
  deleted_at: null,
  version: 1,
} as unknown as ProductGroup;
const staleGroup = { ...group, title: 'F2 Stale Cache Group', normalized_title: 'F2 Stale Cache Group' } as ProductGroup;
const authoritativeGroup = { ...group, title: 'F2 Authoritative Group', normalized_title: 'F2 Authoritative Group', version: 2 } as ProductGroup;
const variant = {
  id: variantId,
  local_id: variantId,
  product_group_id: groupId,
  product_category_id: null,
  variant_name: '白上フブキ',
  myacg_item_code: 'G07413438',
  source: 'catalog',
  default_jpy_cost: 2200,
  effective_myacg_quantity: 7,
  myacg_manual_adjustment: 0,
  waca_auto_quantity: 0,
  waca_manual_adjustment: 0,
  deleted_at: null,
  version: 1,
} as unknown as ProductVariant;

const scenario = (new URLSearchParams(window.location.search).get('scenario') || 'success') as Scenario;
let batches: PurchaseBatch[] = [];
let items: PurchaseBatchItem[] = [];
let saveCalls = 0;
let rpcCalls = 0;
let variantWriteCalls = 0;
let capturedCommand: PurchaseBatchTransactionCommand | null = null;
const idempotencyKeys: string[] = [];
let releasePending: (() => void) | null = null;
let authoritativeCacheReady = false;
let groupReadCalls = 0;
const convergenceResolvers: Array<(value: boolean) => void> = [];

const commit = (command: PurchaseBatchTransactionCommand) => {
  batches = [command.batch];
  items = command.items;
};

Object.assign(dataProvider, {
  getProductGroups: async () => {
    groupReadCalls += 1;
    if (scenario === 'convergence') return [authoritativeCacheReady ? authoritativeGroup : staleGroup];
    return [group];
  },
  getProductVariants: async () => [variant],
  getProductCategories: async () => [],
  getPrivateOrders: async () => [],
  getPrivateOrderItems: async () => [],
  getInventory: async () => [],
  getPurchaseBatchItems: async () => items,
  getSalesOrderItems: async () => [],
  getPurchaseBatches: async () => batches,
  waitForCloudBootstrapConvergence: async () => {
    if (scenario !== 'convergence') return false;
    return new Promise<boolean>(resolve => convergenceResolvers.push(resolve));
  },
  registerFreshLoad: () => {},
  checkIsStaleLive: () => false,
  onStaleChange: () => () => {},
  saveProductVariants: async () => { variantWriteCalls += 1; },
  savePurchaseBatchTransaction: async (command: PurchaseBatchTransactionCommand) => {
    saveCalls += 1;
    capturedCommand = structuredClone(command);
    idempotencyKeys.push(command.idempotencyKey);
    if (scenario === 'stale') throw new StaleDataError();
    if (scenario === 'readiness') throw new CloudOfflineWriteError();
    rpcCalls += 1;
    if (scenario === 'conflict') {
      const error = new Error('採購批次已由其他裝置更新，請重新確認後再儲存。');
      error.name = 'PurchaseBatchTransactionError';
      throw error;
    }
    if (scenario === 'server-rejected') throw new PurchaseBatchSubmitBoundaryError('server-rejected');
    if (scenario === 'unknown') throw new PurchaseBatchSubmitBoundaryError('result-unknown');
    if (scenario === 'postcommit') {
      commit(command);
      throw new PurchaseBatchSubmitBoundaryError('committed-sync-pending');
    }
    if (scenario === 'pending') {
      await new Promise<void>(resolve => { releasePending = () => { commit(command); resolve(); }; });
      return;
    }
    commit(command);
  },
});

window.__PURCHASE_BATCH_SUBMIT_TEST__ = {
  snapshot: () => ({
    scenario,
    saveCalls,
    rpcCalls,
    variantWriteCalls,
    batches: structuredClone(batches),
    items: structuredClone(items),
    command: capturedCommand ? structuredClone(capturedCommand) : null,
    idempotencyKeys: [...idempotencyKeys],
    groupReadCalls,
    authoritativeCacheReady,
  }),
  releasePending: () => releasePending?.(),
  releaseConvergence: () => {
    authoritativeCacheReady = true;
    convergenceResolvers.splice(0).forEach(resolve => resolve(true));
  },
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={['/purchasing']}>
      <ViewportProvider><Purchasing /></ViewportProvider>
    </MemoryRouter>
  </React.StrictMode>,
);

declare global {
  interface Window {
    __PURCHASE_BATCH_SUBMIT_TEST__: {
      snapshot: () => Record<string, unknown>;
      releasePending: () => void;
      releaseConvergence: () => void;
    };
  }
}
