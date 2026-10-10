import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {isolatedDatabase} from './helpers/saveability-isolated.mjs';
globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
const db=await isolatedDatabase();
try {
 await db.sql.query("set timezone='UTC'");
 const {BuyAnimeImportPipeline,importJournalId,proveInventoryRows}=await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
 const {planCloudInventoryImport}=await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
 const {planCatalogTransaction}=await vite.ssrLoadModule('/src/providers/cloud/catalogTransaction.ts');
 const rows=async table=>(await db.sql.query('select to_jsonb(t) r from public.'+table+' t where deleted_at is null order by id')).rows.map(x=>x.r);
 const rpc=async(name,key,r)=>{const v=(await db.sql.query('select public.'+name+'($1,$2) r',[key,JSON.stringify(r)])).rows[0].r;if(v.code==='FIELD_CONFLICT'&&v.entity==='inventory_items'){
  const op=r.operations.find(o=>o.id===v.recordId);const before=(await db.sql.query('select to_jsonb(t) r from public.inventory_items t where id=$1',[v.recordId])).rows[0].r;
  console.log(JSON.stringify({casMismatch:Object.entries(op.expected).filter(([k,val])=>JSON.stringify(val)!==JSON.stringify(before[k])).map(([k,val])=>({field:k,expected:val,current:before[k]}))}));
 }assert.equal(v.ok,true,JSON.stringify(v));return v;};
 const epoch=Number((await db.sql.query('select epoch from public.erp_cloud_restore_epoch where singleton')).rows[0].epoch);
 const port={
  readRestoreGeneration:async()=>({epoch,restoredAt:null}),
  load:async batchId=>(await db.sql.query('select details->\'record\' r from public.import_batches where id=$1',[importJournalId(batchId)])).rows[0]?.r??null,
  save:async(r,v)=>{
   const next={...r,version:v+1};const id=importJournalId(r.batchId);
   const result=v===0?await db.sql.query("insert into public.import_batches(id,platform,file_name,total_rows,valid_rows,imported_at,details,version) values($1,'buyanime-catalog-resume-v1',$2,$3,$3,$4,$5,$6) returning id",[id,r.fileName,r.expected.length,r.observedAt,{record:next},next.version])
    :await db.sql.query('update public.import_batches set details=$1,version=$2 where id=$3 and version=$4 returning id',[{record:next},next.version,id,v]);
   assert.equal(result.rowCount,1);return next;
  },
  prepareInventory:async incoming=>planCloudInventoryImport(await rows('inventory_items'),incoming),
  commitInventory:async(_plan,r)=>rpc('erp_apply_inventory_import',r.inventory.key,r.inventory.request),
  reconcileInventory:async r=>(await rpc('erp_reconcile_inventory_import',r.inventory.key,r.inventory.request)).outcome,
  resumeInventory:async r=>rpc('erp_apply_inventory_import',r.inventory.key,r.inventory.request),
  readInventory:async r=>(await db.sql.query('select to_jsonb(t) r from public.inventory_items t where id=any($1::uuid[])',[r.expected.map(x=>x.id)])).rows.map(x=>x.r),
  planCatalog:async(imported,inventory)=>planCatalogTransaction({inventory:inventory??await rows('inventory_items'),groups:await rows('product_groups'),categories:await rows('product_categories'),variants:await rows('product_variants')},'master',imported.map(r=>r.myacg_item_code)),
  commitCatalog:async c=>rpc('erp_apply_catalog_transaction',c.key,c.plan.request),
  reconcileCatalog:async c=>(await rpc('erp_reconcile_catalog_transaction',c.key,c.plan.request)).outcome,
  verifyCatalog:async c=>{
   for(const [table,ops]of Object.entries(c.plan.request.operations)){
    const mismatch=(await db.sql.query("select count(*)::int n from jsonb_array_elements($1) o left join public."+table+" t on t.id=(o->>'id')::uuid where t.id is null or exists(select 1 from jsonb_each(coalesce(o->'values',o->'changes')) e where to_jsonb(t)->e.key is distinct from e.value)",[JSON.stringify(ops)])).rows[0].n;
    assert.equal(mismatch,0,table);
   }
  },
 };
 const reset=async()=>db.sql.query('delete from public.product_variants;delete from public.product_categories;delete from public.product_groups;delete from public.inventory_items;delete from public.import_batches;delete from public.erp_idempotency_keys');
 const fixture=n=>Array.from({length:n},(_,i)=>({myacg_item_code:'SCALE-'+i,product_title:'__ISOLATED_PIPELINE__ '+Math.floor(i/10),raw_variant_name:'Spec '+i,listing_type:'日本代購',final_price:100,myacg_available_quantity:0,myacg_sold_quantity:1,myacg_listed_at:'',import_sort_index:i}));
 async function run(input){
  const batchId='catalog_import_'+randomUUID(), observedAt=new Date().toISOString();
  const imported=input.map(r=>({...r,latest_catalog_import_id:batchId,catalog_last_seen_at:observedAt}));
  const pipeline=new BuyAnimeImportPipeline(port);const started=performance.now();
  const first=await pipeline.start(imported,'isolated-scale.xls');const result=await pipeline.resume(first);
  assert.equal(result.stage,'COMPLETE');assert.equal((await port.load(batchId)).stage,'COMPLETE');
  await proveInventoryRows(result,await port.readInventory(result));
  const inv=await rows('inventory_items'), variants=await rows('product_variants');
  assert.equal(new Set(inv.map(x=>x.inventory_key)).size,inv.length);
  assert.equal(new Set(variants.map(x=>x.myacg_item_code)).size,variants.length);
  assert.equal(variants.length,input.length,'REAL_CATALOG_VARIANTS_REQUIRED');
  assert.equal(inv.reduce((s,x)=>s+Number(x.myacg_sold_quantity),0),input.reduce((s,x)=>s+x.myacg_sold_quantity,0));
  return {rows:input.length,ms:performance.now()-started,stage:result.stage,inventory:inv.length,variants:variants.length,stats:result.stats};
 }
 const report={scope:'native Inventory + real Catalog planner/writer + durable journal + authoritative readback; excludes XLS/browser/network/Backup',scale:[],soak:[]};
 for(const n of [500,1000,1600,3000,5000,10000]){
  await reset();const input=fixture(n);await run(input);
  for(const mode of ['mostly-update','mixed-create-update','mostly-unchanged']){
   const next=mode==='mostly-update'?input.map(x=>({...x,myacg_sold_quantity:2})):
    mode==='mixed-create-update'?input.map((x,i)=>({...x,myacg_item_code:i<n/2?x.myacg_item_code:'NEW-'+i,myacg_sold_quantity:3})):input;
   if(mode==='mixed-create-update'){await reset();await run(next.slice(0,n/2).map(row=>({...row,myacg_sold_quantity:1})));}
   if(mode==='mostly-unchanged'){await reset();await run(input);}
   const result={mode,...await run(next)};
   if(mode==='mixed-create-update'){
    assert.equal(result.stats.newCount,n/2);
    assert.equal(result.stats.updatedCount,n/2);
   }
   report.scale.push(result);console.log(JSON.stringify(result));
  }
 }
 for(const [n,count]of [[1600,20],[5000,10],[10000,5]]){
  await reset();const input=fixture(n),runs=[];
  for(let i=0;i<count;i++)runs.push(await run(input.map(r=>({...r,myacg_sold_quantity:1+i%2}))));
  report.soak.push({n,count,runs});console.log('PIPELINE SOAK '+n+': '+count+'/'+count);
 }
 await reset();const input=fixture(1600),same=[];for(let i=0;i<5;i++)same.push(await run(input));report.sameFile=same;
 if(process.env.BUYANIME_PIPELINE_REPORT)writeFileSync(process.env.BUYANIME_PIPELINE_REPORT,JSON.stringify(report,null,2));
 console.log('PASS native full durable pipeline scale/soak/same file; no UI benchmark claim');
}catch(error){console.error(JSON.stringify({error:error.code||error.message,cause:error.cause?.code,message:error.cause?.message,stack:error.cause?.stack?.split('\n').slice(0,4)}));process.exitCode=1;}
finally{await vite.close();await db.close();}
