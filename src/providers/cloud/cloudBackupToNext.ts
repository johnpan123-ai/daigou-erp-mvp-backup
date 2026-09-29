import { DASHBOARD_IMAGE_CATEGORY_KEYS } from '../../lib/dashboardImageCategories';
import { WORKBENCH_BACKUP_FORMAT_VERSION } from '../../waca/backupFormat';
import {
  CLOUD_RESTORE_TABLES,
  CloudRestoreValidationError,
  prepareCloudRestoreSnapshot,
  type CloudRestoreCandidate,
  type CloudRestoreCollection,
  type CloudRestoreTable,
} from './cloudAtomicRestore';
import { CLOUD_RESTORE_RELATIONS } from './cloudRestoreRelations';

export const CLOUD_TO_NEXT_PORTABILITY_POLICY_VERSION = 'cloud-to-next-local-v1' as const;

type Row = Record<string, unknown>;

export interface CloudToNextCompatibilitySummary {
  policyVersion: typeof CLOUD_TO_NEXT_PORTABILITY_POLICY_VERSION;
  sourceSchemaVersion: string;
  sourceIdentityContractVersion: CloudRestoreCandidate['sourceIdentityContractVersion'];
  sourceEnvironment: string;
  sourceResourceCount: number;
  targetResourceCount: number;
  sourceTotalRows: number;
  restoredTotalRows: number;
  sourceCounts: Record<CloudRestoreTable, number>;
  restoredCounts: Record<CloudRestoreCollection, number>;
  softDeletedSkippedCount: number;
  softDeletedRetainedForIntegrityCount: number;
  auditIdentityClearedCount: number;
  blockingOrphanCount: number;
  optionalMetadataMissingReferenceCount: number;
  legacyWacaBackup: boolean;
  wacaOrderCount: number;
  wacaItemCount: number;
  deadlineDurableCount: number;
  dashboardImagePolicy: 'legacy-unused-metadata-not-imported';
}

export interface CloudBackupToNextCandidate {
  kind: 'cloud-atomic-backup';
  fileName: string;
  sourceFileSha256: string;
  workbenchData: Record<string, unknown>;
  workbenchJson: string;
  summary: CloudToNextCompatibilitySummary;
}

const isRecord = (value: unknown): value is Row => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value : '';

export function isCloudAtomicBackupDocument(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && typeof value.schemaVersion === 'string'
    && value.schemaVersion.startsWith('cloud-erp-snapshot-');
}

const canonicalId = (row: Row): string => text(row.id).trim().toLowerCase();

const localId = (row: Row): string => {
  const result = text(row.local_id).trim() || text(row.id).trim();
  if (!result) throw new CloudRestoreValidationError('NEXT_LOCAL_ID_REQUIRED', 'Cloud 資料缺少可攜的本機識別碼。');
  return result;
};

/**
 * Cloud snapshots intentionally contain soft-deleted rows. NEXT has no
 * tombstone read model, so its visible projection starts with active rows and
 * then retains only deleted parents required to keep an active durable child
 * referentially complete. The preview reports both retained and skipped rows.
 */
const buildNextProjection = (candidate: CloudRestoreCandidate): {
  data: CloudRestoreCandidate['data'];
  softDeletedSkippedCount: number;
  softDeletedRetainedForIntegrityCount: number;
} => {
  const selected = Object.fromEntries(CLOUD_RESTORE_TABLES.map(([, table]) => [
    table,
    new Map(candidate.data[table]
      .filter(row => !row.deleted_at)
      .map(row => [canonicalId(row), row])),
  ])) as Record<CloudRestoreTable, Map<string, Row>>;
  const source = Object.fromEntries(CLOUD_RESTORE_TABLES.map(([, table]) => [
    table,
    new Map(candidate.data[table].map(row => [canonicalId(row), row])),
  ])) as Record<CloudRestoreTable, Map<string, Row>>;

  let retained = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const relation of CLOUD_RESTORE_RELATIONS) {
      for (const child of selected[relation.childTable].values()) {
        const parentId = text(child[relation.field]).trim().toLowerCase();
        if (!parentId || selected[relation.parentTable].has(parentId)) continue;
        const parent = source[relation.parentTable].get(parentId);
        if (!parent) continue;
        selected[relation.parentTable].set(parentId, parent);
        if (parent.deleted_at) retained += 1;
        changed = true;
      }
    }
  }

  const data = Object.fromEntries(CLOUD_RESTORE_TABLES.map(([, table]) => [
    table,
    [...selected[table].values()],
  ])) as CloudRestoreCandidate['data'];
  const sourceDeletedCount = CLOUD_RESTORE_TABLES.reduce(
    (sum, [, table]) => sum + candidate.data[table].filter(row => Boolean(row.deleted_at)).length,
    0,
  );
  return {
    data,
    softDeletedSkippedCount: sourceDeletedCount - retained,
    softDeletedRetainedForIntegrityCount: retained,
  };
};

const buildIdMaps = (data: CloudRestoreCandidate['data']): Record<CloudRestoreTable, Map<string, string>> => {
  const maps = {} as Record<CloudRestoreTable, Map<string, string>>;
  for (const [, table] of CLOUD_RESTORE_TABLES) {
    const map = new Map<string, string>();
    const targetIds = new Set<string>();
    for (const row of data[table]) {
      const sourceId = canonicalId(row);
      const targetId = table === 'inventory_items' ? sourceId : localId(row);
      if (!sourceId || map.has(sourceId) || targetIds.has(targetId)) {
        throw new CloudRestoreValidationError('NEXT_IDENTITY_COLLISION', `${table} 的跨環境識別碼重複。`);
      }
      map.set(sourceId, targetId);
      targetIds.add(targetId);
    }
    maps[table] = map;
  }
  return maps;
};

const mapRelation = (
  maps: Record<CloudRestoreTable, Map<string, string>>,
  parentTable: CloudRestoreTable,
  value: unknown,
): string | null => {
  const sourceId = text(value).trim().toLowerCase();
  if (!sourceId) return null;
  return maps[parentTable].get(sourceId) ?? sourceId;
};

const cleanCloudMetadata = (row: Row): Row => {
  const result = { ...row };
  delete result.local_id;
  delete result.updated_by;
  delete result.deleted_at;
  delete result.sync_status;
  delete result.version;
  return result;
};

const coreRow = (row: Row, table: CloudRestoreTable, maps: Record<CloudRestoreTable, Map<string, string>>): Row => {
  const result = cleanCloudMetadata(row);
  const sourceId = canonicalId(row);
  result.id = table === 'inventory_items' ? sourceId : localId(row);
  result.database_id = sourceId;
  for (const relation of CLOUD_RESTORE_RELATIONS) {
    if (relation.childTable !== table) continue;
    const mapped = mapRelation(maps, relation.parentTable, row[relation.field]);
    result[relation.field] = mapped;
  }
  if (table === 'sales_order_items') {
    result.order_database_id = text(row.order_id).trim().toLowerCase();
  }
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
};

const payload = (row: Row): Row => isRecord(row.payload) ? { ...row.payload } : {};

const mapWaca = (
  data: CloudRestoreCandidate['data'],
  maps: Record<CloudRestoreTable, Map<string, string>>,
): Pick<Record<string, unknown>,
  'wacaOrders' | 'wacaItems' | 'wacaMappings' | 'myacgMasterLinks'
  | 'wacaImportBatches' | 'wacaCutoverAudit' | 'wacaCutoverState'> => {
  const orderKeys = new Map(data.waca_orders.map(row => [canonicalId(row), text(row.order_key)]));
  const variantIds = maps.product_variants;
  return {
    wacaOrders: data.waca_orders.map(row => ({
      ...payload(row),
      key: text(row.order_key),
      status: text(row.status),
    })),
    wacaItems: data.waca_order_items.map(row => ({
      ...payload(row),
      key: text(row.item_key),
      orderKey: text(payload(row).orderKey) || orderKeys.get(text(row.order_id).toLowerCase()) || text(row.order_id),
      feature: text(row.feature),
      productVariantId: row.product_variant_id
        ? variantIds.get(text(row.product_variant_id).toLowerCase()) ?? text(row.product_variant_id)
        : undefined,
      quantity: Number(row.quantity ?? 0),
    })),
    wacaMappings: data.waca_mappings.map(row => ({
      ...payload(row),
      feature: text(row.feature),
      productVariantId: variantIds.get(text(row.product_variant_id).toLowerCase()) ?? text(row.product_variant_id),
    })),
    myacgMasterLinks: data.waca_master_links.map(row => ({
      ...payload(row),
      childCode: text(row.child_code),
      mainCode: text(row.main_code),
      productVariantId: row.product_variant_id
        ? variantIds.get(text(row.product_variant_id).toLowerCase()) ?? text(row.product_variant_id)
        : undefined,
    })),
    wacaImportBatches: data.waca_import_batches.map(row => ({
      ...payload(row),
      id: text(row.batch_key),
    })),
    wacaCutoverAudit: data.waca_cutover_audit.map(row => ({
      ...payload(row),
      productVariantId: variantIds.get(text(row.product_variant_id).toLowerCase()) ?? text(row.product_variant_id),
    })),
    wacaCutoverState: data.waca_state.map(row => ({
      ...payload(row),
      mode: text(row.mode),
    })),
  };
};

const LOCAL_RELATIONS = [
  ['productCategories', 'product_group_id', 'productGroups'],
  ['productVariants', 'product_group_id', 'productGroups'],
  ['purchaseBatches', 'product_group_id', 'productGroups'],
  ['purchaseBatchItems', 'purchase_batch_id', 'purchaseBatches'],
  ['purchaseBatchItems', 'product_variant_id', 'productVariants'],
  ['privateOrders', 'product_group_id', 'productGroups'],
  ['privateOrderItems', 'private_order_id', 'privateOrders'],
  ['privateOrderItems', 'product_variant_id', 'productVariants'],
  ['salesOrderItems', 'order_id', 'salesOrders'],
  ['bundleComponents', 'bundle_variant_id', 'productVariants'],
  ['bundleComponents', 'component_variant_id', 'productVariants'],
  ['japanPackageItems', 'japan_package_id', 'japanPackages'],
  ['outboundShipmentItems', 'outbound_shipment_id', 'outboundShipments'],
] as const;

const auditLocalRelations = (data: Record<string, unknown>): number => {
  let orphanCount = 0;
  for (const [childCollection, field, parentCollection] of LOCAL_RELATIONS) {
    const children = data[childCollection] as Row[];
    const parents = new Set((data[parentCollection] as Row[]).map(row => text(row.id)));
    orphanCount += children.filter(row => !text(row[field]) || !parents.has(text(row[field]))).length;
  }
  return orphanCount;
};

export async function prepareCloudBackupForNextRestore(
  input: string | unknown,
  options: { fileName?: string } = {},
): Promise<CloudBackupToNextCandidate> {
  const candidate = await prepareCloudRestoreSnapshot(input, { fileName: options.fileName });
  const projection = buildNextProjection(candidate);
  const maps = buildIdMaps(projection.data);
  const workbenchData: Record<string, unknown> = {};

  for (const [collection, table] of CLOUD_RESTORE_TABLES) {
    if (table === 'dashboard_category_images' || table.startsWith('waca_')) continue;
    if (table === 'import_batches') {
      workbenchData[collection] = projection.data[table].map(row => coreRow(row, table, maps));
      continue;
    }
    workbenchData[collection] = projection.data[table].map(row => coreRow(row, table, maps));
  }
  Object.assign(workbenchData, mapWaca(projection.data, maps));
  workbenchData.backupFormatVersion = WORKBENCH_BACKUP_FORMAT_VERSION;
  workbenchData.dashboardCategoryImages = DASHBOARD_IMAGE_CATEGORY_KEYS.map(categoryKey => ({ categoryKey, dataUrl: '' }));
  Object.assign(workbenchData, candidate.deadlineSidecar ?? {
    deadlineVerifiedMappings: [], deadlineApplyBatches: [], deadlineApplyItems: [],
  });

  const blockingOrphanCount = auditLocalRelations(workbenchData);
  if (blockingOrphanCount > 0) {
    throw new CloudRestoreValidationError(
      'NEXT_RELATIONSHIP_INTEGRITY_FAILED',
      `跨環境轉換後仍有 ${blockingOrphanCount} 筆必要關聯缺失，已取消還原。`,
    );
  }
  const restoredCounts = Object.fromEntries(CLOUD_RESTORE_TABLES.map(([collection]) => [
    collection,
    Array.isArray(workbenchData[collection]) ? (workbenchData[collection] as unknown[]).length : 0,
  ])) as Record<CloudRestoreCollection, number>;
  const auditIdentityClearedCount = CLOUD_RESTORE_TABLES.reduce(
    (sum, [, table]) => sum + candidate.data[table].filter(row => row.updated_by !== null && row.updated_by !== undefined).length,
    0,
  );
  const deadlineDurableCount = ['deadlineVerifiedMappings', 'deadlineApplyBatches', 'deadlineApplyItems']
    .reduce((sum, key) => sum + ((workbenchData[key] as unknown[])?.length ?? 0), 0);
  const summary: CloudToNextCompatibilitySummary = {
    policyVersion: CLOUD_TO_NEXT_PORTABILITY_POLICY_VERSION,
    sourceSchemaVersion: candidate.schemaVersion,
    sourceIdentityContractVersion: candidate.sourceIdentityContractVersion,
    sourceEnvironment: candidate.sourceEnvironment,
    sourceResourceCount: candidate.legacyWacaBackup ? 15 : candidate.manifest.resourceCount,
    targetResourceCount: CLOUD_RESTORE_TABLES.length,
    sourceTotalRows: candidate.manifest.totalRows - (candidate.legacyWacaBackup ? 1 : 0),
    restoredTotalRows: Object.values(restoredCounts).reduce((sum, count) => sum + count, 0),
    sourceCounts: { ...candidate.manifest.counts },
    restoredCounts,
    softDeletedSkippedCount: projection.softDeletedSkippedCount,
    softDeletedRetainedForIntegrityCount: projection.softDeletedRetainedForIntegrityCount,
    auditIdentityClearedCount,
    blockingOrphanCount,
    optionalMetadataMissingReferenceCount: candidate.manifest.optionalMetadataMissingReferenceCount,
    legacyWacaBackup: Boolean(candidate.legacyWacaBackup),
    wacaOrderCount: restoredCounts.wacaOrders,
    wacaItemCount: restoredCounts.wacaItems,
    deadlineDurableCount,
    dashboardImagePolicy: 'legacy-unused-metadata-not-imported',
  };
  return {
    kind: 'cloud-atomic-backup',
    fileName: options.fileName ?? candidate.fileName,
    sourceFileSha256: candidate.sourceFileSha256,
    workbenchData,
    workbenchJson: JSON.stringify(workbenchData),
    summary,
  };
}
