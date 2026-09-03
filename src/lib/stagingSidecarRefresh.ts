import {
  CLOSING_DATE_SIDECAR_STORE_NAMES,
  NEXT_CLOSING_DATE_SIDECAR_DB_NAME,
  NEXT_CLOSING_DATE_SIDECAR_DB_VERSION,
  migrateClosingDateResolutionSidecar,
} from './closingDateResolutionSidecarSchema';
import {
  STAGING_SUPABASE_PROJECT_REF,
  assertSupabaseEnvironmentBoundary,
} from './supabaseEnvironmentBoundary';

export interface StagingSidecarRefreshBackup {
  formatVersion: 1;
  sourceProjectRef: string;
  databaseName: string;
  databaseVersion: number;
  capturedAt: string;
  stores: Record<string, unknown[]>;
  storeCounts: Record<string, number>;
  snapshotHash: string;
}

const assertStagingRuntime = (): void => {
  const result = assertSupabaseEnvironmentBoundary({
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL || '',
    viteMode: import.meta.env.MODE,
    sandboxEnvironment: import.meta.env.VITE_SANDBOX_ENV,
    deploymentEnvironment: import.meta.env.VITE_DEPLOYMENT_ENV,
    cloudPreviewEnabled: import.meta.env.VITE_CLOUD_REALTIME_PREVIEW === 'true',
    providerMode: 'next',
  });
  if (!['next', 'staging'].includes(result.role) || result.projectRef !== STAGING_SUPABASE_PROJECT_REF) {
    throw new Error('STAGING_SIDECAR_RUNTIME_REQUIRED');
  }
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stableValue(nested)]));
};

const hashValue = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const openSidecar = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(NEXT_CLOSING_DATE_SIDECAR_DB_NAME, NEXT_CLOSING_DATE_SIDECAR_DB_VERSION);
  request.onupgradeneeded = event => migrateClosingDateResolutionSidecar(
    request.result,
    event.oldVersion,
  );
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('STAGING_SIDECAR_OPEN_FAILED'));
  request.onblocked = () => reject(new Error('STAGING_SIDECAR_OPEN_BLOCKED'));
});

const readStore = (transaction: IDBTransaction, storeName: string): Promise<unknown[]> => new Promise(
  (resolve, reject) => {
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`STAGING_SIDECAR_READ_FAILED:${storeName}`));
  },
);

export async function createStagingSidecarRefreshBackup(): Promise<StagingSidecarRefreshBackup> {
  assertStagingRuntime();
  const database = await openSidecar();
  try {
    const transaction = database.transaction([...CLOSING_DATE_SIDECAR_STORE_NAMES], 'readonly');
    const completion = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('STAGING_SIDECAR_BACKUP_ABORTED'));
      transaction.onerror = () => undefined;
    });
    const entries = await Promise.all(CLOSING_DATE_SIDECAR_STORE_NAMES.map(async storeName => [
      storeName,
      await readStore(transaction, storeName),
    ] as const));
    await completion;
    const stores = Object.fromEntries(entries);
    const unsigned = {
      formatVersion: 1 as const,
      sourceProjectRef: STAGING_SUPABASE_PROJECT_REF,
      databaseName: NEXT_CLOSING_DATE_SIDECAR_DB_NAME,
      databaseVersion: NEXT_CLOSING_DATE_SIDECAR_DB_VERSION,
      capturedAt: new Date().toISOString(),
      stores,
      storeCounts: Object.fromEntries(entries.map(([name, records]) => [name, records.length])),
    };
    return { ...unsigned, snapshotHash: await hashValue(unsigned) };
  } finally {
    database.close();
  }
}

export async function validateStagingSidecarRefreshBackup(
  backup: StagingSidecarRefreshBackup,
): Promise<void> {
  const { snapshotHash, ...unsigned } = backup;
  if (
    backup.formatVersion !== 1
    || backup.sourceProjectRef !== STAGING_SUPABASE_PROJECT_REF
    || backup.databaseName !== NEXT_CLOSING_DATE_SIDECAR_DB_NAME
    || await hashValue(unsigned) !== snapshotHash
  ) {
    throw new Error('STAGING_SIDECAR_BACKUP_INVALID');
  }
}

export async function reinitializeStagingSidecarAfterRefresh(input: {
  backup: StagingSidecarRefreshBackup;
  confirmedBackupHash: string;
  newProductVariantIdentityHash: string;
}): Promise<{ databaseName: string; productVariantIdentityHash: string }> {
  assertStagingRuntime();
  await validateStagingSidecarRefreshBackup(input.backup);
  if (input.confirmedBackupHash !== input.backup.snapshotHash) {
    throw new Error('STAGING_SIDECAR_BACKUP_CONFIRMATION_MISMATCH');
  }
  if (!/^[a-f0-9]{64}$/i.test(input.newProductVariantIdentityHash)) {
    throw new Error('STAGING_BASELINE_IDENTITY_HASH_INVALID');
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(NEXT_CLOSING_DATE_SIDECAR_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('STAGING_SIDECAR_RESET_FAILED'));
    request.onblocked = () => reject(new Error('STAGING_SIDECAR_RESET_BLOCKED_CLOSE_OTHER_TABS'));
  });
  const database = await openSidecar();
  database.close();
  return {
    databaseName: NEXT_CLOSING_DATE_SIDECAR_DB_NAME,
    productVariantIdentityHash: input.newProductVariantIdentityHash,
  };
}
