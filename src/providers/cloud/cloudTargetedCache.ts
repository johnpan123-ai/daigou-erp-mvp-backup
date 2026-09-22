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
import { CLOUD_TABLE_RESOURCE, resolveCloudRowIdentity } from './cloudSyncDomain';
import {
  getCloudConnectivitySnapshot,
  markCloudReadFailed,
  markCloudReadFresh,
  markCloudReadLoading,
  markCloudReachable,
  markCloudRequestFailed,
} from './cloudConnectivity';

type Row = Record<string, unknown> & { id?: string; local_id?: string; deleted_at?: string | null; updated_at?: string };

export interface CloudTargetedQueryRequest {
  table: string;
  databaseIds?: string[];
  updatedAfter?: string;
  from?: number;
  to?: number;
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
  product_variants: { get: () => db.getProductVariants(), save: rows => db.replaceProductVariantsFromAuthoritativeCloud(rows), map: row => ({ ...row, id: canonicalId('product_variants', row), ...commonMeta(row) }), supportsIncremental: true },
  inventory_items: {
    get: () => db.getInventory(),
    save: rows => db.saveInventory(rows),
    map: row => ({
      id: canonicalId('inventory_items', row),
      inventory_key: String(row.inventory_key || ''),
      myacg_item_code: String(row.myacg_item_code || ''),
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

  refreshWithResult(request: CloudRefreshRequest, signal?: AbortSignal): Promise<CloudRefreshResult> {
    if (!this.protectsDraft && !this.prepareDraftProtection) return this.performRefresh(request, signal);
    // Do not let a focus/reconnect read swallow a newer Realtime query through
    // per-table single-flight, or commit an older response after a newer one.
    const pending = this.refreshQueue.then(() => this.performRefresh(request, signal));
    this.refreshQueue = pending.catch(() => undefined);
    return pending;
  }

  private async performRefresh(request: CloudRefreshRequest, signal?: AbortSignal): Promise<CloudRefreshResult> {
    const conflicts: CloudChange[] = [];
    const byTable = new Map<string, CloudChange[]>();
    for (const change of request.changes) {
      byTable.set(change.table, [...(byTable.get(change.table) || []), change]);
    }
    const hasRowChanges = request.changes.length > 0;
    const tables = (request.reason === 'realtime' || (request.reason === 'editing-ended' && hasRowChanges))
      ? [...byTable.keys()]
      : tablesForResources(request.resources);
    const isAuthoritativeResourceRead = request.reason === 'reconnect'
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
    if ((!this.protectsDraft && !this.prepareDraftProtection) || (previousStatus !== 'fresh-online' && previousStatus !== 'fresh-empty')) {
      markCloudReadLoading();
    }
    try {
      if (this.prepareDraftProtection) this.protectsDraft = await this.prepareDraftProtection();
      signal?.throwIfAborted();
      const rowCounts = isAuthoritativeResourceRead
        ? await this.refreshAuthoritativeTables(tables, generation, request.authoritativeEpoch, signal, conflicts)
        : await Promise.all(tables.map(table => this.runSingleFlight(table, async () => {
          const changes = byTable.get(table) || [];
          if (changes.length > 0) return this.refreshChanges(table, changes, generation, signal, conflicts);
          return this.refreshSince(table, generation, signal, conflicts);
        })));
      signal?.throwIfAborted();
      if (generation !== this.authoritativeGeneration) {
        throw new CloudAuthoritativeRefreshSupersededError();
      }
      markCloudReadFresh(isAuthoritativeResourceRead
        ? rowCounts.reduce((sum, count) => sum + count, 0)
        : undefined);
      return { conflicts };
    } catch (error) {
      if (error instanceof CloudAuthoritativeRefreshSupersededError) throw error;
      const cachedRows = await Promise.all(tables.map(table => TABLES[table]?.get() ?? Promise.resolve([])));
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
    if (request.updatedAfter) query = query.gt('updated_at', request.updatedAfter).order('updated_at');
    if (request.from !== undefined && request.to !== undefined) {
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

  private async queryAll(table: string, signal?: AbortSignal): Promise<Row[]> {
    const rows: Row[] = [];
    for (let from = 0; ; from += AUTHORITATIVE_PAGE_SIZE) {
      const page = await this.query({
        table,
        from,
        to: from + AUTHORITATIVE_PAGE_SIZE - 1,
        signal,
      });
      rows.push(...page);
      if (page.length < AUTHORITATIVE_PAGE_SIZE) return rows;
    }
  }

  private async refreshChanges(table: string, changes: CloudChange[], generation: number, signal?: AbortSignal, conflicts: CloudChange[] = []): Promise<number> {
    const adapter = TABLES[table];
    if (!adapter) return 0;
    const touchedIds = [...new Set(changes.map(change => change.canonicalId).filter(Boolean))];
    const databaseIds = [...new Set(changes.map(change => change.databaseId).filter(Boolean))];
    if (databaseIds.length === 0) return 0;
    const rows = await this.query({ table, databaseIds, signal });
    signal?.throwIfAborted();
    if (generation !== this.authoritativeGeneration) return 0;
    await this.merge(table, adapter, touchedIds, rows, conflicts);
    const newest = rows.map(row => row.updated_at).filter(Boolean).sort().at(-1);
    if (newest) this.cursors.set(table, newest);
    return rows.length;
  }

  private async refreshSince(table: string, generation: number, signal?: AbortSignal, conflicts: CloudChange[] = []): Promise<number> {
    const adapter = TABLES[table];
    if (!adapter?.supportsIncremental) return 0;
    const cursor = this.cursors.get(table) || this.now().toISOString();
    const nextCursor = this.now().toISOString();
    const rows = await this.query({ table, updatedAfter: cursor, signal });
    signal?.throwIfAborted();
    if (generation !== this.authoritativeGeneration) return 0;
    await this.merge(table, adapter, rows.map(row => canonicalId(table, row)), rows, conflicts);
    this.cursors.set(table, nextCursor);
    return rows.length;
  }

  private async refreshAuthoritativeTables(
    tables: string[],
    generation: number,
    authoritativeEpoch?: number,
    signal?: AbortSignal,
    conflicts: CloudChange[] = [],
  ): Promise<number[]> {
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort();
    signal?.addEventListener('abort', abortAttempt, { once: true });
    signal?.throwIfAborted();
    let prepared;
    try {
      prepared = await Promise.all(tables.map(async table => {
        const adapter = TABLES[table];
        if (!adapter) return { table, adapter: null, rows: [], activeRows: [], newest: undefined };
        const rows = await this.queryAll(table, attemptController.signal);
        attemptController.signal.throwIfAborted();
        const current = await adapter.get();
        const activeRows = this.protectRows(table, current, rows.filter(row => !row.deleted_at).map(row => adapter.map(row)), conflicts);
        const newest = rows.map(row => row.updated_at).filter(Boolean).sort().at(-1);
        return { table, adapter, rows, activeRows, newest };
      }));
    } catch (error) {
      attemptController.abort();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abortAttempt);
    }

    signal?.throwIfAborted();
    if (generation !== this.authoritativeGeneration) throw new CloudAuthoritativeRefreshSupersededError();
    await db.replaceAuthoritativeCloudCollections(prepared
      .filter(entry => entry.adapter && TABLE_STORAGE_KEYS[entry.table])
      .map(entry => ({ storageKey: TABLE_STORAGE_KEYS[entry.table], value: entry.activeRows })));
    if (generation !== this.authoritativeGeneration) throw new CloudAuthoritativeRefreshSupersededError();
    for (const entry of prepared) {
      if (entry.adapter) this.cursors.set(entry.table, entry.newest || this.now().toISOString());
    }
    if (authoritativeEpoch !== undefined) this.committedAuthoritativeEpoch = authoritativeEpoch;
    return prepared.map(entry => entry.activeRows.length);
  }

  private async merge<T extends { id: string }>(table: string, adapter: TableCacheAdapter<T>, touchedIds: string[], rows: Row[], conflicts: CloudChange[]): Promise<void> {
    const current = await adapter.get();
    const previousById = new Map(current.map(row => [row.id, row]));
    const next = new Map(current.map(row => [row.id, row]));
    const touched = new Set(touchedIds);
    for (const row of current) {
      const databaseId = (row as T & { database_id?: string }).database_id;
      if (touched.has(row.id) || (databaseId && touched.has(databaseId))) next.delete(row.id);
    }
    for (const row of rows) {
      const id = canonicalId(table, row);
      const previous = previousById.get(id) as Row | undefined;
      if (previous && typeof previous.version === 'number' && typeof row.version === 'number' && previous.version > row.version) {
        next.set(id, previous as T);
      } else if (!row.deleted_at) next.set(id, adapter.map(row));
    }
    await adapter.save(this.protectRows(table, current, [...next.values()], conflicts));
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
