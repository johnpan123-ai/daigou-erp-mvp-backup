import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import type { AuthChangeEvent, Session, SupabaseClient, User } from '@supabase/supabase-js';
import { AuthProvider, useAuth } from '../../src/auth/AuthProvider';
import { useRole } from '../../src/auth/useRole';
import { ViewportProvider } from '../../src/contexts/ViewportContext';
import { AppLayout } from '../../src/components/layout/AppLayout';
import Login from '../../src/pages/Login';
import PasswordRecovery from '../../src/pages/PasswordRecovery';
import { getProviderMode, markManualLocalEntry, setProviderMode } from '../../src/providers/providerMode';
import '../../src/index.css';

const SESSION_KEY = 'p0_5_fixture_session';
const PASSWORD_KEY = 'p0_5_fixture_password';
const TEST_USER = {
  id: '50000000-0000-4000-8000-000000000005',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'p0-5-editor@staging.invalid',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  created_at: '2026-09-08T00:00:00.000Z',
} as User;

const buildSession = (): Session => ({
  access_token: 'fixture-access-token-never-logged',
  refresh_token: 'fixture-refresh-token-never-logged',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: 'bearer',
  user: TEST_USER,
});

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;
const listeners = new Set<AuthListener>();
const emit = (event: AuthChangeEvent, session: Session | null) => {
  for (const listener of listeners) listener(event, session);
};

const fakeClient = {
  auth: {
    onAuthStateChange(listener: AuthListener) {
      listeners.add(listener);
      window.setTimeout(() => {
        const parameters = new URLSearchParams(window.location.search);
        if (window.location.pathname === '/auth/recovery' && parameters.get('fixture') === 'recovery') {
          localStorage.setItem(SESSION_KEY, 'valid');
          emit('PASSWORD_RECOVERY', buildSession());
        } else if (window.location.pathname === '/auth/recovery' && parameters.get('fixture') === 'invalid') {
          emit('INITIAL_SESSION', null);
        } else {
          emit('INITIAL_SESSION', localStorage.getItem(SESSION_KEY) === 'valid' ? buildSession() : null);
        }
      }, 0);
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    },
    async signInWithPassword({ email, password }: { email: string; password: string }) {
      if (email === 'network@staging.invalid') throw new TypeError('Failed to fetch');
      const expectedPassword = localStorage.getItem(PASSWORD_KEY) ?? 'ValidPassword123!';
      if (email !== TEST_USER.email || password !== expectedPassword) {
        return { data: { user: null, session: null }, error: { message: 'Invalid login credentials', status: 400 } };
      }
      localStorage.setItem(SESSION_KEY, 'valid');
      const session = buildSession();
      emit('SIGNED_IN', session);
      return { data: { user: TEST_USER, session }, error: null };
    },
    async resetPasswordForEmail(_email: string, options: { redirectTo?: string }) {
      window.__P0_5_AUTH_HARNESS__.resetRedirect = options.redirectTo ?? null;
      return { data: {}, error: null };
    },
    async updateUser({ password }: { password?: string }) {
      if (!password || password.length < 8) return { data: { user: null }, error: { message: 'Password should be at least 8 characters' } };
      localStorage.setItem(PASSWORD_KEY, password);
      emit('USER_UPDATED', buildSession());
      return { data: { user: TEST_USER }, error: null };
    },
    async signOut() {
      localStorage.removeItem(SESSION_KEY);
      emit('SIGNED_OUT', null);
      return { error: null };
    },
  },
  from(table: string) {
    return {
      select() {
        return {
          eq() {
            return {
              async single() {
                if (table !== 'profiles') return { data: null, error: { message: 'fixture table blocked' } };
                return { data: { role: 'owner', display_name: 'Staging Editor', is_active: true }, error: null };
              },
            };
          },
        };
      },
    };
  },
} as unknown as SupabaseClient;

function AuthDashboard() {
  const { user, profile, loading, authFlow, signOut } = useAuth();
  const { canEdit } = useRole();
  const navigate = useNavigate();
  const switchLocal = () => {
    markManualLocalEntry();
    setProviderMode('local');
    navigate('/dashboard?mode=local', { replace: true });
  };
  const switchCloud = () => {
    setProviderMode('cloud');
    navigate('/dashboard?mode=cloud', { replace: true });
  };

  return (
    <section data-testid="auth-dashboard">
      <h1>P0-5 Auth Acceptance</h1>
      <div data-testid="auth-loading">{String(loading)}</div>
      <div data-testid="auth-user">{user?.email ?? 'none'}</div>
      <div data-testid="auth-role">{profile?.role ?? 'none'}</div>
      <div data-testid="editor-check">{String(canEdit())}</div>
      <div data-testid="auth-flow">{authFlow}</div>
      <div data-testid="provider-mode">{getProviderMode()}</div>
      <div data-testid="local-sentinel">{localStorage.getItem('p0_5_local_sentinel')}</div>
      <div data-testid="cloud-sentinel">{localStorage.getItem('p0_5_cloud_sentinel')}</div>
      <button type="button" onClick={switchLocal}>測試切到本地</button>
      <button type="button" onClick={switchCloud}>測試切到雲端</button>
      <button type="button" onClick={() => void signOut()}>測試登出</button>
      <button type="button" onClick={() => {
        localStorage.removeItem(SESSION_KEY);
        emit('SIGNED_OUT', null);
      }}>模擬 Session 過期</button>
    </section>
  );
}

const navigateAuth = (path: string) => {
  window.history.replaceState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
};

declare global {
  interface Window {
    __P0_5_AUTH_HARNESS__: {
      resetRedirect: string | null;
      snapshot: () => Record<string, unknown>;
    };
  }
}

window.__P0_5_AUTH_HARNESS__ = {
  resetRedirect: null,
  snapshot: () => ({
    mode: getProviderMode(),
    session: localStorage.getItem(SESSION_KEY),
    passwordSet: localStorage.hasOwnProperty(PASSWORD_KEY),
    recoveryActive: sessionStorage.getItem('erp_password_recovery_active'),
    localSentinel: localStorage.getItem('p0_5_local_sentinel'),
    cloudSentinel: localStorage.getItem('p0_5_cloud_sentinel'),
  }),
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ViewportProvider>
      <AuthProvider authClient={fakeClient} navigateAuth={navigateAuth}>
        <BrowserRouter>
          <AppLayout>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/auth/recovery" element={<PasswordRecovery />} />
              <Route path="*" element={<AuthDashboard />} />
            </Routes>
          </AppLayout>
        </BrowserRouter>
      </AuthProvider>
    </ViewportProvider>
  </React.StrictMode>,
);
