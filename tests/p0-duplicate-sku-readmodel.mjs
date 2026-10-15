import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

// P0 2026-10-15 (duplicate SKU, false 待採購, Purchase Records tab counts). Isolated: SSR module load,
// no IndexedDB, no network, synthetic rows only.
// P1: the six Purchase Records category tab counts use the Purchase Records group scope
//     (purchaseRecordGroupIds), not every Product Master group. C12 FAILS (counts groups.length).
// P2: computeVariantDedupe must not let a computed-only recalculation (updated_at bump) on a stale
//     duplicate hide the manual quantities kept on the maintained row. C12 FAILS (updated_at wins).
globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false } });
const results = [];
const check = (name, run) => {
  try { run(); results.push({ name, result: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, result: 'FAIL', error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
};
try {
  const { IndexedDbAdapter } = await vite.ssrLoadModule('/src/lib/db.ts');
  const { purchaseRecordGroupIds } = await vite.ssrLoadModule('/src/lib/productGroupDisplayName.ts');
  const dedupe = rows => IndexedDbAdapter.prototype.computeVariantDedupe.call({}, rows);
  const G = 'a1000000-0000-4000-8000-000000000001';
  const id = n => `b1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const v = (n, extra) => ({ id: id(n), product_group_id: G, product_category_id: null, myacg_item_code: 'G07211541',
    raw_variant_name: 'A', variant_name: 'A', product_title: 'T', source: 'myacg_order_import', sort_order: n,
    myacg_auto_quantity: 10, effective_myacg_quantity: 10, waca_auto_quantity: 0,
    myacg_manual_adjustment: 0, waca_manual_adjustment: 0, private_manual_adjustment: null, purchased_manual_adjustment: null,
    default_jpy_cost: null, default_twd_cost: null, note: null, updated_at: '2026-10-14T00:00:00.000Z', ...extra });

  check('P2 recalc bump on a stale duplicate does not hide the maintained manual quantities', () => {
    const maintained = v(1, { waca_manual_adjustment: 6, purchased_manual_adjustment: 30, updated_at: '2026-10-14T09:00:00.000Z' });
    const stale = v(2, { waca_manual_adjustment: 4, myacg_auto_quantity: 11, updated_at: '2026-10-15T13:06:56.000Z' });
    const { canonical, aliasMap } = dedupe([stale, maintained]);
    assert.equal(canonical.length, 1);
    assert.equal(canonical[0].id, maintained.id, 'primary must stay the row carrying the manual business quantities');
    assert.equal(canonical[0].waca_manual_adjustment, 6);
    assert.equal(canonical[0].purchased_manual_adjustment, 30);
    assert.equal(aliasMap.get(stale.id), maintained.id, 'references to the stale row resolve to the maintained row');
  });

  check('P2 a manual quantity missing (null) on the primary is taken from the duplicate, never dropped', () => {
    const newer = v(1, { waca_manual_adjustment: 5, updated_at: '2026-10-15T00:00:00.000Z' });
    const older = v(2, { myacg_manual_adjustment: -3, purchased_manual_adjustment: 8, updated_at: '2026-10-01T00:00:00.000Z' });
    const [row] = dedupe([older, newer]).canonical;
    assert.equal(row.id, older.id, 'two manual quantities outrank one');
    assert.equal(row.purchased_manual_adjustment, 8);
    const tie = dedupe([v(3, { purchased_manual_adjustment: null, waca_manual_adjustment: 2, updated_at: '2026-10-15T00:00:00.000Z' }),
      v(4, { purchased_manual_adjustment: 7, updated_at: '2026-10-01T00:00:00.000Z' })]).canonical[0];
    assert.equal(tie.id, id(3), 'equal manual score: newest updated_at stays primary');
    assert.equal(tie.waca_manual_adjustment, 2);
    assert.equal(tie.purchased_manual_adjustment, 7, 'null purchased on the primary falls back to the duplicate value');
  });

  check('P2 conflicting explicit manual values are neither summed nor overwritten by the duplicate', () => {
    const a = v(1, { purchased_manual_adjustment: 4, updated_at: '2026-10-15T00:00:00.000Z' });
    const b = v(2, { purchased_manual_adjustment: 3, updated_at: '2026-10-01T00:00:00.000Z' });
    const [row] = dedupe([b, a]).canonical;
    assert.equal(row.id, a.id);
    assert.equal(row.purchased_manual_adjustment, 4, 'not 7 (sum) and not 3 (duplicate)');
  });

  check('P2 unique rows and different specs are not merged', () => {
    const out = dedupe([v(1, {}), v(2, { raw_variant_name: 'B', variant_name: 'B' }), v(3, { myacg_item_code: 'G0000001' })]);
    assert.equal(out.canonical.length, 3);
    assert.equal(out.aliasMap.size, 0);
  });

  check('P1 category tab counts use the Purchase Records scope (inventory-only master groups excluded)', () => {
    const source = readFileSync(new URL('../src/pages/PurchaseRecords.tsx', import.meta.url), 'utf8');
    const labels = ['全部商品', 'C108專區', 'Hololive商品', 'VSPO商品', '代理版商品', '其他商品'];
    for (const label of labels) {
      const match = source.match(new RegExp(`${label} \\(\\{([^}]+)\\}\\)`, 'u'));
      assert.ok(match, `tab label not found: ${label}`);
      assert.match(match[1], /^purchaseRecordTabGroups[.\s]/u, `${label} must count purchaseRecordTabGroups, got: ${match[1]}`);
    }
    assert.match(source, /const purchaseRecordTabGroups = useMemo\(\(\) => \{\s*const projected = purchaseRecordGroupIds\(variants\);\s*return groups\.filter\(group => projected\.has\(group\.id\)\);/u);
    const scope = purchaseRecordGroupIds([
      { id: id(1), product_group_id: 'g-order', source: 'myacg_order_import' },
      { id: id(2), product_group_id: 'g-master', source: 'inventory_import' },
      { id: id(3), product_group_id: 'g-mixed', source: 'inventory_import' },
      { id: id(4), product_group_id: 'g-mixed', source: 'manual' },
    ]);
    assert.deepEqual([...scope].sort(), ['g-mixed', 'g-order'], 'Product Master groups stay valid data but are not purchase records');
  });
} finally { await vite.close(); }
const failed = results.filter(r => r.result !== 'PASS');
console.log(JSON.stringify({ result: failed.length ? 'FAIL' : 'PASS', checks: results.length, failed: failed.length }));
process.exit(failed.length ? 1 : 0);
