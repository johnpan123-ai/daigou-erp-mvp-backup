export const PRODUCTION_PROJECT_REF = 'twzpqyesbtnfxdkorluf';
export const STAGING_PROJECT_REF = 'rhfdjsklfrgpoqsaqpkn';

export const REQUIRED_TABLES = Object.freeze([
  'inventory_items',
  'product_groups',
  'product_categories',
  'product_variants',
  'purchase_batches',
  'purchase_batch_items',
  'private_orders',
  'private_order_items',
  'sales_orders',
  'sales_order_items',
  'japan_packages',
  'japan_package_items',
  'bundle_components',
  'outbound_shipments',
  'outbound_shipment_items',
]);

export const OPTIONAL_BUSINESS_TABLES = Object.freeze([
  'import_batches',
  'dashboard_category_images',
]);

export const REVIEW_REQUIRED_TABLES = Object.freeze([
  'inventory',
  'catalog_import_runs',
  'catalog_import_run_events',
  'catalog_import_changes',
  'catalog_import_quantity_snapshots',
]);

export const EXCLUDED_ENVIRONMENT_TABLES = Object.freeze([
  'profiles',
  'erp_healthcheck',
]);

export const RESTORE_ORDER = Object.freeze([
  'inventory_items',
  'import_batches',
  'dashboard_category_images',
  'product_groups',
  'product_categories',
  'product_variants',
  'sales_orders',
  'purchase_batches',
  'private_orders',
  'japan_packages',
  'outbound_shipments',
  'sales_order_items',
  'purchase_batch_items',
  'private_order_items',
  'japan_package_items',
  'bundle_components',
  'outbound_shipment_items',
]);

export const TABLE_KEY_COLUMNS = Object.freeze({
  inventory_items: ['myacg_item_code'],
  import_batches: ['id'],
  dashboard_category_images: ['id'],
  product_groups: ['id'],
  product_categories: ['id'],
  product_variants: ['id'],
  sales_orders: ['id'],
  sales_order_items: ['id'],
  purchase_batches: ['id'],
  purchase_batch_items: ['id'],
  private_orders: ['id'],
  private_order_items: ['id'],
  japan_packages: ['id'],
  japan_package_items: ['id'],
  bundle_components: ['id'],
  outbound_shipments: ['id'],
  outbound_shipment_items: ['id'],
});

export const LOGICAL_RELATIONSHIPS = Object.freeze([
  ['product_categories', 'product_group_id', 'product_groups', 'id'],
  ['product_variants', 'product_group_id', 'product_groups', 'id'],
  ['product_variants', 'product_category_id', 'product_categories', 'id'],
  ['purchase_batches', 'product_group_id', 'product_groups', 'id'],
  ['purchase_batch_items', 'purchase_batch_id', 'purchase_batches', 'id'],
  ['purchase_batch_items', 'product_variant_id', 'product_variants', 'id'],
  ['private_orders', 'product_group_id', 'product_groups', 'id'],
  ['private_order_items', 'private_order_id', 'private_orders', 'id'],
  ['private_order_items', 'product_variant_id', 'product_variants', 'id'],
  ['sales_order_items', 'order_id', 'sales_orders', 'id'],
  ['sales_order_items', 'product_variant_id', 'product_variants', 'id'],
  ['japan_package_items', 'japan_package_id', 'japan_packages', 'id'],
  ['japan_package_items', 'product_group_id', 'product_groups', 'id'],
  ['japan_package_items', 'product_variant_id', 'product_variants', 'id'],
  ['japan_package_items', 'purchase_batch_id', 'purchase_batches', 'id'],
  ['japan_package_items', 'purchase_batch_item_id', 'purchase_batch_items', 'id'],
  ['bundle_components', 'bundle_variant_id', 'product_variants', 'id'],
  ['bundle_components', 'component_variant_id', 'product_variants', 'id'],
  ['outbound_shipment_items', 'outbound_shipment_id', 'outbound_shipments', 'id'],
  ['outbound_shipment_items', 'japan_package_item_id', 'japan_package_items', 'id'],
  ['outbound_shipment_items', 'product_group_id', 'product_groups', 'id'],
  ['outbound_shipment_items', 'product_variant_id', 'product_variants', 'id'],
]);

export class StagingRefreshPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StagingRefreshPolicyError';
    this.code = code;
  }
}

export function assertProjectRef(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9]{20}$/.test(normalized)) {
    throw new StagingRefreshPolicyError('INVALID_PROJECT_REF', `${label} project ref 無效。`);
  }
  return normalized;
}

export function assertRefreshDirection(sourceRef, targetRef) {
  const source = assertProjectRef(sourceRef, 'Source');
  const target = assertProjectRef(targetRef, 'Target');
  if (source === target) {
    throw new StagingRefreshPolicyError('SOURCE_TARGET_EQUAL', 'Source 與 Target 不得相同。');
  }
  if (source !== PRODUCTION_PROJECT_REF) {
    throw new StagingRefreshPolicyError('SOURCE_NOT_PRODUCTION', 'Snapshot source 只能是已核准 Production。');
  }
  if (target === PRODUCTION_PROJECT_REF) {
    throw new StagingRefreshPolicyError('PRODUCTION_TARGET_BLOCKED', 'Production 永遠不得成為 restore target。');
  }
  if (target !== STAGING_PROJECT_REF) {
    throw new StagingRefreshPolicyError('TARGET_NOT_STAGING', 'Restore target 只能是已核准 Staging。');
  }
  return { source, target };
}

export function assertConnectionTargetsProject(connectionUrl, expectedRef, label) {
  const projectRef = assertProjectRef(expectedRef, label);
  let parsed;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    throw new StagingRefreshPolicyError('INVALID_DATABASE_URL', `${label} database URL 無效。`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new StagingRefreshPolicyError('INVALID_DATABASE_PROTOCOL', `${label} 必須使用 PostgreSQL 連線。`);
  }
  const identityText = decodeURIComponent(`${parsed.hostname} ${parsed.username}`).toLowerCase();
  if (!identityText.includes(projectRef)) {
    throw new StagingRefreshPolicyError(
      'DATABASE_PROJECT_REF_MISMATCH',
      `${label} database connection 無法證明屬於 ${projectRef}。`,
    );
  }
  return parsed;
}

export function classifyPublicTables(publicTables) {
  const discovered = [...new Set(publicTables)].sort();
  const requiredMissing = REQUIRED_TABLES.filter(table => !discovered.includes(table));
  const included = [
    ...REQUIRED_TABLES.filter(table => discovered.includes(table)),
    ...OPTIONAL_BUSINESS_TABLES.filter(table => discovered.includes(table)),
  ];
  const reviewRequired = REVIEW_REQUIRED_TABLES.filter(table => discovered.includes(table));
  const excluded = EXCLUDED_ENVIRONMENT_TABLES.filter(table => discovered.includes(table));
  const known = new Set([
    ...REQUIRED_TABLES,
    ...OPTIONAL_BUSINESS_TABLES,
    ...REVIEW_REQUIRED_TABLES,
    ...EXCLUDED_ENVIRONMENT_TABLES,
  ]);
  const unclassified = discovered.filter(table => !known.has(table));
  return { discovered, included, requiredMissing, reviewRequired, excluded, unclassified };
}

const SENSITIVE_COLUMN_NAMES = new Set([
  'password',
  'encrypted_password',
  'access_token',
  'refresh_token',
  'session',
  'session_id',
  'secret',
  'service_role',
  'service_role_key',
  'supabase_key',
  'anon_key',
]);

export function assertNoSecrets(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_COLUMN_NAMES.has(key.toLowerCase())) {
      throw new StagingRefreshPolicyError('SECRET_IN_SNAPSHOT', `Snapshot 禁止包含敏感欄位：${path}.${key}`);
    }
    assertNoSecrets(nested, `${path}.${key}`);
  }
}

export function assertPiiMode(mode) {
  if (mode !== 'internal-preserve') {
    throw new StagingRefreshPolicyError(
      'PII_MODE_NOT_IMPLEMENTED',
      '目前只開放 internal-preserve；masked 必須先完成獨立遮罩規則與驗收。',
    );
  }
  return mode;
}
