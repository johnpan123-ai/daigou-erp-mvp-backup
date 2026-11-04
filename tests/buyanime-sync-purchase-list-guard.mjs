// BuyAnime sync (catalog 'master' materialisation) must never add products to 採購總表
// (show_in_purchase_list), on first import, repeated import, or a cache re-read. Since 079 the explicit
// 'create' projection (訂購紀錄 import) does not either: only the Owner's add/remove action changes it.
// Synthetic data, real planCatalogTransaction, no network.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null, setItem: () => {} } };
globalThis.localStorage = globalThis.window.localStorage;
const vite = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, appType: 'custom' });
try {
  const { planCatalogTransaction } = await vite.ssrLoadModule('/src/providers/cloud/catalogTransaction.ts');
  const { normalizeProductTitle } = await vite.ssrLoadModule('/src/lib/db.ts');
  const at = '2026-11-01T00:00:00.000Z';
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const inv = (code, title, raw, sold) => ({ id: uuid(9000 + Number(code.replace(/\D/gu, ''))), inventory_key: `${normalizeProductTitle(title)}::${code}::${raw}`, myacg_item_code: code, product_title: title,
    raw_variant_name: raw, listing_type: '日本代購', final_price: 900, myacg_available_quantity: 1, myacg_sold_quantity: sold, version: 1 });
  const group = (n, title, show) => ({ id: uuid(n), title, normalized_title: normalizeProductTitle(title), listing_type: '日本代購', priority: 'Low', purchase_date: '', closing_date: '',
    release_month: '', has_official_site: false, product_url: '', show_in_purchase_list: show, created_at: at, updated_at: at, version: 1 });
  const variant = (n, g, code, title, raw, source) => ({ id: uuid(n), product_group_id: uuid(g), myacg_item_code: code, product_title: title, variant_name: raw, raw_variant_name: raw,
    note: '', sort_order: 0, source, myacg_auto_quantity: 0, effective_myacg_quantity: 0, version: 1 });
  // 1 hidden catalog product (never added), 5 formally purchased product (visible, order-import provenance).
  const base = {
    inventory: [inv('H1001', '合成隱藏目錄商品', '款A', 4), inv('P5001', '合成正式採購商品', '款A', 6), inv('N4001', '合成新增無需求商品', '款A', 0), inv('F2001', '合成首次匯入商品', '款A', 3)],
    groups: [group(1, '合成隱藏目錄商品', false), group(5, '合成正式採購商品', true)],
    categories: [],
    variants: [variant(11, 1, 'H1001', '合成隱藏目錄商品', '款A', 'inventory_import'), variant(51, 5, 'P5001', '合成正式採購商品', '款A', 'myacg_order_import')],
  };
  const apply = (snapshot, plan) => {
    // Apply group/variant operations from the plan to a snapshot (create/patch only, as the RPC would).
    const next = structuredClone(snapshot);
    for (const [table, key] of [['product_groups', 'groups'], ['product_variants', 'variants'], ['product_categories', 'categories']]) {
      for (const op of plan.request.operations[table] ?? []) {
        const row = next[key].find(r => r.id === op.id);
        if (op.kind === 'create') next[key].push({ id: op.id, ...op.values, version: 1 });
        else if (row) Object.assign(row, op.changes ?? {});
      }
    }
    return next;
  };
  const visibleInPurchasing = snap => snap.groups.filter(g => g.show_in_purchase_list === true).map(g => g.title).sort();
  const codes = base.inventory.map(r => r.myacg_item_code);

  // 2 first import (master materialisation of every imported code)
  const first = await planCatalogTransaction(structuredClone(base), 'master', codes);
  const groupOps = first.request.operations.product_groups ?? [];
  assert.equal(groupOps.filter(op => (op.values ?? op.changes ?? {}).show_in_purchase_list === true).length, 0, 'sync never sets show_in_purchase_list=true');
  const afterFirst = apply(base, first);
  assert.deepEqual(visibleInPurchasing(afterFirst), ['合成正式採購商品'], '1/2/4: hidden, first-import and no-demand products stay out of 採購總表; 5 stays in');
  const created = afterFirst.groups.filter(g => !base.groups.some(b => b.id === g.id));
  assert.ok(created.length >= 2 && created.every(g => g.show_in_purchase_list === false), '2/4: new catalog masters are hidden');
  assert.ok(afterFirst.variants.filter(v => !base.variants.some(b => b.id === v.id)).every(v => v.source === 'inventory_import'), 'new variants are catalog-only (not purchase records)');
  assert.equal(afterFirst.variants.find(v => v.id === uuid(51)).source, 'myacg_order_import', '5: formal purchase provenance untouched');

  // 3 repeated import of the same data, 6 after a cache re-read (fresh clone of the stored state)
  for (const label of ['3 repeat import', '6 cache reload']) {
    const again = await planCatalogTransaction(structuredClone(afterFirst), 'master', codes);
    const ops = again.request.operations;
    assert.equal((ops.product_groups ?? []).filter(op => op.kind === 'create').length, 0, `${label}: no new groups`);
    assert.equal((ops.product_groups ?? []).filter(op => 'show_in_purchase_list' in (op.changes ?? {})).length, 0, `${label}: visibility never changed`);
    assert.deepEqual(visibleInPurchasing(apply(afterFirst, again)), ['合成正式採購商品'], `${label}: 採購總表 unchanged`);
  }

  // 079: the explicit 訂購紀錄 projection changes provenance only; 採購總表 unchanged.
  const projection = await planCatalogTransaction(structuredClone(afterFirst), 'create', ['H1001']);
  assert.equal((projection.request.operations.product_groups ?? []).filter(op => 'show_in_purchase_list' in (op.changes ?? {})).length, 0);
  const projected = apply(afterFirst, projection);
  assert.deepEqual(visibleInPurchasing(projected), ['合成正式採購商品'], '訂購紀錄 import does not add to 採購總表');
  assert.equal(projected.variants.find(v => v.myacg_item_code === 'H1001').source, 'myacg_order_import', 'but it is now a 訂購紀錄');
  // A product the Owner removed (formal one set hidden) is not re-added by re-import.
  const removed = structuredClone(projected); removed.groups.find(g => g.id === uuid(5)).show_in_purchase_list = false;
  const reimport = await planCatalogTransaction(structuredClone(removed), 'create', codes);
  assert.deepEqual(visibleInPurchasing(apply(removed, reimport)), [], 'manually removed product stays out after re-import');
  console.log('PASS BuyAnime sync keeps hidden/new/no-demand products out of 採購總表 across first, repeated and reloaded imports; 訂購紀錄 import never changes it');
} finally { await vite.close(); }
