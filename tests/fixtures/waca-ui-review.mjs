// Test entry only; not imported by the production entry. Real provider routing
// remains intact. Only the Supabase transport is replaced with synthetic data.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import '/src/index.css';
import { incidentGroups, incidentEpoch } from './waca-preview-incident.mjs';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'cloud';
localStorage.setItem('erp_provider_mode', mode);
const [{ supabase }, { dataProvider }, { AuthContext }, { ViewportProvider }, { AppLayout },
  { default: WacaIntegration }, { markCloudReadFresh }, { wacaFeature, wacaOrderKey }] = await Promise.all([
  import('/src/providers/cloud/supabaseClient.ts'), import('/src/providers/dataProvider.ts'),
  import('/src/auth/authContext.ts'), import('/src/contexts/ViewportContext.tsx'),
  import('/src/components/layout/AppLayout.tsx'), import('/src/pages/WacaIntegration.tsx'),
  import('/src/providers/cloud/cloudConnectivity.ts'), import('/src/waca/orderCore.ts'),
]);
const clone = value => structuredClone(value);
// Owner UI review fixture (test-only): three product groups with ERP1 history, isolated synthetic Cloud transport.
const incident = params.get('incident') === '1';
const groupDefs = incident ? incidentGroups : [
  { id: 'group-a', title: '【小河馬日本代購】 預購 27年02月 代理版 GSC 換裝玩偶 BanG Dream! Morfonica', display: '代理版 GSC 換裝玩偶 BanG Dream! Morfonica', code: 'GP-A',
    rows: [['G10', '倉田真白', 10], ['G11', '桐ヶ谷透子', 4], ['G12', '広町七深', 0]] },
  { id: 'group-b', title: '【小河馬日本代購】 預購 26年12月 Hololive English 活動2周年記念 旋轉壓克力立牌', display: 'Hololive English 活動2周年記念 旋轉壓克力立牌', code: 'GP-B',
    rows: [['G20', 'Cecilia Immergreen', 2], ['G21', 'Gigi Murin', 0]] },
  { id: 'group-c', title: '【小河馬日本代購】 預購 27年01月 GSC 黏土人 Hakos Baelz', display: 'GSC 黏土人 Hakos Baelz', code: 'GP-C',
    rows: [['G30', '標準版', 6]] },
];
const title = groupDefs[0].title;
if (params.get('offFilePending') === '1') groupDefs.push({ id: 'off-file-group', title: '隔離：本次未匯入的歷史待核對商品',
  display: '隔離：本次未匯入的歷史待核對商品', code: 'OFF-FILE', rows: [['OFF-FILE-SKU', '歷史待核對規格', 3]] });
const populated = params.get('populated') === '1';
// daily=1: everyday import after the takeover (ORDER_DRIVEN_ACTIVE, baseline = Restore 5). Display = auto + manual.
const daily = params.get('daily') === '1';
const hasHistory = params.get('history') === '1' || daily || incident;
const dailyQuantity = { G10: [1, 9], G11: [1, 3], G12: [0, 0], G20: [0, 2], G21: [1, 0], G30: [6, 0] };
const groups = populated ? groupDefs.map(g => ({ id: g.id, title: g.title, normalized_title: g.display,
  purchase_date: '', priority: 'Low', closing_date: '', release_month: '', has_official_site: false,
  product_url: '', created_at: '', updated_at: '' })) : [];
const variants = populated ? groupDefs.flatMap(g => g.rows.map(([code, name, history], index) => ({ id: `variant-${code}`, product_group_id: g.id,
  myacg_item_code: code, product_title: g.title, variant_name: name, raw_variant_name: name,
  note: '', sort_order: index, waca_auto_quantity: daily ? dailyQuantity[code][0] : 0,
  waca_manual_adjustment: daily ? dailyQuantity[code][1] : params.get('history') === '1' || incident ? history : 0, groupCode: g.code }))) : [];
const inventory = variants.map(row => ({ id: row.id, inventory_key: row.id,
  myacg_item_code: row.myacg_item_code, myacg_parent_code: row.groupCode, product_title: row.product_title,
  raw_variant_name: row.variant_name, listing_type: '', final_price: 100, myacg_sold_quantity: 0 }));
for (const row of variants) delete row.groupCode;
let snapshot = { revision: 0, orders: [], items: [], mappings: [], batches: [], masterLinks: [], cutoverAudit: [],
  ...(params.get('history') === '1' || incident ? { cutoverState: { mode: 'ORDER_REBASELINE_REQUIRED', updatedAt: '1970-01-01T00:00:00.000Z', sourceBackupFormatVersion: 1 } } : {}) };
if (daily) {
  // Stored ledger before today's file: one ERP2-recognized order (later cancelled in the file -> automatic rollback)
  // and ERP1-history orders (one changes quantity, one is cancelled -> manual review, never auto-deducted).
  const def = code => groupDefs.find(g => g.rows.some(r => r[0] === code));
  const prior = [
    ['W2509300001', '2026/09/30 10:00', 'G10', 1, 0, 'BASELINE_INCLUDED'],
    ['W2610170101', '2026/10/17 09:00', 'G11', 1, 1, 'NEW_AFTER_BASELINE'],
    ['W2509250401', '2026/09/25 15:00', 'G21', 1, 0, 'BASELINE_INCLUDED'],
    ['W2509200301', '2026/09/20 12:00', 'G30', 6, 0, 'BASELINE_INCLUDED'],
  ];
  const items = prior.map(([number, , code, quantity, counted, reason]) => {
    const g = def(code); const name = g.rows.find(r => r[0] === code)[1];
    const row = { productCode: g.code, productTitle: g.title, spec1: name, spec2: '', specCode: code };
    return { key: `${wacaOrderKey(number)}::${wacaFeature(row)}`, orderKey: wacaOrderKey(number), feature: wacaFeature(row), ...row,
      quantity, subtotal: quantity * 100, productVariantId: `variant-${code}`, match: 'AUTO_MATCH', diagnostic: null,
      resolution: 'SPEC_CODE_EXACT', countedQuantity: counted, countedReason: reason, countedBy: 'owner' };
  });
  snapshot = { ...snapshot, revision: 3, items,
    orders: prior.map(([number, at]) => ({ key: wacaOrderKey(number), orderNumber: number, purchasedAt: at, status: '完成付款' })),
    cutoverState: { mode: 'ORDER_DRIVEN_ACTIVE', updatedAt: '2026-10-16T03:00:00Z', sourceBackupFormatVersion: null,
      transition: { contract: 'waca-counted-import-v1', restoreEpoch: 5, baselineAt: '2026-10-16T02:20:45.000000Z', establishedAt: '2026-10-16T03:00:00Z' } },
    cutoverAudit: variants.map(v => ({ productVariantId: v.id, sku: v.myacg_item_code, legacyWacaQuantity: 0, newOrderDerivedQuantity: v.waca_auto_quantity })) };
}
if (params.get('offFilePending') === '1') {
  const row = { productCode: 'OFF-FILE', productTitle: '隔離：本次未匯入的歷史待核對商品',
    spec1: '歷史待核對規格', spec2: '', specCode: 'OFF-FILE-SKU' };
  const key = wacaOrderKey('AUDIT-STORED-PENDING');
  snapshot.orders.push({ key, orderNumber: 'AUDIT-STORED-PENDING', purchasedAt: '2026-10-01 10:00:00', status: '完成付款' });
  snapshot.items.push({ ...row, key: `${key}::${wacaFeature(row)}`, orderKey: key, feature: wacaFeature(row), quantity: 3,
    subtotal: 300, productVariantId: 'variant-OFF-FILE-SKU', match: 'AUTO_MATCH', resolution: 'SPEC_CODE_EXACT',
    countedQuantity: 0, countedReason: 'PENDING_REVIEW', countedBy: 'owner' });
}
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
// persist=1 (test-only): keep the emulated cloud state across page reloads of this tab, so a test can commit, reload and re-import.
const persist = params.get('persist') === '1';
if (persist) {
  try {
    const saved = JSON.parse(sessionStorage.getItem('wacaUiFixtureState') || 'null');
    if (saved) {
      snapshot = saved.snapshot;
      for (const variant of variants) Object.assign(variant, saved.quantities[variant.id] ?? {});
    }
  } catch { /* start from the scenario */ }
}
const save = () => { if (persist) sessionStorage.setItem('wacaUiFixtureState', JSON.stringify({ snapshot,
  quantities: Object.fromEntries(variants.map(v => [v.id, { waca_auto_quantity: v.waca_auto_quantity, waca_manual_adjustment: v.waca_manual_adjustment }])) })); };
let readFailure = params.get('failure') === '1';
const calls = { reads: 0, commits: 0, tables: {}, unexpectedWrites: 0 };
const user = { id: '50000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated',
  email: 'isolated-ui@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '' };
supabase.auth.getSession = async () => ({ data: { session: { user } }, error: null });
supabase.from = table => {
  const builder = {
    select() { return builder; }, is() { return builder; }, order() { return builder; },
    eq() { return builder; }, limit() { return builder; },
    async single() { return table === 'erp_cloud_restore_epoch' ? { data: incident ? clone(incidentEpoch) : hasHistory
        ? { epoch: 5, restored_at: '2026-10-16T02:20:45+00:00' } : { epoch: 0, restored_at: null }, error: null }
      : { data: { role: params.get('role') || 'owner' }, error: null }; },
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
  if (name === 'erp_commit_waca_snapshot' || name === 'erp_commit_waca_counted_snapshot') {
    if (params.get('previewOnly') === '1') { calls.unexpectedWrites++; throw new Error('ISOLATED_PREVIEW_ONLY_NO_COMMIT'); }
    if (name === 'erp_commit_waca_counted_snapshot') calls.countedCommits = (calls.countedCommits || 0) + 1;
    calls.commits++;
    if (args.p_expected_revision !== snapshot.revision) return { data: null, error: { message: 'stale revision' } };
    const delta = clone(args.p_snapshot);
    const merge = (current, incoming, key) => {
      const rows = new Map(current.map(row => [key(row), row]));
      for (const row of incoming ?? []) rows.set(key(row), row);
      return [...rows.values()];
    };
    snapshot = { ...snapshot, ...delta, revision: snapshot.revision + 1,
      orders: merge(snapshot.orders, delta.orders, row => row.key),
      items: merge(snapshot.items, delta.items, row => row.key),
      mappings: merge(snapshot.mappings, delta.mappings, row => row.feature),
      batches: merge(snapshot.batches, delta.batches, row => row.id),
      masterLinks: merge(snapshot.masterLinks, delta.masterLinks, row => row.childCode),
      cutoverAudit: merge(snapshot.cutoverAudit ?? [], delta.cutoverAudit ?? [], row => row.productVariantId),
    };
    if (name === 'erp_commit_waca_counted_snapshot') {
      // Emulates the 073 server outcome: auto = effective ledger, display = reviewed expectation.
      calls.lastCounted = clone(args);
      const effective = new Map();
      for (const item of snapshot.items) {
        const order = snapshot.orders.find(row => row.key === item.orderKey);
        if (item.productVariantId && order && ['處理中', '完成付款'].includes(order.status))
          effective.set(item.productVariantId, (effective.get(item.productVariantId) ?? 0) + item.quantity);
      }
      for (const variant of variants) {
        const auto = effective.get(variant.id) ?? 0;
        const expected = args.p_plan.expectedDisplay[variant.id];
        const display = expected ? expected.after : variant.waca_auto_quantity + variant.waca_manual_adjustment;
        variant.waca_auto_quantity = auto; variant.waca_manual_adjustment = display - auto;
      }
      if (!snapshot.cutoverAudit.length) snapshot.cutoverAudit = variants.map(variant => ({ productVariantId: variant.id,
        sku: variant.myacg_item_code, legacyWacaQuantity: 0, newOrderDerivedQuantity: variant.waca_auto_quantity }));
    }
    if (name === 'erp_commit_waca_counted_snapshot') snapshot.cutoverState = { mode: 'ORDER_DRIVEN_ACTIVE', updatedAt: '2026-10-18T00:00:00Z',
      sourceBackupFormatVersion: null, transition: snapshot.cutoverState?.transition ?? { contract: 'waca-counted-import-v1', restoreEpoch: 0,
        baselineAt: '2026-10-18T00:00:00.000000Z', establishedAt: '2026-10-18T00:00:00Z' } };
    save();
    return { data: { revision: snapshot.revision }, error: null };
  }
  throw new Error(`Unexpected fixture RPC ${name}`);
};
window.wacaUiFixture = {
  calls: () => clone(calls), variants: () => clone(variants), snapshot: () => clone(snapshot), recover() { readFailure = false; },
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
  React.createElement(React.Fragment, null,
    incident && React.createElement('p', { role: 'status', style: { margin: 0, padding: '8px 20px', background: '#e0f2fe', color: '#075985' } },
      '隔離重現：實際商品／數量，訂單編號已代碼化；不連線雲端、不會寫入正式資料。'),
    React.createElement(AuthContext.Provider, { value: auth },
    React.createElement(ViewportProvider, null,
      React.createElement(BrowserRouter, null, React.createElement(AppLayout, null,
        React.createElement(Routes, null,
          React.createElement(Route, { path: '*', element: React.createElement(WacaIntegration) }))))))));
