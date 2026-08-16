import { getProviderMode } from '../providers/providerMode';
import {
  PRODUCTION_INDEXED_DB_NAME,
  TEST_SANDBOX_STORAGE_PREFIX,
  NEXT_SANDBOX_STORAGE_PREFIX,
  EXPERIMENTAL_SANDBOX_STORAGE_PREFIX,
  getActiveSandboxConfig,
  isSandboxMode,
  readPhysicalIndexedDbSnapshot,
  readPhysicalLocalStorageValue,
} from './testSandboxEnvironment';

export const TEST_SNAPSHOT_METADATA_KEY = 'erp_test_snapshot_metadata';

const PROVIDER_MODE_KEY = 'erp_provider_mode';

const COLLECTIONS = [
  { field: 'inventory', storageKey: 'erp_inventory', idFields: ['inventory_key', 'myacg_item_code'] },
  { field: 'salesOrders', storageKey: 'erp_sales_orders', idFields: ['id'] },
  { field: 'salesOrderItems', storageKey: 'erp_sales_order_items', idFields: ['id'] },
  { field: 'productGroups', storageKey: 'erp_product_groups', idFields: ['id'] },
  { field: 'productCategories', storageKey: 'erp_product_categories', idFields: ['id'] },
  { field: 'productVariants', storageKey: 'erp_product_variants', idFields: ['id'] },
  { field: 'purchaseBatches', storageKey: 'erp_purchase_batches', idFields: ['id'] },
  { field: 'purchaseBatchItems', storageKey: 'erp_purchase_batch_items', idFields: ['id'] },
  { field: 'privateOrders', storageKey: 'erp_private_orders', idFields: ['id'] },
  { field: 'privateOrderItems', storageKey: 'erp_private_order_items', idFields: ['id'] },
  { field: 'bundleComponents', storageKey: 'erp_bundle_components', idFields: ['id'] },
  { field: 'japanPackages', storageKey: 'erp_japan_packages', idFields: ['id'] },
  { field: 'japanPackageItems', storageKey: 'erp_japan_package_items', idFields: ['id'] },
  { field: 'outboundShipments', storageKey: 'erp_outbound_shipments', idFields: ['id'] },
  { field: 'outboundShipmentItems', storageKey: 'erp_outbound_shipment_items', idFields: ['id'] },
] as const;

export type TestSnapshotCollectionName = (typeof COLLECTIONS)[number]['field'];
export type TestSnapshotCounts = Record<TestSnapshotCollectionName, number>;
export type TestSnapshotData = Record<TestSnapshotCollectionName, Record<string, unknown>[]>;

export interface TestSnapshotOrphanWarning {
  relation: string;
  count: number;
}

export interface TestSnapshotCandidate {
  fileName: string;
  fileSize: number;
  sha256: string;
  data: TestSnapshotData;
  counts: TestSnapshotCounts;
  collectionHashes: Record<TestSnapshotCollectionName, string>;
  orphanWarnings: TestSnapshotOrphanWarning[];
  extraTopLevelKeys: string[];
}

export interface TestSnapshotMetadata {
  format: 'hippo-test-snapshot';
  formatVersion: 1;
  sourceFormat: 'workbench-backup';
  sourceFileName: string;
  sourceFileSize: number;
  sourceSha256: string;
  importedAt: string;
  counts: TestSnapshotCounts;
  collectionHashes: Record<TestSnapshotCollectionName, string>;
  orphanWarnings: TestSnapshotOrphanWarning[];
  extraTopLevelKeys: string[];
}

export interface TestSnapshotImportResult {
  metadata: TestSnapshotMetadata;
  verifiedCounts: TestSnapshotCounts;
  productionIndexedDbUnchanged: boolean;
  productionLocalStorageUnchanged: boolean;
}

type RelationDefinition = {
  source: TestSnapshotCollectionName;
  foreignKey: string;
  target: TestSnapshotCollectionName;
  label: string;
};

const RELATIONS: RelationDefinition[] = [
  { source: 'productCategories', foreignKey: 'product_group_id', target: 'productGroups', label: '商品分類 → 商品群組' },
  { source: 'productVariants', foreignKey: 'product_group_id', target: 'productGroups', label: 'Variant → 商品群組' },
  { source: 'productVariants', foreignKey: 'product_category_id', target: 'productCategories', label: 'Variant → 商品分類' },
  { source: 'purchaseBatches', foreignKey: 'product_group_id', target: 'productGroups', label: '採購批次 → 商品群組' },
  { source: 'purchaseBatchItems', foreignKey: 'purchase_batch_id', target: 'purchaseBatches', label: '採購明細 → 採購批次' },
  { source: 'purchaseBatchItems', foreignKey: 'product_variant_id', target: 'productVariants', label: '採購明細 → Variant' },
  { source: 'privateOrders', foreignKey: 'product_group_id', target: 'productGroups', label: '私人訂單 → 商品群組' },
  { source: 'privateOrderItems', foreignKey: 'private_order_id', target: 'privateOrders', label: '私人訂單明細 → 私人訂單' },
  { source: 'privateOrderItems', foreignKey: 'product_variant_id', target: 'productVariants', label: '私人訂單明細 → Variant' },
  { source: 'bundleComponents', foreignKey: 'bundle_variant_id', target: 'productVariants', label: '套組 → 母 Variant' },
  { source: 'bundleComponents', foreignKey: 'component_variant_id', target: 'productVariants', label: '套組 → 子 Variant' },
  { source: 'japanPackageItems', foreignKey: 'japan_package_id', target: 'japanPackages', label: '日本包裹明細 → 日本包裹' },
  { source: 'japanPackageItems', foreignKey: 'product_group_id', target: 'productGroups', label: '日本包裹明細 → 商品群組' },
  { source: 'japanPackageItems', foreignKey: 'product_variant_id', target: 'productVariants', label: '日本包裹明細 → Variant' },
  { source: 'japanPackageItems', foreignKey: 'purchase_batch_id', target: 'purchaseBatches', label: '日本包裹明細 → 採購批次' },
  { source: 'japanPackageItems', foreignKey: 'purchase_batch_item_id', target: 'purchaseBatchItems', label: '日本包裹明細 → 採購明細' },
  { source: 'outboundShipmentItems', foreignKey: 'outbound_shipment_id', target: 'outboundShipments', label: '出庫明細 → 出庫單' },
  { source: 'outboundShipmentItems', foreignKey: 'japan_package_item_id', target: 'japanPackageItems', label: '出庫明細 → 日本包裹明細' },
  { source: 'outboundShipmentItems', foreignKey: 'product_group_id', target: 'productGroups', label: '出庫明細 → 商品群組' },
  { source: 'outboundShipmentItems', foreignKey: 'product_variant_id', target: 'productVariants', label: '出庫明細 → Variant' },
  { source: 'salesOrderItems', foreignKey: 'order_id', target: 'salesOrders', label: '銷售訂單明細 → 銷售訂單' },
  { source: 'salesOrderItems', foreignKey: 'product_variant_id', target: 'productVariants', label: '銷售訂單明細 → Variant' },
];

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const nonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);

const assertSandboxMode = (): void => {
  if (typeof window === 'undefined' || !isSandboxMode(getProviderMode())) {
    throw new Error('正式版 JSON 快照只能在 Test Sandbox、Next 或 Experimental Sandbox 匯入。');
  }
};

const stableStringify = (value: unknown): string => JSON.stringify(value, (_key, nestedValue) => {
  if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) return nestedValue;
  return Object.fromEntries(Object.entries(nestedValue).sort(([left], [right]) => left.localeCompare(right)));
});

const sha256Bytes = async (bytes: BufferSource): Promise<string> => {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const sha256Json = async (value: unknown): Promise<string> => (
  sha256Bytes(new TextEncoder().encode(stableStringify(value)))
);

const validateBackupShape = (value: unknown): TestSnapshotData => {
  if (!isRecord(value)) throw new Error('JSON 頂層必須是物件。');

  const data = {} as TestSnapshotData;
  for (const collection of COLLECTIONS) {
    const rows = value[collection.field];
    if (!Array.isArray(rows)) {
      throw new Error(`缺少必要集合或型別錯誤：${collection.field} 必須是陣列。`);
    }

    const ids = new Set<string>();
    const validatedRows: Record<string, unknown>[] = [];
    rows.forEach((row, index) => {
      if (!isRecord(row)) throw new Error(`${collection.field}[${index}] 必須是物件。`);
      const id = collection.idFields.map(field => row[field]).find(nonEmptyString);
      if (!nonEmptyString(id)) {
        throw new Error(`${collection.field}[${index}] 缺少可用識別碼（${collection.idFields.join(' / ')}）。`);
      }
      if (ids.has(id)) throw new Error(`${collection.field} 存在重複識別碼：${id}`);
      ids.add(id);
      validatedRows.push(row);
    });
    data[collection.field] = validatedRows;
  }

  return data;
};

const buildCounts = (data: TestSnapshotData): TestSnapshotCounts => Object.fromEntries(
  COLLECTIONS.map(collection => [collection.field, data[collection.field].length]),
) as TestSnapshotCounts;

const buildCollectionHashes = async (
  data: TestSnapshotData,
): Promise<Record<TestSnapshotCollectionName, string>> => Object.fromEntries(
  await Promise.all(COLLECTIONS.map(async collection => [
    collection.field,
    await sha256Json(data[collection.field]),
  ])),
) as Record<TestSnapshotCollectionName, string>;

const buildOrphanWarnings = (data: TestSnapshotData): TestSnapshotOrphanWarning[] => {
  const idsByCollection = new Map<TestSnapshotCollectionName, Set<string>>();
  for (const collection of COLLECTIONS) {
    idsByCollection.set(
      collection.field,
      new Set(data[collection.field].map(row => String(row.id ?? '')).filter(Boolean)),
    );
  }

  return RELATIONS.flatMap(relation => {
    const targetIds = idsByCollection.get(relation.target) ?? new Set<string>();
    const count = data[relation.source].filter(row => {
      const foreignId = row[relation.foreignKey];
      return nonEmptyString(foreignId) && !targetIds.has(foreignId);
    }).length;
    return count > 0 ? [{ relation: relation.label, count }] : [];
  });
};

const openTestDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const config = getActiveSandboxConfig();
  if (!config) {
    reject(new Error('目前不是 Sandbox 模式，拒絕開啟 Snapshot DB。'));
    return;
  }
  const request = window.indexedDB.open(config.dbName, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error(`Sandbox IndexedDB 開啟被阻擋：${config.dbName}`));
});

const readTestMetadataFromDatabase = async (): Promise<TestSnapshotMetadata | null> => {
  const database = await openTestDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('kv', 'readonly');
      const request = transaction.objectStore('kv').get(TEST_SNAPSHOT_METADATA_KEY);
      request.onsuccess = () => resolve((request.result as TestSnapshotMetadata | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
};

const isProductionAppStorageKey = (key: string): boolean => {
  if (key === PROVIDER_MODE_KEY || key.startsWith(TEST_SANDBOX_STORAGE_PREFIX) || key.startsWith(NEXT_SANDBOX_STORAGE_PREFIX) || key.startsWith(EXPERIMENTAL_SANDBOX_STORAGE_PREFIX) || key.startsWith('sb-')) return false;
  return key.startsWith('erp_')
    || key.startsWith('variant_default_')
    || key.startsWith('dashboard_')
    || key.startsWith('purchase_management_')
    || key === 'sidebar_collapsed'
    || key === 'remembered_email'
    || key === 'remember_me';
};

const productionLocalStorageChecksum = async (): Promise<string> => {
  const entries: [string, string | null][] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key && isProductionAppStorageKey(key)) entries.push([key, readPhysicalLocalStorageValue(key)]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return sha256Json(entries);
};

const productionIndexedDbChecksum = async (): Promise<string> => {
  if (typeof window.indexedDB.databases === 'function') {
    const databases = await window.indexedDB.databases();
    if (!databases.some(database => database.name === PRODUCTION_INDEXED_DB_NAME)) return 'absent';
  }
  return sha256Json(await readPhysicalIndexedDbSnapshot(PRODUCTION_INDEXED_DB_NAME));
};

const writeSnapshotAtomically = async (
  candidate: TestSnapshotCandidate,
  metadata: TestSnapshotMetadata,
): Promise<void> => {
  const database = await openTestDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      let settled = false;
      const finishWithError = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      transaction.onerror = () => finishWithError(transaction.error ?? new Error('Test Snapshot transaction 失敗。'));
      transaction.onabort = () => finishWithError(transaction.error ?? new Error('Test Snapshot transaction 已回滾。'));

      try {
        const store = transaction.objectStore('kv');
        store.clear();
        for (const collection of COLLECTIONS) {
          store.put(candidate.data[collection.field], collection.storageKey);
        }
        store.put(metadata, TEST_SNAPSHOT_METADATA_KEY);
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already have aborted because of the original error.
        }
        finishWithError(error);
      }
    });
  } finally {
    database.close();
  }
};

const verifyImportedSnapshot = async (
  candidate: TestSnapshotCandidate,
): Promise<TestSnapshotCounts> => {
  const config = getActiveSandboxConfig();
  if (!config) throw new Error('目前不是 Sandbox 模式，無法驗證 Snapshot。');
  const snapshot = await readPhysicalIndexedDbSnapshot(config.dbName);
  const verifiedCounts = {} as TestSnapshotCounts;

  for (const collection of COLLECTIONS) {
    const stored = snapshot[collection.storageKey];
    if (!Array.isArray(stored)) throw new Error(`匯入驗證失敗：${collection.storageKey} 不存在或不是陣列。`);
    verifiedCounts[collection.field] = stored.length;
    if (stored.length !== candidate.counts[collection.field]) {
      throw new Error(`匯入驗證失敗：${collection.field} 筆數不一致。`);
    }
    const storedHash = await sha256Json(stored);
    if (storedHash !== candidate.collectionHashes[collection.field]) {
      throw new Error(`匯入驗證失敗：${collection.field} checksum 不一致。`);
    }
  }

  return verifiedCounts;
};

export async function prepareTestSnapshotFile(file: File): Promise<TestSnapshotCandidate> {
  assertSandboxMode();
  if (!file.name.toLowerCase().endsWith('.json')) throw new Error('請選擇 JSON 檔案。');

  const bytes = await file.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    throw new Error('JSON 檔案不是有效的 UTF-8。');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 解析失敗：${error instanceof Error ? error.message : String(error)}`);
  }

  const data = validateBackupShape(parsed);
  const knownKeys = new Set<string>(COLLECTIONS.map(collection => collection.field));
  const extraTopLevelKeys = isRecord(parsed) ? Object.keys(parsed).filter(key => !knownKeys.has(key)) : [];

  return {
    fileName: file.name,
    fileSize: file.size,
    sha256: await sha256Bytes(bytes),
    data,
    counts: buildCounts(data),
    collectionHashes: await buildCollectionHashes(data),
    orphanWarnings: buildOrphanWarnings(data),
    extraTopLevelKeys,
  };
}

export async function importTestSnapshot(candidate: TestSnapshotCandidate): Promise<TestSnapshotImportResult> {
  assertSandboxMode();

  const data = validateBackupShape(candidate.data);
  const currentHashes = await buildCollectionHashes(data);
  for (const collection of COLLECTIONS) {
    if (currentHashes[collection.field] !== candidate.collectionHashes[collection.field]) {
      throw new Error(`匯入候選資料已改變：${collection.field}`);
    }
  }

  const productionDbBefore = await productionIndexedDbChecksum();
  const productionStorageBefore = await productionLocalStorageChecksum();
  const metadata: TestSnapshotMetadata = {
    format: 'hippo-test-snapshot',
    formatVersion: 1,
    sourceFormat: 'workbench-backup',
    sourceFileName: candidate.fileName,
    sourceFileSize: candidate.fileSize,
    sourceSha256: candidate.sha256,
    importedAt: new Date().toISOString(),
    counts: candidate.counts,
    collectionHashes: candidate.collectionHashes,
    orphanWarnings: candidate.orphanWarnings,
    extraTopLevelKeys: candidate.extraTopLevelKeys,
  };

  await writeSnapshotAtomically(candidate, metadata);
  const verifiedCounts = await verifyImportedSnapshot(candidate);

  const productionDbAfter = await productionIndexedDbChecksum();
  const productionStorageAfter = await productionLocalStorageChecksum();
  const productionIndexedDbUnchanged = productionDbBefore === productionDbAfter;
  const productionLocalStorageUnchanged = productionStorageBefore === productionStorageAfter;

  if (!productionIndexedDbUnchanged || !productionLocalStorageUnchanged) {
    throw new Error('安全驗證失敗：Production 瀏覽器資料在 Test Snapshot 匯入期間發生變化。');
  }

  return {
    metadata,
    verifiedCounts,
    productionIndexedDbUnchanged,
    productionLocalStorageUnchanged,
  };
}

export async function getTestSnapshotMetadata(): Promise<TestSnapshotMetadata | null> {
  assertSandboxMode();
  return readTestMetadataFromDatabase();
}

export const TEST_SNAPSHOT_COLLECTIONS = COLLECTIONS;
