import { getProviderMode } from '../providers/providerMode';
import { NEXT_SANDBOX_INDEXED_DB_NAME } from '../lib/testSandboxEnvironment';
import type { ProductVariant } from '../lib/db';
import {
  createWacaRepository, recomputeWacaQuantities,
  type WacaImportResult, type WacaItem, type WacaMapping, type WacaOrder, type WacaRepository,
  type WacaRow,
} from './orderCore';
import type { MyAcgMasterLink } from './masterReference';
import { buildWacaCutoverAudit } from './reconciliation';
import type { WacaCutoverState } from './backupFormat';

export interface WacaBatch {
  id: string;
  fileName: string;
  importedAt: string;
  rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  result: WacaImportResult;
  conflictRows: WacaRow[];
  reconciliation?: { status: 'PASS' | 'FAIL'; passed: number; total: number; effectiveQuantity: number; checkedAt: string };
}

export interface WacaCutoverAudit {
  productVariantId: string;
  sku: string;
  productTitle: string;
  variantTitle: string;
  legacyWacaQuantity: number;
  legacyAutoQuantity: number;
  unverifiedPreCutoverManualQuantity: number;
  newOrderDerivedQuantity: number;
  difference: number;
  cutoverAt: string;
}

export interface NextWacaSnapshot {
  revision: number;
  orders: WacaOrder[];
  items: WacaItem[];
  mappings: WacaMapping[];
  batches: WacaBatch[];
  masterLinks: MyAcgMasterLink[];
  cutoverAudit?: WacaCutoverAudit[];
  cutoverState?: WacaCutoverState;
}

export const NEXT_WACA_KEYS = {
  orders: 'erp_waca_orders_v1',
  items: 'erp_waca_items_v1',
  mappings: 'erp_waca_mappings_v1',
  batches: 'erp_waca_import_batches_v1',
  masterLinks: 'erp_myacg_master_links_v1',
  cutoverAudit: 'erp_waca_cutover_audit_v2',
  cutoverState: 'erp_waca_cutover_state_v1',
  revision: 'erp_waca_revision_v1',
} as const;

const assertNext = () => {
  if (getProviderMode() !== 'next') throw new Error('WACA_NEXT_ONLY');
};

const openNext = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  assertNext();
  const request = window.indexedDB.open(NEXT_SANDBOX_INDEXED_DB_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('NEXT_WACA_DB_OPEN_FAILED'));
});

const rows = <T>(value: unknown, key: string): T[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`NEXT_WACA_COLLECTION_INVALID:${key}`);
  }
  return value as T[];
};

export function validateNextWacaSnapshot(snapshot: NextWacaSnapshot, variants: readonly ProductVariant[]): void {
  if (snapshot.cutoverState && !['LEGACY_QUANTITY_ACTIVE', 'ORDER_REBASELINE_REQUIRED', 'ORDER_DRIVEN_ACTIVE']
    .includes(snapshot.cutoverState.mode)) throw new Error('NEXT_WACA_CUTOVER_STATE_INVALID');
  const unique = (values: readonly string[], label: string) => {
    if (new Set(values).size !== values.length) throw new Error(`NEXT_WACA_DUPLICATE:${label}`);
  };
  unique(snapshot.orders.map(row => row.key), 'orders');
  unique(snapshot.items.map(row => row.key), 'items');
  unique(snapshot.mappings.map(row => row.feature), 'mappings');
  unique(snapshot.batches.map(row => row.id), 'batches');
  unique(snapshot.masterLinks.map(row => row.childCode), 'masterLinks');
  unique((snapshot.cutoverAudit ?? []).map(row => row.productVariantId), 'cutoverAudit');
  const orderIds = new Set(snapshot.orders.map(row => row.key));
  const variantIds = new Set(variants.map(row => row.id));
  for (const item of snapshot.items) {
    if (!orderIds.has(item.orderKey)) throw new Error(`NEXT_WACA_ORPHAN_ORDER:${item.key}`);
    if (item.productVariantId && !variantIds.has(item.productVariantId)) throw new Error(`NEXT_WACA_ORPHAN_VARIANT:${item.key}`);
  }
  for (const mapping of snapshot.mappings) {
    if (!variantIds.has(mapping.productVariantId)) throw new Error(`NEXT_WACA_ORPHAN_MAPPING:${mapping.feature}`);
  }
  for (const link of snapshot.masterLinks) {
    if (!link.mainCode || !link.childCode) throw new Error(`NEXT_WACA_MASTER_LINK_INVALID:${link.childCode}`);
    if (link.productVariantId && !variantIds.has(link.productVariantId)) {
      throw new Error(`NEXT_WACA_ORPHAN_MASTER_LINK:${link.childCode}`);
    }
  }
  for (const row of snapshot.cutoverAudit ?? []) {
    // Historical cutover evidence can outlive a deleted product. Preserve the
    // audit without requiring it to belong to the current catalogue; only
    // active ledger items and mappings above participate in quantities.
    if (typeof row.productVariantId !== 'string' || !row.productVariantId.trim()
      || !Number.isFinite(Number(row.legacyWacaQuantity))
      || !Number.isFinite(Number(row.newOrderDerivedQuantity))) {
      throw new Error('NEXT_WACA_CUTOVER_AUDIT_INVALID');
    }
  }
}

export async function readNextWacaSnapshot(): Promise<NextWacaSnapshot> {
  const database = await openNext();
  try {
    return await new Promise<NextWacaSnapshot>((resolve, reject) => {
      const transaction = database.transaction('kv', 'readonly');
      const store = transaction.objectStore('kv');
      const values = new Map<string, unknown>();
      for (const key of Object.values(NEXT_WACA_KEYS)) {
        const request = store.get(key);
        request.onsuccess = () => values.set(key, request.result);
      }
      transaction.oncomplete = () => resolve({
        revision: Number(values.get(NEXT_WACA_KEYS.revision) ?? 0),
        orders: rows<WacaOrder>(values.get(NEXT_WACA_KEYS.orders), 'orders'),
        items: rows<WacaItem>(values.get(NEXT_WACA_KEYS.items), 'items'),
        mappings: rows<WacaMapping>(values.get(NEXT_WACA_KEYS.mappings), 'mappings'),
        batches: rows<WacaBatch>(values.get(NEXT_WACA_KEYS.batches), 'batches'),
        masterLinks: rows<MyAcgMasterLink>(values.get(NEXT_WACA_KEYS.masterLinks), 'masterLinks'),
        cutoverAudit: rows<WacaCutoverAudit>(values.get(NEXT_WACA_KEYS.cutoverAudit), 'cutoverAudit'),
        cutoverState: values.get(NEXT_WACA_KEYS.cutoverState) as WacaCutoverState | undefined,
      });
      transaction.onerror = () => reject(transaction.error ?? new Error('NEXT_WACA_READ_FAILED'));
      transaction.onabort = () => reject(transaction.error ?? new Error('NEXT_WACA_READ_ABORTED'));
    });
  } finally {
    database.close();
  }
}

export function repositoryFromSnapshot(snapshot: NextWacaSnapshot, variants: readonly ProductVariant[]): WacaRepository {
  validateNextWacaSnapshot(snapshot, variants);
  const repo = createWacaRepository();
  repo.orders = new Map(snapshot.orders.map(row => [row.key, { ...row }]));
  repo.items = new Map(snapshot.items.map(row => [row.key, { ...row }]));
  repo.mappings = new Map(snapshot.mappings.map(row => [row.feature, { ...row }]));
  repo.importHistory = snapshot.batches.map(row => ({ ...row }));
  repo.manualAdjustments = new Map(variants.map(row => [row.id, row.waca_manual_adjustment ?? 0]));
  recomputeWacaQuantities(repo);
  return repo;
}

export function snapshotFromRepository(
  prior: NextWacaSnapshot, repo: WacaRepository, batches: WacaBatch[], masterLinks = prior.masterLinks,
): NextWacaSnapshot {
  return {
    revision: prior.revision,
    orders: [...repo.orders.values()],
    items: [...repo.items.values()],
    mappings: [...repo.mappings.values()],
    batches,
    masterLinks,
    cutoverAudit: prior.cutoverAudit ?? [],
    cutoverState: prior.cutoverState,
  };
}

/** A single IndexedDB transaction owns the WACA ledger and the derived Variant quantity. */
export async function commitNextWacaSnapshot(
  snapshot: NextWacaSnapshot,
  expectedRevision: number,
  updateAutoQuantity: boolean,
): Promise<number> {
  assertNext();
  const database = await openNext();
  try {
    const committedRevision = await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      const store = transaction.objectStore('kv');
      const currentRevision = store.get(NEXT_WACA_KEYS.revision);
      const variantRequest = store.get('erp_product_variants');
      const beforeOrdersRequest = store.get(NEXT_WACA_KEYS.orders);
      const beforeItemsRequest = store.get(NEXT_WACA_KEYS.items);
      let revisionReady = false, variantReady = false, ordersReady = false, itemsReady = false;
      let failure: Error | null = null;
      const abort = (error: Error) => {
        failure = error;
        try { transaction.abort(); } catch { /* already closed */ }
      };
      const stage = () => {
        if (!revisionReady || !variantReady || !ordersReady || !itemsReady) return;
        const revision = Number(currentRevision.result ?? 0);
        if (revision !== expectedRevision) { abort(new Error('NEXT_WACA_STALE_REVISION')); return; }
        const variants = rows<ProductVariant>(variantRequest.result, 'productVariants');
        try { validateNextWacaSnapshot(snapshot, variants); } catch (error) { abort(error as Error); return; }
        let nextVariants = variants;
        let cutoverAudit = snapshot.cutoverAudit ?? [];
        const previousState = snapshot.cutoverState;
        const cutoverState: WacaCutoverState = updateAutoQuantity ? {
          mode: 'ORDER_DRIVEN_ACTIVE', updatedAt: new Date().toISOString(),
          sourceBackupFormatVersion: previousState?.sourceBackupFormatVersion ?? null,
        } : previousState ?? {
          mode: cutoverAudit.length ? 'ORDER_DRIVEN_ACTIVE' : 'LEGACY_QUANTITY_ACTIVE',
          updatedAt: new Date().toISOString(), sourceBackupFormatVersion: null,
        };
        if (updateAutoQuantity) {
          const repo = repositoryFromSnapshot(snapshot, variants);
          if (!cutoverAudit.length && variants.length) {
            const beforeOrders = rows<WacaOrder>(beforeOrdersRequest.result, 'orders');
            const beforeItems = rows<WacaItem>(beforeItemsRequest.result, 'items');
            const priorRepo = createWacaRepository();
            priorRepo.orders = new Map(beforeOrders.map(row => [row.key, row]));
            priorRepo.items = new Map(beforeItems.map(row => [row.key, row]));
            recomputeWacaQuantities(priorRepo);
            cutoverAudit = buildWacaCutoverAudit(
              variants, priorRepo.autoQuantities, repo.autoQuantities, new Date().toISOString(),
            );
          }
          nextVariants = variants.map(variant => ({
            ...variant,
            waca_auto_quantity: repo.autoQuantities.get(variant.id) ?? 0,
            // Match the Cloud transaction contract: the first order-driven
            // cutover replaces the complete legacy aggregate. Historical audit
            // rows are evidence only and must never keep legacy manual quantity
            // alive during ORDER_REBASELINE_REQUIRED.
            waca_manual_adjustment: previousState?.mode === 'ORDER_DRIVEN_ACTIVE'
              ? (variant.waca_manual_adjustment ?? 0) : 0,
          }));
        }
        try {
          store.put(snapshot.orders, NEXT_WACA_KEYS.orders);
          store.put(snapshot.items, NEXT_WACA_KEYS.items);
          store.put(snapshot.mappings, NEXT_WACA_KEYS.mappings);
          store.put(snapshot.batches, NEXT_WACA_KEYS.batches);
          store.put(snapshot.masterLinks, NEXT_WACA_KEYS.masterLinks);
          store.put(cutoverAudit, NEXT_WACA_KEYS.cutoverAudit);
          store.put(cutoverState, NEXT_WACA_KEYS.cutoverState);
          if (updateAutoQuantity) store.put(nextVariants, 'erp_product_variants');
          store.put(revision + 1, NEXT_WACA_KEYS.revision);
        } catch (error) {
          abort(error as Error);
        }
      };
      currentRevision.onsuccess = () => { revisionReady = true; stage(); };
      variantRequest.onsuccess = () => { variantReady = true; stage(); };
      beforeOrdersRequest.onsuccess = () => { ordersReady = true; stage(); };
      beforeItemsRequest.onsuccess = () => { itemsReady = true; stage(); };
      transaction.oncomplete = () => resolve(expectedRevision + 1);
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('NEXT_WACA_WRITE_FAILED'));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('NEXT_WACA_WRITE_ABORTED'));
    });
    return committedRevision;
  } finally {
    database.close();
  }
}
