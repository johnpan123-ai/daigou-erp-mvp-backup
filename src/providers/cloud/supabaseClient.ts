import { createClient } from '@supabase/supabase-js';
import { createGuardedSupabaseFetch } from '../../lib/cloudWriteGuard';
import {
  PRODUCTION_SUPABASE_PROJECT_REF,
  STAGING_SUPABASE_PROJECT_REF,
  assertSupabaseEnvironmentBoundary,
  buildSupabaseProjectUrl,
  parseSupabaseProjectRef,
} from '../../lib/supabaseEnvironmentBoundary';
import { getProviderMode, isSandboxProviderMode } from '../providerMode';

const providerModeAtStartup = typeof window === 'undefined' ? null : getProviderMode();
const configuredSupabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const isLegacyTestRuntimeWithProductionConfig = providerModeAtStartup === 'test'
  && (() => {
    try {
      return parseSupabaseProjectRef(configuredSupabaseUrl) === PRODUCTION_SUPABASE_PROJECT_REF;
    } catch {
      return false;
    }
  })();
// Older isolated browser tests start in Vite development mode before selecting
// the Test provider. Never construct a Production client for that runtime.
const supabaseUrl = isLegacyTestRuntimeWithProductionConfig
  ? buildSupabaseProjectUrl(STAGING_SUPABASE_PROJECT_REF)
  : configuredSupabaseUrl;
const supabaseAnonKey = isLegacyTestRuntimeWithProductionConfig
  ? 'isolated-test-no-network'
  : import.meta.env.VITE_SUPABASE_ANON_KEY || '';
export const supabaseEnvironment = assertSupabaseEnvironmentBoundary({
  supabaseUrl,
  viteMode: import.meta.env.MODE,
  sandboxEnvironment: import.meta.env.VITE_SANDBOX_ENV,
  deploymentEnvironment: import.meta.env.VITE_DEPLOYMENT_ENV,
  cloudPreviewEnabled: import.meta.env.VITE_CLOUD_REALTIME_PREVIEW === 'true',
  providerMode: providerModeAtStartup,
});
const isSandboxModeAtStartup = typeof window !== 'undefined'
  && isSandboxProviderMode(providerModeAtStartup ?? undefined);

const getDefaultAuthStorageKey = (): string | null => {
  if (!supabaseUrl) return null;

  try {
    const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
    return projectRef ? `sb-${projectRef}-auth-token` : null;
  } catch {
    return null;
  }
};

export const supabaseAuthStorageKey = getDefaultAuthStorageKey();

export const initialSupabaseAuthStorageState: 'none' | 'present' | 'corrupt' = (() => {
  if (isSandboxModeAtStartup) return 'none';
  if (typeof window === 'undefined' || !supabaseAuthStorageKey) return 'none';

  const storedValue = window.localStorage.getItem(supabaseAuthStorageKey);
  if (storedValue === null) return 'none';

  try {
    const parsedValue = JSON.parse(storedValue);
    return parsedValue && typeof parsedValue === 'object' ? 'present' : 'corrupt';
  } catch {
    return 'corrupt';
  }
})();

export const hasStoredSupabaseAuthToken = (): boolean => (
  !isSandboxModeAtStartup
  && typeof window !== 'undefined'
  && Boolean(supabaseAuthStorageKey)
  && window.localStorage.getItem(supabaseAuthStorageKey as string) !== null
);

export const clearStoredSupabaseAuthToken = (): void => {
  if (isSandboxModeAtStartup) return;
  if (typeof window === 'undefined' || !supabaseAuthStorageKey) return;

  // Remove only Supabase Auth state for this browser origin. ERP data and
  // IndexedDB caches must remain untouched.
  window.localStorage.removeItem(supabaseAuthStorageKey);
  window.localStorage.removeItem(`${supabaseAuthStorageKey}-code-verifier`);
  window.localStorage.removeItem(`${supabaseAuthStorageKey}-user`);
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: isSandboxModeAtStartup ? {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  } : undefined,
  global: {
    fetch: createGuardedSupabaseFetch(supabaseUrl),
  },
});
