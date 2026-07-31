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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  const fetchProfile = async (userId: string): Promise<UserProfile | null> => {
    // Only query database if not in pure local mode
    if (getProviderMode() === 'local') {
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
    let active = true;
    let profileRequestId = 0;
    let initialAuthResolved = false;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;

      const currentUser = session?.user ?? null;
      const isInitialResolution = !initialAuthResolved;
      initialAuthResolved = true;

      if (!currentUser) {
        profileRequestId++;
        setUser(null);
        setProfile(null);
        setProfileLoading(false);
        setLoading(false);
        return;
      }

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

