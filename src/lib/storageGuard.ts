type StorageWarningListener = (warning: string | null) => void;

const listeners = new Set<StorageWarningListener>();
let currentWarning: string | null = null;

export function onStorageWarning(listener: StorageWarningListener): () => void {
  listeners.add(listener);
  if (currentWarning) listener(currentWarning);
  return () => { listeners.delete(listener); };
}

export function getStorageWarning(): string | null {
  return currentWarning;
}

function emitWarning(message: string): void {
  if (currentWarning === message) return;
  currentWarning = message;
  listeners.forEach(fn => fn(message));
}

export function clearStorageWarning(): void {
  currentWarning = null;
  listeners.forEach(fn => fn(null));
}

export function isQuotaExceededError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.code === 22
      || err.name === 'QuotaExceededError'
      || err.name === 'NS_ERROR_DOM_QUOTA_REACHED';
  }
  return false;
}

const TEST_KEY = '__erp_storage_probe__';

export function checkLocalStorageWritable(reserveBytes: number = 12288): boolean {
  try {
    const payload = 'x'.repeat(reserveBytes);
    localStorage.setItem(TEST_KEY, payload);
    localStorage.removeItem(TEST_KEY);
    return true;
  } catch (err) {
    try { localStorage.removeItem(TEST_KEY); } catch { /* storage may be entirely inaccessible */ }

    if (isQuotaExceededError(err)) {
      emitWarning(
        '瀏覽器儲存空間不足，本機資料或登入狀態可能無法保存。' +
        '請勿繼續大量編輯，並聯絡管理員處理。'
      );
    } else {
      emitWarning(
        '瀏覽器儲存無法使用，本機資料或登入狀態可能無法保存。' +
        '請確認瀏覽器設定允許網站儲存資料，或聯絡管理員處理。'
      );
    }
    return false;
  }
}

export function reportStorageWriteFailure(key: string, err: unknown): void {
  const isQuota = isQuotaExceededError(err);
  const reason = isQuota ? '儲存空間不足' : '寫入失敗';
  console.error(`[Storage] ${reason} (key=${key})`, err);

  if (isQuota) {
    emitWarning(
      '瀏覽器儲存空間不足，本機資料或登入狀態可能無法保存。' +
      '請勿繼續大量編輯，並聯絡管理員處理。'
    );
  } else {
    emitWarning(
      '瀏覽器儲存無法使用，本機資料或登入狀態可能無法保存。' +
      '請確認瀏覽器設定允許網站儲存資料，或聯絡管理員處理。'
    );
  }
}
