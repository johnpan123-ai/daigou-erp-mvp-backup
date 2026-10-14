import type {
  BundleComponent,
  InventoryItem,
  JapanPackage,
  JapanPackageItem,
  OutboundShipment,
  OutboundShipmentItem,
  PrivateOrder,
  PrivateOrderItem,
  PurchaseBatchItem,
} from '../../lib/db';
import { cloudCacheDb as db } from '../../lib/db';
import { supabase } from './supabaseClient';
import type { CloudChange, CloudRefreshRequest, CloudRefreshResult, CloudResource } from './cloudSyncDomain';
import { cloudBusinessRowsEqual } from './cloudRealtimeComparison';
import { assertExpectedCloudFields, readCloudRowsByIds } from './cloudBulkRead';
import { CLOUD_TABLE_RESOURCE, resolveCloudRowIdentity } from './cloudSyncDomain';
import { awaitCatalogCommitReadFence } from './catalogCommitReadFence';
import { recordBuyAnimeCatalogEvidence } from '../../diagnostics/buyAnimeProductionTrace';
import {
  getCloudConnectivitySnapshot,
  markCloudReadFailed,
  markCloudReadFresh,
  markCloudReadLoading,
  markCloudReachable,
  markCloudRequestFailed,
} from './cloudConnectivity';
import {
  beginCloudSnapshot,
  CloudCacheFenceRejectedError,
  cloudReadPassesEpochBarrier,
  commitCloudSnapshot,
  commitCloudTargeted,
  endCloudSnapshot,
  noteSkippedStaleDelete,
  takeCloudReadToken,
} from './cloudCacheWriteFence';
import { finishCloudSyncRun, recordCloudSyncPage, startCloudSyncRun } from './cloudSyncObservability';

type Row = Record<string, unknown> & { id?: string; local_id?: string; deleted_at?: string | null; updated_at?: string };

export interface CloudTargetedQueryRequest {
  table: string;
  databaseIds?: string[];
  updatedAfter?: string;
  from?: number;
  to?: number;
  /** P0-2 Phase 1a keyset page: rows with id > afterId (null = first page), ordered by id. */
  keyset?: { afterId: string | null; limit: number };
  /** Exclude soft-deleted rows on the server. */
  activeOnly?: boolean;
  signal?: AbortSignal;
}

export type CloudTargetedQuery = (request: CloudTargetedQueryRequest) => Promise<Row[]>;

interface TableCacheAdapter<T extends { id: string }> {
  get: () => Promise<T[]>;
  save: (rows: T[]) => Promise<void>;
  map: (row: Row) => T;
  supportsIncremental: boolean;
}

const TABLE_STORAGE_KEYS: Readonly<Record<string, string>> = {
  product_groups: 'erp_product_groups', product_categories: 'erp_product_categories', product_variants: 'erp_product_variants',
  inventory_items: 'erp_inventory', purchase_batches: 'erp_purchase_batches', purchase_batch_items: 'erp_purchase_batch_items',
  private_orders: 'erp_private_orders', private_order_items: 'erp_private_order_items', japan_packages: 'erp_japan_packages',
  japan_package_items: 'erp_japan_package_items', bundle_components: 'erp_bundle_components', outbound_shipments: 'erp_outbound_shipments',
  outbound_shipment_items: 'erp_outbound_shipment_items', sales_orders: 'erp_sales_orders', sales_order_items: 'erp_sales_order_items',
};

const canonicalId = (table: string, row: Row): string => resolveCloudRowIdentity(table, row).canonicalId;
const commonMeta = (row: Row) => ({
  database_id: typeof row.id === 'string' ? row.id : undefined,
  local_id: typeof row.local_id === 'string' && row.local_id ? row.local_id : undefined,
  updated_at: typeof row.updated_at === 'string' ? row.updated_at : undefined,
  version: typeof row.version === 'number' ? row.version : undefined,
});

const TABLES: Readonly<Record<string, TableCacheAdapter<any>>> = {
  product_groups: { get: () => db.getProductGroups(), save: rows => db.saveProductGroups(rows), map: row => ({ ...row, id: canonicalId('product_groups', row), ...commonMeta(row) }), supportsIncremental: true },
  product_categories: { get: () => db.getProductCategories(), save: rows => db.saveProductCategories(rows), map: row => ({ ...row, id: canonicalId('product_categories', row), ...commonMeta(row) }), supportsIncremental: true },
  product_variants: { get: () => db.getProductVariants({ raw: true }), save: rows => db.replaceProductVariantsFromAuthoritativeCloud(rows), map: row => ({ ...row, id: canonicalId('product_variants', row), ...commonMeta(row) }), supportsIncremental: true },
  inventory_items: {
    get: () => db.getInventory(),
    save: rows => db.saveInventory(rows),
    map: row => ({
      id: canonicalId('inventory_items', row),
      inventory_key: String(row.inventory_key || ''),
      myacg_item_code: String(row.myacg_item_code || ''),
      myacg_parent_code: typeof row.myacg_parent_code === 'string' ? row.myacg_parent_code : undefined,
      product_id: typeof row.product_id === 'string' ? row.product_id : undefined,
      product_title: String(row.product_title || ''),
      normalized_product_title: typeof row.normalized_product_title === 'string' ? row.normalized_product_title : undefined,
      raw_variant_name: String(row.raw_variant_name || ''),
      listing_type: String(row.listing_type || ''),
      final_price: Number(row.final_price ?? 0),
      myacg_available_quantity: Number(row.myacg_available_quantity ?? 0),
      myacg_sold_quantity: Number(row.myacg_sold_quantity ?? 0),
      myacg_demand_quantity: Number(row.myacg_demand_quantity ?? 0),
      myacg_listed_at: String(row.myacg_listed_at || ''),
      import_sort_index: row.import_sort_index == null ? undefined : Number(row.import_sort_index),
      latest_catalog_import_id: typeof row.latest_catalog_import_id === 'string' ? row.latest_catalog_import_id : undefined,
      catalog_last_seen_at: typeof row.catalog_last_seen_at === 'string' ? row.catalog_last_seen_at : undefined,
      ...commonMeta(row),
    } as InventoryItem),
    supportsIncremental: true,
  },
  purchase_batches: { get: () => db.getPurchaseBatches(), save: rows => db.savePurchaseBatches(rows), map: row => ({ ...row, id: canonicalId('purchase_batches', row), ...commonMeta(row) }), supportsIncremental: true },
  purchase_batch_items: {
    get: () => db.getPurchaseBatchItems(),
    save: rows => db.savePurchaseBatchItems(rows),
    map: row => ({
      id: canonicalId('purchase_batch_items', row), purchase_batch_id: row.purchase_batch_id, product_variant_id: row.product_variant_id,
      quantity: Number(row.quantity ?? 0), cost: Number(row.cost ?? 0), note: String(row.note || ''), ...commonMeta(row),
    } as PurchaseBatchItem),
    supportsIncremental: true,
  },
  private_orders: {
    get: () => db.getPrivateOrders(), save: rows => db.savePrivateOrders(rows),
    map: row => ({
      id: canonicalId('private_orders', row), product_group_id: row.product_group_id, customer_name: row.customer_name,
      contact: String(row.contact || ''), note: String(row.note || ''), created_at: row.created_at, ...commonMeta(row),
    } as PrivateOrder), supportsIncremental: true,
  },
  private_order_items: {
    get: () => db.getPrivateOrderItems(), save: rows => db.savePrivateOrderItems(rows),
    map: row => ({
      id: canonicalId('private_order_items', row), private_order_id: row.private_order_id, product_variant_id: row.product_variant_id,
      quantity: Number(row.quantity ?? 0), amount: Number(row.amount ?? 0), note: String(row.note || ''), ...commonMeta(row),
    } as PrivateOrderItem), supportsIncremental: true,
  },
  japan_packages: {
    get: () => db.getJapanPackages(), save: rows => db.saveJapanPackages(rows),
    map: row => ({
      id: canonicalId('japan_packages', row), title: String(row.title || ''), vendor_name: String(row.vendor_name || ''), carrier: String(row.carrier || ''),
      tracking_number: String(row.tracking_number || ''), shipped_at: String(row.shipped_at || ''), expected_arrival_at: String(row.expected_arrival_at || ''),
      arrived_at: String(row.arrived_at || ''), status: String(row.status || 'registered'), note: String(row.note || ''),
      created_at: row.created_at, ...commonMeta(row),
    } as JapanPackage), supportsIncremental: true,
  },
  japan_package_items: {
    get: () => db.getJapanPackageItems(), save: rows => db.saveJapanPackageItems(rows),
    map: row => ({
      id: canonicalId('japan_package_items', row), japan_package_id: row.japan_package_id, product_group_id: row.product_group_id || undefined,
      product_variant_id: row.product_variant_id || undefined, purchase_batch_id: row.purchase_batch_id || undefined,
      purchase_batch_item_id: row.purchase_batch_item_id || undefined, product_title: String(row.product_title || ''),
      category_name: String(row.category_name || ''), variant_name: String(row.variant_name || ''), sku: String(row.sku || ''),
      quantity: Number(row.quantity ?? 1), note: String(row.note || ''), checked: Boolean(row.checked),
      checked_at: row.checked_at || undefined, created_at: row.created_at, ...commonMeta(row),
    } as JapanPackageItem), supportsIncremental: true,
  },
  bundle_components: {
    get: () => db.getBundleComponents(), save: rows => db.saveBundleComponents(rows),
    map: row => ({ id: canonicalId('bundle_components', row), bundle_variant_id: row.bundle_variant_id, component_variant_id: row.component_variant_id, created_at: row.created_at, ...commonMeta(row) } as BundleComponent),
    supportsIncremental: false,
  },
  outbound_shipments: {
    get: () => db.getOutboundShipments(), save: rows => db.saveOutboundShipments(rows),
    map: row => ({
      id: canonicalId('outbound_shipments', row), title: String(row.title || ''), status: String(row.status || 'draft'), carrier: String(row.carrier || ''),
      tracking_number: String(row.tracking_number || ''), weight_kg: row.weight_kg == null ? undefined : Number(row.weight_kg),
      shipping_cost: row.shipping_cost == null ? undefined : Number(row.shipping_cost), shipped_at: String(row.shipped_at || ''),
      received_at: String(row.received_at || ''), status_changed_at: typeof row.status_changed_at === 'string' ? row.status_changed_at : undefined,
      note: String(row.note || ''), created_at: row.created_at, ...commonMeta(row),
    } as OutboundShipment), supportsIncremental: true,
  },
  outbound_shipment_items: {
    get: () => db.getOutboundShipmentItems(), save: rows => db.saveOutboundShipmentItems(rows),
    map: row => ({
      id: canonicalId('outbound_shipment_items', row), outbound_shipment_id: row.outbound_shipment_id, japan_package_item_id: row.japan_package_item_id || undefined,
      product_group_id: row.product_group_id || undefined, product_variant_id: row.product_variant_id || undefined,
      product_title: String(row.product_title || ''), variant_name: String(row.variant_name || ''), sku: String(row.sku || ''),
      quantity: Number(row.quantity ?? 1), checked: Boolean(row.checked), checked_at: row.checked_at || undefined,
      note: String(row.note || ''), created_at: row.created_at, ...commonMeta(row),
    } as OutboundShipmentItem), supportsIncremental: true,
  },
  sales_orders: { get: () => db.getSalesOrders(), save: rows => db.saveSalesOrders(rows), map: row => ({ ...row, id: canonicalId('sales_orders', row), ...commonMeta(row) }), supportsIncremental: true },
  sales_order_items: { get: () => db.getSalesOrderItems(), save: rows => db.saveSalesOrderItems(rows), map: row => ({ ...row, id: canonicalId('sales_order_items', row), ...commonMeta(row) }), supportsIncremental: true },
};

const tablesForResources = (resources: CloudResource[]): string[] => (
  Object.entries(CLOUD_TABLE_RESOURCE)
    .filter(([, resource]) => resources.includes(resource))
    .map(([table]) => table)
    .filter(table => Boolean(TABLES[table]))
);

const AUTHORITATIVE_PAGE_SIZE = 1000;
/** Tables without a deleted_at column (matches the core bootstrap read). */
const TABLES_WITHOUT_SOFT_DELETE = new Set(['bundle_components']);

/**
 * P0-2 Phase 1a C1a: tables whose last targeted/authoritative read failed (query
 * error, timeout, permission error, partial/invalid response, strict readback
 * mismatch). Shared by every cache instance because Fresh is one global state:
 * no later success may publish Fresh until these tables were re-read completely.
 */
const unresolvedTables = new Set<string>();
export const getUnresolvedCloudTables = (): string[] => [...unresolvedTables].sort();
/** C1c: a Restore epoch change makes every cached table unresolved until re-read. */
export const markAllCloudTablesUnresolved = (): void => { Object.keys(TABLES).forEach(table => unresolvedTables.add(table)); };
/** Test-only reset (never called by application code). */
export const __resetUnresolvedCloudTablesForTests = (): void => { unresolvedTables.clear(); };

class CloudAuthoritativeRefreshSupersededError extends Error {
  constructor() {
    super('CLOUD_CACHE_AUTHORITATIVE_REFRESH_SUPERSEDED');
    this.name = 'CloudAuthoritativeRefreshSupersededError';
  }
}

export class CloudTargetedCache {
  private readonly now: () => Date;
  private readonly queryOverride?: CloudTargetedQuery;
  private cursors = new Map<string, string>();
  private singleFlight = new Map<string, Promise<number>>();
  private readCaller='unassigned';
  private targetedQueries = 0;
  private rowsFetched = 0;
  private requestsByTable = new Map<string, number>();
  private authoritativeGeneration = 0;
  private committedAuthoritativeEpoch: number | null = null;
  private refreshQueue: Promise<unknown> = Promise.resolve();
  private protectsDraft?: (table: string, before: Row | undefined, after: Row | undefined) => boolean;
  private readonly prepareDraftProtection?: () => Promise<NonNullable<CloudTargetedCache['protectsDraft']>>;

  constructor(options: { now?: () => Date; query?: CloudTargetedQuery; protectsDraft?: (table: string, before: Row | undefined, after: Row | undefined) => boolean; prepareDraftProtection?: CloudTargetedCache['prepareDraftProtection'] } = {}) {
    this.now = options.now ?? (() => new Date());
    this.queryOverride = options.query;
    this.protectsDraft = options.protectsDraft;
    this.prepareDraftProtection = options.prepareDraftProtection;
  }

  initializeCursor(): void {
    const cursor = this.now().toISOString();
    for (const table of Object.keys(TABLES)) this.cursors.set(table, cursor);
  }

  async refresh(request: CloudRefreshRequest, signal?: AbortSignal): Promise<void> {
    await this.refreshWithResult(request, signal);
  }

  /** Commit rows that were already read from Cloud and contract-verified by a
   * mutation pipeline. This is not an optimistic cache write: every non-delete
   * change must carry its exact authoritative server row. */
  async absorbVerifiedRows(
    changes: CloudChange[],
    rowsByTable: Readonly<Record<string, ReadonlyArray<Row>>>,
  ): Promise<void> {
    // The verified rows were read by the mutation pipeline before this call; the
    // token is taken now, so it never claims to be newer than a later read.
    const readToken = takeCloudReadToken();
    if (this.prepareDraftProtection) this.protectsDraft = await this.prepareDraftProtection();
    const grouped = new Map<string, CloudChange[]>();
    for (const change of changes) grouped.set(change.table, [...(grouped.get(change.table) || []), change]);
    for (const table of Object.keys(rowsByTable)) {
      if (!grouped.has(table)) throw new Error('CLOUD_VERIFIED_ROWS_UNEXPECTED_TABLE');
    }
    for (const [table, tableChanges] of grouped) {
      const adapter = TABLES[table];
      if (!adapter) throw new Error('CLOUD_VERIFIED_ROWS_UNSUPPORTED_TABLE');
      const wanted = new Set(tableChanges.map(change => change.databaseId));
      const rows = [...(rowsByTable[table] || [])];
      const byId = new Map<string, Row>();
      for (const row of rows) {
        const id = String(row.id || '');
        if (!wanted.has(id)) throw new Error('CLOUD_VERIFIED_ROWS_UNEXPECTED_ID');
        if (byId.has(id)) throw new Error('CLOUD_VERIFIED_ROWS_DUPLICATE_ID');
        byId.set(id, row);
      }
      for (const change of tableChanges) {
        const row = byId.get(change.databaseId);
        if (change.kind !== 'DELETE' && !row) throw new Error(`CLOUD_VERIFIED_ROWS_MISSING_ID:${table}:${change.kind}`);
        if (row && change.expectedFields) assertExpectedCloudFields(row, change.expectedFields);
      }
      await this.merge(table, adapter, tableChanges.map(change => change.canonicalId), rows, [], readToken);
      const newest = rows.map(row => row.updated_at).filter(Boolean).sort().at(-1);
      if (newest) this.cursors.set(table, newest);
    }
    if (!cloudReadPassesEpochBarrier(readToken)) throw new CloudCacheFenceRejectedError('restore-epoch-barrier');
    // C1a: verified rows never perform a read here (existing reviewed contract). If an
    // earlier read is still unresolved, Fresh is withheld until a refresh re-reads it.
    if (getUnresolvedCloudTables().length === 0) markCloudReadFresh();
  }

  /**
   * C1a: complete authoritative re-read of every unresolved table before any Fresh.
   * Throws (keeping them unresolved) when that read fails.
   */
  private async resolveUnresolvedTables(generation: number, signal?: AbortSignal, conflicts: CloudChange[] = [], authoritativeEpoch?: number): Promise<number> {
    const pending = getUnresolvedCloudTables().filter(table => Boolean(TABLES[table]));
    if (pending.length === 0) return 0;
    const counts = await this.refreshAuthoritativeTables(pending, generation, authoritativeEpoch, signal, conflicts, { changed: false });
    pending.forEach(table => unresolvedTables.delete(table));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  refreshWithResult(request: CloudRefreshRequest, signal?: AbortSignal): Promise<CloudRefreshResult> {
    if (!this.protectsDraft && !this.prepareDraftProtection) return this.performRefresh(request, signal);
    // Do not let a focus/reconnect read swallow a newer Realtime query through
    // per-table single-flight, or commit an older response after a newer one.
    const pending = this.refreshQueue.then(() => this.performRefresh(request, signal));
    this.refreshQueue = pending.catch(() => undefined);
    return pending;
  }

  private async performRefresh(request: CloudRefreshRequest, signal?: AbortSignal): Promise<CloudRefreshResult> {
    this.readCaller='targeted-cache:'+request.reason;
    // Oldest read token of this refresh: Fresh is never published for it after a Restore barrier.
    const refreshToken = takeCloudReadToken();
    const conflicts: CloudChange[] = [];
    const comparison = { changed: false };
    const byTable = new Map<string, CloudChange[]>();
    for (const change of request.changes) {
      byTable.set(change.table, [...(byTable.get(change.table) || []), change]);
    }
    const hasRowChanges = request.changes.length > 0;
    const tables = (request.reason === 'realtime' || (request.reason === 'editing-ended' && hasRowChanges))
      ? [...byTable.keys()]
      : tablesForResources(request.resources);
    const isAuthoritativeResourceRead = request.reason === 'manual' || request.reason === 'reconnect'
      || (request.reason === 'editing-ended' && !hasRowChanges);
    if (request.authoritativeEpoch !== undefined) {
      if (!isAuthoritativeResourceRead || !Number.isSafeInteger(request.authoritativeEpoch) || request.authoritativeEpoch < 0) {
        throw new Error('CLOUD_CACHE_AUTHORITATIVE_EPOCH_INVALID');
      }
      if (this.committedAuthoritativeEpoch !== null && request.authoritativeEpoch < this.committedAuthoritativeEpoch) {
        throw new Error('CLOUD_CACHE_AUTHORITATIVE_EPOCH_REGRESSION');
      }
    }
    const generation = isAuthoritativeResourceRead
      ? ++this.authoritativeGeneration
      : this.authoritativeGeneration;
    const previousStatus = getCloudConnectivitySnapshot().readStatus;
    // A background record read must not revoke all unrelated editors' readiness.
    // Existing fresh authority remains valid; actual read failure still fails closed.
    if (isAuthoritativeResourceRead || (previousStatus !== 'fresh-online' && previousStatus !== 'fresh-empty')) {
      markCloudReadLoading();
    }
    try {
      if (this.prepareDraftProtection) this.protectsDraft = await this.prepareDraftProtection();
      signal?.throwIfAborted();
      const rowCounts = isAuthoritativeResourceRead
        ? await this.refreshAuthoritativeTables(tables, generation, request.authoritativeEpoch, signal, conflicts, comparison)
        : await Promise.all(tables.map(table => this.runSingleFlight(table, async () => {
          const changes = byTable.get(table) || [];
          if (changes.length > 0) return this.refreshChanges(table, changes, generation, signal, conflicts);
          return this.refreshSince(table, generation, signal, conflicts);
        })));
      signal?.throwIfAborted();
      if (generation !== this.authoritativeGeneration) {
        throw new CloudAuthoritativeRefreshSupersededError();
      }
      // C1a: a complete authoritative read of a table resolves an earlier failure of it;
      // any other unresolved table is re-read now, so Fresh never masks an earlier failure.
      if (isAuthoritativeResourceRead) tables.forEach(table => unresolvedTables.delete(table));
      if (unresolvedTables.size > 0) {
        markCloudReadLoading('cloud-read-recovery');
        await this.resolveUnresolvedTables(generation, signal, conflicts, isAuthoritativeResourceRead ? request.authoritativeEpoch : undefined);
        signal?.throwIfAborted();
        if (generation !== this.authoritativeGeneration) throw new CloudAuthoritativeRefreshSupersededError();
      }
      if (!cloudReadPassesEpochBarrier(refreshToken, request.authoritativeEpoch)) {
        throw new CloudCacheFenceRejectedError('restore-epoch-barrier');
      }
      markCloudReadFresh(isAuthoritativeResourceRead
        ? rowCounts.reduce((sum, count) => sum + count, 0)
        : undefined);
      return isAuthoritativeResourceRead ? { conflicts, changed: comparison.changed } : { conflicts };
    } catch (error) {
      if (error instanceof CloudAuthoritativeRefreshSupersededError) throw error;
      if (generation !== this.authoritativeGeneration) throw new CloudAuthoritativeRefreshSupersededError();
      // C1a: an uncertain read (error, timeout, permission, partial response, fence
      // rejection) is never interpreted as deletion; the tables stay unresolved and
      // block Fresh until a later complete authoritative read of them succeeds.
      tables.forEach(table => { if (TABLES[table]) unresolvedTables.add(table); });
      const cachedRows = await Promise.all(tables.map(table => TABLES[table]?.get() ?? Promise.resolve([])));
      if (generation !== this.authoritativeGeneration) throw new CloudAuthoritativeRefreshSupersededError();
      markCloudReadFailed(error, cachedRows.some(rows => rows.length > 0));
      throw error;
    }
  }

  private runSingleFlight(table: string, task: () => Promise<number>): Promise<number> {
    const existing = this.singleFlight.get(table);
    if (existing) return existing;
    const promise = task().finally(() => this.singleFlight.delete(table));
    this.singleFlight.set(table, promise);
    return promise;
  }

  private async query(request: CloudTargetedQueryRequest): Promise<Row[]> {
    request.signal?.throwIfAborted();
    if(request.table==='inventory_items') {
      await awaitCatalogCommitReadFence(this.readCaller,request.signal);
      recordBuyAnimeCatalogEvidence('inventory-read',{caller:this.readCaller,
        mode:request.databaseIds?'ids':request.updatedAfter?'incremental':'page',
        count:request.databaseIds?.length ?? 0,from:request.from ?? -1,to:request.to ?? (request.keyset?.limit ?? -1)});
    }
    this.targetedQueries += 1;
    this.requestsByTable.set(request.table, (this.requestsByTable.get(request.table) || 0) + 1);
    if (this.queryOverride) {
      const rows = await this.queryOverride(request);
      this.rowsFetched += rows.length;
      return rows;
    }
    let query = (supabase as any).from(request.table).select('*');
    if (request.signal) query = query.abortSignal(request.signal);
    if (request.databaseIds) query = query.in('id', request.databaseIds);
    if (request.activeOnly) query = query.is('deleted_at', null);
    if (request.updatedAfter) query = query.gt('updated_at', request.updatedAfter).order('updated_at');
    if (request.keyset) {
      if (request.keyset.afterId !== null) query = query.gt('id', request.keyset.afterId);
      query = query.order('id').limit(request.keyset.limit);
    } else if (request.from !== undefined && request.to !== undefined) {
      query = query.order('id').range(request.from, request.to);
    }
    const result = await query;
    if (result.error) {
      markCloudRequestFailed(result.error);
      throw result.error;
    }
    markCloudReachable();
    const rows = (result.data || []) as Row[];
    this.rowsFetched += rows.length;
    return rows;
  }

  snapshotMetrics() {
    return {
      targetedQueries: this.targetedQueries,
      rowsFetched: this.rowsFetched,
      requestsByTable: Object.fromEntries(this.requestsByTable),
      fullPulls: 0,
      authoritativeGeneration: this.authoritativeGeneration,
      committedAuthoritativeEpoch: this.committedAuthoritativeEpoch,
    };
  }

  /**
   * P0-2 Phase 1a: keyset pagination (id > last id) with server-side soft-delete
   * filtering. `from`/`to` are still supplied so injected test queries that page
   * by position keep working; the Supabase path uses only the keyset.
   */
  private async queryAll(table: string, signal?: AbortSignal): Promise<Row[]> {
    const rows: Row[] = [];
    const run = this.queryOverride ? null : startCloudSyncRun('authoritative-refresh');
    let afterId: string | null = null;
    try {
      for (let from = 0; ; from += AUTHORITATIVE_PAGE_SIZE) {
        const page = await this.query({
          table,
          from,
          to: from + AUTHORITATIVE_PAGE_SIZE - 1,
          keyset: { afterId, limit: AUTHORITATIVE_PAGE_SIZE },
          activeOnly: !TABLES_WITHOUT_SOFT_DELETE.has(table),
          signal,
        });
        if (run) recordCloudSyncPage(run, page);
        rows.push(...page);
        if (page.length < AUTHORITATIVE_PAGE_SIZE) {
          finishCloudSyncRun(run, 'committed');
          return rows;
        }
        const lastId = page[page.length - 1]?.id;
        if (typeof lastId !== 'string' || !lastId || lastId === afterId) throw new Error(`CLOUD_KEYSET_CURSOR_NOT_ADVANCING:${table}`);
        afterId = lastId;
      }
    } catch (error) {
      finishCloudSyncRun(run, 'failed');
      throw error;
    }
  }

  private async refreshChanges(table: string, changes: CloudChange[], generation: number, signal?: AbortSignal, conflicts: CloudChange[] = []): Promise<number> {
    const adapter = TABLES[table];
    if (!adapter) return 0;
    const touchedIds = [...new Set(changes.map(change => change.canonicalId).filter(Boolean))];
    const databaseIds = [...new Set(changes.map(change => change.databaseId).filter(Boolean))];
    if (databaseIds.length === 0) return 0;
    const readToken = takeCloudReadToken();
    const rows = await readCloudRowsByIds({
      table, ids: databaseIds, signal,
      // C1a: a successful authenticated re-read is the row's current server state. Under
      // the canonical RLS (SELECT to authenticated: deleted_at IS NULL OR is_owner; anon
      // has no grant, so an unauthenticated read errors instead of returning nothing),
      // an id absent from a successful response is not in the active set (hard-deleted,
      // or soft-deleted and hidden). Remote Realtime changes may therefore be absent;
      // mutation readbacks with expectedFields and local-origin changes stay strict.
      allowMissing: new Set(changes
        .filter(change => change.kind === 'DELETE' || (change.origin === 'remote' && !change.expectedFields))
        .map(change => change.databaseId)),
      expected: new Map(changes.filter(change => change.expectedFields).map(change => [change.databaseId, change.expectedFields!])),
      load: (ids, chunkSignal) => this.query({ table, databaseIds: ids, signal: chunkSignal }),
    });
    signal?.throwIfAborted();
    if (generation !== this.authoritativeGeneration) return 0;
    await this.merge(table, adapter, touchedIds, rows, conflicts, readToken);
    const newest = rows.map(row => row.updated_at).filter(Boolean).sort().at(-1);
    if (newest) this.cursors.set(table, newest);
    return rows.length;
  }

  private async refreshSince(table: string, generation: number, signal?: AbortSignal, conflicts: CloudChange[] = []): Promise<number> {
    const adapter = TABLES[table];
    if (!adapter?.supportsIncremental) return 0;
    const cursor = this.cursors.get(table) || this.now().toISOString();
    const nextCursor = this.now().toISOString();
    const readToken = takeCloudReadToken();
    const rows = await this.query({ table, updatedAfter: cursor, signal });
    signal?.throwIfAborted();
    if (generation !== this.authoritativeGeneration) return 0;
    await this.merge(table, adapter, rows.map(row => canonicalId(table, row)), rows, conflicts, readToken);
    this.cursors.set(table, nextCursor);
    return rows.length;
  }

  private async refreshAuthoritativeTables(
    tables: string[],
    generation: number,
    authoritativeEpoch?: number,
    signal?: AbortSignal,
    conflicts: CloudChange[] = [],
    comparison = { changed: false },
  ): Promise<number[]> {
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort();
    signal?.addEventListener('abort', abortAttempt, { once: true });
    signal?.throwIfAborted();
    // P0-2 Phase 1a: snapshot token taken before the first page request.
    const snapshotToken = beginCloudSnapshot();
    let committing = false;
    let fetched;
    try {
      fetched = await Promise.all(tables.map(async table => {
        const adapter = TABLES[table];
        if (!adapter) return { table, adapter: null, rows: [] as Row[], incoming: [] as Array<{ id: string }>, newest: undefined };
        const rows = await this.queryAll(table, attemptController.signal);
        attemptController.signal.throwIfAborted();
        const incoming = rows.filter(row => !row.deleted_at).map(row => adapter.map(row));
        const newest = rows.map(row => row.updated_at).filter(Boolean).sort().at(-1);
        return { table, adapter, rows, incoming, newest };
      }));
      signal?.throwIfAborted();
      if (generation !== this.authoritativeGeneration) throw new CloudAuthoritativeRefreshSupersededError();
      committing = true;
    } catch (error) {
      attemptController.abort();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abortAttempt);
      if (!committing) endCloudSnapshot(snapshotToken);
    }

    const counts = await commitCloudSnapshot({
      token: snapshotToken,
      targetEpoch: authoritativeEpoch,
      storageKeys: fetched.filter(entry => entry.adapter && TABLE_STORAGE_KEYS[entry.table]).map(entry => TABLE_STORAGE_KEYS[entry.table]),
      apply: async plan => {
        if (generation !== this.authoritativeGeneration) throw new CloudAuthoritativeRefreshSupersededError();
        const writes: Array<{ storageKey: string; value: unknown[] }> = [];
        const activeCounts: number[] = [];
        for (const entry of fetched) {
          if (!entry.adapter) {
            activeCounts.push(0);
            continue;
          }
          const storageKey = TABLE_STORAGE_KEYS[entry.table];
          const current = await entry.adapter.get();
          const collectionPlan = storageKey ? plan(storageKey) : null;
          if (collectionPlan?.superseded) {
            // A newer-started snapshot already owns this collection.
            activeCounts.push(current.length);
            continue;
          }
          const incoming = collectionPlan ? collectionPlan.overlay(entry.incoming) : entry.incoming;
          const previous = new Map(current.map(row => [row.id, row]));
          if (current.length !== incoming.length || incoming.some(row => !cloudBusinessRowsEqual(previous.get(row.id), row))) {
            comparison.changed = true;
          }
          const activeRows = this.protectRows(entry.table, current, incoming, conflicts);
          activeCounts.push(activeRows.length);
          if (storageKey) writes.push({ storageKey, value: activeRows });
        }
        if (writes.length > 0) await db.replaceAuthoritativeCloudCollections(writes);
        return activeCounts;
      },
    });
    if (generation !== this.authoritativeGeneration) throw new CloudAuthoritativeRefreshSupersededError();
    for (const entry of fetched) {
      if (entry.adapter) this.cursors.set(entry.table, entry.newest || this.now().toISOString());
    }
    if (authoritativeEpoch !== undefined) this.committedAuthoritativeEpoch = authoritativeEpoch;
    return counts;
  }

  private async merge<T extends { id: string }>(table: string, adapter: TableCacheAdapter<T>, touchedIds: string[], rows: Row[], conflicts: CloudChange[], readToken: number): Promise<void> {
    await commitCloudTargeted({
      token: readToken,
      storageKey: TABLE_STORAGE_KEYS[table] ?? `unmapped:${table}`,
      apply: async fence => {
        const current = await adapter.get();
        const previousById = new Map(current.map(row => [row.id, row]));
        const next = new Map(current.map(row => [row.id, row]));
        const touched = new Set(touchedIds);
        const returned = new Set(rows.map(row => canonicalId(table, row)));
        const touchedCanonical = new Set<string>(touchedIds);
        for (const row of current) {
          const databaseId = (row as T & { database_id?: string }).database_id;
          if (!(touched.has(row.id) || (databaseId && touched.has(databaseId)))) continue;
          touchedCanonical.add(row.id);
          // P0-2 Phase 1a: a newer-started snapshot already committed this collection;
          // a row absent from this older read must not erase it.
          if (fence.skipAbsentDeletes && !returned.has(row.id)) {
            noteSkippedStaleDelete();
            continue;
          }
          next.delete(row.id);
        }
        for (const row of rows) {
          const id = canonicalId(table, row);
          touchedCanonical.add(id);
          const previous = previousById.get(id) as Row | undefined;
          const versionsKnown = previous && typeof previous.version === 'number' && typeof row.version === 'number';
          if (versionsKnown && (previous!.version as number) > (row.version as number)) {
            next.set(id, previous as T);
          } else if (!row.deleted_at) next.set(id, adapter.map(row));
          else if (fence.skipAbsentDeletes && previous && !versionsKnown) {
            noteSkippedStaleDelete();
            next.set(id, previous as T);
          }
        }
        for (const id of touchedCanonical) fence.record(id, (next.get(id) as unknown as { id: string } | undefined) ?? null);
        await adapter.save(this.protectRows(table, current, [...next.values()], conflicts));
      },
    });
  }

  private protectRows<T extends { id: string }>(table: string, current: T[], next: T[], conflicts: CloudChange[]): T[] {
    if (!this.protectsDraft) return next;
    const previous = new Map(current.map(row => [row.id, row]));
    const candidate = new Map(next.map(row => [row.id, row]));
    for (const id of new Set([...previous.keys(), ...candidate.keys()])) {
      const before = previous.get(id);
      const after = candidate.get(id);
      if (cloudBusinessRowsEqual(before, after) || !this.protectsDraft(table, before, after)) continue;
      // Preserve the original CAS/business baseline as well as the React draft.
      if (before) candidate.set(id, before);
      else candidate.delete(id);
      const row = (before ?? after) as Row;
      conflicts.push({ table, canonicalId: id, databaseId: String(row.database_id ?? row.id), localId: null,
        resource: CLOUD_TABLE_RESOURCE[table], kind: !after ? 'DELETE' : !before ? 'INSERT' : 'UPDATE', origin: 'remote' });
    }
    return [...candidate.values()];
  }
}
