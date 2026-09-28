/** A single explicit classification for every persisted ERP/NEXT resource. */
export const DURABLE_RESOURCE_REGISTRY = [
  { key: 'inventory', backupKey: 'inventory', restore: 'core-idb', cloud: 'inventory_items' },
  { key: 'salesOrders', backupKey: 'salesOrders', restore: 'core-idb', cloud: 'sales_orders' },
  { key: 'salesOrderItems', backupKey: 'salesOrderItems', restore: 'core-idb', cloud: 'sales_order_items' },
  { key: 'productGroups', backupKey: 'productGroups', restore: 'core-idb', cloud: 'product_groups' },
  { key: 'productCategories', backupKey: 'productCategories', restore: 'core-idb', cloud: 'product_categories' },
  { key: 'productVariants', backupKey: 'productVariants', restore: 'core-idb', cloud: 'product_variants' },
  { key: 'purchaseBatches', backupKey: 'purchaseBatches', restore: 'core-idb', cloud: 'purchase_batches' },
  { key: 'purchaseBatchItems', backupKey: 'purchaseBatchItems', restore: 'core-idb', cloud: 'purchase_batch_items' },
  { key: 'privateOrders', backupKey: 'privateOrders', restore: 'core-idb', cloud: 'private_orders' },
  { key: 'privateOrderItems', backupKey: 'privateOrderItems', restore: 'core-idb', cloud: 'private_order_items' },
  { key: 'importBatches', backupKey: 'importBatches', restore: 'core-idb', cloud: 'import_batches' },
  { key: 'bundleComponents', backupKey: 'bundleComponents', restore: 'core-idb', cloud: 'bundle_components' },
  { key: 'japanPackages', backupKey: 'japanPackages', restore: 'core-idb', cloud: 'japan_packages' },
  { key: 'japanPackageItems', backupKey: 'japanPackageItems', restore: 'core-idb', cloud: 'japan_package_items' },
  { key: 'outboundShipments', backupKey: 'outboundShipments', restore: 'core-idb', cloud: 'outbound_shipments' },
  { key: 'outboundShipmentItems', backupKey: 'outboundShipmentItems', restore: 'core-idb', cloud: 'outbound_shipment_items' },
  { key: 'wacaOrders', backupKey: 'wacaOrders', restore: 'core-idb', cloud: 'waca_orders' },
  { key: 'wacaItems', backupKey: 'wacaItems', restore: 'core-idb', cloud: 'waca_order_items' },
  { key: 'wacaMappings', backupKey: 'wacaMappings', restore: 'core-idb', cloud: 'waca_mappings' },
  { key: 'wacaImportBatches', backupKey: 'wacaImportBatches', restore: 'core-idb', cloud: 'waca_import_batches' },
  { key: 'myacgMasterLinks', backupKey: 'myacgMasterLinks', restore: 'core-idb', cloud: 'waca_master_links' },
  { key: 'wacaCutoverAudit', backupKey: 'wacaCutoverAudit', restore: 'core-idb', cloud: 'waca_cutover_audit' },
  { key: 'wacaCutoverState', backupKey: 'wacaCutoverState', restore: 'core-idb', cloud: 'waca_state' },
  { key: 'deadlineVerifiedMappings', backupKey: 'deadlineVerifiedMappings', restore: 'deadline-sidecar', cloud: 'deadline-sidecar-section' },
  { key: 'deadlineApplyBatches', backupKey: 'deadlineApplyBatches', restore: 'deadline-sidecar', cloud: 'deadline-sidecar-section' },
  { key: 'deadlineApplyItems', backupKey: 'deadlineApplyItems', restore: 'deadline-sidecar', cloud: 'deadline-sidecar-section' },
] as const;

export const REBUILDABLE_RESOURCE_REGISTRY = [
  { key: 'waca_auto_quantity', reason: 'SUM of matched effective WACA items; persisted projection in product_variants' },
  { key: 'waca_import_preview', reason: 'derived from selected workbook and ledger' },
  { key: 'waca_reconciliation_display', reason: 'derived from ledger and product variants' },
  { key: 'closing_date_resolution_batches', reason: 'analysis jobs may be rerun' },
  { key: 'closing_date_resolution_results', reason: 'analysis results may be regenerated; approvals persist in verified mappings' },
  { key: 'closing_date_resolution_candidates', reason: 'ranked temporary candidates may be regenerated' },
] as const;

export const EPHEMERAL_RESOURCE_REGISTRY = [
  'waca_selected_tab', 'waca_expanded_rows', 'waca_temporary_upload_preview',
  'waca_unconfirmed_mapping_preview', 'erp_waca_revision_v1', 'erp_last_import_backup',
  'cloud_deadline_restore_stage',
] as const;

/** Retained for old-data compatibility, but absent from the mounted ERP homepage. */
export const LEGACY_UNUSED_RESOURCE_REGISTRY = [
  {
    key: 'dashboardCategoryImages',
    backupKey: 'dashboardCategoryImages',
    restore: 'core-idb-image',
    cloud: 'dashboard_category_images',
    reason: 'Legacy image metadata/local bytes remain in JSON and Cloud row snapshots for compatibility; no current UI consumes them.',
  },
  {
    key: 'dashboard-category-images-storage-objects',
    backupKey: null,
    restore: 'not-in-current-product',
    cloud: 'legacy-storage-bucket',
    reason: 'The current mounted ERP UI has no Supabase Storage image read or write path.',
  },
] as const;

export const RESOURCE_CLASSIFICATION = {
  A_MUST_BACKUP_RESTORE: DURABLE_RESOURCE_REGISTRY,
  B_DERIVED_REBUILDABLE: REBUILDABLE_RESOURCE_REGISTRY,
  C_EPHEMERAL_EXCLUDED: EPHEMERAL_RESOURCE_REGISTRY,
  D_LEGACY_UNUSED: LEGACY_UNUSED_RESOURCE_REGISTRY,
} as const;
