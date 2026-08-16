import { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  clearStoredSupabaseAuthToken,
  hasStoredSupabaseAuthToken,
  initialSupabaseAuthStorageState,
  supabase,
} from '../providers/cloud/supabaseClient';
import { getProviderMode, isSandboxProviderMode, setProviderMode } from '../providers/providerMode';
import type { User } from '@supabase/supabase-js';
import { TEST_OWNER_PROFILE, TEST_OWNER_USER } from './testOwner';

export interface UserProfile {
  role: 'owner' | 'staff' | 'viewer' | 'helper';
  display_name: string | null;
  is_active: boolean;
}

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  profileLoading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const isSandboxMode = isSandboxProviderMode();
  const [user, setUser] = useState<User | null>(() => isSandboxMode ? TEST_OWNER_USER : null);
  const [profile, setProfile] = useState<UserProfile | null>(() => isSandboxMode ? TEST_OWNER_PROFILE : null);
  const [loading, setLoading] = useState(() => !isSandboxMode);
  const [profileLoading, setProfileLoading] = useState(false);
  const explicitSignOutRef = useRef(false);
  const sessionRecoveryStartedRef = useRef(false);
  const hadAuthenticatedSessionRef = useRef(false);

  const fetchProfile = async (userId: string): Promise<UserProfile | null> => {
    // Local and Test modes never read the Production profiles table.
    if (getProviderMode() === 'local' || isSandboxProviderMode()) {
      return null;
    }

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('role, display_name, is_active')
        .eq('user_id', userId)
        .single();
      
      if (error) {
        console.error('Error fetching user profile:', error);
        return null;
      } else {
        return data as UserProfile;
      }
    } catch (err) {
      console.error('Failed to load profile:', err);
      return null;
    }
  };

  useEffect(() => {
    // Test Sandbox uses a fully local identity and must never initialize or
    // subscribe to the Production Supabase Auth session.
    if (isSandboxMode) return;

    let active = true;
    let profileRequestId = 0;
    let initialAuthResolved = false;

    const recoverExpiredLocalSession = () => {
      if (sessionRecoveryStartedRef.current) return;
      sessionRecoveryStartedRef.current = true;

      // Auth callbacks run while Supabase holds its auth lock. Defer sign-out
      // until after the callback returns to avoid lock contention.
      window.setTimeout(() => {
        void (async () => {
          try {
            await supabase.auth.signOut({ scope: 'local' });
          } catch (error) {
            if (import.meta.env.DEV) {
              console.debug('[Auth] Local session cleanup fallback:', error);
            }
          } finally {
            // Precise fallback only: never clear ERP localStorage or IndexedDB.
            clearStoredSupabaseAuthToken();

            if (!active) return;
            profileRequestId++;
            setUser(null);
            setProfile(null);
            setProfileLoading(false);
            setLoading(false);

            const loginPath = '/login?reason=session_expired';
            if (`${window.location.pathname}${window.location.search}` !== loginPath) {
              window.location.replace(loginPath);
            }
          }
        })();
      }, 0);
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;

      const currentUser = session?.user ?? null;
      const isInitialResolution = !initialAuthResolved;
      initialAuthResolved = true;

      if (!currentUser) {
        const hadStoredAuthAtStartup = initialSupabaseAuthStorageState !== 'none';
        const authTokenIsNowMissing = !hasStoredSupabaseAuthToken();
        const hasUnrecoverableInitialSession = (
          event === 'INITIAL_SESSION'
          && (
            initialSupabaseAuthStorageState === 'corrupt'
            || (hadStoredAuthAtStartup && authTokenIsNowMissing)
          )
        );
        const lostAuthenticatedSession = (
          event === 'SIGNED_OUT'
          && authTokenIsNowMissing
          && (hadStoredAuthAtStartup || hadAuthenticatedSessionRef.current)
        );

        profileRequestId++;
        setUser(null);
        setProfile(null);
        setProfileLoading(false);
        setLoading(false);

        if (
          !explicitSignOutRef.current
          && (hasUnrecoverableInitialSession || lostAuthenticatedSession)
        ) {
          recoverExpiredLocalSession();
        }
        return;
      }

      hadAuthenticatedSessionRef.current = true;
      setUser(currentUser);
      setProfileLoading(true);
      if (isInitialResolution) setLoading(true);

      const requestId = ++profileRequestId;
      // Supabase auth callbacks run while an auth lock is held. Defer the
      // profile query until after the callback returns to avoid lock contention.
      window.setTimeout(() => {
        void fetchProfile(currentUser.id).then(nextProfile => {
          if (!active || requestId !== profileRequestId) return;
          setProfile(nextProfile);
        }).finally(() => {
          if (!active || requestId !== profileRequestId) return;
          setProfileLoading(false);
          setLoading(false);
        });
      }, 0);

      if (import.meta.env.DEV) {
        console.debug(`[Auth] ${event}: session restored for ${currentUser.id}`);
      }
    });

    return () => {
      active = false;
      profileRequestId++;
      subscription.unsubscribe();
    };
  }, [isSandboxMode]);

  const signOut = async () => {
    if (isSandboxMode) {
      console.log('[Provider Mode] leave Sandbox, switch to local');
      setProviderMode('local');
      window.location.reload();
      return;
    }

    console.log('[Provider Mode] explicit logout, switch to local');
    explicitSignOutRef.current = true;
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) {
      clearStoredSupabaseAuthToken();
    }
    setProfile(null);
    setProviderMode('local');
    window.location.reload();
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, profileLoading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

