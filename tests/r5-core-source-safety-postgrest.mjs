// Native PostgreSQL + authenticated PostgREST; synthetic data only, never Cloud.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createServer } from 'vite';
import { isolatedDatabase, owner, viewer, uuid } from './helpers/saveability-isolated.mjs';

assert.ok(process.env.WACA_TEST_SAFEUPDATE_LIBRARY, 'safeupdate required');
assert.ok(process.env.WACA_TEST_POSTGREST_BINARY, 'native PostgREST required');
const d = await isolatedDatabase({ safeupdateLibrary: process.env.WACA_TEST_SAFEUPDATE_LIBRARY,
  postgrestBinary: process.env.WACA_TEST_POSTGREST_BINARY });
const vite = await createServer({ configFile:false,server:{middlewareMode:true,hmr:false},appType:'custom' });
const q = (s,a) => d.sql.query(s,a);
const checks = {};
try {
  const snapshot = async () => (await q('select public.erp_export_cloud_restore_snapshot_json() s')).rows[0].s;
  const before = await snapshot();
  await q(readFileSync('supabase/sql/078_core_source_capacity_and_receiving.sql','utf8'));
  assert.deepEqual(await snapshot(),before,'Migration changes no business rows');
  checks.migrationBusinessMutation = 0;
  const client = await vite.ssrLoadModule('/src/providers/cloud/japanPackageTransaction.ts');
  const ref = 'abcdefghijklmnopqrst';
  const host = {host:ref+'.supabase.co'};
  await q(`create function public.erp_r5_test_context() returns jsonb language sql set search_path=pg_catalog as $$
    select jsonb_build_object('role',current_user,'safeupdate',current_setting('safeupdate.enabled',true)) $$;
    revoke all on function public.erp_r5_test_context() from public,anon;
    grant execute on function public.erp_r5_test_context() to authenticated`);
  await d.startPostgrest();
  const context=await d.http('/rpc/erp_r5_test_context',{});
  assert.equal(context.status,200);assert.equal(context.data.role,'authenticated');assert.equal(context.data.safeupdate,'on');
  checks.authenticatedSafeupdate=context.data;
  const rpc = async (entity,ops,sub=owner) => d.http('/rpc/erp_apply_field_mutations',{
    p_entity:entity,p_operations:ops},sub,{headers:host});
  const get = async (table,id) => (await q(`select to_jsonb(t) r from public.${table} t where id=$1`,[id])).rows[0]?.r;
  const create = (id,values) => ({kind:'create',id,values});
  const patch = async (table,id,changes) => {
    const row=await get(table,id);
    return {kind:'patch',id,observedVersion:row.version,expected:Object.fromEntries(Object.keys(changes).map(k=>[k,row[k]])),changes};
  };
  const sendPatch = async (table,id,changes) => rpc(table,[await patch(table,id,changes)]);
  const ok = r => { assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.ok,true,JSON.stringify(r));return r; };
  const denied = async (action,code) => {
    const b=await snapshot(); const r=await action();
    assert.equal(r.status,409,JSON.stringify(r));assert.equal(r.data.message,code,JSON.stringify(r));
    assert.deepEqual(await snapshot(),b,'rejection is atomic across all 24 resources'); return r;
  };
  const pkg=uuid(100),src=uuid(101),src2=uuid(102),a=uuid(110),b=uuid(111);
  await q("insert into public.purchase_batches(id,product_group_id,name) values($1,$3,'Batch A'),($2,$3,'Batch B')",[uuid(200),uuid(202),uuid(1)]);
  await q('insert into public.purchase_batch_items(id,purchase_batch_id,product_variant_id,quantity,cost) values($1,$2,$5,5,0),($3,$4,$5,5,0)',[uuid(201),uuid(200),uuid(203),uuid(202),uuid(2)]);
  ok(await rpc('japan_packages',[create(pkg,{title:'Synthetic core',status:'registered'})]));
  ok(await rpc('japan_package_items',[create(src,{japan_package_id:pkg,product_title:'bundle source',sku:'SAME',quantity:5,checked:true,
    product_variant_id:uuid(2),purchase_batch_id:uuid(200),purchase_batch_item_id:uuid(201)}),
    create(src2,{japan_package_id:pkg,product_title:'other batch source',sku:'SAME',quantity:5,checked:true,
      product_variant_id:uuid(2),purchase_batch_id:uuid(202),purchase_batch_item_id:uuid(203)})]));
  assert.equal((await get('japan_packages',pkg)).status,'confirmed');
  ok(await rpc('outbound_shipments',[create(a,{title:'A'}),create(b,{title:'B'})]));
  const alloc = (id,source,shipment,quantity) => create(id,{outbound_shipment_id:shipment,japan_package_item_id:source,quantity,product_title:'Synthetic'});
  ok(await rpc('outbound_shipment_items',[alloc(uuid(120),src,a,3)]));
  ok(await rpc('outbound_shipment_items',[alloc(uuid(121),src,b,2)]));
  checks.threePlusTwo = 'PASS';
  await denied(()=>sendPatch('japan_package_items',src,{purchase_batch_item_id:uuid(203)}),'CORE_ALLOCATED_SOURCE_IDENTITY_IMMUTABLE');
  await denied(()=>sendPatch('outbound_shipment_items',uuid(120),{japan_package_item_id:null}),'CORE_SOURCE_LINK_CANNOT_CLEAR');
  await denied(()=>rpc('outbound_shipment_items',[alloc(uuid(125),src,b,0)]),'CORE_POSITIVE_QUANTITY_REQUIRED');
  ok(await rpc('outbound_shipment_items',[create(uuid(126),{outbound_shipment_id:a,quantity:2,product_title:'Manual source-free item'})]));
  checks.sourceLinkAndManualRows = 'source cannot silently lose provenance; positive manual rows remain legal';
  await denied(()=>rpc('outbound_shipment_items',[alloc(uuid(122),src,b,1)]),'CORE_SOURCE_CAPACITY');
  ok(await sendPatch('outbound_shipment_items',uuid(120),{quantity:2}));
  ok(await sendPatch('outbound_shipment_items',uuid(121),{quantity:3}));
  await denied(()=>sendPatch('outbound_shipment_items',uuid(120),{quantity:3}),'CORE_SOURCE_CAPACITY');
  checks.editRecalculates = 'PASS';
  ok(await rpc('outbound_shipment_items',[alloc(uuid(123),src2,b,5)]));
  await denied(()=>rpc('outbound_shipment_items',[alloc(uuid(124),src2,a,5)]),'CORE_SOURCE_CAPACITY');
  checks.fivePlusFiveAndSameSkuDifferentSource = 'PASS';
  const receipt = async (ids,checked) => {
    const p=await get('japan_packages',pkg);
    const items=(await q('select to_jsonb(i) r from public.japan_package_items i where japan_package_id=$1 and deleted_at is null',[pkg])).rows.map(r=>r.r);
    const command={transactionType:'set-receiving',idempotencyKey:crypto.randomUUID(),packageId:pkg,updates:ids.map(itemId=>({itemId,checked}))};
    const request=client.buildJapanPackageTransactionRequest(p,items,command,ref);
    return d.http('/rpc/erp_apply_japan_package_transaction',{p_idempotency_key:command.idempotencyKey,p_request:request},owner,{headers:host});
  };
  let r=await denied(()=>receipt([src],false),'CORE_SOURCE_CAPACITY');
  assert.equal(JSON.parse(r.data.details).cancelable,0);
  await denied(()=>sendPatch('japan_package_items',src,{quantity:4}),'CORE_SOURCE_CAPACITY');
  const free=uuid(130);
  ok(await rpc('japan_package_items',[create(free,{japan_package_id:pkg,quantity:2,checked:true})]));
  await denied(()=>receipt([free,src],false),'CORE_SOURCE_CAPACITY');
  assert.equal((await get('japan_package_items',free)).checked,true);
  ok(await receipt([free],false));
  assert.equal((await get('japan_packages',pkg)).status,'registered');
  await denied(()=>sendPatch('japan_packages',pkg,{status:'confirmed'}),'CORE_PACKAGE_PROGRESS_MISMATCH');
  ok(await receipt([free],true));
  assert.equal((await get('japan_packages',pkg)).status,'confirmed');
  checks.singleBatchAndManualStatus = 'PASS';
  // Delete one allocation, release its exact source, then demonstrate partial-row explanation.
  const oi=await get('outbound_shipment_items',uuid(120));
  ok(await rpc('outbound_shipment_items',[{kind:'delete',id:oi.id,expectedVersion:oi.version}]));
  r=await denied(()=>receipt([src],false),'CORE_SOURCE_CAPACITY');
  assert.equal(JSON.parse(r.data.details).cancelable,2);
  checks.partialRowBoolProtection = 'allocated3, cancelable2; whole-row reversal rejected';
  // Header cancellation in this model is shipment deletion (no cancelled status exists).
  ok(await rpc('outbound_shipments',[{kind:'delete',id:b,expectedVersion:(await get('outbound_shipments',b)).version}]));
  ok(await receipt([src,src2],false));
  await denied(()=>d.http('/outbound_shipments?id=eq.'+b,{deleted_at:null},owner,{method:'PATCH'}),'CORE_SOURCE_CAPACITY');
  checks.cancelReleasesAndUndeleteRevalidates = 'PASS';
  // Actual concurrent HTTP calls: the existing maintenance lock may reject the loser
  // with 55006; an explicit later retry must reject on capacity, never silently replay.
  const last=uuid(140);
  ok(await rpc('japan_package_items',[create(last,{japan_package_id:pkg,quantity:1,checked:true})]));
  const calls=await Promise.all([rpc('outbound_shipment_items',[alloc(uuid(141),last,a,1)]),rpc('outbound_shipment_items',[alloc(uuid(142),last,a,1)])]);
  assert.equal(calls.filter(r=>r.status===200&&r.data.ok).length,1,JSON.stringify(calls));
  assert.equal(Number((await q('select coalesce(sum(quantity),0) n from public.outbound_shipment_items where japan_package_item_id=$1 and deleted_at is null',[last])).rows[0].n),1);
  checks.concurrentHttpLastUnit = calls.map(r=>({status:r.status,code:r.data.code,message:r.data.message}));
  // Explicit two native connections hold one successful allocation uncommitted.
  const race=uuid(150);
  ok(await rpc('japan_package_items',[create(race,{japan_package_id:pkg,quantity:1,checked:true})]));
  const c1=new pg.Client({connectionString:d.url.toString()}),c2=new pg.Client({connectionString:d.url.toString()});
  await c1.connect();await c2.connect();
  try {
    for(const c of [c1,c2]) { await c.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await c.query('set role authenticated'); }
    await c1.query('begin');
    await c1.query('insert into public.outbound_shipment_items(id,outbound_shipment_id,japan_package_item_id,quantity) values($1,$2,$3,1)',[uuid(151),a,race]);
    await assert.rejects(c2.query('update public.japan_package_items set checked=false where id=$1',[race]),/CLOUD_RESTORE_MAINTENANCE_LOCKED/);
    await c1.query('commit');
    await assert.rejects(c2.query('update public.japan_package_items set checked=false where id=$1',[race]),/CORE_SOURCE_CAPACITY/);
    await assert.rejects(c2.query('insert into public.outbound_shipment_items(id,outbound_shipment_id,japan_package_item_id,quantity) values($1,$2,$3,1)',[uuid(152),a,race]),/CORE_SOURCE_CAPACITY/);
    await c2.query('begin isolation level repeatable read');
    await assert.rejects(c2.query('insert into public.outbound_shipment_items(id,outbound_shipment_id,quantity) values($1,$2,1)',[uuid(153),a]),/CORE_READ_COMMITTED_REQUIRED/);
    await c2.query('rollback');
    checks.nativeAllocationVsUnreceive = 'PASS';
  } finally { await c1.query('rollback').catch(()=>{});await c1.end();await c2.end(); }
  // Neither direct table DML nor a forged restore flag may bypass enforcement.
  await q('set role authenticated');
  await q("select set_config('erp.cloud_restore_active','on',false)");
  await assert.rejects(q('update public.japan_package_items set checked=false where id=$1',[race]),/CORE_SOURCE_CAPACITY/);
  await q('reset role');await q("select set_config('erp.cloud_restore_active','off',false)");
  checks.directDmlAndForgedRestoreFlag = 'PASS';
  const hist=uuid(160),hi=uuid(161);
  ok(await rpc('japan_packages',[create(hist,{title:'Historical arrived',status:'arrived',arrived_at:'2020-01-02',note:'keep'})]));
  ok(await rpc('japan_package_items',[create(hi,{japan_package_id:hist,quantity:1,checked:true})]));
  assert.equal((await get('japan_packages',hist)).status,'arrived');
  assert.equal((await get('japan_packages',hist)).arrived_at,'2020-01-02');
  checks.historyPreserved = 'PASS';
  // A second source tied to the same bundle variant remains a separate physical pool.
  // Each whole bundle source unit is allocated once; components are UI expansion only.
  const bundle1=uuid(170),bundle2=uuid(171);
  await q("insert into public.product_variants(id,product_group_id,myacg_item_code,product_title,variant_name) values($1,$3,'COMP-A','Component A','A'),($2,$3,'COMP-B','Component B','B')",[uuid(191),uuid(192),uuid(1)]);
  await q('insert into public.bundle_components(id,bundle_variant_id,component_variant_id) values($1,$3,$4),($2,$3,$5)',[uuid(193),uuid(194),uuid(2),uuid(191),uuid(192)]);
  ok(await rpc('japan_package_items',[create(bundle1,{japan_package_id:pkg,quantity:1,checked:true,product_variant_id:uuid(2)}),
    create(bundle2,{japan_package_id:pkg,quantity:1,checked:true,product_variant_id:uuid(2)})]));
  ok(await rpc('outbound_shipment_items',[alloc(uuid(172),bundle1,a,1),alloc(uuid(173),bundle2,a,1)]));
  await denied(()=>rpc('outbound_shipment_items',[alloc(uuid(174),bundle1,a,1)]),'CORE_SOURCE_CAPACITY');
  const fresh=uuid(180);
  const snap=await snapshot();
  r=await rpc('outbound_shipment_items',[alloc(fresh,free,a,1),alloc(uuid(181),bundle1,a,1)]);
  assert.equal(r.status,409);assert.equal(await get('outbound_shipment_items',fresh),undefined);
  assert.deepEqual(await snapshot(),snap);
  checks.bundleIdentityAndMultiOperationRollback = 'PASS';
  r=await rpc('outbound_shipment_items',[alloc(uuid(190),free,a,1)],viewer);
  assert.ok(r.status>=400);checks.viewerRejected='PASS';
  console.log(JSON.stringify({result:'PASS',runtime:'native PostgreSQL + authenticated PostgREST + safeupdate',checks},null,2));
} finally { await vite.close(); await d.stopPostgrest(); await d.close(); }
