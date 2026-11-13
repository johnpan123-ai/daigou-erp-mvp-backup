// BuyAnime corrected a variant label of an existing SKU (BUYANIME_INVENTORY_SKU_REKEY_CONFLICT on 2026-11-13,
// G07765968 "星街城堡模型" -> "星街城堡模型繪本"). Synthetic rows shaped like that case; the real client plan
// (planCloudInventoryImport) and the real server transaction (erp_apply_inventory_import / reconcile, 072) on an
// isolated PostgreSQL with the canonical migrations.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { isolatedDatabase } from './helpers/saveability-isolated.mjs';

globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
const db = await isolatedDatabase();
try {
  const { sql } = db;
  await sql.query("set timezone='UTC'");
  const { planCloudInventoryImport } = await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
  const { inventoryImportIntent } = await vite.ssrLoadModule('/src/providers/cloud/inventoryImportTransaction.ts');
  const { toCloudFieldRow } = await vite.ssrLoadModule('/src/providers/cloud/cloudEntityPayload.ts');
  const { CLOUD_FIELD_ENTITY_CONTRACTS } = await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  const { normalizeProductTitle } = await vite.ssrLoadModule('/src/lib/db.ts');
  const epoch = Number((await sql.query('select epoch from public.erp_cloud_restore_epoch where singleton')).rows[0].epoch);
  const TITLE = '【合成代購】預購 27年02月 合成偶像 Once Upon a Synthetic 事後通販周邊 合成彗星';
  const at = '2026-11-12T05:47:00.000Z';
  const seed = async rows => {
    const normalized = rows.map(row => ({ ...toCloudFieldRow('inventory_items', row), version: 1 }));
    const columns = ['id', ...CLOUD_FIELD_ENTITY_CONTRACTS.inventory_items.create, 'version'];
    await sql.query(`insert into public.inventory_items (${columns.join(',')}) select ${columns.join(',')} from jsonb_populate_recordset(null::public.inventory_items,$1)`, [JSON.stringify(normalized)]);
  };
  const read = async () => (await sql.query("select to_jsonb(i) row from public.inventory_items i where myacg_item_code like 'SYN%' order by inventory_key")).rows.map(r => r.row);
  const fileRow = (code, variant, sold, extra = {}) => ({ product_title: TITLE, myacg_item_code: code, myacg_parent_code: 'SYNP001', raw_variant_name: variant,
    myacg_sold_quantity: sold, listing_type: 'preorder', latest_catalog_import_id: 'catalog_import_' + randomUUID(), catalog_last_seen_at: '2026-11-13T07:56:00.000Z', ...extra });
  // Same batch identity on every row of one file (as the parser produces).
  const file = (...rows) => { const batch = 'catalog_import_' + randomUUID(); return rows.map(r => ({ ...r, latest_catalog_import_id: batch })); };
  const commit = async plan => {
    if (!plan.operations.length) return { ok: true, outcome: 'NO_OP' };
    const intent = inventoryImportIntent(plan.batchId ?? 'catalog_import_' + randomUUID(), epoch, plan.operations);
    const r = (await sql.query('select public.erp_apply_inventory_import($1,$2) r', [intent.key, JSON.stringify(intent.request)])).rows[0].r;
    if (r.ok) {
      assert.equal((await sql.query('select public.erp_reconcile_inventory_import($1,$2) r', [intent.key, JSON.stringify(intent.request)])).rows[0].r.outcome, 'COMMITTED');
      assert.equal((await sql.query('select public.erp_apply_inventory_import($1,$2) r', [intent.key, JSON.stringify(intent.request)])).rows[0].r.replayed, true, 'idempotent replay');
    }
    return r;
  };
  const report = {};

  // Existing state: the SKU imported on 11-12 with the old label, a sibling SKU of the same product, and a
  // catalog variant + purchase / Japan package / outbound / order rows that reference the catalog variant.
  const holderId = randomUUID(), siblingId = randomUUID();
  const NT = normalizeProductTitle(TITLE);
  const oldKey = `${NT}::SYN001::城堡模型`;
  await seed([
    { id: holderId, inventory_key: oldKey, product_title: TITLE, myacg_item_code: 'SYN001', myacg_parent_code: 'SYNP001', normalized_product_title: NT, raw_variant_name: '城堡模型', myacg_sold_quantity: 0, listing_type: 'preorder', catalog_last_seen_at: at },
    { id: siblingId, inventory_key: `${NT}::SYN002::壓克力立牌`, product_title: TITLE, myacg_item_code: 'SYN002', myacg_parent_code: 'SYNP001', normalized_product_title: NT, raw_variant_name: '壓克力立牌', myacg_sold_quantity: 5, listing_type: 'preorder', catalog_last_seen_at: at },
  ]);
  const refs = async () => Object.fromEntries((await sql.query(`select 'inventory' t, count(*)::int n, string_agg(id::text, ',' order by id) ids from public.inventory_items where myacg_item_code like 'SYN%'
    union all select 'product_variants', count(*)::int, string_agg(id::text || ':' || version, ',') from public.product_variants
    union all select 'purchase_batch_items', count(*)::int, null from public.purchase_batch_items
    union all select 'japan_package_items', count(*)::int, null from public.japan_package_items
    union all select 'outbound_shipment_items', count(*)::int, null from public.outbound_shipment_items
    union all select 'private_order_items', count(*)::int, null from public.private_order_items`)).rows.map(r => [r.t, `${r.n}|${r.ids ?? ''}`]));
  const refsBefore = await refs();

  // 1) The corrected export: same SKU, same parent, same product, new variant label, sold 0 -> 2.
  const newFile = file(fileRow('SYN001', '城堡模型繪本', 2), fileRow('SYN002', '壓克力立牌', 5));
  const before = await read();
  const plan = planCloudInventoryImport(before, newFile);
  assert.ok(plan.operations.every(o => o.kind === 'patch'), 'no create');
  assert.ok(plan.operations.filter(o => o.id !== holderId).every(o => !Object.hasOwn(o.changes, 'inventory_key')), 'no other key changes');
  const op = plan.operations.find(o => o.id === holderId);
  assert.ok(op, 'patch of the existing row, not a create');
  assert.deepEqual(Object.keys(op.changes).filter(k => ['inventory_key', 'raw_variant_name', 'myacg_sold_quantity'].includes(k)).sort(), ['inventory_key', 'myacg_sold_quantity', 'raw_variant_name']);
  assert.equal(op.expected.inventory_key, oldKey, 'CAS on the current key');
  const r1 = await commit(plan);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const after = await read();
  const holder = after.find(r => r.id === holderId);
  assert.equal(after.length, 2, 'no second row');
  assert.equal(holder.raw_variant_name, '城堡模型繪本');
  assert.match(holder.inventory_key, /::SYN001::城堡模型繪本$/u, 'identity key follows the corrected label');
  assert.equal(holder.myacg_sold_quantity, 2, 'sold quantity from the file, not added');
  assert.equal(holder.version, 2);
  assert.equal(after.find(r => r.id === siblingId).inventory_key, before.find(r => r.id === siblingId).inventory_key, 'sibling identity untouched');
  report.rename = { id: holder.id === holderId, key: holder.inventory_key.split('::').slice(1).join('::'), sold: holder.myacg_sold_quantity, rows: after.length };

  // 2) The same file again: nothing to write, still one row, sold still 2.
  const again = planCloudInventoryImport(await read(), newFile);
  assert.equal(again.operations.length, 0, 'same file again: no-op');
  assert.equal((await commit(again)).ok, true);
  assert.equal((await read()).length, 2);
  // 3) A later export with more sales: patch in place (normal path, no rename).
  const later = planCloudInventoryImport(await read(), file(fileRow('SYN001', '城堡模型繪本', 3), fileRow('SYN002', '壓克力立牌', 5)));
  assert.deepEqual(later.operations.map(o => [o.kind, o.id, Object.hasOwn(o.changes ?? {}, 'inventory_key')]).filter(o => o[1] === holderId), [['patch', holderId, false]]);
  assert.ok(later.operations.every(o => o.kind === 'patch' && !Object.hasOwn(o.changes, 'inventory_key')));
  assert.equal((await commit(later)).ok, true);
  // 4) An older export imported afterwards (old label): the same row is relabelled, never a second row.
  const older = planCloudInventoryImport(await read(), file(fileRow('SYN001', '城堡模型', 0), fileRow('SYN002', '壓克力立牌', 5)));
  assert.ok(older.operations.every(o => o.kind === 'patch') && older.operations.some(o => o.id === holderId && Object.hasOwn(o.changes, 'inventory_key')));
  assert.equal((await commit(older)).ok, true);
  const afterOld = await read();
  assert.equal(afterOld.length, 2); assert.equal(afterOld.find(r => r.id === holderId).raw_variant_name, '城堡模型');
  // ... and the newer one again: back, same row.
  assert.equal((await commit(planCloudInventoryImport(afterOld, file(fileRow('SYN001', '城堡模型繪本', 3), fileRow('SYN002', '壓克力立牌', 5))))).ok, true);
  const final = await read();
  assert.equal(final.length, 2); assert.equal(final.find(r => r.id === holderId).myacg_sold_quantity, 3);
  assert.equal(new Set(final.map(r => r.inventory_key)).size, 2);
  const refsAfter = await refs();
  assert.equal(refsAfter.inventory.split('|')[1], refsBefore.inventory.split('|')[1], 'same inventory UUIDs');
  for (const t of ['product_variants', 'purchase_batch_items', 'japan_package_items', 'outbound_shipment_items', 'private_order_items']) assert.equal(refsAfter[t], refsBefore[t], `${t} unchanged`);
  report.sequence = 'new, same again, later, older, newer: one row, same UUID';

  // 5) Fail closed: every case that cannot be proven to be the same SKU keeps BUYANIME_INVENTORY_SKU_REKEY_CONFLICT.
  const current = await read();
  const conflict = (name, authoritative, incoming, pattern = /BUYANIME_INVENTORY_SKU_REKEY_CONFLICT/u) => {
    assert.throws(() => planCloudInventoryImport(authoritative, incoming), pattern, name);
    report[name] = 'FAIL_CLOSED';
  };
  conflict('parentDiffers', current, file(fileRow('SYN001', '另一款', 3, { myacg_parent_code: 'SYNP999' })));
  conflict('parentMissing', current.map(r => r.id === holderId ? { ...r, myacg_parent_code: null } : r), file(fileRow('SYN001', '另一款', 3)));
  conflict('titleDiffers', current, file(fileRow('SYN001', '另一款', 3, { product_title: '【合成代購】完全不同的商品' })));
  const dupHolder = { ...current.find(r => r.id === siblingId), id: randomUUID(), inventory_key: 'dup::SYN001::x', myacg_item_code: 'SYN001', raw_variant_name: 'x' };
  conflict('codeHeldTwice', [...current, dupHolder], file(fileRow('SYN001', '另一款', 3)));
  conflict('codeAlsoOnTombstone', [...current, { ...dupHolder, deleted_at: '2026-11-01T00:00:00.000Z' }], file(fileRow('SYN001', '另一款', 3)));
  conflict('oldAndNewLabelInOneFile', current, file(fileRow('SYN001', '城堡模型繪本', 3), fileRow('SYN001', '另一款', 3)));
  conflict('crossProductCode', current, file(fileRow('SYN002', '城堡模型繪本', 3, { product_title: '【合成代購】別的商品', myacg_parent_code: 'SYNP777' })));
  const tombstoneOnNewKey = { ...dupHolder, myacg_item_code: 'SYNX', inventory_key: final.find(r => r.id === holderId).inventory_key.replace('城堡模型繪本', '另一款'), deleted_at: '2026-11-01T00:00:00.000Z' };
  conflict('newKeyHeldByTombstone', [...current, tombstoneOnNewKey], file(fileRow('SYN001', '另一款', 3)), /CLOUD_INVENTORY_KEY_SOFT_DELETED|REKEY_CONFLICT/u);

  // 6) Server guards unchanged: a key held by another UUID is refused; a stale CAS is refused; nothing written.
  const snap = await read();
  const stolen = { kind: 'patch', id: holderId, observedVersion: snap.find(r => r.id === holderId).version,
    expected: { inventory_key: snap.find(r => r.id === holderId).inventory_key }, changes: { inventory_key: snap.find(r => r.id === siblingId).inventory_key } };
  const steal = inventoryImportIntent('catalog_import_' + randomUUID(), epoch, [stolen]);
  const rs = (await sql.query('select public.erp_apply_inventory_import($1,$2) r', [steal.key, JSON.stringify(steal.request)])).rows[0].r;
  assert.equal(rs.ok, false); report.serverKeyTransfer = rs.code;
  // Field CAS: a client view that is behind the server on this row (another writer changed the label).
  const stale = planCloudInventoryImport(snap.map(r => r.id === holderId ? { ...r, raw_variant_name: '過期標籤' } : r), file(fileRow('SYN001', '又一款', 4), fileRow('SYN002', '壓克力立牌', 5)));
  const rc = await commit(stale);
  assert.equal(rc.ok, false); report.serverStaleCas = rc.code;
  assert.deepEqual(await read(), snap, 'refused requests wrote nothing');
  console.log('REPORT ' + JSON.stringify(report));
  console.log('PASS BuyAnime variant rename: same UUID, key follows label, sold from file, idempotent, old/new order safe, 8 fail-closed cases, server guards unchanged');
} finally { await db.close(); await vite.close(); }
