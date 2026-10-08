import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {isolatedDatabase} from './helpers/saveability-isolated.mjs';
import {CANONICAL_FRESH_INSTALL_V3} from '../supabase/canonicalFreshInstallV3.mjs';
const dir=process.env.CATALOG_LARGE_EVIDENCE_DIR;
if(!dir) throw Error('CATALOG_LARGE_EVIDENCE_DIR_REQUIRED');
const prior=await readFile('scratch/restore-execute-envelope-v2/run-correctness-release-impact.mjs','utf8');
process.env.WACA_ISOLATED_PG_URL=prior.match(/WACA_ISOLATED_PG_URL:\s*'([^']+)'/u)[1];
const db=await isolatedDatabase({migrations:CANONICAL_FRESH_INSTALL_V3.filter(name=>!name.startsWith('070_'))});
const request=JSON.parse(await readFile(dir+'/incident-catalog-request.json','utf8'));
const current=JSON.parse(await readFile(dir+'/PRE_TASK_CURRENT_RECOVERY.json','utf8'));
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},appType:'custom'});
const r=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
const originalCandidate=await r.prepareCloudRestoreSnapshot(JSON.stringify(current));
const initial=structuredClone(originalCandidate.data);
const census={};
for(const [table,ops] of Object.entries(request.operations)){
 const creates=new Set(ops.filter(o=>o.kind==='create').map(o=>o.id));
 const patches=new Map(ops.filter(o=>o.kind==='patch').map(o=>[o.id,o]));
 initial[table]=initial[table].filter(row=>!creates.has(row.id)).map(row=>{
  const op=patches.get(row.id);return op?{...row,...op.expected,version:op.observedVersion}:row;
 });
 const ids=ops.map(o=>o.id);census[table]={operations:ops.length,uniqueIds:new Set(ids).size,
  kinds:Object.fromEntries([...new Set(ops.map(o=>o.kind))].map(k=>[k,ops.filter(o=>o.kind===k).length])),
  duplicateIds:ids.length-new Set(ids).size,
  fieldShapes:[...new Set(ops.map(o=>Object.keys(o.values??o.changes??{}).sort().join(',')))].length,
  noops:ops.filter(o=>o.kind==='patch'&&JSON.stringify(o.expected)===JSON.stringify(o.changes)).length};
}
await writeFile(dir+'/operation-census.json',JSON.stringify(census,null,2));
try{
 const upload=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
 // Exact real snapshot, but the initial Catalog state is reconstructed from
 // completed receipt CREATE ids and PATCH expected fields; never Live writes.
 await db.sql.query('select set_config(\'request.headers\',$1,false)',[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
 const candidate={...originalCandidate,...await r.buildCloudRestoreManifest(initial)};
 if(initial.dashboard_category_images.every(row=>!Object.hasOwn(row,'local_id')&&!Object.hasOwn(row,'version')))
  await db.sql.query('alter table public.dashboard_category_images drop column local_id,drop column version');
 for(const id of new Set(Object.values(initial).flatMap(rows=>rows.map(x=>x.updated_by).filter(Boolean))))
  await db.sql.query('insert into auth.users(id,email) values($1,$2) on conflict do nothing',[id,'isolated@example.invalid']);
 const requestId=randomUUID(),attempt=randomUUID(),trace=randomUUID();
 const proof=await upload.uploadCloudRestoreCandidate(async(name,args)=>{
  const keys={erp_begin_restore_upload:['p_request_id','p_manifest','p_restore_mode','p_source_environment'],
   erp_upload_restore_chunk:['p_request_id','p_resource','p_ordinal','p_rows'],erp_upload_restore_chunk_batch:['p_request_id','p_chunks'],
   erp_stage_restore_upload_resource:['p_request_id','p_resource'],erp_finalize_restore_upload:['p_request_id']};
  const values=keys[name].map(k=>typeof args[k]==='object'?JSON.stringify(args[k]):args[k]);
  return {data:(await db.sql.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) result`,values)).rows[0].result,error:null};
 },{...candidate,sourceEnvironment:'isolated'},candidate.data,'strict',requestId);
 assert.equal(proof.ok,true);
 await db.sql.query('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,$7,$8)',
  [attempt,trace,candidate.manifest.snapshotFingerprint,candidate.manifest.snapshotFingerprint,'strict','rhfdjsklfrgpoqsaqpkn',120000,'postgresql-statement-timeout-v1']);
 const restored=(await db.sql.query('select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result',[attempt,trace,randomUUID(),proof.proof_id,requestId])).rows[0].result;
 assert.equal(restored.ok,true,JSON.stringify(restored));
 for(const [table,expected] of Object.entries(request.dependencies)){
  // Restore intentionally starts fresh versions; reproduce the exact receipt
  // dependencies in this disposable clone for the Catalog replay benchmark.
  await db.sql.query(`alter table public.${table} disable trigger user`);
  await db.sql.query(`update public.${table} t set version=e.version from jsonb_to_recordset($1) e(id uuid,version int) where t.id=e.id`,[JSON.stringify(expected)]);
  await db.sql.query(`alter table public.${table} enable trigger user`);
  const rows=(await db.sql.query(`select id,version from public.${table} where deleted_at is null order by id`)).rows;
  assert.ok(JSON.stringify(rows)===JSON.stringify(expected),'EXACT_DEPENDENCY:'+table);
 }
const results=[];
 const reset=async()=>{
  for(const table of ['product_variants','product_categories','product_groups']){
   const ops=request.operations[table];
   const ids=ops.filter(o=>o.kind==='create').map(o=>o.id);
   if(ids.length) await db.sql.query('delete from public.'+table+' where id=ANY($1::uuid[])',[ids]);
   await db.sql.query('alter table public.'+table+' disable trigger user');
   for(const op of ops.filter(o=>o.kind==='patch')){
    const keys=Object.keys(op.expected);
    const assignments=keys.map(k=>'"'+k+'"=typed."'+k+'"').join(',');
    await db.sql.query('update public.'+table+' target set '+assignments+',version=$3 from jsonb_populate_record(NULL::public.'+table+',$2) typed where target.id=$1',[op.id,op.expected,op.observedVersion]);
   }
   await db.sql.query('alter table public.'+table+' enable trigger user');
  }
 };
 const verify=async()=>{
  for(const [table,ops]of Object.entries(request.operations)){
   const invalid=(await db.sql.query(
    "select count(*)::int n from jsonb_array_elements($1) o left join public."+table+" t on t.id=(o->>'id')::uuid where t.id is null or exists(select 1 from jsonb_each(coalesce(o->'values',o->'changes')) e where to_jsonb(t)->e.key is distinct from e.value)",
    [JSON.stringify(ops)])).rows[0].n;
   assert.equal(invalid,0,'EXACT_RESULT:'+table);
  }
 };
 const safety=async()=>({counts:await Promise.all(Object.keys(initial).map(async table=>(await db.sql.query('select count(*)::int n from public.'+table)).rows[0].n)),
   epoch:(await db.sql.query('select to_jsonb(s) value from public.erp_cloud_restore_epoch s')).rows,
   generation:(await db.sql.query('select to_jsonb(s) value from public.erp_restore_business_generation s')).rows});
 const migrationBefore=await safety();
 await db.sql.query(await readFile('supabase/sql/070_catalog_set_based_commit_and_reconciliation.sql','utf8'));
 assert.deepEqual(await safety(),migrationBefore,'MIGRATION_BUSINESS_MUTATION_ZERO');
 for(let run=1;run<=21;run++){
  if(run>1)await reset();
  const key=randomUUID(),start=performance.now();
  const result=(await db.sql.query('select public.erp_apply_catalog_transaction($1,$2) result',[key,request])).rows[0].result;
  const wallMs=performance.now()-start;
  assert.equal(result.ok,true,JSON.stringify(result));
  await verify();
  const outcome=(await db.sql.query('select public.erp_reconcile_catalog_transaction($1,$2) result',[key,request])).rows[0].result;
  assert.equal(outcome.outcome,'COMMITTED');assert.equal(outcome.result.idempotencyKey,key);
  const receipt=(await db.sql.query('select status from public.erp_idempotency_keys where idempotency_key=$1',[key])).rows[0];
  assert.equal(receipt.status,'completed');
  if(run>1)results.push({run:run-1,wallMs,serverPhases:result.serverPhases,status:'COMMITTED'});
  console.log(JSON.stringify({run,warmup:run===1,wallMs,status:'COMMITTED'}));
 }
 // Same identity replays only the receipt, even after the dependency state moved.
 const replayKey=randomUUID();
 await reset();
 const first=(await db.sql.query('select public.erp_apply_catalog_transaction($1,$2) result',[replayKey,request])).rows[0].result;
 assert.equal(first.ok,true);for(let n=0;n<5;n++){
  const replay=(await db.sql.query('select public.erp_apply_catalog_transaction($1,$2) result',[replayKey,request])).rows[0].result;
  assert.equal(replay.ok,true);assert.equal(replay.replayed,true);
 }
 await verify();
 // Failed Variant INSERT rolls back earlier Group/Category writes and receipt.
 await reset();
 const bad=structuredClone(request);bad.operations.product_variants[0].values.product_group_id=randomUUID();
 const failKey=randomUUID();
 const failed=(await db.sql.query('select public.erp_apply_catalog_transaction($1,$2) result',[failKey,bad])).rows[0].result;
 assert.equal(failed.ok,false);
 for(const [table,ops]of Object.entries(request.operations)){
  const ids=ops.filter(o=>o.kind==='create').map(o=>o.id);
  assert.equal((await db.sql.query('select count(*)::int n from public.'+table+' where id=ANY($1::uuid[])',[ids])).rows[0].n,0,'ROLLBACK:'+table);
 }
 assert.equal((await db.sql.query('select count(*)::int n from public.erp_idempotency_keys where idempotency_key=$1',[failKey])).rows[0].n,0);
 const absent=(await db.sql.query('select public.erp_reconcile_catalog_transaction($1,$2) result',[failKey,bad])).rows[0].result;
 assert.equal(absent.outcome,'NOT_COMMITTED');
 const repaired=(await db.sql.query('select public.erp_apply_catalog_transaction($1,$2) result',[failKey,request])).rows[0].result;
 assert.equal(repaired.ok,true);await verify();
 const explain={};
 for(const [label,file] of [['before','056_catalog_materialized_purchase_projection.sql'],['after','070_catalog_set_based_commit_and_reconciliation.sql']]) {
  await reset();await db.sql.query(await readFile('supabase/sql/'+file,'utf8'));
  await db.sql.query('begin');
  explain[label]=(await db.sql.query('explain (analyze,buffers,format json) select public.erp_apply_catalog_transaction($1,$2)',[randomUUID(),request])).rows[0]['QUERY PLAN'];
  await db.sql.query('rollback');
 }
 await writeFile(dir+'/isolated-query-plans.json',JSON.stringify(explain,null,2));
 await writeFile(dir+'/heavy-commit-acceptance.json',JSON.stringify({census,results,forcedRollback:'PASS',exactReceiptReplay:'PASS',migrationBusinessMutation:0},null,2));
 console.log('PASS 20/20 actual committed heavy transactions, exact rows, forced rollback, absent/completed receipt, same identity x5');
}finally{await vite.close();await db.close();}
