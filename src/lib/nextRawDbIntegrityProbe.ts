import { NEXT_SANDBOX_INDEXED_DB_NAME, getActiveSandboxMode } from './testSandboxEnvironment';

type Row = Record<string, unknown>;

const STORAGE_KEYS = {
  productGroups: 'erp_product_groups',
  productVariants: 'erp_product_variants',
  purchaseBatches: 'erp_purchase_batches',
  purchaseBatchItems: 'erp_purchase_batch_items',
  privateOrderItems: 'erp_private_order_items',
  bundleComponents: 'erp_bundle_components',
  japanPackageItems: 'erp_japan_package_items',
  outboundShipmentItems: 'erp_outbound_shipment_items',
} as const;

export const VSPO_PROBE_GROUP_IDS = [
  '18bcdaae-52a2-47a4-9aec-6f7c9b5897cc',
  '4a584e43-8478-47fd-ae1d-618ad37223f4',
  '52e277f7-18c5-4694-99af-d2a6d34ddf56',
  '549ef9a3-e106-41c8-ac51-ae9dd218c0f3',
  'cf9ccf77-5c84-4afc-8f23-d51e7475d5ce',
] as const;

export interface NextRawCollections {
  productGroups: Row[];
  productVariants: Row[];
  purchaseBatches: Row[];
  purchaseBatchItems: Row[];
  privateOrderItems: Row[];
  bundleComponents: Row[];
  japanPackageItems: Row[];
  outboundShipmentItems: Row[];
}

interface BusinessTotals {
  waca: number;
  purchased: number;
}

interface GroupProbeResult {
  id: string;
  title: string;
  source: {
    totals: BusinessTotals;
    variantIds: string[];
    batchIds: string[];
    batchItemIds: string[];
    variants: Row[];
    batches: Row[];
    batchItems: Row[];
  };
  nextRaw: {
    totals: BusinessTotals;
    variantIds: string[];
    batchIds: string[];
    batchItemIds: string[];
    variants: Row[];
    batches: Row[];
    batchItems: Row[];
  };
  differences: string[];
}

interface OrphanSummary {
  purchaseBatchItemToBatch: string[];
  purchaseBatchItemToVariant: string[];
  purchaseBatchToGroup: string[];
  productVariantToGroup: string[];
  privateOrderItemToVariant: string[];
  bundleToBundleVariant: string[];
  bundleToComponentVariant: string[];
  japanPackageItemToVariant: string[];
  outboundItemToGroup: string[];
  outboundItemToPackageItem: string[];
}

export interface NextRawIntegrityReport {
  generatedAt: string;
  databaseName: string;
  transactionMode: 'readonly';
  collectionCounts: Record<keyof NextRawCollections, { source: number; nextRaw: number }>;
  collectionHashes: Record<keyof NextRawCollections, { source: string; nextRaw: string; equal: boolean }>;
  targetGroups: GroupProbeResult[];
  referentialIntegrity: {
    source: OrphanSummary;
    nextRaw: OrphanSummary;
    increasedRelations: Array<{ relation: keyof OrphanSummary; source: number; nextRaw: number }>;
  };
}

const asRows = (value: unknown, label: string): Row[] => {
  if (!Array.isArray(value)) throw new Error(`${label} 不是陣列。`);
  return value.filter((row): row is Row => row !== null && typeof row === 'object' && !Array.isArray(row));
};

const stringValue = (value: unknown): string => typeof value === 'string' ? value : '';
const positiveNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const openNextRawDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (getActiveSandboxMode() !== 'next') {
    reject(new Error('此唯讀診斷只允許在 Next Sandbox 執行。'));
    return;
  }

  const request = window.indexedDB.open(NEXT_SANDBOX_INDEXED_DB_NAME);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('無法開啟 Next Sandbox IndexedDB。'));
  request.onblocked = () => reject(new Error('Next Sandbox IndexedDB 被其他分頁阻擋。'));
  request.onupgradeneeded = () => {
    request.transaction?.abort();
    reject(new Error('Next Sandbox DB／kv store 不存在；唯讀診斷拒絕建立資料庫。'));
  };
});

export async function readNextRawCollections(): Promise<NextRawCollections> {
  const database = await openNextRawDatabase();
  try {
    if (!database.objectStoreNames.contains('kv')) throw new Error('Next Sandbox DB 缺少 kv store。');
    return await new Promise<NextRawCollections>((resolve, reject) => {
      const transaction = database.transaction('kv', 'readonly');
      const store = transaction.objectStore('kv');
      const result = {} as NextRawCollections;
      let failed = false;

      for (const [field, key] of Object.entries(STORAGE_KEYS) as Array<[keyof NextRawCollections, string]>) {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            result[field] = asRows(request.result ?? [], key);
          } catch (error) {
            failed = true;
            reject(error);
          }
        };
        request.onerror = () => {
          failed = true;
          reject(request.error ?? new Error(`讀取 ${key} 失敗。`));
        };
      }

      transaction.oncomplete = () => {
        if (!failed) resolve(result);
      };
      transaction.onerror = () => reject(transaction.error ?? new Error('Next raw readonly transaction 失敗。'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Next raw readonly transaction 被中止。'));
    });
  } finally {
    database.close();
  }
}

export async function readNextRawSnapshotMetadata(): Promise<Row | null> {
  const database = await openNextRawDatabase();
  try {
    if (!database.objectStoreNames.contains('kv')) throw new Error('Next Sandbox DB 缺少 kv store。');
    return await new Promise<Row | null>((resolve, reject) => {
      const transaction = database.transaction('kv', 'readonly');
      const request = transaction.objectStore('kv').get('erp_test_snapshot_metadata');
      request.onsuccess = () => {
        const value = request.result;
        resolve(value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null);
      };
      request.onerror = () => reject(request.error ?? new Error('讀取 Snapshot metadata 失敗。'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Snapshot metadata readonly transaction 失敗。'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Snapshot metadata readonly transaction 被中止。'));
    });
  } finally {
    database.close();
  }
}

export function parseWorkbenchBackup(text: string): NextRawCollections {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return Object.fromEntries(
    (Object.keys(STORAGE_KEYS) as Array<keyof NextRawCollections>).map(field => [field, asRows(parsed[field], field)]),
  ) as unknown as NextRawCollections;
}

const stableJson = (value: unknown): string => JSON.stringify(value, (_key, entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)));
});

const sha256 = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(stableJson(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
};

const ids = (rows: Row[]): string[] => rows.map(row => stringValue(row.id)).filter(Boolean).sort();

const totalsForGroup = (data: NextRawCollections, groupId: string): BusinessTotals => {
  const variants = data.productVariants.filter(row => row.product_group_id === groupId);
  const batchItemsByVariant = new Map<string, number>();
  for (const item of data.purchaseBatchItems) {
    const variantId = stringValue(item.product_variant_id);
    batchItemsByVariant.set(variantId, (batchItemsByVariant.get(variantId) ?? 0) + positiveNumber(item.quantity));
  }

  return variants.reduce<BusinessTotals>((totals, variant) => {
    totals.waca += Math.max(
      0,
      positiveNumber(variant.waca_auto_quantity) + Number(variant.waca_manual_adjustment ?? 0),
    );
    const manual = positiveNumber(variant.purchased_manual_adjustment);
    const fromItems = batchItemsByVariant.get(stringValue(variant.id)) ?? 0;
    const legacy = positiveNumber(variant.ordered_quantity ?? variant.ordered_qty);
    totals.purchased += manual > 0 ? manual : fromItems > 0 ? fromItems : legacy;
    return totals;
  }, { waca: 0, purchased: 0 });
};

const groupSlice = (data: NextRawCollections, groupId: string) => {
  const variants = data.productVariants.filter(row => row.product_group_id === groupId);
  const variantIds = new Set(ids(variants));
  const batches = data.purchaseBatches.filter(row => row.product_group_id === groupId);
  const batchIds = new Set(ids(batches));
  const batchItems = data.purchaseBatchItems.filter(row => (
    batchIds.has(stringValue(row.purchase_batch_id)) || variantIds.has(stringValue(row.product_variant_id))
  ));
  return {
    totals: totalsForGroup(data, groupId),
    variantIds: [...variantIds].sort(),
    batchIds: [...batchIds].sort(),
    batchItemIds: ids(batchItems),
    variants,
    batches,
    batchItems,
  };
};

const missingForeignIds = (
  sourceRows: Row[],
  foreignKey: string,
  targetRows: Row[],
): string[] => {
  const targetIds = new Set(ids(targetRows));
  return sourceRows.flatMap(row => {
    const foreignId = stringValue(row[foreignKey]);
    return foreignId && !targetIds.has(foreignId) ? [`${stringValue(row.id)}→${foreignId}`] : [];
  }).sort();
};

const orphanSummary = (data: NextRawCollections): OrphanSummary => ({
  purchaseBatchItemToBatch: missingForeignIds(data.purchaseBatchItems, 'purchase_batch_id', data.purchaseBatches),
  purchaseBatchItemToVariant: missingForeignIds(data.purchaseBatchItems, 'product_variant_id', data.productVariants),
  purchaseBatchToGroup: missingForeignIds(data.purchaseBatches, 'product_group_id', data.productGroups),
  productVariantToGroup: missingForeignIds(data.productVariants, 'product_group_id', data.productGroups),
  privateOrderItemToVariant: missingForeignIds(data.privateOrderItems, 'product_variant_id', data.productVariants),
  bundleToBundleVariant: missingForeignIds(data.bundleComponents, 'bundle_variant_id', data.productVariants),
  bundleToComponentVariant: missingForeignIds(data.bundleComponents, 'component_variant_id', data.productVariants),
  japanPackageItemToVariant: missingForeignIds(data.japanPackageItems, 'product_variant_id', data.productVariants),
  outboundItemToGroup: missingForeignIds(data.outboundShipmentItems, 'product_group_id', data.productGroups),
  outboundItemToPackageItem: missingForeignIds(data.outboundShipmentItems, 'japan_package_item_id', data.japanPackageItems),
});

const arrayDifference = (left: string[], right: string[]): string[] => {
  const rightSet = new Set(right);
  return left.filter(value => !rightSet.has(value));
};

export async function buildNextRawIntegrityReport(
  source: NextRawCollections,
  nextRaw: NextRawCollections,
): Promise<NextRawIntegrityReport> {
  const collectionCounts = {} as NextRawIntegrityReport['collectionCounts'];
  const collectionHashes = {} as NextRawIntegrityReport['collectionHashes'];
  for (const field of Object.keys(STORAGE_KEYS) as Array<keyof NextRawCollections>) {
    collectionCounts[field] = { source: source[field].length, nextRaw: nextRaw[field].length };
    const [sourceHash, nextRawHash] = await Promise.all([sha256(source[field]), sha256(nextRaw[field])]);
    collectionHashes[field] = { source: sourceHash, nextRaw: nextRawHash, equal: sourceHash === nextRawHash };
  }

  const targetGroups = VSPO_PROBE_GROUP_IDS.map(id => {
    const sourceSlice = groupSlice(source, id);
    const nextRawSlice = groupSlice(nextRaw, id);
    const differences: string[] = [];
    for (const key of ['variantIds', 'batchIds', 'batchItemIds'] as const) {
      const missing = arrayDifference(sourceSlice[key], nextRawSlice[key]);
      const added = arrayDifference(nextRawSlice[key], sourceSlice[key]);
      if (missing.length) differences.push(`${key} missing: ${missing.join(', ')}`);
      if (added.length) differences.push(`${key} added: ${added.join(', ')}`);
    }
    if (sourceSlice.totals.waca !== nextRawSlice.totals.waca) {
      differences.push(`WACA ${sourceSlice.totals.waca} → ${nextRawSlice.totals.waca}`);
    }
    if (sourceSlice.totals.purchased !== nextRawSlice.totals.purchased) {
      differences.push(`Purchased ${sourceSlice.totals.purchased} → ${nextRawSlice.totals.purchased}`);
    }
    return {
      id,
      title: stringValue(source.productGroups.find(group => group.id === id)?.title)
        || stringValue(nextRaw.productGroups.find(group => group.id === id)?.title),
      source: sourceSlice,
      nextRaw: nextRawSlice,
      differences,
    };
  });

  const sourceOrphans = orphanSummary(source);
  const nextRawOrphans = orphanSummary(nextRaw);
  const increasedRelations = (Object.keys(sourceOrphans) as Array<keyof OrphanSummary>).flatMap(relation => (
    nextRawOrphans[relation].length > sourceOrphans[relation].length
      ? [{ relation, source: sourceOrphans[relation].length, nextRaw: nextRawOrphans[relation].length }]
      : []
  ));

  return {
    generatedAt: new Date().toISOString(),
    databaseName: NEXT_SANDBOX_INDEXED_DB_NAME,
    transactionMode: 'readonly',
    collectionCounts,
    collectionHashes,
    targetGroups,
    referentialIntegrity: { source: sourceOrphans, nextRaw: nextRawOrphans, increasedRelations },
  };
}
