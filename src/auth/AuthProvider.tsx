import { createContext, useContext, useEffect, useRef, useState } from 'react';
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
import { TEST_OWNER_PROFILE, TEST_OWNER_USER } from './testOwner';

export interface UserProfile {
  role: 'owner' | 'staff' | 'viewer' | 'helper';
  display_name: string | null;
  is_active: boolean;
}

export type AuthFlowState = 'normal' | 'checking-recovery' | 'recovery' | 'invalid-recovery';

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  profileLoading: boolean;
  authFlow: AuthFlowState;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  setNewPassword: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

interface AuthProviderProps {
  children: React.ReactNode;
  authClient?: SupabaseClient;
  navigateAuth?: (path: string) => void;
}

const RECOVERY_PATH = '/auth/recovery';
const defaultAuthNavigation = (path: string): void => window.location.replace(path);
const AuthContext = createContext<AuthContextType | undefined>(undefined);

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
          } finally {
            clearStoredSupabaseAuthToken();
            clearRecoverySession();
            clearCloudLoginIntent();
            clearManualLocalEntry();
            setProviderMode('local');
            if (!active) return;
            profileRequestId += 1;
            setUser(null);
            setProfile(null);
            setProfileLoading(false);
            setAuthFlow('normal');
            setLoading(false);
            const loginPath = '/login?reason=session_expired';
            if (`${window.location.pathname}${window.location.search}` !== loginPath) {
              redirect(loginPath);
            }
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

      if (onRecoveryRoute) {
        profileRequestId += 1;
        setProviderMode('local');
        setUser(currentUser);
        setProfile(null);
        setProfileLoading(false);
        setAuthFlow(hasRecoverySession() ? 'recovery' : 'invalid-recovery');
        setLoading(false);
        return;
      }

      clearRecoverySession();
      setAuthFlow('normal');
      hadAuthenticatedSessionRef.current = true;
      const loginIntent = consumeCloudLoginIntent();
      const preserveManualLocal = isInitialResolution && consumeManualLocalEntry();
      if (loginIntent || (isInitialResolution && !preserveManualLocal)) setProviderMode('cloud');

      setUser(currentUser);
      const shouldFetchProfile = getProviderMode() === 'cloud' || getProviderMode() === 'fallback';
      setProfileLoading(shouldFetchProfile);
      if (isInitialResolution) setLoading(true);
      const requestId = ++profileRequestId;

      window.setTimeout(() => {
        const request = shouldFetchProfile ? fetchProfile(currentUser.id) : Promise.resolve(null);
        void request.then(nextProfile => {
          if (!active || requestId !== profileRequestId) return;
          setProfile(nextProfile);
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

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
