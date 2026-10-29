import type { SupabaseRuntimeRole } from './supabaseEnvironmentBoundary';
import type { ProviderMode } from '../providers/providerMode';

export function getEnvironmentModeLabel(mode: ProviderMode, runtimeRole: SupabaseRuntimeRole): string {
  if (mode === 'local') return '本地模式｜資料不會同步雲端';
  if (mode === 'cloud' || mode === 'fallback') {
    return runtimeRole === 'production' ? '雲端正式' : 'STAGING / 測試雲端';
  }
  if (mode === 'next') return 'NEXT SANDBOX';
  if (mode === 'experimental') return 'EXPERIMENTAL';
  return 'TEST SANDBOX';
}

/**
 * Label shown to ERP users. Cloud modes show the neutral mode name only: the
 * staging/production distinction stays in engineering surfaces (build identity,
 * diagnostics, logs, getEnvironmentModeLabel) and is never rendered as a
 * "正式" claim. Local/sandbox modes keep their safety wording.
 */
export function getUserFacingModeLabel(mode: ProviderMode, runtimeRole: SupabaseRuntimeRole): string {
  if (mode === 'cloud') return '雲端模式';
  if (mode === 'fallback') return '備援模式';
  return getEnvironmentModeLabel(mode, runtimeRole);
}

/** The full-width environment banner is a sandbox/local safety notice only. */
export const showsEnvironmentBanner = (mode: ProviderMode): boolean => mode !== 'cloud' && mode !== 'fallback';
