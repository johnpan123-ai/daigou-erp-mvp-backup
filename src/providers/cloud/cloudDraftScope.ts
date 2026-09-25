import { cloudCacheDb } from '../../lib/db';

type Row = Record<string, unknown>;
export type CloudDraftScope =
  | { kind: 'groups'; ids: string[] }
  | { kind: 'package'; ids: string[] }
  | { kind: 'shipment'; ids: string[] };

export function cloudDraftScopeForOwner(owner: string): CloudDraftScope | undefined {
  const [page, id] = owner.split(':');
  if (!id || id === 'unknown') return undefined;
  if (page === 'japan-package-detail') return { kind: 'package', ids: [id] };
  if (page === 'outbound-shipment-detail') return { kind: 'shipment', ids: [id] };
  if (page === 'purchase-management' || page === 'purchasing-summary') return { kind: 'groups', ids: [id] };
  return undefined;
}

/** Read cached relations once per catch-up, never an extra Cloud pull or an actor-ID heuristic. */
export async function readCloudDraftRelations() {
  const [categories, variants, batches, orders, salesItems] = await Promise.all([
    cloudCacheDb.getProductCategories(), cloudCacheDb.getProductVariants(),
    cloudCacheDb.getPurchaseBatches(), cloudCacheDb.getPrivateOrders(), cloudCacheDb.getSalesOrderItems(),
  ]);
  // Cache keys retain their existing table-specific canonical identity contract.
  const byId = (rows: Row[]) => {
    const result = new Map<string, Row>();
    for (const row of rows) {
      for (const key of [row.id, row.database_id]) if (typeof key === 'string') result.set(key, row);
    }
    return result;
  };
  return {
    categories: byId(categories as unknown as Row[]),
    variants: byId(variants as unknown as Row[]),
    batches: byId(batches as unknown as Row[]),
    orders: byId(orders as unknown as Row[]),
    variantRows: variants as unknown as Row[],
    salesItems: salesItems as unknown as Row[],
  };
}
export type CloudDraftRelations = Awaited<ReturnType<typeof readCloudDraftRelations>>;

/** null means unresolved ownership: fail closed for the affected editor only. */
function groupsForRow(table: string, row: Row, relations: CloudDraftRelations): string[] | null {
  const direct = (value: unknown) => typeof value === 'string' && value ? [value] : null;
  const parent = (rows: Map<string, Row>, key: unknown, parentTable: string): string[] | null => {
    const found = typeof key === 'string' ? rows.get(key) : undefined;
    return found ? groupsForRow(parentTable, found, relations) : null;
  };
  const variant = (id: unknown) => parent(relations.variants, id, 'product_variants');
  const skuGroups = (sku: unknown) => {
    if (typeof sku !== 'string' || !sku) return null;
    const matches = relations.variantRows.filter(v => v.myacg_item_code === sku);
    const resolved = matches.map(v => groupsForRow('product_variants', v, relations));
    return resolved.some(value => value === null) ? null : resolved.flatMap(value => value ?? []);
  };
  switch (table) {
    case 'product_groups': return direct(row.id);
    case 'product_categories':
    case 'purchase_batches':
    case 'private_orders': return direct(row.product_group_id);
    case 'product_variants': {
      const group = direct(row.product_group_id);
      const category = row.product_category_id ? parent(relations.categories, row.product_category_id, 'product_categories') : [];
      // Either relationship can make a variant visible in PurchaseManagement.
      if (category === null || (!group && category.length === 0)) return null;
      return [...(group ?? []), ...category];
    }
    case 'purchase_batch_items': return parent(relations.batches, row.purchase_batch_id, 'purchase_batches');
    case 'private_order_items': return parent(relations.orders, row.private_order_id, 'private_orders');
    case 'inventory_items': return skuGroups(row.myacg_item_code);
    case 'sales_order_items': return row.product_variant_id ? variant(row.product_variant_id) : skuGroups(row.myacg_item_code);
    case 'sales_orders': {
      const items = relations.salesItems.filter(item => item.order_id === row.id || item.order_id === row.database_id);
      const groups = items.map(item => groupsForRow('sales_order_items', item, relations));
      return groups.some(value => value === null) ? null : groups.flatMap(value => value ?? []);
    }
    case 'bundle_components': {
      const groups = [variant(row.bundle_variant_id), variant(row.component_variant_id)];
      return groups.some(value => value === null) ? null : groups.flatMap(value => value ?? []);
    }
    default: return [];
  }
}

export function cloudRowAffectsDraft(scope: CloudDraftScope, table: string, before: Row | undefined, after: Row | undefined, relations?: CloudDraftRelations): boolean {
  if (scope.ids.length === 0) return false; // An unsaved new header has no existing aggregate to collide with.
  const rows = [before, after].filter((row): row is Row => Boolean(row));
  if (scope.kind === 'package' || scope.kind === 'shipment') {
    const parent = scope.kind === 'package' ? 'japan_packages' : 'outbound_shipments';
    const child = scope.kind === 'package' ? 'japan_package_items' : 'outbound_shipment_items';
    const fk = scope.kind === 'package' ? 'japan_package_id' : 'outbound_shipment_id';
    if (table !== parent && table !== child) return false;
    return rows.some(row => {
      const id = table === parent ? row.id : row[fk];
      return typeof id !== 'string' || scope.ids.includes(id);
    });
  }
  if (!relations) return true;
  return rows.some(row => {
    const groups = groupsForRow(table, row, relations);
    return groups === null || groups.some(id => scope.ids.includes(id));
  });
}
