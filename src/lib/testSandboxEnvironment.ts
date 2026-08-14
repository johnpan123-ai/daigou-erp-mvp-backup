export const PRODUCTION_INDEXED_DB_NAME = 'daigou-erp-db';
export const TEST_SANDBOX_INDEXED_DB_NAME = 'daigou-erp-db-test-v1';
export const TEST_SANDBOX_STORAGE_PREFIX = '__hippo_test_sandbox__::';

const PROVIDER_MODE_KEY = 'erp_provider_mode';
const PRODUCTION_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';

let installed = false;
let nativeIndexedDbOpen: typeof IDBFactory.prototype.open | null = null;
let nativeStorageGetItem: typeof Storage.prototype.getItem | null = null;
let nativeStorageSetItem: typeof Storage.prototype.setItem | null = null;
let nativeStorageRemoveItem: typeof Storage.prototype.removeItem | null = null;
let nativeFetch: typeof globalThis.fetch | null = null;
let nativeXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let nativeSendBeacon: typeof navigator.sendBeacon | null = null;
let nativeWebSocket: typeof WebSocket | null = null;

export class TestSandboxProductionNetworkBlockedError extends Error {
  constructor(channel: string, url: string) {
    super(`Test Sandbox blocked Production Supabase ${channel}: ${url}`);
    this.name = 'TestSandboxProductionNetworkBlockedError';
  }
}

const requestUrl = (input: RequestInfo | URL | string): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

export const isProductionSupabaseRequest = (input: RequestInfo | URL | string): boolean => {
  if (!PRODUCTION_SUPABASE_URL) return false;
  try {
    const request = new URL(requestUrl(input), window.location.origin);
    const production = new URL(PRODUCTION_SUPABASE_URL);
    return request.hostname === production.hostname && request.port === production.port;
  } catch {
    return false;
  }
};

const installProductionNetworkBlock = (): void => {
  nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (isProductionSupabaseRequest(input)) {
      throw new TestSandboxProductionNetworkBlockedError(`fetch ${init?.method || (input instanceof Request ? input.method : 'GET')}`, requestUrl(input));
    }
    return nativeFetch!(input, init);
  }) as typeof fetch;

  nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function sandboxedXhrOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ): void {
    if (isProductionSupabaseRequest(url)) {
      throw new TestSandboxProductionNetworkBlockedError(`XMLHttpRequest ${method}`, String(url));
    }
    const open = nativeXhrOpen as unknown as (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async: boolean,
      username?: string | null,
      password?: string | null,
    ) => void;
    open.call(this, method, url, async, username, password);
  } as typeof XMLHttpRequest.prototype.open;

  nativeSendBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = ((url: string | URL, data?: BodyInit | null) => {
    if (isProductionSupabaseRequest(url)) {
      throw new TestSandboxProductionNetworkBlockedError('sendBeacon', String(url));
    }
    return nativeSendBeacon!(url, data);
  }) as typeof navigator.sendBeacon;

  nativeWebSocket = window.WebSocket;
  window.WebSocket = class SandboxWebSocket extends nativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (isProductionSupabaseRequest(url)) {
        throw new TestSandboxProductionNetworkBlockedError('WebSocket', String(url));
      }
      super(url, protocols);
    }
  } as typeof WebSocket;
};

const shouldNamespaceLocalStorageKey = (key: string): boolean => {
  if (key === PROVIDER_MODE_KEY || key.startsWith(TEST_SANDBOX_STORAGE_PREFIX)) return false;

  // Supabase owns sb-* auth keys. Test Mode must neither read, write, delete,
  // nor remap the real Production session storage.
  if (key.startsWith('sb-')) return false;

  return key.startsWith('erp_')
    || key.startsWith('variant_default_')
    || key.startsWith('dashboard_')
    || key.startsWith('purchase_management_')
    || key === 'sidebar_collapsed'
    || key === 'remembered_email'
    || key === 'remember_me';
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

  installProductionNetworkBlock();

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

export function readPhysicalLocalStorageValue(key: string): string | null {
  if (typeof window === 'undefined') return null;
  const get = nativeStorageGetItem ?? Storage.prototype.getItem;
  return get.call(window.localStorage, key);
}
