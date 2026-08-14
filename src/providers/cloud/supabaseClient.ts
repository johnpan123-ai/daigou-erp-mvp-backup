import { createClient } from '@supabase/supabase-js';
import { createGuardedSupabaseFetch } from '../../lib/cloudWriteGuard';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const isTestModeAtStartup = typeof window !== 'undefined'
  && window.localStorage.getItem('erp_provider_mode') === 'test';

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
  if (isTestModeAtStartup) return 'none';
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
  !isTestModeAtStartup
  && typeof window !== 'undefined'
  && Boolean(supabaseAuthStorageKey)
  && window.localStorage.getItem(supabaseAuthStorageKey as string) !== null
);

export const clearStoredSupabaseAuthToken = (): void => {
  if (isTestModeAtStartup) return;
  if (typeof window === 'undefined' || !supabaseAuthStorageKey) return;

  // Remove only Supabase Auth state for this browser origin. ERP data and
  // IndexedDB caches must remain untouched.
  window.localStorage.removeItem(supabaseAuthStorageKey);
  window.localStorage.removeItem(`${supabaseAuthStorageKey}-code-verifier`);
  window.localStorage.removeItem(`${supabaseAuthStorageKey}-user`);
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: isTestModeAtStartup ? {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  } : undefined,
  global: {
    fetch: createGuardedSupabaseFetch(supabaseUrl),
  },
});
