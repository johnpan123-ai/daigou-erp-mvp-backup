import type { CloudMutableEntity } from './cloudFieldCas';
import { toCloudFieldRow } from './cloudEntityPayload';
import { CLOUD_RESTORE_RELATIONS, cloudRestoreRelationKey, type CloudRestoreRelationSpec } from './cloudRestoreRelations';
import {
  LEGACY_CLOUD_RESTORE_IDENTITY_CONTRACT,
  verifyLegacyCloudRestoreSnapshot,
} from './cloudRestoreLegacySnapshot';
import { parseCloudRestoreFailure, type CloudRestoreFailure } from './cloudRestoreFailure';
import { validateDeadlineDurableBackup, type DeadlineDurableBackup } from '../../lib/closingDateSidecarBackup';

export const CLOUD_RESTORE_SCHEMA_VERSION = 'cloud-erp-snapshot-v2' as const;
export const CLOUD_RESTORE_IDENTITY_CONTRACT_VERSION = 'inventory-id-v2' as const;

export const CLOUD_RESTORE_RPC = 'erp_restore_proven_cloud_snapshot_attempt' as const;
export const CLOUD_RESTORE_LEGACY_ATTEMPT_RPC = 'erp_restore_cloud_snapshot_attempt' as const;
export const CLOUD_RESTORE_LEGACY_RPC = 'erp_restore_cloud_snapshot' as const;
export const CLOUD_RESTORE_SNAPSHOT_RPC = 'erp_export_cloud_restore_snapshot_json' as const;
export const CLOUD_RESTORE_ATTEMPT_PREPARE_RPC = 'erp_prepare_cloud_restore_attempt' as const;
export const CLOUD_RESTORE_ATTEMPT_BEGIN_RPC = 'erp_begin_cloud_restore_attempt' as const;
export const CLOUD_RESTORE_ATTEMPT_RECONCILE_RPC = 'erp_reconcile_cloud_restore_attempt' as const;
export const CLOUD_RESTORE_TIMEOUT_BUDGET_MS = 120_000 as const;
export const CLOUD_RESTORE_TIMEOUT_CONTRACT_VERSION = 'postgresql-statement-timeout-v1' as const;
export const CLOUD_RESTORE_TABLES = [
  ['inventory', 'inventory_items'],
  ['productGroups', 'product_groups'],
  ['productCategories', 'product_categories'],
  ['dashboardCategoryImages', 'dashboard_category_images'],
  ['productVariants', 'product_variants'],
  ['bundleComponents', 'bundle_components'],
  ['purchaseBatches', 'purchase_batches'],
  ['purchaseBatchItems', 'purchase_batch_items'],
  ['privateOrders', 'private_orders'],
  ['privateOrderItems', 'private_order_items'],
  ['salesOrders', 'sales_orders'],
  ['salesOrderItems', 'sales_order_items'],
  ['importBatches', 'import_batches'],
  ['japanPackages', 'japan_packages'],
  ['japanPackageItems', 'japan_package_items'],
  ['outboundShipments', 'outbound_shipments'],
  ['outboundShipmentItems', 'outbound_shipment_items'],
  ['wacaOrders', 'waca_orders'],
  ['wacaItems', 'waca_order_items'],
  ['wacaMappings', 'waca_mappings'],
  ['myacgMasterLinks', 'waca_master_links'],
  ['wacaImportBatches', 'waca_import_batches'],
  ['wacaCutoverAudit', 'waca_cutover_audit'],
  ['wacaCutoverState', 'waca_state'],
] as const;

export const CLOUD_PASSTHROUGH_RESTORE_TABLES = new Set<string>([
  'dashboard_category_images',
  'import_batches',
  'waca_orders', 'waca_order_items', 'waca_mappings', 'waca_master_links',
  'waca_import_batches', 'waca_cutover_audit', 'waca_state',
]);

export type CloudRestoreCollection = typeof CLOUD_RESTORE_TABLES[number][0];
export type CloudRestoreTable = typeof CLOUD_RESTORE_TABLES[number][1];
export type CloudRestoreSnapshotData = Record<CloudRestoreTable, Record<string, unknown>[]>;

export interface CloudRestorePortabilityManifest {
  policyVersion: 'cross-environment-audit-null-v1';
  mode: 'cross-environment';
  targetProjectRef: string;
  sourceFileSha256: string;
  sourceSnapshotFingerprint: string;
  transformedCounts: Record<CloudRestoreTable, number>;
  totalTransformedRows: number;
}

export interface CloudRestoreManifest {
  schemaVersion: typeof CLOUD_RESTORE_SCHEMA_VERSION;
  identityContractVersion: typeof CLOUD_RESTORE_IDENTITY_CONTRACT_VERSION;
  resourceCount: number;
  counts: Record<CloudRestoreTable, number>;
  totalRows: number;
  snapshotFingerprint: string;
  unknownProductCount: number;
  orphanCount: number;
  duplicateVariantIdCount: number;
  duplicateVariantLocalIdCount: number;
  duplicateCanonicalIdCount: number;
  optionalMetadataMissingReferenceCount: number;
  canonicalIdentityAnomalyCount: number;
  relationshipHash: string;
  portability?: CloudRestorePortabilityManifest;
}

export interface CloudRestoreRelationAuditEntry {
  relation: string;
  childTable: CloudRestoreTable;
  field: string;
  parentTable: CloudRestoreTable;
  kind: 'blocking' | 'metadata';
  invalidCount: number;
  uniqueMissingParentIds: number;
}

export interface CloudRestoreRelationAudit {
  blockingOrphanCount: number;
  optionalMetadataMissingReferenceCount: number;
  entries: CloudRestoreRelationAuditEntry[];
}

export interface CloudRestoreCandidate {
  schemaVersion: typeof CLOUD_RESTORE_SCHEMA_VERSION;
  data: CloudRestoreSnapshotData;
  manifest: CloudRestoreManifest;
  sourceIdentityContractVersion: typeof CLOUD_RESTORE_IDENTITY_CONTRACT_VERSION | 'current-unversioned'
    | 'cloud-pre-waca-v1' | typeof LEGACY_CLOUD_RESTORE_IDENTITY_CONTRACT;
  legacyWacaBackup?: boolean;
  legacyDashboardPreserved?: boolean;
  deadlineSidecar?: DeadlineDurableBackup;
  deadlineSidecarSha256?: string;
  sourceEnvironment: string;
  fileName: string;
  sourceFileSha256: string;
  executionFingerprint: string;
  portability?: CloudRestorePortabilityManifest;
  /** Verified immutable source copy used only by the Server effective-path RPC. */
  sourceData?: CloudRestoreSnapshotData;
}

export interface CloudRestoreCommand {
  attemptCorrelationId: string;
  idempotencyKey: string;
  candidate: CloudRestoreCandidate;
  confirmation: 'OVERWRITE CLOUD DATA';
}

export interface CloudRestoreAttemptCommand {
  attemptId: string;
  traceId: string;
}

export interface CloudRestoreAttemptExecution extends CloudRestoreAttemptCommand {
  status: 'prepared' | 'executing';
  executionId: string;
  expectedEpoch: number;
  effectiveFingerprint: string;
  reconcileAfter: string;
}

export interface CloudRestoreExecutionCommand extends CloudRestoreCommand {
  attempt: CloudRestoreAttemptExecution;
  proofId: string;
}

export type CloudRestoreAttemptOutcomeStatus = 'prepared' | 'executing' | 'pending' | 'completed' | 'not_committed';

export interface CloudRestoreAttemptOutcome extends CloudRestoreAttemptCommand {
  status: CloudRestoreAttemptOutcomeStatus;
  expectedEpoch: number;
  effectiveFingerprint: string;
  reconcileAfter?: string;
  executionId?: string;
  resultEpoch?: number;
  restoreResult?: CloudRestoreResult;
  reason?: string;
  failure?: CloudRestoreFailure;
}

export type CloudRestoreCommitOutcomeClassification =
  | 'PREPARE_REJECTED'
  | 'EXECUTE_REJECTED'
  | 'EXECUTE_ROLLED_BACK'
  | 'DATABASE_INTERRUPTED_NOT_COMMITTED'
  | 'COMMITTED_RESPONSE_LOST'
  | 'COMMITTED_VERIFIED'
  | 'COMMIT_RESULT_UNKNOWN';

/**
 * Classify only from durable evidence. A lost response, transport failure, or
 * reconnect by itself is never proof that the business transaction rolled back.
 */
export function classifyCloudRestoreCommitOutcome(input: {
  outcome?: CloudRestoreAttemptOutcome;
  phase?: 'prepare' | 'execute';
  responseLost?: boolean;
  databaseInterrupted?: boolean;
}): CloudRestoreCommitOutcomeClassification {
  const { outcome } = input;
  if (outcome?.status === 'completed') {
    return input.responseLost ? 'COMMITTED_RESPONSE_LOST' : 'COMMITTED_VERIFIED';
  }
  if (outcome?.status === 'not_committed') {
    if (outcome.failure?.evidence === 'caught-subtransaction') return 'EXECUTE_ROLLED_BACK';
    if (outcome.failure?.evidence === 'reconciled-noncommit' && input.databaseInterrupted) {
      return 'DATABASE_INTERRUPTED_NOT_COMMITTED';
    }
    return input.phase === 'prepare' ? 'PREPARE_REJECTED' : 'EXECUTE_REJECTED';
  }
  return 'COMMIT_RESULT_UNKNOWN';
}

export interface CloudRestoreResult {
  ok: true;
  replayed: boolean;
  idempotencyKey: string;
  snapshotFingerprint: string;
  rollbackSnapshotId: string;
  restoreEpoch: number;
  manifest: CloudRestoreManifest;
  timingsMs?: Readonly<Record<string, number>>;
  authoritativeRefresh?: Readonly<{
    status: 'complete' | 'pending';
    errorCode?: string;
    errorMessage?: string;
  }>;
}

export class CloudRestoreValidationError extends Error {
  readonly code: string;
  readonly resource?: string;
  readonly rowIdentity?: string;
  readonly reasonCode?: string;
  readonly phase?: 'prepare';
  constructor(code: string, message: string, detail: {
    resource?: string; rowIdentity?: string; reasonCode?: string; phase?: 'prepare';
  } = {}) {
    super(message);
    this.name = 'CloudRestoreValidationError';
    this.code = code;
    this.resource = detail.resource;
    this.rowIdentity = detail.rowIdentity;
    this.reasonCode = detail.reasonCode ?? code;
    this.phase = detail.phase ?? 'prepare';
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

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
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

export async function sha256BytesHex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const canonicalId = (row: Record<string, unknown>, table: CloudRestoreTable): string => {
  if (table === 'inventory_items') {
    const id = String(row.id ?? '').trim();
    if (!UUID_PATTERN.test(id)) {
      throw new CloudRestoreValidationError('CANONICAL_ID_REQUIRED', 'inventory_items 必須保留 canonical database UUID id。');
    }
    return id.toLowerCase();
  }
  const databaseId = String(row.database_id ?? '').trim();
  const id = UUID_PATTERN.test(databaseId) ? databaseId : String(row.id ?? '').trim();
  if (!UUID_PATTERN.test(id)) {
    if (table.startsWith('waca_')) {
      throw new CloudRestoreValidationError(
        'WACA_CANONICAL_IDENTITY_MISSING',
        `${table} 缺少 canonical UUID。`,
        { resource: table, rowIdentity: id || 'unknown', reasonCode: 'WACA_CANONICAL_IDENTITY_MISSING' },
      );
    }
    throw new CloudRestoreValidationError('CANONICAL_UUID_REQUIRED', `${table} 必須保留 canonical database UUID。`);
  }
  return id.toLowerCase();
};

const SAFE_SNAPSHOT_METADATA = ['created_at', 'updated_at', 'updated_by', 'deleted_at', 'sync_status'] as const;

const normalizeRows = (
  source: Record<string, unknown>,
): CloudRestoreSnapshotData => Object.fromEntries(CLOUD_RESTORE_TABLES.map(([collection, table]) => {
  const rows = source[collection] ?? source[table];
  if (!Array.isArray(rows)) {
    throw new CloudRestoreValidationError('RESTORE_COLLECTION_REQUIRED', `JSON 缺少 ${collection} 陣列。`);
  }
  const entity = table as CloudMutableEntity;
  const normalized = rows.map((value, index) => {
    if (!isRecord(value)) {
      throw new CloudRestoreValidationError('RESTORE_ROW_INVALID', `${collection}[${index}] 不是物件。`);
    }
    const identity = canonicalId(value, table);
    if (table === 'inventory_items' && !String(value.inventory_key ?? '').trim()) {
      throw new CloudRestoreValidationError('INVENTORY_KEY_REQUIRED', 'Inventory 資料缺少 inventory_key。');
    }
    let row: Record<string, unknown>;
    if (CLOUD_PASSTHROUGH_RESTORE_TABLES.has(table)) {
      row = { ...value };
    } else {
      try {
        row = toCloudFieldRow(entity, value);
      } catch (error) {
        if (error instanceof Error && error.message.includes('CANONICAL_UUID_REQUIRED')) {
          throw new CloudRestoreValidationError('CANONICAL_UUID_REQUIRED', `${table} 必須保留 canonical database UUID。`);
        }
        throw error;
      }
    }
    // Restore never inherits mutation-time identity synthesis. Every raw Cloud
    // resource, including inventory_items, must carry its authoritative DB id.
    row.id = identity;
    if (table === 'sales_order_items') {
      const orderDatabaseId = String(value.order_database_id ?? value.order_id ?? '').trim();
      if (UUID_PATTERN.test(orderDatabaseId)) row.order_id = orderDatabaseId.toLowerCase();
    }
    for (const metadataField of SAFE_SNAPSHOT_METADATA) {
      if (metadataField in value) row[metadataField] = value[metadataField];
    }
    // This timestamp is server-managed for normal mutations, but it is also
    // durable business history. Preserve it only in the Atomic Restore
    // candidate so the internal writer can restore the backup value exactly.
    if (table === 'outbound_shipments' && 'status_changed_at' in value) {
      row.status_changed_at = value.status_changed_at;
    }
    delete row.version;
    return Object.fromEntries(Object.entries(row).filter(([, fieldValue]) => fieldValue !== undefined));
  });
  return [table, normalized];
})) as CloudRestoreSnapshotData;

const idsFor = (data: CloudRestoreSnapshotData, table: CloudRestoreTable): Set<string> => new Set(
  data[table].map(row => canonicalId(row, table)),
);

export function auditCloudRestoreRelations(data: CloudRestoreSnapshotData): CloudRestoreRelationAudit {
  const parentIds = new Map<CloudRestoreTable, Set<string>>(
    CLOUD_RESTORE_TABLES.map(([, table]) => [table, idsFor(data, table)]),
  );
  let blockingOrphanCount = 0;
  let optionalMetadataMissingReferenceCount = 0;
  const entries = CLOUD_RESTORE_RELATIONS.map((relation: CloudRestoreRelationSpec) => {
    const missingIds = new Set<string>();
    let invalidCount = 0;
    const parents = parentIds.get(relation.parentTable) ?? new Set<string>();
    for (const row of data[relation.childTable]) {
      const value = String(row[relation.field] ?? '').trim().toLowerCase();
      if (!value) {
        if (relation.optional) continue;
        invalidCount += 1;
        continue;
      }
      if (!parents.has(value)) {
        invalidCount += 1;
        missingIds.add(value);
      }
    }
    if (relation.kind === 'blocking') blockingOrphanCount += invalidCount;
    else optionalMetadataMissingReferenceCount += invalidCount;
    return {
      relation: cloudRestoreRelationKey(relation),
      childTable: relation.childTable,
      field: relation.field,
      parentTable: relation.parentTable,
      kind: relation.kind,
      invalidCount,
      uniqueMissingParentIds: missingIds.size,
    };
  });
  return { blockingOrphanCount, optionalMetadataMissingReferenceCount, entries };
}

export const countOrphans = (data: CloudRestoreSnapshotData): number => auditCloudRestoreRelations(data).blockingOrphanCount;

export const closeCloudRestoreData = (
  seed: CloudRestoreSnapshotData,
  raw: CloudRestoreSnapshotData,
): CloudRestoreSnapshotData => {
  const result = Object.fromEntries(CLOUD_RESTORE_TABLES.map(([, table]) => [table, seed[table].map(row => ({ ...row }))])) as CloudRestoreSnapshotData;
  const rawByTable = new Map<CloudRestoreTable, Map<string, Record<string, unknown>>>();
  for (const [, table] of CLOUD_RESTORE_TABLES) {
    const map = new Map<string, Record<string, unknown>>();
    for (const row of raw[table]) {
      const id = canonicalId(row, table);
      if (map.has(id)) throw new CloudRestoreValidationError('DUPLICATE_CANONICAL_ID', `${table} 含重複 identity。`);
      map.set(id, row);
    }
    rawByTable.set(table, map);
  }
  const seen = new Map<CloudRestoreTable, Set<string>>();
  for (const [, table] of CLOUD_RESTORE_TABLES) seen.set(table, new Set(result[table].map(row => canonicalId(row, table))));
  const maxIterations = Math.max(1, CLOUD_RESTORE_TABLES.reduce((sum, [, table]) => sum + raw[table].length, 0) + 1);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let added = 0;
    for (const relation of CLOUD_RESTORE_RELATIONS) {
      const currentParents = seen.get(relation.parentTable) ?? new Set<string>();
      for (const child of result[relation.childTable]) {
        const value = String(child[relation.field] ?? '').trim();
        if (!value || currentParents.has(value.toLowerCase())) continue;
        const parent = rawByTable.get(relation.parentTable)?.get(value.toLowerCase());
        if (!parent) continue;
        result[relation.parentTable].push({ ...parent });
        currentParents.add(value.toLowerCase());
        added += 1;
      }
    }
    if (added === 0) break;
    if (iteration === maxIterations - 1) throw new CloudRestoreValidationError('CLOUD_RESTORE_CLOSURE_UNSTABLE', 'Cloud Restore snapshot closure 無法收斂。');
  }
  for (const [, table] of CLOUD_RESTORE_TABLES) {
    result[table].sort((left, right) => canonicalId(left, table).localeCompare(canonicalId(right, table)));
  }
  return result;
};

const duplicateCount = (values: string[]): number => values.length - new Set(values).size;

const assertInventoryKeyUniqueness = (data: CloudRestoreSnapshotData): void => {
  const inventoryKeys = data.inventory_items.map(row => String(row.inventory_key ?? '').trim());
  if (duplicateCount(inventoryKeys) > 0) {
    throw new CloudRestoreValidationError('DUPLICATE_INVENTORY_KEY', 'inventory_items 的 inventory_key 不可重複。');
  }
};

export const assertCurrentCloudRestoreDataContract = (data: CloudRestoreSnapshotData): void => {
  assertInventoryKeyUniqueness(data);
  for (const [, table] of CLOUD_RESTORE_TABLES) {
    if (table.startsWith('waca_') && data[table].some(row => !UUID_PATTERN.test(String(row.id ?? '').trim()))) {
      throw new CloudRestoreValidationError(
        'WACA_CANONICAL_IDENTITY_MISSING',
        `${table} 缺少 canonical UUID。`,
        { resource: table, rowIdentity: 'unknown', reasonCode: 'WACA_CANONICAL_IDENTITY_MISSING' },
      );
    }
    const ids = data[table].map(row => canonicalId(row, table));
    if (duplicateCount(ids) > 0) throw new CloudRestoreValidationError('DUPLICATE_CANONICAL_ID', `${table} 含重複 identity。`);
  }
  const duplicateVariantLocalIdCount = duplicateCount(data.product_variants
    .map(row => String(row.local_id ?? '').trim())
    .filter(Boolean));
  if (duplicateVariantLocalIdCount > 0) {
    throw new CloudRestoreValidationError('DUPLICATE_VARIANT_LOCAL_ID', 'Variant local_id 不可重複。');
  }
  const wacaOrderIds = new Set(data.waca_orders.map(row => String(row.id)));
  const orphanWacaItem = data.waca_order_items.find(row => !wacaOrderIds.has(String(row.order_id ?? '')));
  if (orphanWacaItem) {
    throw new CloudRestoreValidationError(
      'WACA_ORDER_ITEM_ORPHAN',
      `waca_order_items ${String(orphanWacaItem.item_key ?? 'unknown')} 找不到來源訂單。`,
      { resource: 'waca_order_items', rowIdentity: String(orphanWacaItem.item_key ?? ''), reasonCode: 'WACA_ORDER_ITEM_ORPHAN' },
    );
  }
  const variantIds = new Set(data.product_variants.map(row => String(row.id)));
  const invalidMapping = data.waca_mappings.find(row => !variantIds.has(String(row.product_variant_id ?? '')));
  if (invalidMapping) {
    throw new CloudRestoreValidationError(
      'WACA_MAPPING_VARIANT_INVALID',
      `waca_mappings ${String(invalidMapping.feature ?? 'unknown')} 找不到商品規格。`,
      { resource: 'waca_mappings', rowIdentity: String(invalidMapping.feature ?? ''), reasonCode: 'WACA_MAPPING_VARIANT_INVALID' },
    );
  }
  const invalidMasterLink = data.waca_master_links.find(row => {
    const id = String(row.product_variant_id ?? '').trim();
    return id && !variantIds.has(id);
  });
  if (invalidMasterLink) {
    throw new CloudRestoreValidationError(
      'WACA_MASTER_LINK_INVALID',
      `waca_master_links ${String(invalidMasterLink.child_code ?? 'unknown')} 指向不存在的商品規格。`,
      { resource: 'waca_master_links', rowIdentity: String(invalidMasterLink.child_code ?? ''), reasonCode: 'WACA_MASTER_LINK_INVALID' },
    );
  }
  const relationAudit = auditCloudRestoreRelations(data);
  if (relationAudit.blockingOrphanCount > 0) {
    throw new CloudRestoreValidationError('ORPHAN_RELATION', `JSON 含 ${relationAudit.blockingOrphanCount} 筆無效關聯。`);
  }
  const uniqueBusinessKey = (table: CloudRestoreTable, field: string) => {
    const values = data[table].map(row => String(row[field] ?? '').trim());
    if (values.some(value => !value)) {
      throw new CloudRestoreValidationError('WACA_BUSINESS_KEY_MISSING', `${table}.${field} 不可缺少。`,
        { resource: table, rowIdentity: field, reasonCode: 'WACA_BUSINESS_KEY_MISSING' });
    }
    if (duplicateCount(values) > 0) {
      throw new CloudRestoreValidationError('WACA_DUPLICATE_BUSINESS_KEY', `${table}.${field} 不可重複。`,
        { resource: table, rowIdentity: field, reasonCode: 'WACA_DUPLICATE_BUSINESS_KEY' });
    }
  };
  uniqueBusinessKey('waca_orders', 'order_key');
  uniqueBusinessKey('waca_order_items', 'item_key');
  uniqueBusinessKey('waca_mappings', 'feature');
  uniqueBusinessKey('waca_master_links', 'child_code');
  uniqueBusinessKey('waca_import_batches', 'batch_key');
  uniqueBusinessKey('waca_cutover_audit', 'product_variant_id');
  const requireWacaPayloadKey = (
    table: 'waca_orders' | 'waca_order_items',
    businessKey: 'order_key' | 'item_key',
  ) => {
    for (const row of data[table]) {
      const rowIdentity = String(row[businessKey] ?? '').trim();
      const payload = isRecord(row.payload) ? row.payload : null;
      const payloadKey = payload && typeof payload.key === 'string' ? payload.key.trim() : '';
      if (!payloadKey) {
        throw new CloudRestoreValidationError(
          'WACA_PAYLOAD_KEY_MISSING',
          `${table} ${rowIdentity || '(unknown)'} 的 payload.key 缺失。`,
          { resource: table, rowIdentity, reasonCode: 'WACA_PAYLOAD_KEY_MISSING' },
        );
      }
      if (payloadKey !== rowIdentity) {
        throw new CloudRestoreValidationError(
          'WACA_PAYLOAD_KEY_MISMATCH',
          `${table} ${rowIdentity || '(unknown)'} 的 payload.key 與 business key 不一致。`,
          { resource: table, rowIdentity, reasonCode: 'WACA_PAYLOAD_KEY_MISMATCH' },
        );
      }
    }
  };
  requireWacaPayloadKey('waca_orders', 'order_key');
  requireWacaPayloadKey('waca_order_items', 'item_key');
  for (const row of data.waca_orders) {
    if (!['處理中', '完成付款', '取消', '失敗'].includes(String(row.status ?? ''))) {
      throw new CloudRestoreValidationError(
        'WACA_ORDER_STATUS_INVALID',
        `waca_orders ${String(row.order_key ?? '(unknown)')} 的狀態無效。`,
        { resource: 'waca_orders', rowIdentity: String(row.order_key ?? ''), reasonCode: 'WACA_ORDER_STATUS_INVALID' },
      );
    }
  }
  if (data.waca_state.length !== 1 || data.waca_state[0].id !== '00000000-0000-4000-8000-000000000001') {
    throw new CloudRestoreValidationError('WACA_CUTOVER_STATE_INVALID', 'WACA 數量來源狀態缺少或不唯一。');
  }
  const mode = String(data.waca_state[0].mode ?? '');
  if (!['LEGACY_QUANTITY_ACTIVE', 'ORDER_REBASELINE_REQUIRED', 'ORDER_DRIVEN_ACTIVE'].includes(mode)) {
    throw new CloudRestoreValidationError('WACA_CUTOVER_STATE_INVALID', 'WACA 數量來源狀態無效。');
  }
  const statusByOrder = new Map(data.waca_orders.map(row => [String(row.id), String(row.status)]));
  const mappingByFeature = new Map(data.waca_mappings.map(row => [String(row.feature), String(row.product_variant_id)]));
  const derived = new Map<string, number>();
  for (const row of data.waca_order_items) {
    const quantity = Number(row.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new CloudRestoreValidationError('WACA_QUANTITY_INVALID', 'WACA 訂單明細數量無效。');
    }
    const variantId = String(row.product_variant_id ?? '');
    if (variantId && mappingByFeature.get(String(row.feature)) !== variantId) {
      throw new CloudRestoreValidationError('WACA_MAPPING_MISMATCH', 'WACA 明細與永久商品對照不一致。');
    }
    if (variantId && ['處理中', '完成付款'].includes(statusByOrder.get(String(row.order_id)) ?? '')) {
      derived.set(variantId, (derived.get(variantId) ?? 0) + quantity);
    }
  }
  if (mode === 'ORDER_DRIVEN_ACTIVE') {
    for (const variant of data.product_variants) {
      if (Number(variant.waca_auto_quantity ?? 0) !== (derived.get(String(variant.id)) ?? 0)) {
        throw new CloudRestoreValidationError('WACA_QUANTITY_RECONCILIATION_FAILED',
          'WACA 訂單數量與訂購紀錄表不一致。');
      }
    }
  }
};

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
  const relationAudit = auditCloudRestoreRelations(data);
  const duplicateCanonicalIdCount = CLOUD_RESTORE_TABLES.reduce(
    (sum, [, table]) => sum + duplicateCount(data[table].map(row => canonicalId(row, table))),
    0,
  );
  const duplicateVariantIdCount = duplicateCount(data.product_variants.map(row => canonicalId(row, 'product_variants')));
  const duplicateVariantLocalIdCount = duplicateCount(data.product_variants.map(row => String(row.local_id ?? '').trim()).filter(Boolean));
  const canonicalIdentityAnomalyCount = CLOUD_RESTORE_TABLES.reduce(
    (sum, [, table]) => sum + data[table].reduce(
      (anomalies, row) => anomalies + (UUID_PATTERN.test(String(row.id ?? '').trim()) ? 0 : 1),
      0,
    ),
    0,
  );
  return {
    schemaVersion: CLOUD_RESTORE_SCHEMA_VERSION,
    identityContractVersion: CLOUD_RESTORE_IDENTITY_CONTRACT_VERSION,
    resourceCount: CLOUD_RESTORE_TABLES.length,
    counts,
    totalRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
    snapshotFingerprint,
    unknownProductCount,
    orphanCount: relationAudit.blockingOrphanCount,
    duplicateVariantIdCount,
    duplicateVariantLocalIdCount,
    duplicateCanonicalIdCount,
    optionalMetadataMissingReferenceCount: relationAudit.optionalMetadataMissingReferenceCount,
    canonicalIdentityAnomalyCount,
    relationshipHash,
  };
};

const assertManifestMatches = (
  provided: unknown,
  expected: CloudRestoreManifest,
  allowMissingIdentityContractVersion = false,
): void => {
  if (!isRecord(provided)) throw new CloudRestoreValidationError('RESTORE_MANIFEST_REQUIRED', 'JSON 缺少 manifest。');
  const providedCounts = isRecord(provided.counts) ? provided.counts : null;
  if (provided.schemaVersion !== expected.schemaVersion
    || (provided.identityContractVersion !== expected.identityContractVersion
      && !(allowMissingIdentityContractVersion && provided.identityContractVersion === undefined))
    || provided.resourceCount !== expected.resourceCount
    || provided.totalRows !== expected.totalRows
    || provided.snapshotFingerprint !== expected.snapshotFingerprint
    || provided.relationshipHash !== expected.relationshipHash
    || provided.unknownProductCount !== expected.unknownProductCount
    || provided.orphanCount !== expected.orphanCount
    || provided.duplicateVariantIdCount !== expected.duplicateVariantIdCount
    || provided.duplicateVariantLocalIdCount !== expected.duplicateVariantLocalIdCount
    || provided.duplicateCanonicalIdCount !== expected.duplicateCanonicalIdCount
    || provided.optionalMetadataMissingReferenceCount !== expected.optionalMetadataMissingReferenceCount
    || provided.canonicalIdentityAnomalyCount !== expected.canonicalIdentityAnomalyCount
    || !providedCounts
    || CLOUD_RESTORE_TABLES.some(([, table]) => providedCounts[table] !== expected.counts[table])) {
    throw new CloudRestoreValidationError('RESTORE_MANIFEST_MISMATCH', 'JSON manifest 與資料內容不一致。');
  }
};

export async function buildCloudRestoreManifest(source: Record<string, unknown>, rawSource?: Record<string, unknown>): Promise<{
  data: CloudRestoreSnapshotData;
  manifest: CloudRestoreManifest;
}> {
  const seed = normalizeRows(source);
  const raw = normalizeRows(rawSource ?? source);
  assertInventoryKeyUniqueness(seed);
  assertInventoryKeyUniqueness(raw);
  const data = closeCloudRestoreData(seed, raw);
  assertCurrentCloudRestoreDataContract(data);
  return { data, manifest: await manifestFor(data) };
}

export async function rebuildCurrentCloudRestoreCandidate(
  source: CloudRestoreSnapshotData,
): Promise<{ data: CloudRestoreSnapshotData; manifest: CloudRestoreManifest }> {
  const data = Object.fromEntries(CLOUD_RESTORE_TABLES.map(([, table]) => [
    table,
    source[table].map(row => ({ ...row })),
  ])) as CloudRestoreSnapshotData;
  assertCurrentCloudRestoreDataContract(data);
  return { data, manifest: await manifestFor(data) };
}

/** Old 15-resource files never contained dashboard images. Retain the target's
 * current image associations instead of silently deleting them on restore. */
export async function preserveLegacyCloudDashboardImages(
  candidate: CloudRestoreCandidate,
  targetRows: Record<string, unknown>[],
): Promise<CloudRestoreCandidate> {
  if (!candidate.legacyWacaBackup || !Array.isArray(targetRows)) {
    throw new CloudRestoreValidationError('LEGACY_DASHBOARD_POLICY_INVALID', '舊備份首頁圖片保留流程無效。');
  }
  const data = { ...candidate.data,
    dashboard_category_images: targetRows.map(row => ({ ...row })) } as CloudRestoreSnapshotData;
  assertCurrentCloudRestoreDataContract(data);
  const manifest = await manifestFor(data);
  return { ...candidate, data, manifest, executionFingerprint: manifest.snapshotFingerprint,
    legacyDashboardPreserved: true };
}

export async function prepareCloudRestoreSnapshot(
  input: string | unknown,
  options: { fileName?: string; sourceEnvironment?: string; sourceFileSha256?: string } = {},
): Promise<CloudRestoreCandidate> {
  let parsed: unknown;
  try {
    parsed = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (error) {
    throw new CloudRestoreValidationError('MALFORMED_JSON', `JSON 解析失敗：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new CloudRestoreValidationError('RESTORE_DOCUMENT_INVALID', 'JSON 最上層必須是物件。');
  if (parsed.schemaVersion !== CLOUD_RESTORE_SCHEMA_VERSION && parsed.schemaVersion !== 'cloud-erp-snapshot-v1') {
    throw new CloudRestoreValidationError('UNSUPPORTED_SCHEMA_VERSION', `不支援的 schemaVersion：${String(parsed.schemaVersion ?? 'missing')}`);
  }
  const rawData = isRecord(parsed.data) ? parsed.data : null;
  if (!rawData) throw new CloudRestoreValidationError('RESTORE_DATA_REQUIRED', 'JSON 缺少 data 物件。');
  const legacyPreWaca = parsed.schemaVersion === 'cloud-erp-snapshot-v1';
  const deadlineSidecar = !legacyPreWaca && isRecord(parsed.deadlineSidecar)
    ? validateDeadlineDurableBackup(parsed.deadlineSidecar) : undefined;
  if (!legacyPreWaca && !deadlineSidecar) {
    throw new CloudRestoreValidationError('DEADLINE_SIDECAR_BACKUP_REQUIRED',
      '新版備份缺少已確認的期限對照與套用紀錄，已取消還原。');
  }
  if (legacyPreWaca) {
    const oldTables = CLOUD_RESTORE_TABLES.filter(([, table]) =>
      table !== 'import_batches' && !CLOUD_PASSTHROUGH_RESTORE_TABLES.has(table));
    const oldKeys = new Set<string>(oldTables.flatMap(([collection, table]) => [collection, table]));
    if (Object.keys(rawData).length !== 15 || Object.keys(rawData).some(key => !oldKeys.has(key))
      || !isRecord(parsed.manifest) || parsed.manifest.resourceCount !== 15) {
      throw new CloudRestoreValidationError('LEGACY_CLOUD_BACKUP_INVALID', '舊版雲端備份資料類別不完整。');
    }
    const expanded = { ...rawData,
      dashboardCategoryImages: [],
      importBatches: [],
      wacaOrders: [], wacaItems: [], wacaMappings: [], myacgMasterLinks: [],
      wacaImportBatches: [], wacaCutoverAudit: [],
      wacaCutoverState: [{
        id: '00000000-0000-4000-8000-000000000001', revision: 0,
        mode: 'ORDER_REBASELINE_REQUIRED',
        // A fixed compatibility marker keeps the same legacy file byte-for-byte
        // idempotent across retries and browsers.
        payload: { mode: 'ORDER_REBASELINE_REQUIRED', updatedAt: '1970-01-01T00:00:00.000Z', sourceBackupFormatVersion: 1 },
        updated_by: null,
      }],
    };
    const normalized = normalizeRows(expanded);
    // The pre-WACA inventory schema did not have the GP parent evidence
    // column. Verify its original fingerprint against that historical row
    // shape, then keep the new nullable field in the modern candidate.
    const oldData = Object.fromEntries(oldTables.map(([, table]) => [table,
      table === 'inventory_items'
        ? normalized[table].map(row => Object.fromEntries(
          Object.entries(row).filter(([key]) => key !== 'myacg_parent_code')))
        : normalized[table]]));
    const oldCounts = Object.fromEntries(oldTables.map(([, table]) => [table, normalized[table].length]));
    const oldProjection = oldTables.flatMap(([, table]) => normalized[table].map(row => ({
      table, id: canonicalId(row, table),
      relations: Object.fromEntries(Object.entries(row).filter(([key]) => key.endsWith('_id') && key !== 'local_id')),
    }))).sort((left, right) => `${left.table}:${left.id}`.localeCompare(`${right.table}:${right.id}`));
    const oldManifest = parsed.manifest;
    if (oldManifest.schemaVersion !== 'cloud-erp-snapshot-v1'
      || stableCloudRestoreJson(oldManifest.counts) !== stableCloudRestoreJson(oldCounts)
      || oldManifest.totalRows !== Object.values(oldCounts).reduce((sum, count) => sum + count, 0)
      || oldManifest.snapshotFingerprint !== await sha256Hex(stableCloudRestoreJson(oldData))
      || oldManifest.relationshipHash !== await sha256Hex(stableCloudRestoreJson(oldProjection))) {
      throw new CloudRestoreValidationError('LEGACY_CLOUD_BACKUP_INVALID', '舊版雲端備份驗證失敗，已取消還原。');
    }
    // ERP1 v1 exports predate the outbound status-history field. Authenticate
    // the unmodified historical manifest first, then represent unavailable
    // history as NULL in the current Restore-only candidate (033 is nullable).
    // Never invent a clock time or apply this downgrade to a current v2 file.
    for (const row of normalized.outbound_shipments) {
      if (!('status_changed_at' in row)) row.status_changed_at = null;
    }
    assertCurrentCloudRestoreDataContract(normalized);
    const manifest = await manifestFor(normalized);
    const serialized = typeof input === 'string' ? input : stableCloudRestoreJson(input);
    const sourceFileSha256 = (options.sourceFileSha256 ?? await sha256Hex(serialized)).toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(sourceFileSha256)) {
      throw new CloudRestoreValidationError('RESTORE_SOURCE_SHA256_INVALID', '原始 JSON SHA-256 無效。');
    }
    return {
      schemaVersion: CLOUD_RESTORE_SCHEMA_VERSION, data: normalized, manifest,
      sourceIdentityContractVersion: 'cloud-pre-waca-v1', legacyWacaBackup: true,
      sourceEnvironment: String(parsed.sourceEnvironment ?? options.sourceEnvironment ?? 'unknown'),
      fileName: options.fileName ?? 'cloud-restore.json', sourceFileSha256,
      executionFingerprint: manifest.snapshotFingerprint,
    };
  }
  const allowedCollections = new Set<string>(CLOUD_RESTORE_TABLES.map(([collection]) => collection));
  const unexpected = Object.keys(rawData).filter(key => !allowedCollections.has(key));
  if (unexpected.length > 0) throw new CloudRestoreValidationError('UNEXPECTED_RESOURCE', `JSON 含不支援的 resource：${unexpected.join(', ')}`);
  if (!isRecord(parsed.manifest)) throw new CloudRestoreValidationError('RESTORE_MANIFEST_REQUIRED', 'JSON 缺少 manifest。');
  if ('portability' in parsed.manifest) {
    throw new CloudRestoreValidationError(
      'RESTORE_PORTABLE_CANDIDATE_NOT_IMPORTABLE',
      '跨環境 candidate 必須由已驗證原始 JSON 在記憶體中建立，不接受再次匯入。',
    );
  }
  const validateCurrentData = async (): Promise<{ data: CloudRestoreSnapshotData; manifest: CloudRestoreManifest }> => {
    const data = normalizeRows(rawData);
    assertCurrentCloudRestoreDataContract(data);
    return { data, manifest: await manifestFor(data) };
  };

  const declaredIdentityContract = parsed.manifest.identityContractVersion;
  if (declaredIdentityContract !== undefined && declaredIdentityContract !== CLOUD_RESTORE_IDENTITY_CONTRACT_VERSION) {
    throw new CloudRestoreValidationError(
      'UNSUPPORTED_IDENTITY_CONTRACT_VERSION',
      `不支援的 identityContractVersion：${String(declaredIdentityContract)}。`,
    );
  }

  let current = await validateCurrentData();
  let sourceIdentityContractVersion: CloudRestoreCandidate['sourceIdentityContractVersion'];
  if (declaredIdentityContract === CLOUD_RESTORE_IDENTITY_CONTRACT_VERSION) {
    assertManifestMatches(parsed.manifest, current.manifest);
    sourceIdentityContractVersion = CLOUD_RESTORE_IDENTITY_CONTRACT_VERSION;
  } else {
    try {
      assertManifestMatches(parsed.manifest, current.manifest, true);
      sourceIdentityContractVersion = 'current-unversioned';
    } catch (error) {
      if (!(error instanceof CloudRestoreValidationError) || error.code !== 'RESTORE_MANIFEST_MISMATCH') throw error;
      const legacy = await verifyLegacyCloudRestoreSnapshot(rawData, parsed.manifest);
      if (!legacy) throw error;
      // Do not pass the legacy projection to the server. Re-run the complete
      // current UUID-id closure/sort contract after legacy integrity
      // verification and use only that freshly constructed candidate for RPC.
      current = await buildCloudRestoreManifest(rawData, rawData);
      assertCurrentCloudRestoreDataContract(current.data);
      sourceIdentityContractVersion = legacy.identityContractVersion;
    }
  }
  const serializedInput = typeof input === 'string' ? input : stableCloudRestoreJson(input);
  const sourceFileSha256 = (options.sourceFileSha256 ?? await sha256Hex(serializedInput)).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(sourceFileSha256)) {
    throw new CloudRestoreValidationError('RESTORE_SOURCE_SHA256_INVALID', '原始 JSON SHA-256 無效。');
  }
  return {
    schemaVersion: CLOUD_RESTORE_SCHEMA_VERSION,
    data: current.data,
    manifest: current.manifest,
    deadlineSidecar,
    deadlineSidecarSha256: deadlineSidecar ? await sha256Hex(stableCloudRestoreJson(deadlineSidecar)) : undefined,
    sourceIdentityContractVersion,
    sourceEnvironment: String(parsed.sourceEnvironment ?? options.sourceEnvironment ?? 'unknown'),
    fileName: options.fileName ?? 'cloud-restore.json',
    sourceFileSha256,
    executionFingerprint: current.manifest.snapshotFingerprint,
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

export function assertCloudRestoreAttemptOutcome(value: unknown): CloudRestoreAttemptOutcome {
  if (!isRecord(value)) {
    throw new CloudRestoreServerError('CLOUD_RESTORE_ATTEMPT_RESULT_INVALID', 'Restore attempt 結果格式無效。');
  }
  const status = value.status;
  const validStatus = status === 'prepared' || status === 'executing' || status === 'pending'
    || status === 'completed' || status === 'not_committed';
  if (!validStatus
    || typeof value.attemptId !== 'string' || !UUID_PATTERN.test(value.attemptId)
    || typeof value.traceId !== 'string' || !UUID_PATTERN.test(value.traceId)
    || typeof value.expectedEpoch !== 'number' || !Number.isSafeInteger(value.expectedEpoch) || value.expectedEpoch < 0
    || typeof value.effectiveFingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(value.effectiveFingerprint)) {
    throw new CloudRestoreServerError('CLOUD_RESTORE_ATTEMPT_RESULT_INVALID', 'Restore attempt 結果格式無效。');
  }
  if (status === 'executing' && (typeof value.executionId !== 'string' || !UUID_PATTERN.test(value.executionId))) {
    throw new CloudRestoreServerError('CLOUD_RESTORE_ATTEMPT_RESULT_INVALID', 'Restore attempt execution 格式無效。');
  }
  let restoreResult: CloudRestoreResult | undefined;
  let failure: CloudRestoreFailure | undefined;
  if (value.failure !== undefined) {
    if (status !== 'not_committed') throw new CloudRestoreServerError('CLOUD_RESTORE_ATTEMPT_RESULT_INVALID', 'Restore failure 狀態無效。');
    failure = parseCloudRestoreFailure(value.failure);
  }
  if (status === 'completed') {
    restoreResult = assertCloudRestoreServerResult(value.restoreResult);
    if (typeof value.resultEpoch !== 'number' || !Number.isSafeInteger(value.resultEpoch)
      || value.resultEpoch !== restoreResult.restoreEpoch) {
      throw new CloudRestoreServerError('CLOUD_RESTORE_ATTEMPT_RESULT_INVALID', 'Restore attempt epoch 格式無效。');
    }
  }
  return {
    status,
    attemptId: value.attemptId,
    traceId: value.traceId,
    expectedEpoch: value.expectedEpoch,
    effectiveFingerprint: value.effectiveFingerprint,
    ...(typeof value.reconcileAfter === 'string' ? { reconcileAfter: value.reconcileAfter } : {}),
    ...(typeof value.executionId === 'string' ? { executionId: value.executionId } : {}),
    ...(typeof value.resultEpoch === 'number' ? { resultEpoch: value.resultEpoch } : {}),
    ...(restoreResult ? { restoreResult } : {}),
    ...(failure ? { failure } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
}
