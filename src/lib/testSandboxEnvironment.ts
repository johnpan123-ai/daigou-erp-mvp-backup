import { PRODUCTION_SUPABASE_PROJECT_REF, parseSupabaseProjectRef } from './supabaseEnvironmentBoundary';

export const PRODUCTION_INDEXED_DB_NAME = 'daigou-erp-db';
export const TEST_SANDBOX_INDEXED_DB_NAME = 'daigou-erp-db-test-v1';
export const NEXT_SANDBOX_INDEXED_DB_NAME = 'daigou-erp-db-next-v1';
export const EXPERIMENTAL_SANDBOX_INDEXED_DB_NAME = 'daigou-erp-db-experimental-v1';

export const TEST_SANDBOX_STORAGE_PREFIX = '__hippo_test_sandbox__::';
export const NEXT_SANDBOX_STORAGE_PREFIX = '__hippo_next_sandbox__::';
export const EXPERIMENTAL_SANDBOX_STORAGE_PREFIX = '__hippo_experimental_sandbox__::';
export const PROVIDER_MODE_KEY = 'erp_provider_mode';

export type SandboxMode = 'test' | 'next' | 'experimental';

export interface SandboxConfig {
  mode: SandboxMode;
  dbName: string;
  storagePrefix: string;
  label: string;
  title: string;
}

const SANDBOX_DATABASE_NAMES = new Set([
  TEST_SANDBOX_INDEXED_DB_NAME,
  NEXT_SANDBOX_INDEXED_DB_NAME,
  EXPERIMENTAL_SANDBOX_INDEXED_DB_NAME,
]);

const SANDBOX_CONFIGS: Record<SandboxMode, SandboxConfig> = {
  test: {
    mode: 'test',
    dbName: TEST_SANDBOX_INDEXED_DB_NAME,
    storagePrefix: TEST_SANDBOX_STORAGE_PREFIX,
    label: 'TEST SANDBOX',
    title: '[TEST] 小河馬 ERP',
  },
  next: {
    mode: 'next',
    dbName: NEXT_SANDBOX_INDEXED_DB_NAME,
    storagePrefix: NEXT_SANDBOX_STORAGE_PREFIX,
    label: 'NEXT SANDBOX',
    title: '[NEXT] 小河馬 ERP',
  },
  experimental: {
    mode: 'experimental',
    dbName: EXPERIMENTAL_SANDBOX_INDEXED_DB_NAME,
    storagePrefix: EXPERIMENTAL_SANDBOX_STORAGE_PREFIX,
    label: 'EXPERIMENTAL',
    title: '[EXPERIMENTAL] 小河馬 ERP',
  },
};

let installed = false;
let nativeIndexedDbOpen: typeof IDBFactory.prototype.open | null = null;
let nativeStorageGetItem: typeof Storage.prototype.getItem | null = null;
let nativeStorageSetItem: typeof Storage.prototype.setItem | null = null;
let nativeStorageRemoveItem: typeof Storage.prototype.removeItem | null = null;
let nativeStorageClear: typeof Storage.prototype.clear | null = null;
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

const rawProviderMode = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(PROVIDER_MODE_KEY);
  } catch {
    return null;
  }
};

/** The Vite mode is the immutable role of a dedicated Next/Experimental server. */
export const getBuildSandboxMode = (): SandboxMode | null => {
  const configured = import.meta.env.VITE_SANDBOX_ENV || import.meta.env.MODE;
  if (configured === 'next' || configured === 'experimental') return configured;
  if (typeof window !== 'undefined' && window.location.port === '4192') return 'next';
  if (typeof window !== 'undefined' && window.location.port === '4193') return 'experimental';
  return null;
};

export const getActiveSandboxMode = (): SandboxMode | null => {
  const mode = rawProviderMode();
  if (mode === 'test' || mode === 'next' || mode === 'experimental') return mode;
  return getBuildSandboxMode();
};

export const getSandboxConfig = (mode: SandboxMode): SandboxConfig => SANDBOX_CONFIGS[mode];

export const getActiveSandboxConfig = (): SandboxConfig | null => {
  const mode = getActiveSandboxMode();
  return mode ? getSandboxConfig(mode) : null;
};

export const isSandboxMode = (mode: string | null | undefined): mode is SandboxMode => (
  mode === 'test' || mode === 'next' || mode === 'experimental'
);

export const isSandboxEnvironmentActive = (): boolean => getActiveSandboxConfig() !== null;

export const isTestSandboxRequested = (): boolean => rawProviderMode() === 'test';

export const isProductionSupabaseRequest = (input: RequestInfo | URL | string): boolean => {
  try {
    const request = new URL(requestUrl(input), window.location.origin);
    return parseSupabaseProjectRef(request.origin) === PRODUCTION_SUPABASE_PROJECT_REF;
  } catch {
    return false;
  }
};

const isAnySupabaseRequest = (input: RequestInfo | URL | string): boolean => {
  try {
    const request = new URL(requestUrl(input), window.location.origin);
    return request.hostname.toLowerCase().endsWith('.supabase.co');
  } catch {
    return false;
  }
};

const installProductionNetworkBlock = (): void => {
  nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (isAnySupabaseRequest(input)) {
      throw new TestSandboxProductionNetworkBlockedError(
        `fetch ${init?.method || (input instanceof Request ? input.method : 'GET')}`,
        requestUrl(input),
      );
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
    if (isAnySupabaseRequest(url)) {
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
    if (isAnySupabaseRequest(url)) {
      throw new TestSandboxProductionNetworkBlockedError('sendBeacon', String(url));
    }
    return nativeSendBeacon!(url, data);
  }) as typeof navigator.sendBeacon;

  nativeWebSocket = window.WebSocket;
  window.WebSocket = class SandboxWebSocket extends nativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (isAnySupabaseRequest(url)) {
        throw new TestSandboxProductionNetworkBlockedError('WebSocket', String(url));
      }
      super(url, protocols);
    }
  } as typeof WebSocket;
};

const shouldNamespaceStorageKey = (key: string): boolean => {
  if (key === PROVIDER_MODE_KEY || key.startsWith('sb-')) return false;
  if (Object.values(SANDBOX_CONFIGS).some(config => key.startsWith(config.storagePrefix))) return false;
  return key.startsWith('erp_')
    || key.startsWith('variant_default_')
    || key.startsWith('dashboard_')
    || key.startsWith('purchase_management_')
    || key === 'sidebar_collapsed'
    || key === 'remembered_email'
    || key === 'remember_me';
};

const mapStorageKey = (key: string): string => {
  const config = getActiveSandboxConfig();
  return config && shouldNamespaceStorageKey(key) ? `${config.storagePrefix}${key}` : key;
};

export function installTestSandboxEnvironment(): void {
  if (installed || typeof window === 'undefined' || !isSandboxEnvironmentActive()) return;

  nativeIndexedDbOpen = IDBFactory.prototype.open;
  nativeStorageGetItem = Storage.prototype.getItem;
  nativeStorageSetItem = Storage.prototype.setItem;
  nativeStorageRemoveItem = Storage.prototype.removeItem;
  nativeStorageClear = Storage.prototype.clear;
  installProductionNetworkBlock();

  IDBFactory.prototype.open = function sandboxedOpen(name: string, version?: number): IDBOpenDBRequest {
    const config = getActiveSandboxConfig();
    const routedName = config && (name === PRODUCTION_INDEXED_DB_NAME || SANDBOX_DATABASE_NAMES.has(name))
      ? config.dbName
      : name;
    return version === undefined
      ? nativeIndexedDbOpen!.call(this, routedName)
      : nativeIndexedDbOpen!.call(this, routedName, version);
  };

  Storage.prototype.getItem = function sandboxedGetItem(key: string): string | null {
    return nativeStorageGetItem!.call(this, this === window.localStorage || this === window.sessionStorage ? mapStorageKey(key) : key);
  };
  Storage.prototype.setItem = function sandboxedSetItem(key: string, value: string): void {
    nativeStorageSetItem!.call(this, this === window.localStorage || this === window.sessionStorage ? mapStorageKey(key) : key, value);
  };
  Storage.prototype.removeItem = function sandboxedRemoveItem(key: string): void {
    nativeStorageRemoveItem!.call(this, this === window.localStorage || this === window.sessionStorage ? mapStorageKey(key) : key);
  };
  Storage.prototype.clear = function sandboxedClear(): void {
    const config = getActiveSandboxConfig();
    if (!config) return nativeStorageClear!.call(this);
    const remove = nativeStorageRemoveItem!;
    const keys: string[] = [];
    for (let index = 0; index < this.length; index += 1) {
      const key = this.key(index);
      if (key?.startsWith(config.storagePrefix)) keys.push(key);
    }
    keys.forEach(key => remove.call(this, key));
  };

  installed = true;
  const config = getActiveSandboxConfig()!;
  console.info(`[${config.label}] isolation enabled: ${config.dbName}, ${config.storagePrefix}`);
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

const clearPhysicalSandbox = async (config: SandboxConfig): Promise<void> => {
  const database = await openPhysicalDatabase(config.dbName);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      transaction.objectStore('kv').clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error(`${config.label} clear aborted`));
    });
  } finally {
    database.close();
  }

  const remove = nativeStorageRemoveItem ?? Storage.prototype.removeItem;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    const keysToRemove: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(config.storagePrefix)) keysToRemove.push(key);
    }
    keysToRemove.forEach(key => remove.call(storage, key));
  }
};

export async function clearSandboxData(): Promise<void> {
  const config = getActiveSandboxConfig();
  if (typeof window === 'undefined' || !config) return;
  await clearPhysicalSandbox(config);
}

/** Legacy API retained for existing Test Sandbox tests and operators. */
export async function clearTestSandboxData(): Promise<void> {
  if (typeof window === 'undefined') return;
  await clearPhysicalSandbox(SANDBOX_CONFIGS.test);
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

export function readPhysicalSessionStorageValue(key: string): string | null {
  if (typeof window === 'undefined') return null;
  const get = nativeStorageGetItem ?? Storage.prototype.getItem;
  return get.call(window.sessionStorage, key);
}
