import type {
  BundleComponent,
  JapanPackage,
  JapanPackageItem,
  OutboundShipment,
  OutboundShipmentItem,
  PrivateOrder,
  PrivateOrderItem,
  PurchaseBatchItem,
} from '../../lib/db';
import { db } from '../../lib/db';
import { supabase } from './supabaseClient';
import type { CloudChange, CloudRefreshRequest, CloudResource } from './cloudSyncDomain';
import { CLOUD_TABLE_RESOURCE, resolveCloudRowIdentity } from './cloudSyncDomain';

type Row = Record<string, unknown> & { id?: string; local_id?: string; deleted_at?: string | null; updated_at?: string };

export interface CloudTargetedQueryRequest {
  table: string;
  databaseIds?: string[];
  updatedAfter?: string;
}

export type CloudTargetedQuery = (request: CloudTargetedQueryRequest) => Promise<Row[]>;

interface TableCacheAdapter<T extends { id: string }> {
  get: () => Promise<T[]>;
  save: (rows: T[]) => Promise<void>;
  map: (row: Row) => T;
  supportsIncremental: boolean;
}

const canonicalId = (table: string, row: Row): string => resolveCloudRowIdentity(table, row).canonicalId;
const commonMeta = (row: Row) => ({
  local_id: typeof row.local_id === 'string' && row.local_id ? row.local_id : undefined,
  updated_at: typeof row.updated_at === 'string' ? row.updated_at : undefined,
  version: typeof row.version === 'number' ? row.version : undefined,
});

const TABLES: Readonly<Record<string, TableCacheAdapter<any>>> = {
  product_groups: { get: () => db.getProductGroups(), save: rows => db.saveProductGroups(rows), map: row => ({ ...row, id: canonicalId('product_groups', row), ...commonMeta(row) }), supportsIncremental: true },
  product_categories: { get: () => db.getProductCategories(), save: rows => db.saveProductCategories(rows), map: row => ({ ...row, id: canonicalId('product_categories', row), ...commonMeta(row) }), supportsIncremental: true },
  product_variants: { get: () => db.getProductVariants(), save: rows => db.saveProductVariants(rows), map: row => ({ ...row, id: canonicalId('product_variants', row), ...commonMeta(row) }), supportsIncremental: true },
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
      received_at: String(row.received_at || ''), note: String(row.note || ''), created_at: row.created_at, ...commonMeta(row),
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

export class CloudTargetedCache {
  private readonly now: () => Date;
  private readonly queryOverride?: CloudTargetedQuery;
  private cursors = new Map<string, string>();
  private singleFlight = new Map<string, Promise<void>>();
  private targetedQueries = 0;
  private rowsFetched = 0;
  private requestsByTable = new Map<string, number>();

  constructor(options: { now?: () => Date; query?: CloudTargetedQuery } = {}) {
    this.now = options.now ?? (() => new Date());
    this.queryOverride = options.query;
  }

  initializeCursor(): void {
    const cursor = this.now().toISOString();
    for (const table of Object.keys(TABLES)) this.cursors.set(table, cursor);
  }

  async refresh(request: CloudRefreshRequest): Promise<void> {
    const byTable = new Map<string, CloudChange[]>();
    for (const change of request.changes) {
      byTable.set(change.table, [...(byTable.get(change.table) || []), change]);
    }
    const tables = request.reason === 'realtime' ? [...byTable.keys()] : tablesForResources(request.resources);
    await Promise.all(tables.map(table => this.runSingleFlight(table, async () => {
      const changes = byTable.get(table) || [];
      if (changes.length > 0) await this.refreshChanges(table, changes);
      else await this.refreshSince(table);
    })));
  }

  private runSingleFlight(table: string, task: () => Promise<void>): Promise<void> {
    const existing = this.singleFlight.get(table);
    if (existing) return existing;
    const promise = task().finally(() => this.singleFlight.delete(table));
    this.singleFlight.set(table, promise);
    return promise;
  }

  private async query(request: CloudTargetedQueryRequest): Promise<Row[]> {
    this.targetedQueries += 1;
    this.requestsByTable.set(request.table, (this.requestsByTable.get(request.table) || 0) + 1);
    if (this.queryOverride) {
      const rows = await this.queryOverride(request);
      this.rowsFetched += rows.length;
      return rows;
    }
    let query = (supabase as any).from(request.table).select('*');
    if (request.databaseIds) query = query.in('id', request.databaseIds);
    if (request.updatedAfter) query = query.gt('updated_at', request.updatedAfter).order('updated_at');
    const result = await query;
    if (result.error) throw result.error;
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
    };
  }

  private async refreshChanges(table: string, changes: CloudChange[]): Promise<void> {
    const adapter = TABLES[table];
    if (!adapter) return;
    const touchedIds = [...new Set(changes.map(change => change.canonicalId).filter(Boolean))];
    const databaseIds = [...new Set(changes.map(change => change.databaseId).filter(Boolean))];
    if (databaseIds.length === 0) return;
    const rows = await this.query({ table, databaseIds });
    await this.merge(table, adapter, touchedIds, rows);
    const newest = rows.map(row => row.updated_at).filter(Boolean).sort().at(-1);
    if (newest) this.cursors.set(table, newest);
  }

  private async refreshSince(table: string): Promise<void> {
    const adapter = TABLES[table];
    if (!adapter?.supportsIncremental) return;
    const cursor = this.cursors.get(table) || this.now().toISOString();
    const nextCursor = this.now().toISOString();
    const rows = await this.query({ table, updatedAfter: cursor });
    await this.merge(table, adapter, rows.map(row => canonicalId(table, row)), rows);
    this.cursors.set(table, nextCursor);
  }

  private async merge<T extends { id: string }>(table: string, adapter: TableCacheAdapter<T>, touchedIds: string[], rows: Row[]): Promise<void> {
    const current = await adapter.get();
    const next = new Map(current.map(row => [row.id, row]));
    for (const id of touchedIds) next.delete(id);
    for (const row of rows) {
      if (!row.deleted_at) next.set(canonicalId(table, row), adapter.map(row));
    }
    await adapter.save([...next.values()]);
  }
}
