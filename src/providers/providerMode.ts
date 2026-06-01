export type ProviderMode = 'local' | 'cloud' | 'fallback';

export const PROVIDER_MODE_KEY = 'erp_provider_mode';

export function getProviderMode(): ProviderMode {
  const mode = localStorage.getItem(PROVIDER_MODE_KEY);
  if (mode === 'cloud' || mode === 'fallback' || mode === 'local') {
    return mode;
  }
  return 'local';
}

export function setProviderMode(mode: ProviderMode): void {
  localStorage.setItem(PROVIDER_MODE_KEY, mode);
}

export function isCloudEnabled(): boolean {
  return true;
}
