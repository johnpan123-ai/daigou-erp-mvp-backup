import { reportStorageWriteFailure } from './storageGuard';

// Dashboard category images are user-uploaded Base64 Data URLs that can each run to
// several megabytes. localStorage is a ~5MB origin-wide budget shared with the Supabase
// auth token, so storing them there can silently push the login session out. They live in
// IndexedDB instead, reusing the same database/object store the main adapter already owns.

export const DASHBOARD_IMAGE_CATEGORY_KEYS = ['all', 'hololive', 'vspo', 'agency', 'other'] as const;

export type DashboardImageCategoryKey = typeof DASHBOARD_IMAGE_CATEGORY_KEYS[number];

const legacyLocalStorageKey = (categoryKey: string) => `dashboard_category_img_${categoryKey}`;

let dbPromise: Promise<IDBDatabase> | null = null;

function openImageDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB not supported'));
      return;
    }

    const request = window.indexedDB.open('daigou-erp-db', 1);

    // Mirrors IndexedDbAdapter: whichever connection opens a fresh database first
    // creates the shared 'kv' store.
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Never block another connection's upgrade; drop the cached handle so the
      // next call reopens instead of using a closed database.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });

  // A failed open must not be cached, or every later call inherits the rejection.
  dbPromise = pending.catch(err => {
    dbPromise = null;
    throw err;
  });

  return dbPromise;
}

async function idbGet(key: string): Promise<string | undefined> {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    request.onsuccess = () => resolve(request.result as string | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(key: string, value: string): Promise<void> {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('kv', 'readwrite');
    transaction.objectStore('kv').put(value, key);

    // request.onsuccess only means the write was queued -- the transaction can
    // still abort afterwards (quota, disk error). Durability is oncomplete.
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Reads a category image, preferring IndexedDB and falling back to any legacy
 * localStorage copy that has not been migrated yet.
 */
export async function getDashboardCategoryImage(categoryKey: string): Promise<string> {
  const key = legacyLocalStorageKey(categoryKey);

  try {
    const stored = await idbGet(key);
    if (typeof stored === 'string' && stored) return stored;
  } catch (err) {
    console.warn(`[DashboardImage] IndexedDB read failed for ${categoryKey}, falling back to localStorage`, err);
  }

  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

export async function getAllDashboardCategoryImages(): Promise<Record<string, string>> {
  const entries = await Promise.all(
    DASHBOARD_IMAGE_CATEGORY_KEYS.map(async cat => [cat, await getDashboardCategoryImage(cat)] as const)
  );
  return Object.fromEntries(entries);
}

/**
 * Writes a category image to IndexedDB and verifies it read back intact.
 * Throws on failure so callers can surface a real error instead of reporting
 * a save that did not happen. Deliberately never falls back to localStorage --
 * that is the failure mode this module exists to prevent.
 */
export async function saveDashboardCategoryImage(categoryKey: string, dataUrl: string): Promise<void> {
  const key = legacyLocalStorageKey(categoryKey);

  try {
    await idbPut(key, dataUrl);

    const verification = await idbGet(key);
    if (verification !== dataUrl) {
      throw new Error('IndexedDB verification mismatch after write');
    }
  } catch (err) {
    reportStorageWriteFailure(key, err);
    throw err;
  }

  // The IndexedDB copy is now authoritative, so drop any stale localStorage duplicate.
  try {
    localStorage.removeItem(key);
  } catch { /* leaving a stale duplicate behind is harmless */ }
}

export interface DashboardImageMigrationResult {
  /** Legacy image copied into IndexedDB and verified; localStorage copy reclaimed. */
  migrated: string[];
  /** IndexedDB already held identical bytes; only the duplicate was reclaimed. */
  deduped: string[];
  /** IndexedDB holds a different (newer) image; both copies left untouched. */
  conflicted: string[];
  failed: string[];
  skipped: string[];
}

/**
 * Moves legacy localStorage Base64 images into IndexedDB.
 *
 * Strictly copy -> read back -> compare in full -> only then remove. Any failure
 * at any step leaves the localStorage original untouched, so an image is never
 * lost. Runs regardless of provider mode: a Cloud Mode browser can still be
 * holding megabytes of legacy Local Mode images.
 *
 * IndexedDB always wins. Once an image lives there it is the newer one -- the
 * localStorage copy is by definition a pre-migration leftover -- so a differing
 * legacy value is treated as a conflict and neither side is touched.
 */
export async function migrateLegacyDashboardImages(): Promise<DashboardImageMigrationResult> {
  const result: DashboardImageMigrationResult = {
    migrated: [], deduped: [], conflicted: [], failed: [], skipped: []
  };

  for (const categoryKey of DASHBOARD_IMAGE_CATEGORY_KEYS) {
    const key = legacyLocalStorageKey(categoryKey);

    let legacyValue: string | null = null;
    try {
      legacyValue = localStorage.getItem(key);
    } catch (err) {
      console.warn(`[DashboardImage] Cannot read legacy ${categoryKey}`, err);
      result.failed.push(categoryKey);
      continue;
    }

    if (!legacyValue) {
      result.skipped.push(categoryKey);
      continue;
    }

    try {
      const existing = await idbGet(key);

      if (typeof existing === 'string' && existing) {
        if (existing === legacyValue) {
          // Same bytes on both sides: nothing to write, just reclaim the duplicate.
          localStorage.removeItem(key);
          result.deduped.push(categoryKey);
        } else {
          // IndexedDB holds a newer image. Overwriting it with the legacy copy
          // would silently restore an old picture, so leave both in place.
          console.warn(`[DashboardImage] Conflict for ${categoryKey}: IndexedDB copy differs from legacy localStorage copy, keeping both`);
          result.conflicted.push(categoryKey);
        }
        continue;
      }

      await idbPut(key, legacyValue);

      const verification = await idbGet(key);
      if (verification !== legacyValue) {
        throw new Error('verification mismatch');
      }

      // Verified byte-for-byte in IndexedDB -- only now is it safe to reclaim
      // the localStorage space.
      localStorage.removeItem(key);
      result.migrated.push(categoryKey);
    } catch (err) {
      // Keep the localStorage original. A failed migration must never lose an image.
      console.error(`[DashboardImage] Migration failed for ${categoryKey}, keeping localStorage copy`, err);
      result.failed.push(categoryKey);
    }
  }

  if (result.migrated.length > 0) {
    console.log(`[DashboardImage] Migrated ${result.migrated.length} image(s) to IndexedDB:`, result.migrated);
  }
  if (result.conflicted.length > 0) {
    console.warn(`[DashboardImage] ${result.conflicted.length} image(s) left unmigrated due to conflict:`, result.conflicted);
  }

  return result;
}
