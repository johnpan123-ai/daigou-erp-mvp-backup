import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../providers/cloud/supabaseClient';
import { getProviderMode, setProviderMode } from '../providers/providerMode';
import type { User } from '@supabase/supabase-js';

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

function hasStoredSupabaseSession(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
        return true;
      }
    }
  } catch (e) {
    console.error('Error checking localStorage:', e);
  }
  return false;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [authPending, setAuthPending] = useState(false);

  useEffect(() => {
    if (authPending) {
      const timer = setTimeout(() => {
        console.warn('[Auth] token refresh timed out after 2h, staying in cloud read-only');
        setAuthPending(false);
        setLoading(false);
      }, 2 * 60 * 60 * 1000);
      return () => clearTimeout(timer);
    }
  }, [authPending]);

  // Safety timeout: Ensure loading is set to false after 4 seconds regardless of auth status
  useEffect(() => {
    if (loading) {
      const timer = setTimeout(() => {
        console.warn('[AuthProvider] Safety timeout: Force loading to false to prevent page hang');
        setLoading(false);
        setAuthPending(false);
      }, 4000); // 4 seconds safety timeout
      return () => clearTimeout(timer);
    }
  }, [loading]);

  const fetchProfile = async (userId: string) => {
    // Only query database if not in pure local mode
    if (getProviderMode() === 'local') {
      setProfile(null);
      setProfileLoading(false);
      return;
    }

    setProfileLoading(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('role, display_name, is_active')
        .eq('user_id', userId)
        .single();
      
      if (error) {
        console.error('Error fetching user profile:', error);
        setProfile(null);
      } else {
        setProfile(data as UserProfile);
      }
    } catch (err) {
      console.error('Failed to load profile:', err);
      setProfile(null);
    } finally {
      setProfileLoading(false);
    }
  };

  useEffect(() => {
    // Check active sessions on load
    supabase.auth.getSession().then(({ data: { session } }) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      const currentMode = getProviderMode();
      if (!currentUser && (currentMode === 'cloud' || currentMode === 'fallback')) {
        if (hasStoredSupabaseSession()) {
          console.log('[Provider Mode] auth pending, do not fallback local');
          setAuthPending(true);
          setLoading(true); // Keep loading spinner active
          return;
        } else {
          console.log('[Provider Mode] no stored session, staying in cloud read-only mode');
          setLoading(false);
          setProfile(null);
          setProfileLoading(false);
          return;
        }
      }

      setLoading(false);

      if (currentUser) {
        setAuthPending(false);
        fetchProfile(currentUser.id);
      } else {
        setProfile(null);
        setProfileLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const currentUser = session?.user ?? null;

      if (event === 'SIGNED_OUT') {
        console.log('[Auth] explicit SIGNED_OUT event');
        setUser(null);
        setProfile(null);
        setProfileLoading(false);
        setAuthPending(false);
        setLoading(false);
        return;
      }

      if (currentUser) {
        setUser(currentUser);
        setAuthPending(false);
        setLoading(false);
        fetchProfile(currentUser.id);
        return;
      }

      // null session on a non-SIGNED_OUT event (e.g. TOKEN_REFRESHED failure,
      // network hiccup while tab is in background). Keep the previous user state
      // so the UI doesn't flash to logged-out during transient failures.
      const currentMode = getProviderMode();
      if (currentMode === 'cloud' || currentMode === 'fallback') {
        if (hasStoredSupabaseSession()) {
          console.log(`[Auth] ${event} with null session but stored token exists, keeping current state`);
          return;
        }
        console.log(`[Auth] ${event} with null session, no stored token, staying cloud read-only`);
        setLoading(false);
        setProfile(null);
        setProfileLoading(false);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    console.log('[Provider Mode] explicit logout, switch to local');
    await supabase.auth.signOut();
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

