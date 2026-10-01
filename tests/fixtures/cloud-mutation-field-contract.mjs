// Production route + facade + providers + cache; only HTTP is simulated.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import '/src/index.css';
localStorage.setItem('erp_provider_mode', 'cloud');
localStorage.setItem('purchase_management_edit_mode', 'true');
const [{ supabase }, { dataProvider }, { AuthContext }, { ViewportProvider }, { AppLayout },
  { default: PurchaseManagement }, { markCloudReadFresh }, cas] = await Promise.all([
  import('/src/providers/cloud/supabaseClient.ts'), import('/src/providers/dataProvider.ts'),
  import('/src/auth/authContext.ts'), import('/src/contexts/ViewportContext.tsx'),
  import('/src/components/layout/AppLayout.tsx'), import('/src/pages/PurchaseManagement.tsx'),
  import('/src/providers/cloud/cloudConnectivity.ts'), import('/src/providers/cloud/cloudFieldCas.ts'),
]);
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => structuredClone(value);
const twd = new URLSearchParams(location.search).get('currency') === 'TWD';
const tables = {
  product_groups: [{ id: id(1), local_id: id(1), title: 'Isolated 玩偶', normalized_title: 'Isolated 玩偶',
    priority: 'Low', purchase_date: '', closing_date: '', release_month: '', has_official_site: false,
    listing_type: twd ? '代理版' : '日本代購', product_url: '', show_in_purchase_list: true, version: 1 }],
  product_categories: [{ id: id(2), local_id: id(2), product_group_id: id(1), title: '規格', sort_order: 0, version: 1 }],
  product_variants: [{ id: id(3), local_id: id(3), product_group_id: id(1), product_category_id: id(2),
    myacg_item_code: 'TEST-G001', product_title: 'Isolated 玩偶', variant_name: '玩偶', raw_variant_name: '玩偶',
    source: 'manual', default_jpy_cost: 100, default_twd_cost: 200, waca_auto_quantity: 0,
    myacg_auto_quantity: 0, effective_myacg_quantity: 0, myacg_manual_adjustment: 0, waca_manual_adjustment: 0,
    private_manual_adjustment: 0, purchased_manual_adjustment: 0, note: '', sort_order: 0,
    updated_at: '2026-10-01T00:00:00.000Z', version: 7 }],
};
// Test-only authoritative server double persists through page reload, separately
// from the production cost preference keys. No production storage is accessed.
const serverKey = `isolated_field_contract_server_${twd ? 'twd' : 'jpy'}`;
const savedServerRow = sessionStorage.getItem(serverKey);
if (savedServerRow) tables.product_variants[0] = JSON.parse(savedServerRow);
const calls = []; const reads = [];
let failNext = false;
let failReadAfterCommit = false;
let nextReadFails = false;
const user = { id: id(99), aud: 'authenticated', role: 'authenticated', email: 'isolated@example.invalid',
  app_metadata: {}, user_metadata: {}, created_at: '' };
supabase.auth.getSession = async () => ({ data: { session: { user } }, error: null });
supabase.from = table => {
  let ids; let from = 0; let to = Infinity;
  const result = () => {
    if (table === 'product_variants' && nextReadFails) {
      nextReadFails = false;
      return { data: null, error: { message: 'Synthetic readback failure', code: 'XX001' } };
    }
    return { data: clone((tables[table] || []).filter(row => !ids || ids.includes(row.id)).slice(from, to + 1)), error: null };
  };
  const builder = {
    select() { return builder; }, is() { return builder; }, order() { return builder; }, eq() { return builder; },
    limit() { return builder; }, abortSignal() { return builder; }, gt() { return builder; },
    in(_field, value) { ids = value; return builder; },
    range(start, end) { from = start; to = end; return builder; },
    async single() { return { data: { role: 'owner' }, error: null }; },
    then(resolve, reject) { reads.push({ table, ids: ids || null }); return Promise.resolve(result()).then(resolve, reject); },
    upsert() { throw new Error('Unexpected table write'); }, insert() { throw new Error('Unexpected table write'); },
    update() { throw new Error('Unexpected table write'); }, delete() { throw new Error('Unexpected table write'); },
  };
  return builder;
};
supabase.rpc = async (name, args) => {
  if (name !== 'erp_apply_field_mutations') throw new Error(`Unexpected test RPC:${name}`);
  calls.push(clone(args));
  if (failNext) { failNext = false; return { data: null, error: { message: 'Synthetic mutation failure' } }; }
  cas.assertCloudMutationOperations(args.p_entity, args.p_operations);
  const rows = tables[args.p_entity] || [];
  for (const op of args.p_operations) {
    const row = rows.find(value => value.id === op.id);
    if (!row) return { data: { ok: false, code: 'RECORD_DELETED_OR_MISSING', entity: args.p_entity, recordId: op.id }, error: null };
    if (Object.entries(op.expected).some(([field, value]) => !cas.cloudFieldValuesEqual(row[field], value))) {
      return { data: { ok: false, code: 'FIELD_CONFLICT', entity: args.p_entity, recordId: op.id }, error: null };
    }
  }
  for (const op of args.p_operations) {
    const row = rows.find(value => value.id === op.id);
    Object.assign(row, op.changes, { version: row.version + 1, updated_at: new Date().toISOString() });
  }
  sessionStorage.setItem(serverKey, JSON.stringify(tables.product_variants[0]));
  if (failReadAfterCommit) { failReadAfterCommit = false; nextReadFails = true; }
  return { data: { ok: true, entity: args.p_entity, rows: clone(rows) }, error: null };
};
window.fieldContractFixture = {
  snapshot: () => ({ calls: clone(calls), reads: clone(reads), variant: clone(tables.product_variants[0]) }),
  failNext() { failNext = true; },
  failReadAfterCommit() { failReadAfterCommit = true; },
  remotePrice(value) { Object.assign(tables.product_variants[0], { [twd ? 'default_twd_cost' : 'default_jpy_cost']: value,
    version: tables.product_variants[0].version + 1 }); },
  async patch(patch) { markCloudReadFresh(1); return dataProvider.updateProductVariantPatch(id(3), patch); },
};
const auth = { user, profile: { role: 'owner', display_name: 'Synthetic owner', is_active: true }, loading: false,
  profileLoading: false, authFlow: 'normal', signOut: async () => {}, signInWithPassword: async () => {},
  requestPasswordReset: async () => {}, setNewPassword: async () => {} };
markCloudReadFresh(1);
history.replaceState(null, '', `/purchase-records/${id(1)}${location.search}`);
createRoot(document.getElementById('root')).render(
  React.createElement(AuthContext.Provider, { value: auth }, React.createElement(ViewportProvider, null,
    React.createElement(BrowserRouter, null, React.createElement(AppLayout, null,
      React.createElement(Routes, null, React.createElement(Route, {
        path: '/purchase-records/:id', element: React.createElement(PurchaseManagement),
      })))))));
