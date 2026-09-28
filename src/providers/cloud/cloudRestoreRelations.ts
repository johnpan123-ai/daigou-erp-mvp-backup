import type { CloudRestoreTable } from './cloudAtomicRestore';

export type CloudRestoreRelationKind = 'blocking' | 'metadata';

export interface CloudRestoreRelationSpec {
  childTable: CloudRestoreTable;
  field: string;
  parentTable: CloudRestoreTable;
  kind: CloudRestoreRelationKind;
  optional: boolean;
}

/**
 * The single relation contract used by snapshot closure, manifest auditing and
 * restore preflight.  `blocking` mirrors a required FK (or an equivalent
 * invariant enforced by the restore server). `metadata` is a nullable pointer
 * which is useful to retain, but must not make an otherwise valid restore fail.
 */
export const CLOUD_RESTORE_RELATIONS = [
  { childTable: 'product_categories', field: 'product_group_id', parentTable: 'product_groups', kind: 'blocking', optional: false },
  { childTable: 'product_variants', field: 'product_group_id', parentTable: 'product_groups', kind: 'blocking', optional: false },
  { childTable: 'product_variants', field: 'product_category_id', parentTable: 'product_categories', kind: 'metadata', optional: true },
  { childTable: 'bundle_components', field: 'bundle_variant_id', parentTable: 'product_variants', kind: 'blocking', optional: false },
  { childTable: 'bundle_components', field: 'component_variant_id', parentTable: 'product_variants', kind: 'blocking', optional: false },
  { childTable: 'purchase_batches', field: 'product_group_id', parentTable: 'product_groups', kind: 'blocking', optional: false },
  { childTable: 'purchase_batch_items', field: 'purchase_batch_id', parentTable: 'purchase_batches', kind: 'blocking', optional: false },
  { childTable: 'purchase_batch_items', field: 'product_variant_id', parentTable: 'product_variants', kind: 'blocking', optional: false },
  { childTable: 'private_orders', field: 'product_group_id', parentTable: 'product_groups', kind: 'blocking', optional: false },
  { childTable: 'private_order_items', field: 'private_order_id', parentTable: 'private_orders', kind: 'blocking', optional: false },
  { childTable: 'private_order_items', field: 'product_variant_id', parentTable: 'product_variants', kind: 'blocking', optional: false },
  { childTable: 'sales_order_items', field: 'order_id', parentTable: 'sales_orders', kind: 'blocking', optional: false },
  { childTable: 'sales_order_items', field: 'product_variant_id', parentTable: 'product_variants', kind: 'metadata', optional: true },
  { childTable: 'japan_package_items', field: 'japan_package_id', parentTable: 'japan_packages', kind: 'blocking', optional: false },
  { childTable: 'japan_package_items', field: 'product_group_id', parentTable: 'product_groups', kind: 'metadata', optional: true },
  { childTable: 'japan_package_items', field: 'product_variant_id', parentTable: 'product_variants', kind: 'metadata', optional: true },
  { childTable: 'japan_package_items', field: 'purchase_batch_id', parentTable: 'purchase_batches', kind: 'metadata', optional: true },
  { childTable: 'japan_package_items', field: 'purchase_batch_item_id', parentTable: 'purchase_batch_items', kind: 'metadata', optional: true },
  { childTable: 'outbound_shipment_items', field: 'outbound_shipment_id', parentTable: 'outbound_shipments', kind: 'blocking', optional: false },
  { childTable: 'outbound_shipment_items', field: 'japan_package_item_id', parentTable: 'japan_package_items', kind: 'metadata', optional: true },
  { childTable: 'outbound_shipment_items', field: 'product_group_id', parentTable: 'product_groups', kind: 'metadata', optional: true },
  { childTable: 'outbound_shipment_items', field: 'product_variant_id', parentTable: 'product_variants', kind: 'metadata', optional: true },
  { childTable: 'waca_order_items', field: 'order_id', parentTable: 'waca_orders', kind: 'blocking', optional: false },
  { childTable: 'waca_order_items', field: 'product_variant_id', parentTable: 'product_variants', kind: 'metadata', optional: true },
  { childTable: 'waca_mappings', field: 'product_variant_id', parentTable: 'product_variants', kind: 'blocking', optional: false },
  { childTable: 'waca_master_links', field: 'product_variant_id', parentTable: 'product_variants', kind: 'metadata', optional: true },
  { childTable: 'waca_cutover_audit', field: 'product_variant_id', parentTable: 'product_variants', kind: 'blocking', optional: false },
] as const satisfies readonly CloudRestoreRelationSpec[];

export const cloudRestoreRelationKey = (relation: CloudRestoreRelationSpec): string => (
  `${relation.childTable}.${relation.field}->${relation.parentTable}`
);
