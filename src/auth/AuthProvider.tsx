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
      setLoading(false);

      const currentMode = getProviderMode();
      if (!currentUser && (currentMode === 'cloud' || currentMode === 'fallback')) {
        console.log('[Provider Mode] blocked: login required');
        setProviderMode('local');
        window.location.reload();
        return;
      }

      if (currentUser) {
        if (currentMode === 'local') {
          console.log('[Provider Mode] auto switched to cloud mode after login');
          setProviderMode('cloud');
          window.location.reload();
          return;
        }
        fetchProfile(currentUser.id);
      } else {
        setProfile(null);
        setProfileLoading(false);
      }
    });

    // Listen for authentication changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      setLoading(false);

      const currentMode = getProviderMode();
      if (!currentUser && (currentMode === 'cloud' || currentMode === 'fallback')) {
        console.log('[Provider Mode] blocked: login required');
        setProviderMode('local');
        window.location.reload();
        return;
      }

      if (currentUser) {
        if (currentMode === 'local') {
          console.log('[Provider Mode] auto switched to cloud mode after login');
          setProviderMode('cloud');
          window.location.reload();
          return;
        }
        fetchProfile(currentUser.id);
      } else {
        setProfile(null);
        setProfileLoading(false);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
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

