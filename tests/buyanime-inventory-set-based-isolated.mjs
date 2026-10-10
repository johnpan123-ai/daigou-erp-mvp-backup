import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isolatedDatabase,owner,viewer} from './helpers/saveability-isolated.mjs';
const db=await isolatedDatabase();
const report={scale:[],soak:[],safety:{}};
try {
 await db.sql.query("set timezone='UTC'");
 const epoch=Number((await db.sql.query('select epoch from public.erp_cloud_restore_epoch where singleton')).rows[0].epoch);
 const generation=async()=>String((await db.sql.query('select generation from public.erp_restore_business_generation where singleton')).rows[0].generation);
 const request=operations=>({family:'inventory_import',batchId:'catalog_import_'+randomUUID(),restoreEpoch:epoch,operations});
 const call=async(name,key,r)=>(await db.sql.query(`select public.${name}($1,$2) r`,[key,JSON.stringify(r)])).rows[0].r;
 const apply=(key,r)=>call('erp_apply_inventory_import',key,r);
 const reconcile=(key,r)=>call('erp_reconcile_inventory_import',key,r);
 const id=i=>`30000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
 const ids=Array.from({length:10000},(_,i)=>id(i));
 async function fixture(count,mode){
  await db.sql.query('delete from public.inventory_items where id=any($1::uuid[])',[ids]);
  const existing=mode==='mixed'?Math.floor(count/2):count;
  const rows=Array.from({length:existing},(_,i)=>({id:id(i),inventory_key:'__ISOLATED_BUYANIME__'+i,product_title:'__ISOLATED_BUYANIME__',myacg_item_code:'G'+i,myacg_sold_quantity:0}));
  await db.sql.query('insert into public.inventory_items(id,inventory_key,product_title,myacg_item_code,myacg_sold_quantity) select id,inventory_key,product_title,myacg_item_code,myacg_sold_quantity from jsonb_populate_recordset(null::public.inventory_items,$1)',[JSON.stringify(rows)]);
  const ops=[];
  for(let i=0;i<count;i++){
   if(i>=existing)ops.push({kind:'create',id:id(i),values:{inventory_key:'__ISOLATED_BUYANIME__'+i,product_title:'__ISOLATED_BUYANIME__',myacg_item_code:'G'+i,myacg_sold_quantity:1}});
   else if(mode!=='unchanged'||i%100===0)ops.push({kind:'patch',id:id(i),observedVersion:1,expected:{myacg_sold_quantity:0},changes:{myacg_sold_quantity:1}});
  }
  return request(ops);
 }
 async function run(count,mode){
  const r=await fixture(count,mode),key=randomUUID(),started=performance.now();
  const result=await apply(key,r),ms=performance.now()-started;
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.affected,r.operations.length);
  const gen=await generation();
  assert.equal((await reconcile(key,r)).outcome,'COMMITTED');
  assert.equal((await apply(key,r)).replayed,true);assert.equal(await generation(),gen);
  const actual=(await db.sql.query('select count(*)::int n,sum(myacg_sold_quantity)::int qty,count(distinct inventory_key)::int keys from public.inventory_items where id=any($1::uuid[])',[ids])).rows[0];
  assert.deepEqual(actual,{n:count,qty:mode==='unchanged'?Math.ceil(count/100):count,keys:count});
  return {count,mode,operations:r.operations.length,ms,serverPhases:result.serverPhases,resultBytes:Buffer.byteLength(JSON.stringify(result)),committed:true};
 }
 for(const n of [500,1000,1600,3000,5000,10000])for(const mode of ['update','mixed','unchanged']){
  const result=await run(n,mode);report.scale.push(result);console.log(JSON.stringify(result));
 }
 for(const [count,runs] of [[1600,20],[5000,10],[10000,5]]){
  const measurements=[];
  for(let i=0;i<runs;i++)measurements.push(await run(count,['update','mixed','unchanged'][i%3]));
  report.soak.push({count,passed:measurements.length,runs:measurements});console.log(`SOAK ${count}: ${runs}/${runs} PASS`);
 }
 // All-before reconciliation does not mutate business generation or receipts.
 let r=await fixture(10,'mixed'),key=randomUUID(),gen=await generation();
 assert.equal((await reconcile(key,r)).outcome,'NOT_COMMITTED');assert.equal(await generation(),gen);
 assert.equal((await db.sql.query('select count(*)::int n from public.erp_idempotency_keys where idempotency_key=$1',[key])).rows[0].n,0);
 report.safety.readonlyReconcile=true;
 // Force an exception after INSERT but before the UPDATE shape. Entire call rolls back.
 await db.sql.query(`create function public.test_inventory_forced_failure() returns trigger language plpgsql as $$ begin raise exception 'TEST_FORCED_FAILURE'; end $$;
 create trigger test_inventory_forced_failure after insert on public.inventory_items for each statement execute function public.test_inventory_forced_failure()`);
 await assert.rejects(()=>apply(key,r),/TEST_FORCED_FAILURE/);
 assert.equal(await generation(),gen);assert.equal((await reconcile(key,r)).outcome,'NOT_COMMITTED');
 await db.sql.query('drop trigger test_inventory_forced_failure on public.inventory_items; drop function public.test_inventory_forced_failure()');
 assert.equal((await apply(key,r)).outcome,'COMMITTED');report.safety.forcedRollbackAndRetry=true;
 // Exact request identity and generation are mandatory, including after a receipt.
 assert.equal((await apply(key,{...r,batchId:'catalog_import_'+randomUUID()})).code,'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
 assert.equal((await apply(key,{...r,restoreEpoch:epoch+1})).code,'STALE_AFTER_RESTORE');
 report.safety.identityAndEpoch=true;
 r=await fixture(10,'update');r.operations[9].expected.myacg_sold_quantity=999;gen=await generation();
 assert.equal((await apply(randomUUID(),r)).code,'FIELD_CONFLICT');assert.equal(await generation(),gen);
 report.safety.casNoMutation=true;
 // Field-aware CAS: a disjoint update/version advance must not overwrite that field.
 r=await fixture(1,'update');await db.sql.query('update public.inventory_items set final_price=123,version=version+1 where id=$1',[id(0)]);
 assert.equal((await apply(randomUUID(),r)).ok,true);
 assert.equal(Number((await db.sql.query('select final_price from public.inventory_items where id=$1',[id(0)])).rows[0].final_price),123);
 report.safety.disjointCas=true;
 for(const role of ['anon','authenticated']){
  await db.sql.query('begin');await db.sql.query('set local role '+role);
  if(role==='authenticated')await db.sql.query("select set_config('request.jwt.claim.sub',$1,true)",[viewer]);
  await assert.rejects(()=>apply(randomUUID(),request([])),e=>e.code==='42501');await db.sql.query('rollback');
 }
 await db.sql.query('begin');await db.sql.query('set local role authenticated');
 await db.sql.query("select set_config('request.jwt.claim.sub',$1,true)",[owner]);
 await assert.rejects(()=>db.sql.query('select public.erp_inventory_import_core($1,$2,true)',[randomUUID(),JSON.stringify(request([]))]),e=>e.code==='42501');
 await db.sql.query('rollback');report.safety.anonViewerPrivateHelperDenied=true;
 // Receipt is actor scoped. No receipt is claimed to another authorized actor.
 const acl=(await db.sql.query("select has_function_privilege('anon','public.erp_apply_inventory_import(uuid,jsonb)','execute') anon,has_function_privilege('authenticated','public.erp_inventory_import_core(uuid,jsonb,boolean)','execute') helper")).rows[0];
 assert.deepEqual(acl,{anon:false,helper:false});
 if(process.env.BUYANIME_INVENTORY_REPORT)writeFileSync(process.env.BUYANIME_INVENTORY_REPORT,JSON.stringify(report,null,2));
 console.log('PASS Inventory native scale/soak + exact replay/response-loss reconcile + rollback + CAS + epoch + ACL');
}finally{await db.close();}
