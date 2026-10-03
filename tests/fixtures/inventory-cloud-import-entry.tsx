import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { dataProvider } from '../../src/providers/dataProvider';
import type { InventoryItem, ProductGroup } from '../../src/lib/db';
import { normalizeProductTitle } from '../../src/lib/db';
import Inventory from '../../src/pages/Inventory';
import { ViewportProvider } from '../../src/contexts/ViewportContext';
import { BuyAnimeResumeError, inventoryProof, proveInventoryRows, type BuyAnimeImportRecord } from '../../src/providers/cloud/buyAnimeImportResume';
import { deterministicCloudUuid } from '../../src/providers/cloud/cloudEntityPayload';
import { linksFromMyAcgInventory, mergeMyAcgMasterLinks } from '../../src/waca/masterReference';
import { coordinateBuyAnimeImport, finishBuyAnimeImport, publishBuyAnimeFlow, buyAnimeFlowLabel } from '../../src/providers/cloud/buyAnimeImportCoordinator';

const inventoryRow = (index: number, title = `Authoritative ${index}`): InventoryItem => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  version: 1,
  inventory_key: `key-${index}`,
  myacg_item_code: `SKU-${index}`,
  product_title: title,
  normalized_product_title: title,
  raw_variant_name: '規格',
  listing_type: '日本代購',
  final_price: 10,
  myacg_available_quantity: 1,
  myacg_sold_quantity: 0,
  myacg_listed_at: '2026-09-13',
});

let inventory = Array.from({ length: 501 }, (_, index) => inventoryRow(index, `Incomplete cache ${index}`));
const authoritative = Array.from({ length: 1_469 }, (_, index) => inventoryRow(index));
const groups: ProductGroup[] = [
  ...authoritative.slice(0, 684).map((item, index) => ({
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    title: item.product_title,
    normalized_title: item.normalized_product_title,
    priority: 'Low' as const,
    purchase_date: '',
    closing_date: '',
    release_month: '',
    has_official_site: false,
    product_url: '',
  })),
  {
  id: '00000000-0000-4000-8000-000000009001',
  title: 'Existing Product',
  normalized_title: 'Existing Product',
  priority: 'Low',
  purchase_date: '',
  closing_date: '',
  release_month: '',
  has_official_site: false,
  product_url: '',
  },
];
let syncCalls = 0;
let upsertCalls = 0;
let nextImportError: { code?: string; message: string } | null = null;
const callOrder: string[] = [];
let delayedOldRead = false;
let returnOldInventoryOnce = false;
let failNextGroupRead = false;
let armPostCommitGroupReadFailure = false;
let bootstrapPending = true;
let resolveBootstrap: ((converged: boolean) => void) | null = null;
const bootstrapConvergence = new Promise<boolean>(resolve => { resolveBootstrap = resolve; });
let root: Root | null = null;
let mockRecovery: BuyAnimeImportRecord | null = null;
let allowCatalog = false;
let failBackup = false;

dataProvider.getProductGroups = async () => {
  callOrder.push('groups');
  if (failNextGroupRead) {
    failNextGroupRead = false;
    throw new Error('ISOLATED_AUTHORITATIVE_READ_FAILURE');
  }
  if (delayedOldRead) {
    delayedOldRead = false;
    await new Promise(resolve => window.setTimeout(resolve, 150));
    returnOldInventoryOnce = true;
  }
  return groups.map(group => ({ ...group }));
};
dataProvider.getInventory = async () => {
  callOrder.push('inventory');
  if (returnOldInventoryOnce) {
    returnOldInventoryOnce = false;
    return Array.from({ length: 450 }, (_, index) => inventoryRow(index, `Late stale ${index}`));
  }
  return inventory.map(row => ({ ...row }));
};
dataProvider.getInventoryCatalogSnapshot = async () => {
  callOrder.push('catalog-snapshot');
  return {
    inventory: inventory.map(row => ({ ...row })),
    productGroups: groups.map(group => ({ ...group })),
  };
};
dataProvider.waitForCloudBootstrapConvergence = async () => (
  bootstrapPending ? bootstrapConvergence : false
);
dataProvider.upsertInventory = async rows => {
  if (nextImportError) {
    const error = nextImportError;
    nextImportError = null;
    throw error;
  }
  upsertCalls += 1;
  for (const row of rows) {
    const inventoryKey = row.inventory_key || row.myacg_item_code;
    const index = inventory.findIndex(item => item.inventory_key === inventoryKey);
    const canonicalRow = { ...row, inventory_key: inventoryKey, id: index >= 0 ? inventory[index].id : deterministicCloudUuid('inventory_items:' + inventoryKey), version: 1 };
    if (index >= 0) inventory[index] = { ...inventory[index], ...canonicalRow };
    else inventory.push(canonicalRow);
  }
  if (armPostCommitGroupReadFailure) {
    armPostCommitGroupReadFailure = false;
    failNextGroupRead = true;
  }
  return { total: rows.length, newCount: rows.length, updatedCount: 0, unchangedCount: 0, groupCount: rows.length };
};
dataProvider.syncProductGroupsWithInventory = async () => {
  syncCalls += 1;
  if (!allowCatalog) throw new Error('SERVER_AUTHORITATIVE_TRANSACTION_REQUIRED');
  return { filledVariantsCount: 0, affectedGroupsCount: 0 };
};
dataProvider.getLastImportBackup = async () => null;
dataProvider.saveLastImportBackup = async () => {};

const empty = async () => [];
dataProvider.getSalesOrders = empty as never;
dataProvider.getSalesOrderItems = empty as never;
dataProvider.getProductCategories = empty as never;
dataProvider.getProductVariants = async () => [{
  id: '10000000-0000-4000-8000-000000008888', product_group_id: '10000000-0000-4000-8000-000000008887',
  myacg_item_code: 'GP-EVIDENCE-G', product_title: 'GP Evidence Product', variant_name: '規格',
}] as never;
dataProvider.getAuthoritativeWacaVariants = dataProvider.getProductVariants;
let wacaEvidenceCommits = 0;
let wacaMasterLinks: unknown[] = [];
dataProvider.getNextWacaSnapshot = async () => ({
  revision: wacaEvidenceCommits, orders: [], items: [], mappings: [], batches: [],
  masterLinks: wacaMasterLinks, cutoverAudit: [], cutoverState: {
    mode: 'LEGACY_QUANTITY_ACTIVE', updatedAt: '', sourceBackupFormatVersion: null,
  },
}) as never;
dataProvider.commitNextWacaSnapshot = async snapshot => {
  wacaMasterLinks = snapshot.masterLinks;
  wacaEvidenceCommits += 1;
  return wacaEvidenceCommits;
};
dataProvider.getBuyAnimeImportRecovery = async () => mockRecovery?.stage === 'COMPLETE' ? null : mockRecovery;
dataProvider.verifyBuyAnimeImportRecovery = async record => {
  const selected = inventory.filter(row => row.latest_catalog_import_id === record.batchId);
  await proveInventoryRows(record, selected);
};
dataProvider.importBuyAnimeInventory = async (rows, fileName) => {
  const stats = await dataProvider.upsertInventory(rows);
  const imported = inventory.filter(row => row.latest_catalog_import_id === rows[0].latest_catalog_import_id);
  mockRecovery = { format: 'BUYANIME_IMPORT_RESUME_V1', batchId: rows[0].latest_catalog_import_id!,
    observedAt: rows[0].catalog_last_seen_at!, fileName, stats, stage: 'INVENTORY_VERIFIED', version: 1,
    expected: await Promise.all(imported.map(inventoryProof)) };
  return mockRecovery;
};
dataProvider.resumeBuyAnimeImport = async record => {
  const imported = inventory.filter(row => row.latest_catalog_import_id === record.batchId);
  try {
    const currentGroups = await dataProvider.getProductGroups();
    if (currentGroups.some(group => imported.some(row => normalizeProductTitle(row.product_title) === normalizeProductTitle(group.title))))
      await dataProvider.syncProductGroupsWithInventory();
    const variants = await dataProvider.getAuthoritativeWacaVariants();
    const evidence = linksFromMyAcgInventory(imported, variants, record.fileName, record.observedAt);
    if (evidence.links.length) {
      const snapshot = await dataProvider.getNextWacaSnapshot();
      const masterLinks = mergeMyAcgMasterLinks(snapshot.masterLinks, evidence.links);
      if (JSON.stringify(masterLinks) !== JSON.stringify(snapshot.masterLinks))
        await dataProvider.commitNextWacaSnapshot({ ...snapshot, masterLinks }, snapshot.revision, false);
    }
    mockRecovery = { ...record, stage: 'COMPLETE' };
    return mockRecovery;
  } catch (cause) {
    mockRecovery = { ...record, stage: 'CATALOG_PENDING' };
    throw new BuyAnimeResumeError('BUYANIME_CATALOG_PENDING', mockRecovery, cause);
  }
};
dataProvider.recoverPendingBuyAnimeImport = async (options = {}) => coordinateBuyAnimeImport(async () => {
  const pending = await dataProvider.getBuyAnimeImportRecovery();
  if (!pending) return null;
  const result = await finishBuyAnimeImport(pending, dataProvider.resumeBuyAnimeImport, async () => {});
  options.onStage?.(result.stage); return result;
});
dataProvider.completeBuyAnimeImport = async (rows, fileName, options = {}) => coordinateBuyAnimeImport(async () => {
  const pending = await dataProvider.getBuyAnimeImportRecovery();
  if (pending) await finishBuyAnimeImport(pending, dataProvider.resumeBuyAnimeImport, async () => {});
  await options.beforeStart?.();
  const record = await dataProvider.importBuyAnimeInventory(rows, fileName);
  const result = await finishBuyAnimeImport(record, dataProvider.resumeBuyAnimeImport, async () => {});
  options.onStage?.(result.stage); publishBuyAnimeFlow(buyAnimeFlowLabel(result.stage)); return result;
});
dataProvider.getPurchaseBatches = empty as never;
dataProvider.getPurchaseBatchItems = empty as never;
dataProvider.getPrivateOrders = empty as never;
dataProvider.getPrivateOrderItems = empty as never;
dataProvider.getImportBatches = async () => { if (failBackup) { failBackup=false; throw new Error('ISOLATED_BACKUP_FAILED'); } return []; };
dataProvider.getBundleComponents = empty as never;
dataProvider.getJapanPackages = empty as never;
dataProvider.getJapanPackageItems = empty as never;
dataProvider.getOutboundShipments = empty as never;
dataProvider.getOutboundShipmentItems = empty as never;

localStorage.setItem('erp_provider_mode', 'cloud');

declare global {
  interface Window {
    __INVENTORY_CLOUD_IMPORT_TEST__: {
      failNextImport: (error: { code?: string; message: string }) => void;
      failNextBackup: () => void;
      failNextPostCommitGroupRead: () => void;
      allowCatalogResume: () => void;
      completeBootstrap: () => void;
      prepareLateStaleRead: () => void;
      remount: () => void;
      resetToServer500: () => void;
      snapshot: () => { callOrder: string[]; inventoryCount: number; syncCalls: number; upsertCalls: number; recoveryStage: string | null };
      evidenceSnapshot: () => { commits: number; links: unknown[] };
    };
  }
}

window.__INVENTORY_CLOUD_IMPORT_TEST__ = {
  failNextImport: error => { nextImportError = error; },
  failNextBackup: () => { failBackup=true; },
  failNextPostCommitGroupRead: () => { armPostCommitGroupReadFailure = true; },
  allowCatalogResume: () => { allowCatalog = true; },
  completeBootstrap: () => {
    if (!bootstrapPending) return;
    bootstrapPending = false;
    inventory = authoritative.map(row => ({ ...row }));
    resolveBootstrap?.(true);
  },
  prepareLateStaleRead: () => {
    inventory = Array.from({ length: 600 }, (_, index) => inventoryRow(index, `Latest ${index}`));
    delayedOldRead = true;
  },
  remount: () => {
    root?.unmount();
    root = createRoot(document.getElementById('root')!);
    root.render(<ViewportProvider><Inventory /></ViewportProvider>);
    // Simulate the authenticated application boundary's F5 durable recovery.
    void dataProvider.recoverPendingBuyAnimeImport().catch(() => {});
  },
  resetToServer500: () => {
    inventory = authoritative.slice(0, 500).map(row => ({ ...row }));
  },
  snapshot: () => ({ callOrder: [...callOrder], inventoryCount: inventory.length, syncCalls, upsertCalls,
    recoveryStage: mockRecovery?.stage || null }),
  evidenceSnapshot: () => ({ commits: wacaEvidenceCommits, links: [...wacaMasterLinks] }),
};

root = createRoot(document.getElementById('root')!);
root.render(<ViewportProvider><Inventory /></ViewportProvider>);
