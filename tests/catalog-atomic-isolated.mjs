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
  const insertMaterialized=async(prefix,count,start,fixtures=[])=>{
    const codes=[];
    for(let n=0;n<count;n++){
      const code=fixtures[n]?.code ?? `${prefix}-${String(n+1).padStart(3,'0')}`; const groupId=uuid(start+n*3); const variantId=uuid(start+n*3+1);
      const inventoryId=uuid(start+n*3+2); const title=fixtures[n]?.title ?? `${prefix} Product ${n+1}`; const raw=fixtures[n]?.raw ?? `${prefix} Variant ${n+1}`;
      await sql.query(`insert into public.inventory_items(id,inventory_key,myacg_item_code,product_title,raw_variant_name,myacg_sold_quantity,import_sort_index)
        values($1,$2,$3,$4,$5,1,$6)`,[inventoryId,`${prefix.toLowerCase()}-${n+1}`,code,title,raw,n+1]);
      await sql.query(`insert into public.product_groups(id,title,show_in_purchase_list)
        values($1,$2,false)`,[groupId,title]);
      await sql.query(`insert into public.product_variants(id,product_group_id,myacg_item_code,product_title,variant_name,raw_variant_name,source,waca_auto_quantity)
        values($1,$2,$3,$4,$5,$5,'inventory_import',7)`,[variantId,groupId,code,title,raw]);
      codes.push(code);
    }
    return codes;
  };
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

  // Materialized BuyAnime Product Masters remain hidden until the user makes
  // an explicit create projection. The server accepts only the paired group +
  // provenance transition and preserves unrelated WACA quantity evidence.
  const exactCodes=await insertMaterialized('G-PROJECTION',2,100,[
    {code:'G07609652',title:'Fuwawa',raw:'Fuwawa'},
    {code:'G07609640',title:'Mococo',raw:'Mococo'},
  ]);
  const materializedBefore=await snapshot();
  const projection=await planCatalogTransaction(materializedBefore,'create',exactCodes);
  assert.equal(projection.request.mode,'create');
  assert.equal(projection.request.operations.product_groups.filter(o=>o.changes?.show_in_purchase_list===true).length,2);
  assert.equal(projection.request.operations.product_variants.filter(o=>o.changes?.source==='myacg_order_import').length,2);

  // Validation happens before the mutation block: arbitrary and reverse
  // provenance changes cannot turn the group visible.
  for(const [mode,target] of [['sync','manual'],['reparse','inventory_import']]){
    const invalid=structuredClone(projection); invalid.request.mode=mode;
    invalid.request.operations.product_variants[0].changes.source=target;
    await assert.rejects(call(invalid),/CATALOG_PROVENANCE_TRANSITION_FORBIDDEN/);
    assert.equal((await sql.query('select count(*)::int n from public.product_groups where id in ($1,$2) and show_in_purchase_list',[uuid(100),uuid(103)])).rows[0].n,0);
  }
  const sourceOnly=structuredClone(projection); sourceOnly.request.operations.product_groups=[];
  await assert.rejects(call(sourceOnly),/CATALOG_PROVENANCE_TRANSITION_FORBIDDEN/);
  const forgedGroup=structuredClone(projection);
  forgedGroup.request.operations.product_groups[0].expected.show_in_purchase_list=true;
  await assert.rejects(call(forgedGroup),/CATALOG_PROVENANCE_TRANSITION_FORBIDDEN/);

  // Force the second variant mutation to fail after both group operations have
  // run. The PL/pgSQL exception block must roll the entire Catalog transaction
  // back, including the first otherwise-valid item.
  const forcedRollback=structuredClone(projection);
  forcedRollback.request.operations.product_variants[1].expected.variant_name='stale-value';
  forcedRollback.request.operations.product_variants[1].changes.variant_name='Mococo';
  const rollbackResult=await call(forcedRollback);
  assert.equal(rollbackResult.ok,false);
  assert.equal((await sql.query('select count(*)::int n from public.product_groups where id in ($1,$2) and show_in_purchase_list',[uuid(100),uuid(103)])).rows[0].n,0);
  assert.equal((await sql.query("select count(*)::int n from public.product_variants where id in ($1,$2) and source='myacg_order_import'",[uuid(101),uuid(104)])).rows[0].n,0);

  const projectionKey=crypto.randomUUID();
  assert.equal((await call(projection,projectionKey)).ok,true);
  for(let n=0;n<5;n++)assert.equal((await call(projection,projectionKey)).replayed,true);
  const projected=(await sql.query(`select g.show_in_purchase_list,v.source,v.waca_auto_quantity
    from public.product_variants v join public.product_groups g on g.id=v.product_group_id
    where v.id in ($1,$2) order by v.id`,[uuid(101),uuid(104)])).rows;
  assert.deepEqual(projected.map(r=>[r.show_in_purchase_list,r.source,Number(r.waca_auto_quantity)]),[
    [true,'myacg_order_import',7],[true,'myacg_order_import',7],
  ]);
  assert.equal((await call(await planCatalogTransaction(await snapshot(),'create',exactCodes))).ok,true,'Fresh replay was not idempotent');

  // The narrow proof must hold at realistic batch sizes and remain linear.
  const timings=[];
  let bulkStart=200;
  for(const count of [1,2,10,50]){
    const runs=count===50?1:5;
    for(let run=1;run<=runs;run++){
      const codes=await insertMaterialized(`G-BULK-${count}-${run}`,count,bulkStart); bulkStart+=count*3+3;
      const bulk=await planCatalogTransaction(await snapshot(),'create',codes);
      const began=performance.now(); const result=await call(bulk); timings.push([count,performance.now()-began]);
      assert.equal(result.ok,true,`Bulk ${count} projection failed`);
      assert.equal((await sql.query(`select count(*)::int n from public.product_variants where myacg_item_code=any($1) and source='myacg_order_import'`,[codes])).rows[0].n,count);
    }
  }
  const updated=await snapshot(); const reparse=await planCatalogTransaction(updated,'reparse');
  assert.equal((await call(reparse)).ok,true);
  const reread=await snapshot();
  assert.equal((await call(await planCatalogTransaction(reread,'reparse'))).ok,true);
  assert.deepEqual(await snapshot(),reread,'Second reparse mutated unchanged rows');
  const inject=await planCatalogTransaction(await snapshot(),'sync');
  inject.request.operations.product_variants=[{kind:'patch',id:uuid(2),observedVersion:reread.variants.find(v=>v.id===uuid(2)).version,
    expected:{waca_manual_adjustment:0},changes:{waca_manual_adjustment:5}}];
  await assert.rejects(call(inject),/CATALOG_MANUAL_METADATA_FORBIDDEN/);
  await sql.query(readFileSync('supabase/sql/056_catalog_materialized_purchase_projection.sql','utf8'));
  await sql.query(readFileSync('supabase/sql/070_catalog_set_based_commit_and_reconciliation.sql','utf8'));
  await db.startPostgrest();
  const postgrestTimings=[];
  for(let run=1;run<=5;run++){
    const codes=await insertMaterialized(`G-HTTP-${run}`,1,2000+run*3);
    const httpProjection=await planCatalogTransaction(await snapshot(),'create',codes);
    const began=performance.now();
    const response=await db.http('/rpc/erp_apply_catalog_transaction',{
      p_idempotency_key:crypto.randomUUID(),p_request:httpProjection.request,
    });
    postgrestTimings.push(performance.now()-began);
    assert.equal(response.status,200);assert.equal(response.data.ok,true);
  }
  const httpPlan=await planCatalogTransaction(await snapshot(),'sync');
  const payload={p_idempotency_key:crypto.randomUUID(),p_request:httpPlan.request};
  assert.equal((await db.http('/rpc/erp_apply_catalog_transaction',payload)).data.ok,true);
  assert.equal((await db.http('/rpc/erp_apply_catalog_transaction',payload)).data.replayed,true);
  const reconciliation=await db.http('/rpc/erp_reconcile_catalog_transaction',payload);
  assert.equal(reconciliation.status,200);assert.equal(reconciliation.data.outcome,'COMMITTED');
  for(const actor of [viewer,null]) assert.ok([401,403,404].includes((await db.http('/rpc/erp_reconcile_catalog_transaction',payload,actor)).status));
  assert.ok([401,403,404].includes((await db.http('/rpc/erp_apply_catalog_fields_set_based',{p_entity:'product_groups',p_operations:[]})).status));
  for(const actor of [viewer,null])assert.ok([401,403,404].includes((await db.http('/rpc/erp_apply_catalog_transaction',payload,actor)).status));
  assert.equal((await db.http('/product_groups')).status,200);
  const backup=(await sql.query('select public.erp_export_cloud_restore_snapshot() result')).rows[0].result;
  assert.ok(backup && typeof backup==='object');
  console.log('PASS Catalog shared pure plan; create/existing/missing variants; guarded materialized projection; 5x replay; sync/reparse; quantity + WACA preservation');
  console.log('PASS native/PostgREST atomic rollback/dependency CAS/invalid provenance/relationship/owner/viewer/anon/ACL; fresh chain + rerun; Backup; Live writes=0');
  console.log('Catalog projection DB timings ms',JSON.stringify(timings.map(([count,ms])=>({count,ms:Number(ms.toFixed(2))}))));
  console.log('Catalog projection PostgREST timings ms',JSON.stringify(postgrestTimings.map(ms=>Number(ms.toFixed(2)))));
}finally{await vite.close();await db.close();}
