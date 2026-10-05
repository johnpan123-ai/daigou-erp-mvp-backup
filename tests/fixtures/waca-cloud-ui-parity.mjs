// Test entry only; not imported by the production entry. Real provider routing
// remains intact. Only the Supabase transport is replaced with synthetic data.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import '/src/index.css';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'cloud';
localStorage.setItem('erp_provider_mode', mode);
const [{ supabase }, { dataProvider }, { AuthContext }, { ViewportProvider }, { AppLayout },
  { default: WacaIntegration }, { markCloudReadFresh }] = await Promise.all([
  import('/src/providers/cloud/supabaseClient.ts'), import('/src/providers/dataProvider.ts'),
  import('/src/auth/authContext.ts'), import('/src/contexts/ViewportContext.tsx'),
  import('/src/components/layout/AppLayout.tsx'), import('/src/pages/WacaIntegration.tsx'),
  import('/src/providers/cloud/cloudConnectivity.ts'),
]);
const clone = value => structuredClone(value);
const title = '【小河馬日本代購】 預購 27年02月 代理版 GSC 換裝玩偶 BanG Dream! Morfonica';
const displayTitle = '代理版 GSC 換裝玩偶 BanG Dream! Morfonica';
const populated = params.get('populated') === '1';
const groups = populated ? [{ id: 'group-a', title, normalized_title: displayTitle,
  purchase_date: '', priority: 'Low', closing_date: '', release_month: '', has_official_site: false,
  product_url: '', created_at: '', updated_at: '' }] : [];
const variants = populated ? [10, 2, 1].map(n => ({ id: `variant-${n}`, product_group_id: 'group-a',
  myacg_item_code: `G${n}`, product_title: title, variant_name: `規格${n}`, raw_variant_name: `規格${n}`,
  note: '', sort_order: n, waca_auto_quantity: 0, waca_manual_adjustment: 0 })) : [];
const inventory = variants.map(row => ({ id: row.id, inventory_key: row.id,
  myacg_item_code: row.myacg_item_code, myacg_parent_code: 'GP-A', product_title: title,
  raw_variant_name: row.variant_name, listing_type: '', final_price: 100, myacg_sold_quantity: 0 }));
let snapshot = { revision: 0, orders: [], items: [], mappings: [], batches: [], masterLinks: [], cutoverAudit: [] };
if (params.get('pending') === '1') {
  const items = Array.from({length:84},(_,n)=>{
    const featureNumber=n<45?n:n-45;
    return {key:`pending-${n}`,orderKey:`WACA::PENDING-${n}`,feature:`feature-${featureNumber}`,
      productCode:`GP-PENDING-${featureNumber}`,productTitle:`歷史商品 ${featureNumber}`,spec1:'歷史規格',spec2:'',specCode:'',
      quantity:1,subtotal:100,productVariantId:null,match:'UNMATCHED',diagnostic:'MASTER_EVIDENCE_MISSING'};
  });
  snapshot = {...snapshot,revision:9,items,orders:items.map((item,n)=>({key:item.orderKey,orderNumber:`PENDING-${n}`,
    purchasedAt:'2026-09-28',status:n===43?'取消':n===44?'失敗':'處理中'})),
    cutoverAudit:[{productVariantId:'historical-audit',sku:'G-HISTORY',legacyWacaQuantity:0,newOrderDerivedQuantity:0}],
    batches:params.get('noBatch')==='1'?[]:[{id:'latest-batch',fileName:'current-isolated.xlsx',importedAt:'2026-10-05',
      rows:20,inserted:4,updated:13,unchanged:0,conflictRows:[],result:{ordersTotal:14,productRows:17,matched:params.get('lastPending')==='1'?16:17,
        unmatched:params.get('lastPending')==='1'?1:0,multipleCandidates:0,statusConflicts:[],cancelledOrders:0,failedOrders:1}}]};
}
let readFailure = params.get('failure') === '1';
const calls = { reads: 0, commits: 0, tables: {}, unexpectedWrites: 0 };
const user = { id: '50000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated',
  email: 'isolated-ui@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '' };
supabase.auth.getSession = async () => ({ data: { session: { user } }, error: null });
supabase.from = table => {
  const builder = {
    select() { return builder; }, is() { return builder; }, order() { return builder; },
    eq() { return builder; }, limit() { return builder; },
    async single() { return { data: { role: params.get('role') || 'owner' }, error: null }; },
    async range() {
      calls.tables[table] = (calls.tables[table] || 0) + 1;
      // Real catalog bootstrap completes after the first cache-read opportunity.
      await new Promise(resolve => setTimeout(resolve, 40));
      return { data: clone({ product_groups: groups, product_variants: variants, inventory_items: inventory }[table] || []), error: null };
    },
    upsert() { calls.unexpectedWrites++; throw new Error('Unexpected table write'); },
    insert() { calls.unexpectedWrites++; throw new Error('Unexpected table write'); },
    delete() { calls.unexpectedWrites++; throw new Error('Unexpected table write'); },
  };
  return builder;
};
supabase.rpc = async (name, args) => {
  if (name === 'erp_read_waca_snapshot') {
    calls.reads++;
    return readFailure ? { data: null, error: { message: '隔離測試：訂單讀取失敗' } }
      : { data: clone(snapshot), error: null };
  }
  if (name === 'erp_commit_waca_snapshot') {
    calls.commits++;
    if (args.p_expected_revision !== snapshot.revision) return { data: null, error: { message: 'stale revision' } };
    snapshot = { ...clone(args.p_snapshot), revision: snapshot.revision + 1 };
    return { data: { revision: snapshot.revision }, error: null };
  }
  throw new Error(`Unexpected fixture RPC ${name}`);
};
window.wacaUiFixture = {
  calls: () => clone(calls), recover() { readFailure = false; },
  async providerCommit() {
    markCloudReadFresh(variants.length);
    const current = await dataProvider.getNextWacaSnapshot();
    return dataProvider.commitNextWacaSnapshot(current, current.revision, false);
  },
};
const auth = { user, profile: { role: params.get('role') || 'owner', display_name: 'Isolated owner', is_active: true },
  loading: false, profileLoading: false, authFlow: 'normal', signOut: async () => {},
  signInWithPassword: async () => {}, requestPasswordReset: async () => {}, setNewPassword: async () => {} };
createRoot(document.getElementById('root')).render(
  React.createElement(AuthContext.Provider, { value: auth },
    React.createElement(ViewportProvider, null,
      React.createElement(BrowserRouter, null, React.createElement(AppLayout, null,
        React.createElement(Routes, null,
          React.createElement(Route, { path: '*', element: React.createElement(WacaIntegration) })))))));
