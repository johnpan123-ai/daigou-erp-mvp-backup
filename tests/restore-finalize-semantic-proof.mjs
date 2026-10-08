import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {isolatedDatabase,viewer} from './helpers/saveability-isolated.mjs';
import {CANONICAL_FRESH_INSTALL_V3} from '../supabase/canonicalFreshInstallV3.mjs';
const dir=process.env.RESTORE_FINALIZE_EVIDENCE_OUT??'scratch/restore-finalize-proof-p1-20261008';
const migration='069_restore_finalize_server_resource_semantic_proof.sql';
const prior=await readFile('scratch/restore-execute-envelope-v2/run-correctness-release-impact.mjs','utf8');
process.env.WACA_ISOLATED_PG_URL=prior.match(/WACA_ISOLATED_PG_URL:\s*'([^']+)'/u)[1];
const db=await isolatedDatabase({migrations:CANONICAL_FRESH_INSTALL_V3.filter(f=>f!==migration)});
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
const stats=xs=>{const s=[...xs].sort((a,b)=>a-b);return {median:(s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2,p95:s[Math.ceil(s.length*.95)-1],max:s.at(-1)};};
const report={scope:'ISOLATED_EXACT_24_RESOURCE_A_FINALIZE',runs:[],parity:[]};
try{
 const r=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const u=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
 const errors=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreSubmit.ts');
 const c=await r.prepareCloudRestoreSnapshot(await readFile(dir+'/BASELINE_A.json','utf8'));
 assert.equal(c.manifest.totalRows,25031);assert.equal(c.manifest.resourceCount,24);
 for(const id of new Set(Object.values(c.data).flatMap(rows=>rows.map(x=>x.updated_by).filter(Boolean))))await db.sql.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3) on conflict do nothing',[id,'fixture@example.invalid',{}]);
 await db.sql.query("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
 const proof=(await db.sql.query('select public.erp_prove_cloud_restore_candidate_v2($1,$2,$3,$4,$5) r',[c.data,c.manifest,'strict','isolated',randomUUID()])).rows[0].r;
 await db.sql.query('select public.erp_restore_staged_cloud_snapshot($1,$2,$3,$4,$5)',[randomUUID(),proof.proof_id,c.manifest.snapshotFingerprint,c.manifest,'isolated']);
 const snapshot=async()=>(await db.sql.query('select public.erp_cloud_restore_snapshot() d')).rows[0].d;
 const epoch=async()=>(await db.sql.query('select (select epoch from public.erp_cloud_restore_epoch where singleton) epoch,(select generation from public.erp_restore_business_generation where singleton) generation')).rows[0];
 const before=await snapshot(),generation=await epoch();
 const names=['erp_restore_staged_cloud_snapshot','erp_restore_proven_cloud_snapshot_attempt','erp_prepare_cloud_restore_attempt','erp_export_cloud_restore_snapshot_json','erp_cloud_restore_validate_waca_dataset','erp_stage_restore_upload_resource','erp_begin_restore_upload','erp_cleanup_expired_restore_ops'];
 const defs=async()=>(await db.sql.query("select proname,md5(prosrc) hash,proconfig from pg_proc where pronamespace='public'::regnamespace and proname=any($1) order by proname",[names])).rows;
 const priorDefs=await defs();
 await db.startPostgrest();
 const rpc=async(name,args)=>{const x=await db.http('/rpc/'+name,args,undefined,{headers:{host:'rhfdjsklfrgpoqsaqpkn.supabase.co'}});return {data:x.status===200?x.data:null,error:x.status===200?null:x.data,status:x.status};};
 const prepare=async({hold=false}={})=>{
  const id=randomUUID(),at=performance.now();let calls,p;
  try{p=await u.uploadCloudRestoreCandidate(async(name,args)=>{if(hold&&name==='erp_finalize_restore_upload')throw Error('ISOLATED_HOLD_FINALIZE');return rpc(name,args);},c,c.data,'strict',id,undefined,x=>{calls=x;});}
  catch(e){if(!hold||e.message!=='ISOLATED_HOLD_FINALIZE')throw e;}
  return {id,p,ms:performance.now()-at,calls};
 };
 const seed=await prepare({hold:true});
 const projection=(await db.sql.query('select jsonb_object_agg(resource,validation_rows) d from public.erp_restore_upload_resource_proofs where request_id=$1',[seed.id])).rows[0].d;
 const oldAudit=(await db.sql.query('select public.erp_cloud_restore_audit_dataset($1) a,public.erp_cloud_restore_relationship_hash($1) h',[projection])).rows[0];
 const oldCall=await rpc('erp_finalize_restore_upload',{p_request_id:seed.id});assert.equal(oldCall.error,null);report.oldFinalize=oldCall.data;
 await db.sql.query(await readFile('supabase/sql/'+migration,'utf8'));
 assert.deepEqual(await defs(),priorDefs);assert.deepEqual(await epoch(),generation);assert.deepEqual(await snapshot(),before);
 await db.sql.query("notify pgrst,'reload schema'");
 // Rebuild the same server projection in a fresh request for exact OLD/NEW parity.
 const staged=await prepare({hold:true});
 const seedRows=(await db.sql.query('select * from public.erp_restore_upload_resource_proofs where request_id=$1',[staged.id])).rows;
 const checkAudit=async()=>{
  const d=(await db.sql.query('select jsonb_object_agg(resource,validation_rows) d from public.erp_restore_upload_resource_proofs where request_id=$1',[staged.id])).rows[0].d;
  const old=(await db.sql.query('select public.erp_cloud_restore_audit_dataset($1) a,public.erp_cloud_restore_relationship_hash($1) h',[d])).rows[0];
  const next=(await db.sql.query('select public.erp_restore_upload_semantic_audit($1) a',[staged.id])).rows[0].a;
  const {execute_relationship_hash,...a}=next;assert.deepEqual(a,old.a);assert.equal(execute_relationship_hash,old.h);return {d,a};
 };
 assert.deepEqual((await checkAudit()).a,oldAudit.a);
 for(const [name,resource,mutate]of [
  ['valid A',null,()=>{}],
  ['canonical duplicate','inventory_items',rows=>rows.push(structuredClone(rows[0]))],
  ['canonical malformed','inventory_items',rows=>{rows[0].id='INVALID';}],
  ['orphan relationship','product_variants',rows=>{rows[0].product_group_id=randomUUID();}],
  ['inventory key missing','inventory_items',rows=>{delete rows[0].inventory_key;}],
  ['inventory key duplicate','inventory_items',rows=>{rows[1].inventory_key=rows[0].inventory_key;}],
  ['missing outbound timestamp','outbound_shipments',rows=>{delete rows[0].status_changed_at;}],
  ['bad WACA payload key','waca_orders',rows=>{rows[0].payload.key='WRONG';}],
 ]){
  for(const row of seedRows)await db.sql.query('update public.erp_restore_upload_resource_proofs set validation_rows=$3 where request_id=$1 and resource=$2',[staged.id,row.resource,JSON.stringify(row.validation_rows)]);
  if(resource){const rows=structuredClone(seedRows.find(x=>x.resource===resource).validation_rows);mutate(rows);await db.sql.query('update public.erp_restore_upload_resource_proofs set validation_rows=$3 where request_id=$1 and resource=$2',[staged.id,resource,JSON.stringify(rows)]);}
  await checkAudit();report.parity.push({name,result:'MATCH'});
 }
 for(const row of seedRows)await db.sql.query('update public.erp_restore_upload_resource_proofs set validation_rows=$3 where request_id=$1 and resource=$2',[staged.id,row.resource,JSON.stringify(row.validation_rows)]);
 // Cold-session then warm-session relational helper plans; no Live EXPLAIN.
 const source=(await db.sql.query("select prosrc from pg_proc where oid='public.erp_restore_upload_semantic_audit(uuid)'::regprocedure")).rows[0].prosrc;
 const q=source.slice(source.indexOf('  with\n'),source.indexOf(' into v_result;')).replaceAll('p_request_id','$1::uuid').replaceAll('v_ws',"U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF'");
 await db.sql.query("set work_mem='16MB'");report.plans=[];
 for(let n=0;n<3;n++)report.plans.push((await db.sql.query('explain(analyze,buffers,format json) '+q,[staged.id])).rows[0]['QUERY PLAN']);
 // Query-cancel injection at proof write: whole OPS Ready transition rolls back.
 await db.sql.query("create function public.finalize_probe() returns trigger language plpgsql as $$begin if new.proof_result->>'candidate_valid'='true' then raise exception using errcode='57014',message='ISOLATED_FINALIZE_CANCEL';end if;return new;end$$;create trigger finalize_probe before update on public.erp_cloud_restore_candidate_proofs for each row execute function public.finalize_probe()");
 const rejected=await rpc('erp_finalize_restore_upload',{p_request_id:staged.id});assert.equal(rejected.error.code,'57014');assert.equal(JSON.parse(rejected.error.details).phase,'proof-write');
 const notReady=(await db.sql.query('select completed_result from public.erp_restore_upload_requests where request_id=$1',[staged.id])).rows[0];assert.equal(notReady.completed_result,null);
 assert.equal((await db.sql.query('select prepared_payload_hash from public.erp_cloud_restore_candidate_proofs where proof_id=$1',[staged.id])).rows[0].prepared_payload_hash,null);
 await db.sql.query('drop trigger finalize_probe on public.erp_cloud_restore_candidate_proofs;drop function public.finalize_probe()');
 const retry=await rpc('erp_finalize_restore_upload',{p_request_id:staged.id});assert.equal(retry.error,null);assert.equal(retry.data.candidate_valid,true);
 // Commit of proof + lost response: same request returns exact immutable result.
 assert.deepEqual(await rpc('erp_finalize_restore_upload',{p_request_id:staged.id}),retry);
 assert.equal((await db.http('/rpc/erp_finalize_restore_upload',{p_request_id:staged.id},viewer,{headers:{host:'rhfdjsklfrgpoqsaqpkn.supabase.co'}})).status,403);
 assert.ok([401,403].includes((await db.http('/rpc/erp_finalize_restore_upload',{p_request_id:staged.id},null,{headers:{host:'rhfdjsklfrgpoqsaqpkn.supabase.co'}})).status));
 assert.ok([401,403,404].includes((await db.http('/rpc/erp_restore_upload_semantic_audit',{p_request_id:staged.id},undefined,{headers:{host:'rhfdjsklfrgpoqsaqpkn.supabase.co'}})).status));
 const stale=await prepare({hold:true});await db.sql.query('update public.erp_restore_business_generation set generation=generation+1 where singleton');
 const staleResponse=await rpc('erp_finalize_restore_upload',{p_request_id:stale.id});assert.equal(staleResponse.error.message,'STALE_RESTORE_PREPARE');await db.sql.query('update public.erp_restore_business_generation set generation=generation-1 where singleton');
 for(let n=0;n<20;n++){
  const x=await prepare();assert.equal(x.p.candidate_valid,true);assert.equal(x.p.statementTimeout,'25s');
  assert.equal(x.p.prepared_row_count,25031);assert.equal(x.p.resource_count,24);assert.equal(x.p.relationship_hash,c.manifest.relationshipHash);
  report.runs.push({run:n+1,requestId:x.id,totalMs:Math.round(x.ms),finalize:x.p.finalizeServerMs,proof:x.p.phaseTimingsMs.projectedSemanticProof,phases:x.p.phaseTimingsMs});
  assert.ok(x.calls.every(call=>call.httpStatus===200));console.log(JSON.stringify(report.runs.at(-1)));
 }
 assert.equal(new Set(report.runs.map(x=>x.requestId)).size,20);
 const safe=errors.createCloudRestoreSafeSubmitError({code:'RESTORE_PREPARE_FINALIZE_TIMEOUT',reasonCode:'RESTORE_PREPARE_FINALIZE_TIMEOUT',sqlstate:'57014',requestId:staged.id,preparePhase:'finalize/projected-semantic-proof'},'server-response');
 const visible=errors.normalizeCloudRestoreSubmitError(safe,'readiness');assert.equal(visible.phase,'finalize/projected-semantic-proof');assert.equal(visible.sqlstate,'57014');assert.equal(visible.requestId,staged.id);
 assert.match(errors.formatCloudRestoreSubmitError(visible),/最後驗證階段逾時/u);assert.doesNotMatch(errors.formatCloudRestoreSubmitError(visible),/\[object Object\]|還原交易/u);
 assert.deepEqual(await snapshot(),before);assert.deepEqual(await epoch(),generation);assert.deepEqual(await defs(),priorDefs);
 report.result='PASS';report.mismatch=0;report.businessMutation=0;report.exactlyOnce='PASS';report.cas='PASS';report.failureRetry='PASS';report.security='PASS';report.fullStats=stats(report.runs.map(x=>x.totalMs));report.finalizeStats=stats(report.runs.map(x=>x.finalize));report.proofStats=stats(report.runs.map(x=>x.proof));
 assert.ok(report.finalizeStats.p95<=8000);assert.ok(report.proofStats.p95<=5000);
 await mkdir(dir,{recursive:true});await writeFile(dir+'/isolated-finalize-regression.json',JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,ready:20,full:report.fullStats,finalize:report.finalizeStats,proof:report.proofStats,mismatch:0}));
}finally{await vite.close();await db.close();delete process.env.WACA_ISOLATED_PG_URL;}
