export const PRODUCTION_INDEXED_DB_NAME = 'daigou-erp-db';
export const TEST_SANDBOX_INDEXED_DB_NAME = 'daigou-erp-db-test-v1';
export const TEST_SANDBOX_STORAGE_PREFIX = '__hippo_test_sandbox__::';

const PROVIDER_MODE_KEY = 'erp_provider_mode';

let installed = false;
let nativeIndexedDbOpen: typeof IDBFactory.prototype.open | null = null;
let nativeStorageGetItem: typeof Storage.prototype.getItem | null = null;
let nativeStorageSetItem: typeof Storage.prototype.setItem | null = null;
let nativeStorageRemoveItem: typeof Storage.prototype.removeItem | null = null;

const shouldNamespaceLocalStorageKey = (key: string): boolean => {
  if (key === PROVIDER_MODE_KEY || key.startsWith(TEST_SANDBOX_STORAGE_PREFIX)) return false;

  return key.startsWith('erp_')
    || key.startsWith('variant_default_')
    || key.startsWith('dashboard_')
    || key.startsWith('purchase_management_')
    || key === 'sidebar_collapsed';
};

const mapLocalStorageKey = (key: string): string => (
  shouldNamespaceLocalStorageKey(key) ? `${TEST_SANDBOX_STORAGE_PREFIX}${key}` : key
);

export const isTestSandboxRequested = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(PROVIDER_MODE_KEY) === 'test';
};

export function installTestSandboxEnvironment(): void {
  if (installed || typeof window === 'undefined' || !isTestSandboxRequested()) return;

  nativeIndexedDbOpen = IDBFactory.prototype.open;
  nativeStorageGetItem = Storage.prototype.getItem;
  nativeStorageSetItem = Storage.prototype.setItem;
  nativeStorageRemoveItem = Storage.prototype.removeItem;

  IDBFactory.prototype.open = function sandboxedOpen(name: string, version?: number): IDBOpenDBRequest {
    const routedName = name === PRODUCTION_INDEXED_DB_NAME ? TEST_SANDBOX_INDEXED_DB_NAME : name;
    return version === undefined
      ? nativeIndexedDbOpen!.call(this, routedName)
      : nativeIndexedDbOpen!.call(this, routedName, version);
  };

  Storage.prototype.getItem = function sandboxedGetItem(key: string): string | null {
    const mappedKey = this === window.localStorage ? mapLocalStorageKey(key) : key;
    return nativeStorageGetItem!.call(this, mappedKey);
  };

  Storage.prototype.setItem = function sandboxedSetItem(key: string, value: string): void {
    const mappedKey = this === window.localStorage ? mapLocalStorageKey(key) : key;
    nativeStorageSetItem!.call(this, mappedKey, value);
  };

  Storage.prototype.removeItem = function sandboxedRemoveItem(key: string): void {
    const mappedKey = this === window.localStorage ? mapLocalStorageKey(key) : key;
    nativeStorageRemoveItem!.call(this, mappedKey);
  };

  installed = true;
  console.info(`[Test Sandbox] Storage isolation enabled: ${TEST_SANDBOX_INDEXED_DB_NAME}`);
}

const openPhysicalDatabase = (name: string, version = 1): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const open = nativeIndexedDbOpen ?? IDBFactory.prototype.open;
  const request = open.call(window.indexedDB, name, version);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error(`IndexedDB open blocked: ${name}`));
});

export async function clearTestSandboxData(): Promise<void> {
  if (typeof window === 'undefined') return;

  const database = await openPhysicalDatabase(TEST_SANDBOX_INDEXED_DB_NAME);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      transaction.objectStore('kv').clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Test Sandbox clear aborted'));
    });
  } finally {
    database.close();
  }

  const remove = nativeStorageRemoveItem ?? Storage.prototype.removeItem;
  const keysToRemove: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(TEST_SANDBOX_STORAGE_PREFIX)) keysToRemove.push(key);
  }
  keysToRemove.forEach(key => remove.call(window.localStorage, key));
}

export async function readPhysicalIndexedDbSnapshot(databaseName: string): Promise<Record<string, unknown>> {
  const database = await openPhysicalDatabase(databaseName);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('kv', 'readonly');
      const request = transaction.objectStore('kv').openCursor();
      const result: Record<string, unknown> = {};
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(result);
          return;
        }
        result[String(cursor.key)] = cursor.value;
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}
