// Versioned Restore identity contract derived from the post-state asserted by
// tools/staging-refresh/sql/staging_schema_parity_20260905.sql. This fixture is
// intentionally limited to the columns that authorize canonical identity and
// safeupdate-compatible full replacement; it is not a generic schema guesser.
export const CLOUD_RESTORE_SCHEMA_FIXTURE_VERSION = 'staging-parity-post-state-20260905';
export const CLOUD_RESTORE_SCHEMA_FIXTURE_PROVENANCE = 'current parity post-state';

export const CLOUD_RESTORE_TABLES = Object.freeze([
  'inventory_items',
  'product_groups',
  'product_categories',
  'product_variants',
  'bundle_components',
  'purchase_batches',
  'purchase_batch_items',
  'private_orders',
  'private_order_items',
  'sales_orders',
  'sales_order_items',
  'japan_packages',
  'japan_package_items',
  'outbound_shipments',
  'outbound_shipment_items',
]);

const idColumn = Object.freeze({ dataType: 'uuid', nullable: false, primaryKey: true });

export const CLOUD_RESTORE_LIVE_SCHEMA_CONTRACT = Object.freeze({
  version: CLOUD_RESTORE_SCHEMA_FIXTURE_VERSION,
  provenance: CLOUD_RESTORE_SCHEMA_FIXTURE_PROVENANCE,
  tables: Object.freeze(Object.fromEntries(CLOUD_RESTORE_TABLES.map(table => [table, Object.freeze({
    primaryKey: Object.freeze(['id']),
    columns: Object.freeze({
      id: idColumn,
      ...(table === 'inventory_items' ? {
        inventory_key: Object.freeze({ dataType: 'text', nullable: false, unique: true, primaryKey: false }),
      } : {}),
    }),
    deletePredicate: 'id IS NOT NULL',
    canonicalIdentity: 'id',
  })]))),
});

export function assertCloudRestoreLiveSchemaContract(schema) {
  if (schema?.provenance !== CLOUD_RESTORE_SCHEMA_FIXTURE_PROVENANCE) {
    throw new Error('CLOUD_RESTORE_SCHEMA_PROVENANCE_MISMATCH');
  }
  for (const table of CLOUD_RESTORE_TABLES) {
    const contract = schema.tables?.[table];
    const id = contract?.columns?.id;
    if (contract?.primaryKey?.length !== 1
        || contract.primaryKey[0] !== 'id'
        || id?.dataType !== 'uuid'
        || id.nullable !== false
        || id.primaryKey !== true
        || contract.deletePredicate !== 'id IS NOT NULL'
        || contract.canonicalIdentity !== 'id') {
      throw new Error(`CLOUD_RESTORE_ID_PRIMARY_KEY_CONTRACT_MISMATCH:${table}`);
    }
  }
  const inventoryKey = schema.tables.inventory_items.columns.inventory_key;
  if (inventoryKey?.dataType !== 'text'
      || inventoryKey.nullable !== false
      || inventoryKey.unique !== true
      || inventoryKey.primaryKey !== false) {
    throw new Error('CLOUD_RESTORE_INVENTORY_KEY_CONTRACT_MISMATCH');
  }
}
