import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import {
  clearStoredSupabaseAuthToken,
  hasStoredSupabaseAuthToken,
  initialSupabaseAuthStorageState,
  supabase,
} from '../providers/cloud/supabaseClient';
import {
  clearManualLocalEntry,
  consumeManualLocalEntry,
  getProviderMode,
  isSandboxProviderMode,
  setProviderMode,
} from '../providers/providerMode';
import {
  clearCloudLoginIntent,
  clearRecoverySession,
  consumeCloudLoginIntent,
  hasRecoverySession,
  markCloudLoginIntent,
  markRecoverySession,
} from './authRecoveryState';
import { AuthContext } from './authContext';
import type { AuthFlowState, UserProfile } from './authContext';
import { TEST_OWNER_PROFILE, TEST_OWNER_USER } from './testOwner';

interface AuthProviderProps {
  children: React.ReactNode;
  authClient?: SupabaseClient;
  navigateAuth?: (path: string) => void;
}

const RECOVERY_PATH = '/auth/recovery';
const defaultAuthNavigation = (path: string): void => window.location.replace(path);

const stableJson = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => (
  nested && typeof nested === 'object' && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : nested
));

/** Same account and no field of the User changed (key order is not a change). */
const isSameAuthUser = (previous: User | null, next: User): boolean => (
  previous !== null && previous.id === next.id && stableJson(previous) === stableJson(next)
);

const isSameProfile = (previous: UserProfile | null, next: UserProfile | null): boolean => (
  previous === next || (previous !== null && next !== null && stableJson(previous) === stableJson(next))
);

export function AuthProvider({ children, authClient, navigateAuth }: AuthProviderProps) {
  const client = authClient ?? supabase;
  const redirect = navigateAuth ?? defaultAuthNavigation;
  const isSandboxMode = isSandboxProviderMode();
  const startsOnRecoveryRoute = typeof window !== 'undefined' && window.location.pathname === RECOVERY_PATH;
  const [user, setUser] = useState<User | null>(() => isSandboxMode ? TEST_OWNER_USER : null);
  const [profile, setProfile] = useState<UserProfile | null>(() => isSandboxMode ? TEST_OWNER_PROFILE : null);
  const [loading, setLoading] = useState(() => !isSandboxMode);
  const [profileLoading, setProfileLoading] = useState(false);
  const [authFlow, setAuthFlow] = useState<AuthFlowState>(() => startsOnRecoveryRoute ? 'checking-recovery' : 'normal');
  const explicitSignOutRef = useRef(false);
  const sessionRecoveryStartedRef = useRef(false);
  const hadAuthenticatedSessionRef = useRef(false);
  // P0-1: account of the last normal (non-recovery) signed-in event; null after any other state.
  const signedInUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (isSandboxMode) return;

    let active = true;
    let profileRequestId = 0;
    let initialAuthResolved = false;

    const fetchProfile = async (userId: string): Promise<UserProfile | null> => {
      if (getProviderMode() === 'local' || isSandboxProviderMode()) return null;
      try {
        const { data, error } = await client
          .from('profiles')
          .select('role, display_name, is_active')
          .eq('user_id', userId)
          .single();
        if (error) {
          console.error('Error fetching user profile:', error);
          return null;
        }
        return data as UserProfile;
      } catch (error) {
        console.error('Failed to load profile:', error);
        return null;
      }
    };

    const recoverExpiredLocalSession = () => {
      if (sessionRecoveryStartedRef.current) return;
      sessionRecoveryStartedRef.current = true;
      window.setTimeout(() => {
        void (async () => {
          try {
            await client.auth.signOut({ scope: 'local' });
          } catch (error) {
            if (import.meta.env.DEV) console.debug('[Auth] Local session cleanup fallback:', error);
          }
          clearStoredSupabaseAuthToken();
          clearRecoverySession();
          clearCloudLoginIntent();
          clearManualLocalEntry();
          setProviderMode('local');
          if (!active) return;
          profileRequestId += 1;
          signedInUserIdRef.current = null;
          setUser(null);
          setProfile(null);
          setProfileLoading(false);
          setAuthFlow('normal');
          setLoading(false);
          const loginPath = '/login?reason=session_expired';
          if (`${window.location.pathname}${window.location.search}` !== loginPath) {
            redirect(loginPath);
          }
        })();
      }, 0);
    };

    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      const currentUser = session?.user ?? null;
      const isInitialResolution = !initialAuthResolved;
      initialAuthResolved = true;
      const onRecoveryRoute = window.location.pathname === RECOVERY_PATH;

      if (event === 'PASSWORD_RECOVERY' && currentUser) {
        markRecoverySession();
        clearCloudLoginIntent();
        setProviderMode('local');
        profileRequestId += 1;
        signedInUserIdRef.current = null;
        setUser(currentUser);
        setProfile(null);
        setProfileLoading(false);
        setAuthFlow('recovery');
        setLoading(false);
        if (!onRecoveryRoute) redirect(RECOVERY_PATH);
        return;
      }

      if (!currentUser) {
        const hadStoredAuthAtStartup = initialSupabaseAuthStorageState !== 'none';
        const authTokenIsNowMissing = !hasStoredSupabaseAuthToken();
        const hasUnrecoverableInitialSession = event === 'INITIAL_SESSION'
          && (initialSupabaseAuthStorageState === 'corrupt' || (hadStoredAuthAtStartup && authTokenIsNowMissing));
        const lostAuthenticatedSession = event === 'SIGNED_OUT'
          && authTokenIsNowMissing
          && (hadStoredAuthAtStartup || hadAuthenticatedSessionRef.current);

        if (onRecoveryRoute) clearRecoverySession();
        profileRequestId += 1;
        setProviderMode('local');
        signedInUserIdRef.current = null;
        setUser(null);
        setProfile(null);
        setProfileLoading(false);
        setAuthFlow(onRecoveryRoute ? 'invalid-recovery' : 'normal');
        setLoading(false);

        if (!explicitSignOutRef.current && (hasUnrecoverableInitialSession || lostAuthenticatedSession)) {
          recoverExpiredLocalSession();
        }
        return;
      }

      if (hasRecoverySession()) {
        profileRequestId += 1;
        setProviderMode('local');
        signedInUserIdRef.current = null;
        setUser(currentUser);
        setProfile(null);
        setProfileLoading(false);
        setAuthFlow('recovery');
        setLoading(false);
        if (!onRecoveryRoute) redirect(RECOVERY_PATH);
        return;
      }

      if (onRecoveryRoute) {
        profileRequestId += 1;
        setProviderMode('local');
        signedInUserIdRef.current = null;
        setUser(currentUser);
        setProfile(null);
        setProfileLoading(false);
        setAuthFlow('invalid-recovery');
        setLoading(false);
        return;
      }

      clearRecoverySession();
      setAuthFlow('normal');
      hadAuthenticatedSessionRef.current = true;
      const loginIntent = consumeCloudLoginIntent();
      const preserveManualLocal = isInitialResolution && consumeManualLocalEntry();
      if (loginIntent || (isInitialResolution && !preserveManualLocal)) setProviderMode('cloud');

      // P0-1: Supabase Auth re-emits SIGNED_IN / TOKEN_REFRESHED for the same account (e.g. on
      // every hidden -> visible tab transition) with a freshly parsed User object. Keep the
      // existing reference when nothing in the User changed, so consumers keyed on it do not
      // rebuild. A different account, or a real change to the same account, still replaces it;
      // the profile (role/permissions) is still re-read below for every event.
      const sameSignedInUser = signedInUserIdRef.current === currentUser.id;
      signedInUserIdRef.current = currentUser.id;
      setUser(previous => isSameAuthUser(previous, currentUser) ? previous : currentUser);
      const shouldFetchProfile = getProviderMode() === 'cloud' || getProviderMode() === 'fallback';
      // A same-account re-read refreshes permissions in the background; it does not flip the
      // whole UI back into a profile-loading state.
      if (!sameSignedInUser || isInitialResolution) setProfileLoading(shouldFetchProfile);
      if (isInitialResolution) setLoading(true);
      const requestId = ++profileRequestId;

      window.setTimeout(() => {
        const request = shouldFetchProfile ? fetchProfile(currentUser.id) : Promise.resolve(null);
        void request.then(nextProfile => {
          if (!active || requestId !== profileRequestId) return;
          setProfile(previous => isSameProfile(previous, nextProfile) ? previous : nextProfile);
        }).finally(() => {
          if (!active || requestId !== profileRequestId) return;
          setProfileLoading(false);
          setLoading(false);
        });
      }, 0);

      if (import.meta.env.DEV) console.debug(`[Auth] ${event}: session restored for ${currentUser.id}`);
    });

    return () => {
      active = false;
      profileRequestId += 1;
      subscription.unsubscribe();
    };
  }, [client, isSandboxMode, redirect]);

  const signInWithPassword = async (email: string, password: string): Promise<void> => {
    markCloudLoginIntent();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || (!data.session && !data.user)) {
      clearCloudLoginIntent();
      throw error ?? new Error('AUTH_SESSION_MISSING');
    }
    setProviderMode('cloud');
  };

  const requestPasswordReset = async (email: string): Promise<void> => {
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${RECOVERY_PATH}`,
    });
    if (error) throw error;
  };

  const setNewPassword = async (password: string): Promise<void> => {
    if (authFlow !== 'recovery' || !user || !hasRecoverySession()) {
      throw new Error('PASSWORD_RECOVERY_SESSION_REQUIRED');
    }
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;

    explicitSignOutRef.current = true;
    const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
    if (signOutError) clearStoredSupabaseAuthToken();
    clearRecoverySession();
    clearCloudLoginIntent();
    clearManualLocalEntry();
    setProviderMode('local');
    signedInUserIdRef.current = null;
    setUser(null);
    setProfile(null);
    setAuthFlow('normal');
    redirect('/login?reason=password_updated');
  };

  const signOut = async (): Promise<void> => {
    clearRecoverySession();
    clearCloudLoginIntent();
    clearManualLocalEntry();
    if (isSandboxMode) {
      setProviderMode('local');
      window.location.reload();
      return;
    }

    explicitSignOutRef.current = true;
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) clearStoredSupabaseAuthToken();
    signedInUserIdRef.current = null;
    setUser(null);
    setProfile(null);
    setProviderMode('local');
    redirect('/dashboard');
  };

  return (
    <AuthContext.Provider value={{
      user,
      profile,
      loading,
      profileLoading,
      authFlow,
      signInWithPassword,
      requestPasswordReset,
      setNewPassword,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
