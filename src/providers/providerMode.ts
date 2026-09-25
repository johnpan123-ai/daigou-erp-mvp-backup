export type ProviderMode = 'local' | 'cloud' | 'fallback' | 'test' | 'next' | 'experimental';

export const PROVIDER_MODE_KEY = 'erp_provider_mode';
const MANUAL_LOCAL_ENTRY_KEY = 'erp_manual_local_entry_once';

let hasLoggedLoad = false;

export function getProviderMode(): ProviderMode {
  const mode = localStorage.getItem(PROVIDER_MODE_KEY);
  
  if (mode === 'cloud' || mode === 'fallback' || mode === 'local' || mode === 'test' || mode === 'next' || mode === 'experimental') {
    if (!hasLoggedLoad) {
      console.log(`[Provider Mode] loaded: ${mode === 'fallback' ? 'cloud' : mode}`);
      hasLoggedLoad = true;
    }
    return mode;
  }
  
  // If invalid value (not set is fine, but any other value is invalid)
  if (mode !== null) {
    console.log('[Provider Mode] invalid value fallback: local');
    localStorage.setItem(PROVIDER_MODE_KEY, 'local');
  }
  
  if (!hasLoggedLoad) {
    console.log('[Provider Mode] loaded: local');
    hasLoggedLoad = true;
  }
  return 'local';
}

export function markManualLocalEntry(): void {
  sessionStorage.setItem(MANUAL_LOCAL_ENTRY_KEY, 'true');
}

export function consumeManualLocalEntry(): boolean {
  const requested = sessionStorage.getItem(MANUAL_LOCAL_ENTRY_KEY) === 'true';
  sessionStorage.removeItem(MANUAL_LOCAL_ENTRY_KEY);
  return requested;
}

export function clearManualLocalEntry(): void {
  sessionStorage.removeItem(MANUAL_LOCAL_ENTRY_KEY);
}

export function setProviderMode(mode: ProviderMode): boolean {
  const currentMode = getProviderMode();
  if (currentMode === 'test' && (mode === 'cloud' || mode === 'fallback')) {
    const firstConfirmed = window.confirm(
      '即將切換至正式模式，接下來的新增、修改與刪除會影響正式營運資料。'
    );
    if (!firstConfirmed) return false;

    const secondConfirmed = window.confirm(
      '請再次確認：切換後所有操作都可能修改正式資料。確定要進入正式模式嗎？'
    );
    if (!secondConfirmed) return false;
  }

  localStorage.setItem(PROVIDER_MODE_KEY, mode);
  console.log(`[Provider Mode] changed: ${mode === 'fallback' ? 'cloud' : mode}`);
  return true;
}

export function isCloudEnabled(): boolean {
  return true;
}

export function isSandboxProviderMode(mode: ProviderMode = getProviderMode()): boolean {
  return mode === 'test' || mode === 'next' || mode === 'experimental';
}
