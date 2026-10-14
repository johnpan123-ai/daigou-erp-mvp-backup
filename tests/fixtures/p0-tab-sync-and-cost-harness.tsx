// P0-1 / P0-2 regression harness (isolated; no network, no Supabase, no production data).
// ?part=auth : AuthProvider with a fake Auth client (Cloud mode). Same-account SIGNED_IN /
//              TOKEN_REFRESHED must keep the User reference; profile is still re-read.
// ?part=sync : CloudRealtimeSyncBoundary under a controlled AuthContext with the sandbox test
//              bridge. A new User object for the same account must not rebuild the boundary.
// ?part=cost&mode=cloud|local : PurchaseManagement with an in-memory data provider. Cloud mode
//              must not show or write back the legacy localStorage default cost.
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthChangeEvent, Session, SupabaseClient, User } from '@supabase/supabase-js';

const params = new URLSearchParams(window.location.search);
const part = params.get('part') ?? 'auth';
const costMode = params.get('mode') === 'local' ? 'local' : 'cloud';
localStorage.setItem('erp_provider_mode', part === 'sync' ? 'experimental' : part === 'cost' ? costMode : 'cloud');

const clone = <T,>(value: T): T => structuredClone(value);
const USER_A = {
  id: '5a000000-0000-4000-8000-0000000000a1', aud: 'authenticated', role: 'authenticated',
  email: 'p0-tab-a@staging.invalid', app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {}, created_at: '2026-10-14T00:00:00.000Z', updated_at: '2026-10-14T00:00:00.000Z',
} as unknown as User;
const USER_B = { ...clone(USER_A), id: '5b000000-0000-4000-8000-0000000000b2', email: 'p0-tab-b@staging.invalid' } as User;

declare global {
  interface Window { __P0TAB__: Record<string, unknown> }
}

const root = createRoot(document.getElementById('root')!);

if (part === 'auth') {
  const [{ AuthProvider }, { useAuth }] = await Promise.all([
    import('../../src/auth/AuthProvider'),
    import('../../src/auth/authContext'),
  ]);
  type Listener = (event: AuthChangeEvent, session: Session | null) => void;
  const listeners = new Set<Listener>();
  let profileRole: 'owner' | 'viewer' = 'owner';
  let profileReads = 0;
  const session = (user: User): Session => ({
    access_token: 'fixture-access-token-never-logged', refresh_token: 'fixture-refresh-token-never-logged',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user: clone(user),
  });
  const fakeClient = {
    auth: {
      onAuthStateChange(listener: Listener) {
        listeners.add(listener);
        window.setTimeout(() => listener('INITIAL_SESSION', session(USER_A)), 0);
        return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
      },
      async signOut() { return { error: null }; },
    },
    from() {
      return { select: () => ({ eq: () => ({ single: async () => {
        profileReads += 1;
        return { data: { role: profileRole, display_name: 'P0 Tab', is_active: true }, error: null };
      } }) }) };
    },
  } as unknown as SupabaseClient;

  const seen = new WeakSet<object>();
  const probe = { userIdentities: 0, userIds: [] as Array<string | null>, profileLoadingTrue: 0, role: null as string | null,
    email: null as string | null, loading: true };
  function Probe() {
    const { user, profile, profileLoading, loading } = useAuth();
    React.useEffect(() => {
      if (user && !seen.has(user)) { seen.add(user); probe.userIdentities += 1; }
      probe.userIds.push(user?.id ?? null);
      probe.email = user?.email ?? null;
    }, [user]);
    React.useEffect(() => { if (profileLoading) probe.profileLoadingTrue += 1; }, [profileLoading]);
    probe.role = profile?.role ?? null;
    probe.loading = loading;
    return <div data-testid="auth-probe">{user?.id ?? 'none'}|{profile?.role ?? 'none'}</div>;
  }
  window.__P0TAB__ = {
    emit(event: AuthChangeEvent, which: 'A' | 'B' | 'A-email' | null) {
      const user = which === 'A' ? USER_A : which === 'B' ? USER_B
        : which === 'A-email' ? ({ ...clone(USER_A), email: 'p0-tab-a-renamed@staging.invalid' } as User) : null;
      for (const listener of listeners) listener(event, user ? session(user) : null);
    },
    setProfileRole(role: 'owner' | 'viewer') { profileRole = role; },
    snapshot: () => ({ ...probe, userIds: [...probe.userIds], profileReads }),
  };
  root.render(<AuthProvider authClient={fakeClient} navigateAuth={() => undefined}><Probe /></AuthProvider>);
}

if (part === 'sync') {
  // The sandbox-only test bridge is installed first (it requires a sandbox mode), then the page
  // runs as Cloud mode so the real AuthProvider consumes the fake Auth client. With the bridge the
  // boundary never opens a Supabase channel; attach/detach count each sync-engine generation.
  const [{ AuthProvider }, { CloudRealtimeSyncBoundary }, { installCloudRealtimeTestBridge }] = await Promise.all([
    import('../../src/auth/AuthProvider'),
    import('../../src/contexts/CloudRealtimeSyncContext'),
    import('../../src/contexts/cloudRealtimeTestBridge'),
  ]);
  const counters = { attaches: 0, detaches: 0, queries: 0 };
  let controller: { fallback: (reason: 'focus' | 'visibility' | 'reconnect', resources?: string[]) => Promise<boolean> } | null = null;
  installCloudRealtimeTestBridge({
    query: async () => { counters.queries += 1; return []; },
    attach: next => { counters.attaches += 1; controller = next as never; },
    detach: () => { counters.detaches += 1; controller = null; },
  });
  localStorage.setItem('erp_provider_mode', 'cloud');
  type Listener = (event: AuthChangeEvent, session: Session | null) => void;
  const listeners = new Set<Listener>();
  const session = (user: User): Session => ({
    access_token: 'fixture-access-token-never-logged', refresh_token: 'fixture-refresh-token-never-logged',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user: clone(user),
  });
  const fakeClient = {
    auth: {
      onAuthStateChange(listener: Listener) {
        listeners.add(listener);
        window.setTimeout(() => listener('INITIAL_SESSION', session(USER_A)), 0);
        return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
      },
      async signOut() { return { error: null }; },
    },
    from() {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { role: 'owner', display_name: 'P0', is_active: true }, error: null }) }) }) };
    },
  } as unknown as SupabaseClient;
  window.__P0TAB__ = {
    emit(event: AuthChangeEvent, which: 'A' | 'B' | null) {
      const user = which === 'A' ? USER_A : which === 'B' ? USER_B : null;
      for (const listener of listeners) listener(event, user ? session(user) : null);
    },
    async fallback() { if (!controller) throw new Error('NO_CONTROLLER'); return controller.fallback('reconnect', ['products']); },
    snapshot: () => ({ ...counters, attached: Boolean(controller) }),
  };
  root.render(
    <AuthProvider authClient={fakeClient} navigateAuth={() => undefined}>
      <CloudRealtimeSyncBoundary><div data-testid="sync-probe">sync</div></CloudRealtimeSyncBoundary>
    </AuthProvider>,
  );
}

if (part === 'cost') {
  const [{ AuthContext }, { ViewportProvider }, { dataProvider }, { MemoryRouter, Route, Routes }, { default: PurchaseManagement }] = await Promise.all([
    import('../../src/auth/authContext'),
    import('../../src/contexts/ViewportContext'),
    import('../../src/providers/dataProvider'),
    import('react-router-dom'),
    import('../../src/pages/PurchaseManagement'),
  ]);
  const GROUP = 'a0000000-0000-4000-8000-00000000c0f1';
  const variant = (id: string, sku: string, name: string, cost: number | null, order: number) => ({
    id, product_group_id: GROUP, product_category_id: null, myacg_item_code: sku, product_title: 'P0 VSPO Fixture',
    variant_name: name, raw_variant_name: name, myacg_auto_quantity: 0, effective_myacg_quantity: 0, myacg_manual_adjustment: 0,
    waca_auto_quantity: 0, waca_manual_adjustment: 0, note: '', sort_order: order, catalog_missing: false, source: null,
    default_jpy_cost: cost, default_twd_cost: null, version: 1, updated_at: '2026-10-14T11:48:29.628Z',
  });
  const initialCosts = (params.get('costs') ?? '13000,null,null').split(',').map(value => value === 'null' ? null : Number(value));
  const server: Record<string, unknown[]> = {
    productGroups: [{ id: GROUP, title: 'P0 VSPO Fixture', normalized_title: 'p0 vspo fixture', listing_type: '日本代購',
      priority: 'Medium', purchase_date: '2026-10-01', closing_date: '2099-12-31', release_month: '2099-12', has_official_site: false,
      product_url: '', show_in_purchase_list: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }],
    productCategories: [],
    productVariants: [
      variant('a0000000-0000-4000-8000-000000000374', 'P0-G07592374', '複製簽套組', initialCosts[0], 0),
      variant('a0000000-0000-4000-8000-000000000375', 'P0-G07592375', '雙層壓克力面板', initialCosts[1], 1),
      variant('a0000000-0000-4000-8000-000000000376', 'P0-G07592376', '絨毛玩偶鑰匙圈', initialCosts[2], 2),
    ],
    inventory: [], purchaseBatches: [], purchaseBatchItems: [], privateOrders: [], privateOrderItems: [],
    bundleComponents: [], japanPackages: [], japanPackageItems: [], salesOrderItems: [],
  };
  const calls = { saveProductVariants: [] as unknown[], patch: [] as unknown[], bulk: [] as unknown[] };
  const getters: Record<string, string> = {
    getProductGroups: 'productGroups', getProductCategories: 'productCategories', getProductVariants: 'productVariants',
    getInventory: 'inventory', getPurchaseBatches: 'purchaseBatches', getPurchaseBatchItems: 'purchaseBatchItems',
    getPrivateOrders: 'privateOrders', getPrivateOrderItems: 'privateOrderItems', getBundleComponents: 'bundleComponents',
    getJapanPackages: 'japanPackages', getJapanPackageItems: 'japanPackageItems', getSalesOrderItems: 'salesOrderItems',
  };
  const provider = dataProvider as unknown as Record<string, unknown>;
  for (const [method, collection] of Object.entries(getters)) provider[method] = async () => clone(server[collection]);
  provider.canWriteCloud = async () => true;
  provider.saveProductVariants = async (rows: Array<{ id: string }>) => {
    calls.saveProductVariants.push(clone(rows));
    const byId = new Map(rows.map(row => [row.id, row]));
    server.productVariants = server.productVariants.map(row => byId.get((row as { id: string }).id) ?? row);
  };
  const applyPatch = (id: string, patch: Record<string, unknown>) => {
    server.productVariants = server.productVariants.map(row => (row as { id: string }).id === id
      ? { ...(row as object), ...clone(patch), version: Number((row as { version?: number }).version ?? 1) + 1 } : row);
  };
  provider.updateProductVariantPatch = async (id: string, patch: Record<string, unknown>) => {
    calls.patch.push({ id, patch: clone(patch) });
    applyPatch(id, patch);
  };
  provider.updateProductVariantPatchBulk = async (patches: Array<{ id: string; patch: Record<string, unknown> }>) => {
    calls.bulk.push(clone(patches));
    patches.forEach(entry => applyPatch(entry.id, entry.patch));
  };
  window.alert = () => undefined;
  window.confirm = () => true;
  const auth = {
    user: USER_A, profile: { role: 'owner' as const, display_name: 'P0', is_active: true }, loading: false, profileLoading: false,
    authFlow: 'normal' as const, signInWithPassword: async () => undefined, requestPasswordReset: async () => undefined,
    setNewPassword: async () => undefined, signOut: async () => undefined,
  };
  window.__P0TAB__ = {
    group: GROUP,
    server,
    setServerCost(id: string, cost: number | null) {
      server.productVariants = server.productVariants.map(row => (row as { id: string }).id === id
        ? { ...(row as object), default_jpy_cost: cost } : row);
    },
    snapshot: () => clone({ calls, server: server.productVariants,
      legacyJpy: localStorage.getItem('variant_default_jpy_costs'), legacyTwd: localStorage.getItem('variant_default_twd_costs') }),
  };
  root.render(
    <AuthContext.Provider value={auth}>
      <ViewportProvider>
        <MemoryRouter initialEntries={[`/purchase-records/${GROUP}`]}>
          <Routes><Route path="/purchase-records/:id" element={<PurchaseManagement />} /></Routes>
        </MemoryRouter>
      </ViewportProvider>
    </AuthContext.Provider>,
  );
}
