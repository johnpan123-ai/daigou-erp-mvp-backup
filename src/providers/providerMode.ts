export type ProviderMode = 'local' | 'cloud' | 'fallback';

export const PROVIDER_MODE_KEY = 'erp_provider_mode';

let hasLoggedLoad = false;

export function getProviderMode(): ProviderMode {
  const mode = localStorage.getItem(PROVIDER_MODE_KEY);
  
  if (mode === 'cloud' || mode === 'fallback' || mode === 'local') {
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

export function setProviderMode(mode: ProviderMode): void {
  localStorage.setItem(PROVIDER_MODE_KEY, mode);
  console.log(`[Provider Mode] changed: ${mode === 'fallback' ? 'cloud' : mode}`);
}

export function isCloudEnabled(): boolean {
  return true;
}
