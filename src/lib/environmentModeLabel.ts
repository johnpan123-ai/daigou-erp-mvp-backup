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
