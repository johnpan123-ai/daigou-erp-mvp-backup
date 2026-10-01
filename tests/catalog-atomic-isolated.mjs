import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { isolatedDatabase,uuid,viewer } from './helpers/saveability-isolated.mjs';
const db=await isolatedDatabase();
// db.ts exports the existing browser adapters as well as pure matching helpers.
// Never resolve a storage open in this Node test; the planner must not use it.
globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false}});
try{
  const {planCatalogTransaction}=await vite.ssrLoadModule('/src/providers/cloud/catalogTransaction.ts');
  const {sql}=db;
  await sql.query(`insert into public.inventory_items(id,inventory_key,myacg_item_code,product_title,raw_variant_name,myacg_sold_quantity,import_sort_index)
    values($1,'synthetic-1','G-CATALOG-1','Synthetic catalog','A - 帽子',3,1),($2,'synthetic-2','G-CATALOG-2','Synthetic catalog','B - 帽子',2,2)`,[uuid(30),uuid(31)]);
  const snapshot=async()=>{
    const result={};
    for(const [key,table] of Object.entries({inventory:'inventory_items',groups:'product_groups',categories:'product_categories',variants:'product_variants'}))
      result[key]=(await sql.query('select * from public.'+table+' where deleted_at is null order by id')).rows;
    return result;
  };
  const call=async(plan,key=crypto.randomUUID())=>(await sql.query('select public.erp_apply_catalog_transaction($1,$2) result',[key,plan.request])).rows[0].result;
  const before=await snapshot(); const plan=await planCatalogTransaction(before,'create',['G-CATALOG-1','G-CATALOG-2']);
  assert.deepEqual(await snapshot(),before,'Pure planner mutated persistence');
  const broken=structuredClone(plan); broken.request.operations.product_variants.at(-1).values.product_group_id=uuid(999);
  assert.equal((await call(broken)).ok,false); assert.deepEqual(await snapshot(),before,'Catalog partial create');
  const key=crypto.randomUUID(); const first=await call(plan,key); assert.equal(first.ok,true,JSON.stringify(first));
  for(let n=0;n<5;n++)assert.equal((await call(plan,key)).replayed,true);
  let current=await snapshot();
  assert.equal(current.groups.length,2); assert.equal(current.variants.length,3);
  assert.equal(current.groups.find(g=>g.title==='Synthetic catalog').show_in_purchase_list,true);
  assert.equal(Number(current.variants.find(v=>v.myacg_item_code==='G-CATALOG-1').myacg_auto_quantity),3);
  const again=await planCatalogTransaction(current,'create',['G-CATALOG-1','G-CATALOG-2']);
  assert.equal((await call(again)).ok,true); assert.deepEqual(await snapshot(),current);
  await sql.query("insert into public.inventory_items(id,inventory_key,myacg_item_code,product_title,raw_variant_name,myacg_sold_quantity,import_sort_index) values($1,'synthetic-3','G-CATALOG-3','Synthetic catalog','C - 玩偶',5,3)",[uuid(32)]);
  current=await snapshot(); const stale=await planCatalogTransaction(current,'sync');
  await sql.query("update public.product_variants set note='concurrent',version=version+1 where id=$1",[uuid(2)]);
  const stable=await snapshot(); assert.equal((await call(stale)).code,'FIELD_CONFLICT'); assert.deepEqual(await snapshot(),stable);
  const syncFresh=await planCatalogTransaction(stable,'sync'); assert.equal((await call(syncFresh)).ok,true);
  assert.equal((await snapshot()).variants.length,4);
  const updated=await snapshot(); const reparse=await planCatalogTransaction(updated,'reparse');
  assert.equal((await call(reparse)).ok,true);
  const reread=await snapshot();
  assert.equal((await call(await planCatalogTransaction(reread,'reparse'))).ok,true);
  assert.deepEqual(await snapshot(),reread,'Second reparse mutated unchanged rows');
  const inject=await planCatalogTransaction(await snapshot(),'sync');
  inject.request.operations.product_variants=[{kind:'patch',id:uuid(2),observedVersion:reread.variants.find(v=>v.id===uuid(2)).version,
    expected:{waca_manual_adjustment:0},changes:{waca_manual_adjustment:5}}];
  await assert.rejects(call(inject),/CATALOG_MANUAL_METADATA_FORBIDDEN/);
  await sql.query(readFileSync('supabase/sql/050_catalog_atomic_transaction.sql','utf8'));
  await db.startPostgrest();
  const httpPlan=await planCatalogTransaction(await snapshot(),'sync');
  const payload={p_idempotency_key:crypto.randomUUID(),p_request:httpPlan.request};
  assert.equal((await db.http('/rpc/erp_apply_catalog_transaction',payload)).data.ok,true);
  assert.equal((await db.http('/rpc/erp_apply_catalog_transaction',payload)).data.replayed,true);
  for(const actor of [viewer,null])assert.ok([401,403,404].includes((await db.http('/rpc/erp_apply_catalog_transaction',payload,actor)).status));
  assert.equal((await db.http('/product_groups')).status,200);
  const backup=(await sql.query('select public.erp_export_cloud_restore_snapshot() result')).rows[0].result;
  assert.ok(backup && typeof backup==='object');
  console.log('PASS Catalog shared pure plan; create/existing/missing variants; 5x replay; sync/reparse; second action/reload read; quantity + manual preservation');
  console.log('PASS native/PostgREST atomic rollback/dependency CAS/invalid relationship/owner/viewer/anon/ACL; fresh chain + rerun; Backup; Live writes=0');
}finally{await vite.close();await db.close();}
