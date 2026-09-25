import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import JapanPackageDetail from '../../src/pages/JapanPackageDetail';
import { ViewportProvider } from '../../src/contexts/ViewportContext';
import { dataProvider, StaleDataError } from '../../src/providers/dataProvider';
import {
  JapanPackageSubmitBoundaryError,
  type JapanPackageTransactionCommand,
} from '../../src/providers/cloud/japanPackageTransaction';
import { CloudOfflineWriteError } from '../../src/providers/cloud/cloudConnectivity';
import type { JapanPackage, JapanPackageItem } from '../../src/lib/db';

type Scenario = 'success' | 'stale' | 'offline' | 'server-rejected' | 'unknown' | 'pending' | 'postcommit';
const packageId = '72000000-0000-4000-8000-000000000001';
const itemId = '72000000-0000-4000-8000-000000000002';
const scenario = (new URLSearchParams(window.location.search).get('scenario') || 'success') as Scenario;
let packageRow: JapanPackage = {
  id: packageId,
  title: 'F3 Transaction Fixture',
  status: 'arrived',
  arrived_at: '2026-09-19',
  created_at: '2026-09-19T00:00:00.000Z',
  updated_at: '2026-09-19T00:00:00.000Z',
  version: 1,
};
let items: JapanPackageItem[] = [{
  id: itemId,
  japan_package_id: packageId,
  product_title: 'F3 Transaction Item',
  variant_name: 'F3 Variant',
  sku: 'F3-ATOMIC-SKU',
  quantity: 1,
  checked: false,
  created_at: '2026-09-19T00:00:00.000Z',
  updated_at: '2026-09-19T00:00:00.000Z',
  version: 1,
}];
let transactionCalls = 0;
let rpcCalls = 0;
let oldPackageWrites = 0;
let oldItemWrites = 0;
let releasePending: (() => void) | null = null;
const idempotencyKeys: string[] = [];

Object.assign(dataProvider, {
  getJapanPackages: async () => [structuredClone(packageRow)],
  getJapanPackageItems: async () => structuredClone(items),
  getProductGroups: async () => [],
  getProductVariants: async () => [],
  getProductCategories: async () => [],
  getPurchaseBatches: async () => [],
  getPurchaseBatchItems: async () => [],
  getBundleComponents: async () => [],
  getOutboundShipmentItems: async () => [],
  saveJapanPackages: async () => { oldPackageWrites += 1; },
  saveJapanPackageItems: async () => { oldItemWrites += 1; },
  applyJapanPackageTransaction: async (command: JapanPackageTransactionCommand) => {
    transactionCalls += 1;
    idempotencyKeys.push(command.idempotencyKey);
    if (scenario === 'stale') throw new StaleDataError();
    if (scenario === 'offline') throw new CloudOfflineWriteError();
    rpcCalls += 1;
    if (scenario === 'server-rejected') throw new JapanPackageSubmitBoundaryError('server-rejected');
    if (scenario === 'unknown') throw new JapanPackageSubmitBoundaryError('result-unknown');
    if (scenario === 'pending') await new Promise<void>(resolve => { releasePending = resolve; });
    if (command.transactionType !== 'set-receiving') throw new Error('FIXTURE_EXPECTED_RECEIVING');
    const update = command.updates[0];
    const checkedAt = update.checked ? (update.checkedAt || '2026-09-19T01:00:00.000Z') : undefined;
    items = items.map(item => item.id === update.itemId ? {
      ...item,
      checked: update.checked,
      checked_at: checkedAt,
      version: Number(item.version) + 1,
    } : item);
    packageRow = {
      ...packageRow,
      status: items.every(item => item.checked) ? 'confirmed' : 'arrived',
      version: Number(packageRow.version) + 1,
    };
    return {
      ok: true,
      transactionType: command.transactionType,
      idempotencyKey: command.idempotencyKey,
      replayed: false,
      package: structuredClone(packageRow) as unknown as Record<string, unknown>,
      items: structuredClone(items) as unknown as Array<Record<string, unknown>>,
      syncPending: scenario === 'postcommit',
    };
  },
});

window.__JAPAN_PACKAGE_TRANSACTION_TEST__ = {
  snapshot: () => ({
    scenario,
    transactionCalls,
    rpcCalls,
    oldPackageWrites,
    oldItemWrites,
    packageRow: structuredClone(packageRow),
    items: structuredClone(items),
    idempotencyKeys: [...idempotencyKeys],
  }),
  releasePending: () => releasePending?.(),
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={[`/japan-packages/${packageId}`]}>
      <ViewportProvider>
        <Routes><Route path="/japan-packages/:id" element={<JapanPackageDetail />} /></Routes>
      </ViewportProvider>
    </MemoryRouter>
  </React.StrictMode>,
);

declare global {
  interface Window {
    __JAPAN_PACKAGE_TRANSACTION_TEST__: {
      snapshot: () => Record<string, unknown>;
      releasePending: () => void;
    };
  }
}
