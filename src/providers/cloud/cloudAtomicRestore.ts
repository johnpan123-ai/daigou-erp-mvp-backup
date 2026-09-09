import type { CloudMutableEntity } from './cloudFieldCas';
import { toCloudFieldRow } from './cloudEntityPayload';

export const CLOUD_RESTORE_SCHEMA_VERSION = 'cloud-erp-snapshot-v1' as const;
export const CLOUD_RESTORE_RPC = 'erp_restore_cloud_snapshot' as const;
export const CLOUD_RESTORE_TABLES = [
  ['inventory', 'inventory_items'],
  ['productGroups', 'product_groups'],
  ['productCategories', 'product_categories'],
  ['productVariants', 'product_variants'],
  ['bundleComponents', 'bundle_components'],
  ['purchaseBatches', 'purchase_batches'],
  ['purchaseBatchItems', 'purchase_batch_items'],
  ['privateOrders', 'private_orders'],
  ['privateOrderItems', 'private_order_items'],
  ['salesOrders', 'sales_orders'],
  ['salesOrderItems', 'sales_order_items'],
  ['japanPackages', 'japan_packages'],
  ['japanPackageItems', 'japan_package_items'],
  ['outboundShipments', 'outbound_shipments'],
  ['outboundShipmentItems', 'outbound_shipment_items'],
] as const;

export type CloudRestoreCollection = typeof CLOUD_RESTORE_TABLES[number][0];
export type CloudRestoreTable = typeof CLOUD_RESTORE_TABLES[number][1];
export type CloudRestoreSnapshotData = Record<CloudRestoreTable, Record<string, unknown>[]>;

export interface CloudRestoreManifest {
  schemaVersion: typeof CLOUD_RESTORE_SCHEMA_VERSION;
  resourceCount: number;
  counts: Record<CloudRestoreTable, number>;
  totalRows: number;
  snapshotFingerprint: string;
  unknownProductCount: number;
  orphanCount: number;
  duplicateVariantIdCount: number;
  duplicateVariantLocalIdCount: number;
  relationshipHash: string;
}

export interface CloudRestoreCandidate {
  schemaVersion: typeof CLOUD_RESTORE_SCHEMA_VERSION;
  data: CloudRestoreSnapshotData;
  manifest: CloudRestoreManifest;
  sourceEnvironment: string;
  fileName: string;
}

export interface CloudRestoreCommand {
  idempotencyKey: string;
  candidate: CloudRestoreCandidate;
  confirmation: 'OVERWRITE CLOUD DATA';
}

export interface CloudRestoreResult {
  ok: true;
  replayed: boolean;
  idempotencyKey: string;
  snapshotFingerprint: string;
  rollbackSnapshotId: string;
  restoreEpoch: number;
  manifest: CloudRestoreManifest;
}

export class CloudRestoreValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CloudRestoreValidationError';
    this.code = code;
  }
}

export class CloudRestoreServerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CloudRestoreServerError';
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
};

export const stableCloudRestoreJson = (value: unknown): string => JSON.stringify(stableValue(value));

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const canonicalId = (row: Record<string, unknown>, table: CloudRestoreTable): string => {
  if (table === 'inventory_items') {
    const inventoryKey = String(row.inventory_key ?? '').trim();
    if (!inventoryKey) throw new CloudRestoreValidationError('INVENTORY_KEY_REQUIRED', 'Inventory 資料缺少 inventory_key。');
    return inventoryKey;
  }
  const databaseId = String(row.database_id ?? '').trim();
  const id = UUID_PATTERN.test(databaseId) ? databaseId : String(row.id ?? '').trim();
  if (!UUID_PATTERN.test(id)) {
    throw new CloudRestoreValidationError('CANONICAL_UUID_REQUIRED', `${table} 必須保留 canonical database UUID。`);
  }
  return id.toLowerCase();
};

const normalizeRows = (
  source: Record<string, unknown>,
): CloudRestoreSnapshotData => Object.fromEntries(CLOUD_RESTORE_TABLES.map(([collection, table]) => {
  const rows = source[collection];
  if (!Array.isArray(rows)) {
    throw new CloudRestoreValidationError('RESTORE_COLLECTION_REQUIRED', `JSON 缺少 ${collection} 陣列。`);
  }
  const entity = table as CloudMutableEntity;
  const normalized = rows.map((value, index) => {
    if (!isRecord(value)) {
      throw new CloudRestoreValidationError('RESTORE_ROW_INVALID', `${collection}[${index}] 不是物件。`);
    }
    let row: Record<string, unknown>;
    try {
      row = toCloudFieldRow(entity, value);
    } catch (error) {
      if (error instanceof Error && error.message.includes('CANONICAL_UUID_REQUIRED')) {
        throw new CloudRestoreValidationError('CANONICAL_UUID_REQUIRED', `${table} 必須保留 canonical database UUID。`);
      }
      throw error;
    }
    if (table !== 'inventory_items') row.id = canonicalId(value, table);
    if (table === 'sales_order_items') {
      const orderDatabaseId = String(value.order_database_id ?? value.order_id ?? '').trim();
      if (UUID_PATTERN.test(orderDatabaseId)) row.order_id = orderDatabaseId.toLowerCase();
    }
    delete row.version;
    return Object.fromEntries(Object.entries(row).filter(([, fieldValue]) => fieldValue !== undefined));
  });
  return [table, normalized];
})) as CloudRestoreSnapshotData;

const idsFor = (data: CloudRestoreSnapshotData, table: CloudRestoreTable): Set<string> => new Set(
  data[table].map(row => canonicalId(row, table)),
);

const requireRelation = (
  row: Record<string, unknown>, field: string, parents: Set<string>, optional = false,
): number => {
  const value = String(row[field] ?? '').trim().toLowerCase();
  if (!value && optional) return 0;
  return value && parents.has(value) ? 0 : 1;
};

function countOrphans(data: CloudRestoreSnapshotData): number {
  const groups = idsFor(data, 'product_groups');
  const categories = idsFor(data, 'product_categories');
  const variants = idsFor(data, 'product_variants');
  const batches = idsFor(data, 'purchase_batches');
  const batchItems = idsFor(data, 'purchase_batch_items');
  const privateOrders = idsFor(data, 'private_orders');
  const salesOrders = idsFor(data, 'sales_orders');
  const packages = idsFor(data, 'japan_packages');
  const packageItems = idsFor(data, 'japan_package_items');
  const shipments = idsFor(data, 'outbound_shipments');
  let count = 0;
  data.product_categories.forEach(row => { count += requireRelation(row, 'product_group_id', groups); });
  data.product_variants.forEach(row => {
    count += requireRelation(row, 'product_group_id', groups);
    count += requireRelation(row, 'product_category_id', categories, true);
  });
  data.bundle_components.forEach(row => {
    count += requireRelation(row, 'bundle_variant_id', variants);
    count += requireRelation(row, 'component_variant_id', variants);
  });
  data.purchase_batches.forEach(row => { count += requireRelation(row, 'product_group_id', groups); });
  data.purchase_batch_items.forEach(row => {
    count += requireRelation(row, 'purchase_batch_id', batches);
    count += requireRelation(row, 'product_variant_id', variants);
  });
  data.private_orders.forEach(row => { count += requireRelation(row, 'product_group_id', groups); });
  data.private_order_items.forEach(row => {
    count += requireRelation(row, 'private_order_id', privateOrders);
    count += requireRelation(row, 'product_variant_id', variants);
  });
  data.sales_order_items.forEach(row => {
    count += requireRelation(row, 'order_id', salesOrders);
    count += requireRelation(row, 'product_variant_id', variants, true);
  });
  data.japan_package_items.forEach(row => {
    count += requireRelation(row, 'japan_package_id', packages);
    count += requireRelation(row, 'product_group_id', groups, true);
    count += requireRelation(row, 'product_variant_id', variants, true);
    count += requireRelation(row, 'purchase_batch_id', batches, true);
    count += requireRelation(row, 'purchase_batch_item_id', batchItems, true);
  });
  data.outbound_shipment_items.forEach(row => {
    count += requireRelation(row, 'outbound_shipment_id', shipments);
    count += requireRelation(row, 'japan_package_item_id', packageItems, true);
    count += requireRelation(row, 'product_group_id', groups, true);
    count += requireRelation(row, 'product_variant_id', variants, true);
  });
  return count;
}

const duplicateCount = (values: string[]): number => values.length - new Set(values).size;

const manifestFor = async (data: CloudRestoreSnapshotData): Promise<CloudRestoreManifest> => {
  const relationshipProjection = CLOUD_RESTORE_TABLES.flatMap(([, table]) => data[table].map(row => ({
    table,
    id: canonicalId(row, table),
    relations: Object.fromEntries(Object.entries(row).filter(([key]) => key.endsWith('_id') && key !== 'local_id')),
  }))).sort((left, right) => `${left.table}:${left.id}`.localeCompare(`${right.table}:${right.id}`));
  const counts = Object.fromEntries(CLOUD_RESTORE_TABLES.map(([, table]) => [table, data[table].length])) as Record<CloudRestoreTable, number>;
  const snapshotFingerprint = await sha256Hex(stableCloudRestoreJson(data));
  const relationshipHash = await sha256Hex(stableCloudRestoreJson(relationshipProjection));
  const unknownProductCount = data.product_groups.filter(row => {
    const title = String(row.normalized_title ?? row.title ?? '').trim().toLowerCase();
    return title === '未知商品' || title === 'unknown product';
  }).length;
  return {
    schemaVersion: CLOUD_RESTORE_SCHEMA_VERSION,
    resourceCount: CLOUD_RESTORE_TABLES.length,
    counts,
    totalRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
    snapshotFingerprint,
    unknownProductCount,
    orphanCount: 0,
    duplicateVariantIdCount: 0,
    duplicateVariantLocalIdCount: 0,
    relationshipHash,
  };
};

const assertManifestMatches = (provided: unknown, expected: CloudRestoreManifest): void => {
  if (!isRecord(provided)) throw new CloudRestoreValidationError('RESTORE_MANIFEST_REQUIRED', 'JSON 缺少 manifest。');
  const providedCounts = isRecord(provided.counts) ? provided.counts : null;
  if (provided.schemaVersion !== expected.schemaVersion
    || provided.resourceCount !== expected.resourceCount
    || provided.totalRows !== expected.totalRows
    || provided.snapshotFingerprint !== expected.snapshotFingerprint
    || provided.relationshipHash !== expected.relationshipHash
    || provided.unknownProductCount !== expected.unknownProductCount
    || provided.orphanCount !== expected.orphanCount
    || provided.duplicateVariantIdCount !== expected.duplicateVariantIdCount
    || provided.duplicateVariantLocalIdCount !== expected.duplicateVariantLocalIdCount
    || !providedCounts
    || CLOUD_RESTORE_TABLES.some(([, table]) => providedCounts[table] !== expected.counts[table])) {
    throw new CloudRestoreValidationError('RESTORE_MANIFEST_MISMATCH', 'JSON manifest 與資料內容不一致。');
  }
};

export async function buildCloudRestoreManifest(source: Record<string, unknown>): Promise<{
  data: CloudRestoreSnapshotData;
  manifest: CloudRestoreManifest;
}> {
  const data = normalizeRows(source);
  return { data, manifest: await manifestFor(data) };
}

export async function prepareCloudRestoreSnapshot(
  input: string | unknown,
  options: { fileName?: string; sourceEnvironment?: string } = {},
): Promise<CloudRestoreCandidate> {
  let parsed: unknown;
  try {
    parsed = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (error) {
    throw new CloudRestoreValidationError('MALFORMED_JSON', `JSON 解析失敗：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new CloudRestoreValidationError('RESTORE_DOCUMENT_INVALID', 'JSON 最上層必須是物件。');
  if (parsed.schemaVersion !== CLOUD_RESTORE_SCHEMA_VERSION) {
    throw new CloudRestoreValidationError('UNSUPPORTED_SCHEMA_VERSION', `不支援的 schemaVersion：${String(parsed.schemaVersion ?? 'missing')}`);
  }
  const rawData = isRecord(parsed.data) ? parsed.data : null;
  if (!rawData) throw new CloudRestoreValidationError('RESTORE_DATA_REQUIRED', 'JSON 缺少 data 物件。');
  const allowedCollections = new Set<string>(CLOUD_RESTORE_TABLES.map(([collection]) => collection));
  const unexpected = Object.keys(rawData).filter(key => !allowedCollections.has(key));
  if (unexpected.length > 0) throw new CloudRestoreValidationError('UNEXPECTED_RESOURCE', `JSON 含不支援的 resource：${unexpected.join(', ')}`);
  const data = normalizeRows(rawData);
  for (const [, table] of CLOUD_RESTORE_TABLES) {
    const ids = data[table].map(row => canonicalId(row, table));
    if (duplicateCount(ids) > 0) throw new CloudRestoreValidationError('DUPLICATE_CANONICAL_ID', `${table} 含重複 identity。`);
  }
  const orphanCount = countOrphans(data);
  if (orphanCount > 0) throw new CloudRestoreValidationError('ORPHAN_RELATION', `JSON 含 ${orphanCount} 筆無效關聯。`);
  const variants = data.product_variants;
  const duplicateVariantLocalIdCount = duplicateCount(variants
    .map(row => String(row.local_id ?? '').trim())
    .filter(Boolean));
  if (duplicateVariantLocalIdCount > 0) {
    throw new CloudRestoreValidationError('DUPLICATE_VARIANT_LOCAL_ID', 'Variant local_id 不可重複。');
  }
  const manifest = await manifestFor(data);
  assertManifestMatches(parsed.manifest, manifest);
  return {
    schemaVersion: CLOUD_RESTORE_SCHEMA_VERSION,
    data,
    manifest,
    sourceEnvironment: String(parsed.sourceEnvironment ?? options.sourceEnvironment ?? 'unknown'),
    fileName: options.fileName ?? 'cloud-restore.json',
  };
}

export function assertCloudRestoreServerResult(value: unknown): CloudRestoreResult {
  if (!isRecord(value) || value.ok !== true) {
    const code = isRecord(value) && typeof value.code === 'string' ? value.code : 'CLOUD_RESTORE_FAILED';
    const message = isRecord(value) && typeof value.message === 'string' ? value.message : 'Cloud Restore 未完成，資料已回滾。';
    throw new CloudRestoreServerError(code, message);
  }
  return value as unknown as CloudRestoreResult;
}
