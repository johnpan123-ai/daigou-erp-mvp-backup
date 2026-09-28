import {
  CLOSING_DATE_SIDECAR_STORES, CLOUD_CLOSING_DATE_SIDECAR_DB_NAME,
  NEXT_CLOSING_DATE_SIDECAR_DB_NAME, NEXT_CLOSING_DATE_SIDECAR_DB_VERSION,
  migrateClosingDateResolutionSidecar,
} from './closingDateResolutionSidecarSchema';

/** The three analysis stores are rebuildable. Confirmed mappings and apply audits are not. */
export const DEADLINE_DURABLE_BACKUP_KEYS = {
  deadlineVerifiedMappings: CLOSING_DATE_SIDECAR_STORES.verifiedMappings,
  deadlineApplyBatches: CLOSING_DATE_SIDECAR_STORES.applyBatches,
  deadlineApplyItems: CLOSING_DATE_SIDECAR_STORES.applyItems,
} as const;

export type DeadlineDurableBackup = Record<keyof typeof DEADLINE_DURABLE_BACKUP_KEYS, Record<string, unknown>[]>;
type SidecarMode = 'next' | 'cloud';

const open = (mode: SidecarMode): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const name = mode === 'next' ? NEXT_CLOSING_DATE_SIDECAR_DB_NAME : CLOUD_CLOSING_DATE_SIDECAR_DB_NAME;
  const request = window.indexedDB.open(name, NEXT_CLOSING_DATE_SIDECAR_DB_VERSION);
  request.onupgradeneeded = event => migrateClosingDateResolutionSidecar(request.result, event.oldVersion);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('期限對照資料庫無法開啟。'));
});

export function validateDeadlineDurableBackup(data: Record<string, unknown>): DeadlineDurableBackup {
  const result = {} as DeadlineDurableBackup;
  for (const key of Object.keys(DEADLINE_DURABLE_BACKUP_KEYS) as (keyof DeadlineDurableBackup)[]) {
    const rows = data[key];
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error(`備份中的期限對照資料 ${key} 不完整。`);
    }
    result[key] = rows as Record<string, unknown>[];
  }
  const unique = (values: unknown[], label: string) => {
    if (values.some(value => typeof value !== 'string' || !value) || new Set(values).size !== values.length) {
      throw new Error(`期限對照備份 ${label} 有重複或無效識別碼。`);
    }
  };
  unique(result.deadlineVerifiedMappings.map(row => row.id), '已確認對照');
  unique(result.deadlineApplyBatches.map(row => row.id), '套用紀錄');
  unique(result.deadlineApplyItems.map(row => row.id), '套用明細');
  const batches = new Set(result.deadlineApplyBatches.map(row => row.id));
  if (result.deadlineApplyItems.some(row => !batches.has(row.applyBatchId))) {
    throw new Error('期限對照備份的套用明細缺少主紀錄。');
  }
  return result;
}

export async function readDeadlineDurableBackup(mode: SidecarMode): Promise<DeadlineDurableBackup> {
  const database = await open(mode);
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(Object.values(DEADLINE_DURABLE_BACKUP_KEYS), 'readonly');
      const result = {} as DeadlineDurableBackup;
      for (const [key, store] of Object.entries(DEADLINE_DURABLE_BACKUP_KEYS) as [keyof DeadlineDurableBackup, string][]) {
        const request = tx.objectStore(store).getAll();
        request.onsuccess = () => { result[key] = request.result as Record<string, unknown>[]; };
      }
      tx.oncomplete = () => { try { resolve(validateDeadlineDurableBackup(result)); } catch (error) { reject(error); } };
      tx.onerror = () => reject(tx.error ?? new Error('期限對照備份讀取失敗。'));
      tx.onabort = () => reject(tx.error ?? new Error('期限對照備份讀取中止。'));
    });
  } finally { database.close(); }
}

export async function restoreDeadlineDurableBackup(mode: SidecarMode, input: Record<string, unknown>): Promise<void> {
  const data = validateDeadlineDurableBackup(input);
  const database = await open(mode);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(Object.values(DEADLINE_DURABLE_BACKUP_KEYS), 'readwrite');
      for (const [key, storeName] of Object.entries(DEADLINE_DURABLE_BACKUP_KEYS) as [keyof DeadlineDurableBackup, string][]) {
        const store = tx.objectStore(storeName);
        store.clear();
        for (const row of data[key]) store.put(row);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('期限對照還原失敗。'));
      tx.onabort = () => reject(tx.error ?? new Error('期限對照還原已回滾。'));
    });
  } finally { database.close(); }
}
