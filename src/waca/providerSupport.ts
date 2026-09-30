import type { ProviderMode } from '../providers/providerMode';
import { STAGING_SUPABASE_PROJECT_REF } from '../lib/supabaseEnvironmentBoundary';

// Availability follows the existing ledger providers, not the build label.
export function supportsWacaProvider(mode: ProviderMode, cloudProjectRef: string): boolean {
  return mode === 'next' || ((mode === 'cloud' || mode === 'fallback')
    && cloudProjectRef === STAGING_SUPABASE_PROJECT_REF);
}
