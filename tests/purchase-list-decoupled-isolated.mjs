// 079 candidate acceptance: BuyAnime 訂購紀錄 import/projection never changes 採購總表
// (show_in_purchase_list). Real erp_apply_catalog_transaction on disposable PostgreSQL (v33 + 079),
// real planCatalogTransaction; synthetic data only.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { isolatedDatabase, R5_V33_MIGRATIONS, uuid } from './helpers/saveability-isolated.mjs';
const db = await isolatedDatabase({ migrations: [...R5_V33_MIGRATIONS, '../sql/079_catalog_projection_without_purchase_list.sql'] });
globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
const summary = {};
try {
  const { planCatalogTransaction } = await vite.ssrLoadModule('/src/providers/cloud/catalogTransaction.ts');
  const { sql } = db;
  const snapshot = async () => {
    const r = {};
    for (const [k, t] of Object.entries({ inventory: 'inventory_items', groups: 'product_groups', categories: 'product_categories', variants: 'product_variants' }))
      r[k] = (await sql.query(`select * from public.${t} where deleted_at is null order by id`)).rows;
    return r;
  };
  const call = async (plan, key = crypto.randomUUID()) => (await sql.query('select public.erp_apply_catalog_transaction($1,$2) result', [key, plan.request])).rows[0].result;
  const purchaseList = async () => (await sql.query('select id from public.product_groups where deleted_at is null and show_in_purchase_list order by id')).rows.map(r => r.id);
  const orderRecords = async () => (await sql.query("select count(*)::int n from public.product_variants where deleted_at is null and source='myacg_order_import'")).rows[0].n;
  const counts = async () => (await sql.query("select (select count(*)::int from public.product_groups where deleted_at is null) g,(select count(*)::int from public.product_variants where deleted_at is null) v,(select count(distinct myacg_item_code)::int from public.product_variants where deleted_at is null and myacg_item_code like 'BA%') skus")).rows[0];

  // Baseline: one product the Owner already added to 採購總表 (with a purchase batch), WACA evidence on it.
  await sql.query("insert into public.product_groups(id,title,show_in_purchase_list) values($1,'既有採購商品',true)", [uuid(900)]);
  await sql.query("insert into public.product_variants(id,product_group_id,myacg_item_code,product_title,variant_name,raw_variant_name,source,waca_auto_quantity) values($1,$2,'KEEP-1','既有採購商品','A','A','myacg_order_import',4)", [uuid(901), uuid(900)]);
  await sql.query("insert into public.purchase_batches(id,product_group_id,name) values($1,$2,'合成批次')", [uuid(902), uuid(900)]);
  const listBefore = await purchaseList();

  // 100 BuyAnime products (inventory) -> catalog sync (BuyAnime 'master' -> request mode 'sync').
  const codes = [];
  for (let n = 1; n <= 100; n++) {
    const code = `BA${String(n).padStart(4, '0')}`; codes.push(code);
    await sql.query(`insert into public.inventory_items(id,inventory_key,myacg_item_code,product_title,raw_variant_name,myacg_sold_quantity,import_sort_index)
      values($1,$2,$3,$4,'款A',$5,$6)`, [uuid(1000 + n), `ba-${n}`, code, `合成買動漫商品 ${n}`, n % 5, n]);
  }
  const sync = await planCatalogTransaction(await snapshot(), 'master', codes);
  assert.equal((await call(sync)).ok, true);
  assert.deepEqual(await purchaseList(), listBefore, '6: catalog materialisation adds nothing to 採購總表');

  // 1 first import of 100 訂購紀錄 (explicit projection of all 100).
  const recordsBefore = await orderRecords();
  const first = await planCatalogTransaction(await snapshot(), 'create', codes);
  assert.equal(first.request.operations.product_groups.filter(o => 'show_in_purchase_list' in (o.changes ?? {})).length, 0);
  const key = crypto.randomUUID();
  const r1 = await call(first, key); assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal((await orderRecords()) - recordsBefore, 100, '1: 100 訂購紀錄 created');
  assert.deepEqual(await purchaseList(), listBefore, '1: 採購總表 unchanged after importing 100');
  // 9 Journal/receipt idempotency: exact replay answered, changed payload under the same key refused.
  for (let n = 0; n < 3; n++) assert.equal((await call(first, key)).replayed, true);
  const tampered = structuredClone(first); tampered.request.operations.product_variants = tampered.request.operations.product_variants.slice(1);
  const beforeTamper = await counts();
  const tamperOutcome = await call(tampered, key).then(r => r.code, e => String(e.message));
  assert.match(tamperOutcome, /IDEMPOTENCY_KEY_PAYLOAD_MISMATCH|CATALOG_PROVENANCE_TRANSITION_FORBIDDEN/u, 'changed payload under a used key is refused');
  assert.deepEqual(await counts(), beforeTamper, 'refused payload wrote nothing');
  const afterFirst = await counts();

  // 2 repeat the same import: no new rows, no 採購總表 change.
  const again = await planCatalogTransaction(await snapshot(), 'create', codes);
  assert.equal((await call(again)).ok, true);
  assert.deepEqual(await counts(), afterFirst, '2: no duplicate SKU / Group / Variant');
  assert.deepEqual(await purchaseList(), listBefore, '2: 採購總表 unchanged');

  // 3 order quantity update (sold changes) -> re-import: quantity follows once, 採購總表 unchanged.
  await sql.query("update public.inventory_items set myacg_sold_quantity=myacg_sold_quantity+3,version=version+1 where myacg_item_code=any($1)", [codes.slice(0, 10)]);
  assert.equal((await call(await planCatalogTransaction(await snapshot(), 'create', codes))).ok, true);
  const qty = (await sql.query("select v.myacg_item_code c,v.myacg_auto_quantity q,i.myacg_sold_quantity s from public.product_variants v join public.inventory_items i on i.myacg_item_code=v.myacg_item_code where v.myacg_item_code=any($1)", [codes])).rows;
  assert.ok(qty.every(r => Number(r.q) === Number(r.s)), '7: BuyAnime 訂購 quantity equals sold (not doubled)');
  assert.equal((await call(await planCatalogTransaction(await snapshot(), 'create', codes))).ok, true);
  assert.ok((await sql.query("select v.myacg_auto_quantity q,i.myacg_sold_quantity s from public.product_variants v join public.inventory_items i on i.myacg_item_code=v.myacg_item_code where v.myacg_item_code=any($1)", [codes])).rows.every(r => Number(r.q) === Number(r.s)), '7: repeat does not add twice');
  assert.deepEqual(await purchaseList(), listBefore, '3: 採購總表 unchanged after quantity update');

  // 4 Owner explicitly adds product #1 (explicit field update path, not the Catalog RPC) -> re-import keeps it.
  const g1 = (await sql.query("select product_group_id id from public.product_variants where myacg_item_code='BA0001'")).rows[0].id;
  await sql.query('update public.product_groups set show_in_purchase_list=true,version=version+1 where id=$1', [g1]);
  assert.equal((await call(await planCatalogTransaction(await snapshot(), 'create', codes))).ok, true);
  assert.equal((await call(await planCatalogTransaction(await snapshot(), 'master', codes))).ok, true);
  assert.deepEqual(await purchaseList(), [...listBefore, g1].sort(), '4: manually added product stays after re-import');
  // 5 Owner removes it again -> re-import keeps it out.
  await sql.query('update public.product_groups set show_in_purchase_list=false,version=version+1 where id=$1', [g1]);
  assert.equal((await call(await planCatalogTransaction(await snapshot(), 'create', codes))).ok, true);
  assert.deepEqual(await purchaseList(), listBefore, '5: manually removed product stays out after re-import');

  // 6 catalog rebuild with new SKUs: new masters hidden.
  await sql.query("insert into public.inventory_items(id,inventory_key,myacg_item_code,product_title,raw_variant_name,myacg_sold_quantity,import_sort_index) values($1,'ba-new','BA0999','合成新商品','款A',2,999)", [uuid(1999)]);
  assert.equal((await call(await planCatalogTransaction(await snapshot(), 'master', ['BA0999']))).ok, true);
  assert.equal((await call(await planCatalogTransaction(await snapshot(), 'reparse'))).ok, true);
  assert.deepEqual(await purchaseList(), listBefore, '6: catalog rebuild / reparse adds nothing');

  // 8 unrelated evidence untouched: WACA quantity, purchase batch, existing visible product.
  const keep = (await sql.query('select v.waca_auto_quantity w,g.show_in_purchase_list s,(select count(*)::int from public.purchase_batches b where b.product_group_id=g.id) b from public.product_variants v join public.product_groups g on g.id=v.product_group_id where v.id=$1', [uuid(901)])).rows[0];
  assert.deepEqual([Number(keep.w), keep.s, keep.b], [4, true, 1], '8: WACA / purchase batch / existing 採購總表 entry intact');
  summary.ok = true; summary.orderRecords = await orderRecords(); summary.purchaseList = (await purchaseList()).length; summary.counts = await counts();
  console.log(JSON.stringify(summary));
  console.log('PASS 079: 100 訂購紀錄 import, repeat, quantity update, manual add/remove and catalog rebuild never change 採購總表; idempotency intact');
} finally { await vite.close(); await db.close(); }
