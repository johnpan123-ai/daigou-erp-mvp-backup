import { validateDeadlineDurableBackup, type DeadlineDurableBackup } from './closingDateSidecarBackup';

// A local, recoverable hand-off between the durable Cloud restore attempt and
// the browser-only Deadline sidecar. This is not a business data source.
const DATABASE = 'daigou-erp-cloud-restore-deadline-stage-v1';
const STORE = 'pending';

export interface CloudDeadlineRestoreStage {
  id: string;
  sourceFingerprint: string;
  legacyBackup: boolean;
  deadlineSidecar?: DeadlineDurableBackup;
  deadlineSidecarSha256?: string;
}

const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = window.indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('期限對照還原暫存無法開啟。'));
});

export async function stageCloudDeadlineRestore(input: CloudDeadlineRestoreStage): Promise<void> {
  if (!input.id || !input.sourceFingerprint || (!input.legacyBackup &&
    (!input.deadlineSidecar || !/^[0-9a-f]{64}$/u.test(input.deadlineSidecarSha256 ?? '')))) {
    throw new Error('期限對照還原暫存資料不完整。');
  }
  const row = { ...input, deadlineSidecar: input.deadlineSidecar
    ? validateDeadlineDurableBackup(input.deadlineSidecar) : undefined };
  const database = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('期限對照還原暫存失敗。'));
      tx.onabort = () => reject(tx.error ?? new Error('期限對照還原暫存已中止。'));
    });
  } finally { database.close(); }
}

export async function readCloudDeadlineRestoreStage(id: string): Promise<CloudDeadlineRestoreStage | null> {
  const database = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(id);
      request.onsuccess = () => {
        const row = request.result as CloudDeadlineRestoreStage | undefined;
        if (!row) { resolve(null); return; }
        try {
          resolve({ ...row, deadlineSidecar: row.deadlineSidecar
            ? validateDeadlineDurableBackup(row.deadlineSidecar) : undefined });
        } catch (error) { reject(error); }
      };
      request.onerror = () => reject(request.error ?? new Error('期限對照還原暫存讀取失敗。'));
    });
  } finally { database.close(); }
}

export async function clearCloudDeadlineRestoreStage(id: string): Promise<void> {
  const database = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('期限對照還原暫存清除失敗。'));
      tx.onabort = () => reject(tx.error ?? new Error('期限對照還原暫存清除已中止。'));
    });
  } finally { database.close(); }
}
