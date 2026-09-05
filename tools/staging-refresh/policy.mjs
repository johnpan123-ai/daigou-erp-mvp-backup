export const PRODUCTION_PROJECT_REF = 'twzpqyesbtnfxdkorluf';
export const STAGING_PROJECT_REF = 'rhfdjsklfrgpoqsaqpkn';
export const RESTORE_WRITER_ROLE = 'staging_refresh_restore_writer';
export const SNAPSHOT_SCHEMA_CONTRACT_VERSION = 2;

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
  inventory_items: ['id'],
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

const requireConnectionUrl = (environment, variableName) => {
  const connectionUrl = String(environment?.[variableName] || '').trim();
  if (!connectionUrl) {
    throw new StagingRefreshPolicyError(
      'DATABASE_URL_REQUIRED',
      `${variableName} is required`,
    );
  }
  return connectionUrl;
};

export function assertRestoreWriterConnection(connectionUrl) {
  const parsed = assertConnectionTargetsProject(
    connectionUrl,
    STAGING_PROJECT_REF,
    'Staging restore writer',
  );

  let username;
  try {
    username = decodeURIComponent(parsed.username).toLowerCase();
  } catch {
    throw new StagingRefreshPolicyError(
      'RESTORE_WRITER_USERNAME_INVALID',
      'Staging restore writer username is not valid URL encoding',
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const expectedDirectHost = `db.${STAGING_PROJECT_REF}.supabase.co`;
  const expectedPoolerUsername = `${RESTORE_WRITER_ROLE}.${STAGING_PROJECT_REF}`;
  const isSupabasePooler = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/u.test(hostname);

  if (`${hostname} ${username}`.includes(PRODUCTION_PROJECT_REF)) {
    throw new StagingRefreshPolicyError(
      'PRODUCTION_TARGET_BLOCKED',
      'Staging restore writer must never identify the Production project',
    );
  }

  if (hostname === expectedDirectHost) {
    if (username !== RESTORE_WRITER_ROLE) {
      throw new StagingRefreshPolicyError(
        'RESTORE_WRITER_ROLE_NOT_ALLOWED',
        `Direct Staging restore connections must use ${RESTORE_WRITER_ROLE}`,
      );
    }
    return parsed;
  }

  if (isSupabasePooler) {
    if (username !== expectedPoolerUsername) {
      throw new StagingRefreshPolicyError(
        'RESTORE_WRITER_ROLE_NOT_ALLOWED',
        `Staging pooler restore connections must use ${expectedPoolerUsername}`,
      );
    }
    return parsed;
  }

  throw new StagingRefreshPolicyError(
    'RESTORE_WRITER_HOST_NOT_ALLOWED',
    'Staging restore writer must use the verified Supabase direct or pooler hostname',
  );
}

export function resolveSnapshotConnection(role, environment = {}) {
  if (!['production', 'staging-rollback'].includes(role)) {
    throw new StagingRefreshPolicyError(
      'SNAPSHOT_ROLE_INVALID',
      'Snapshot role must be production or staging-rollback',
    );
  }

  const isProduction = role === 'production';
  const variableName = isProduction
    ? 'STAGING_REFRESH_SOURCE_DATABASE_URL'
    : 'STAGING_REFRESH_TARGET_DATABASE_URL';
  const expectedRef = isProduction ? PRODUCTION_PROJECT_REF : STAGING_PROJECT_REF;
  const label = isProduction ? 'Production snapshot source' : 'Staging rollback source';
  const connectionUrl = requireConnectionUrl(environment, variableName);
  assertConnectionTargetsProject(connectionUrl, expectedRef, label);
  return { connectionUrl, expectedRef, label, variableName };
}

export function resolveDryRunConnection(environment = {}) {
  const variableName = 'STAGING_REFRESH_TARGET_DATABASE_URL';
  const connectionUrl = requireConnectionUrl(environment, variableName);
  assertConnectionTargetsProject(connectionUrl, STAGING_PROJECT_REF, 'Staging dry-run target');
  return {
    connectionUrl,
    expectedRef: STAGING_PROJECT_REF,
    label: 'Staging dry-run target',
    variableName,
  };
}

export function resolveRestoreConnection(environment = {}) {
  const variableName = 'STAGING_REFRESH_RESTORE_DATABASE_URL';
  const connectionUrl = String(environment?.[variableName] || '').trim();
  if (!connectionUrl) {
    throw new StagingRefreshPolicyError(
      'RESTORE_DATABASE_URL_REQUIRED',
      `${variableName} is required for restore --execute; the read-only target credential is never used as a fallback`,
    );
  }
  assertRestoreWriterConnection(connectionUrl);
  return {
    connectionUrl,
    expectedRef: STAGING_PROJECT_REF,
    label: 'Staging restore writer',
    variableName,
  };
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
