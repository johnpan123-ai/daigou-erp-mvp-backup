import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createServer} from 'vite';
import pg from 'pg';
import {isolatedDatabase,owner,viewer} from './helpers/saveability-isolated.mjs';
import {CANONICAL_FRESH_INSTALL_V3} from '../supabase/canonicalFreshInstallV3.mjs';
const migration='067_restore_begin_independent_bounded_ops_cleanup.sql';
const dir=process.env.RESTORE_CLEANUP_EVIDENCE_OUT??'scratch/restore-expired-ops-cleanup-p1-20261008';
const prior=await readFile('scratch/restore-execute-envelope-v2/run-correctness-release-impact.mjs','utf8');
const localUrl=prior.match(/WACA_ISOLATED_PG_URL:\s*'([^']+)'/u)?.[1];
assert.equal(new URL(localUrl).hostname,'127.0.0.1');assert.equal(new URL(localUrl).port,'55492');
process.env.WACA_ISOLATED_PG_URL=localUrl;
const db=await isolatedDatabase({migrations:CANONICAL_FRESH_INSTALL_V3.filter(f=>f!==migration)});
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
const report={scope:'ISOLATED_FULL_A_EXPIRED_OPS',prepareRuns:[],cleanupBatches:[],beginScale:[]};
const stats=values=>{const s=[...values].sort((a,b)=>a-b);return {median:(s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2,p95:s[Math.ceil(s.length*.95)-1],max:s.at(-1)};};
try {
 const r=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const upload=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
 const maint=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreOpsMaintenance.ts');
 const errors=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreSubmit.ts');
 const c=await r.prepareCloudRestoreSnapshot(await readFile(dir+'/BASELINE_A.json','utf8'));
 assert.equal(c.manifest.totalRows,25031);assert.equal(c.manifest.resourceCount,24);
 for(const id of new Set(Object.values(c.data).flatMap(rows=>rows.map(x=>x.updated_by).filter(Boolean))))await db.sql.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3) on conflict do nothing',[id,'fixture@example.invalid',{}]);
 await db.sql.query("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
 const proof=(await db.sql.query('select public.erp_prove_cloud_restore_candidate_v2($1,$2,$3,$4,$5) r',[c.data,c.manifest,'strict','isolated',randomUUID()])).rows[0].r;
 await db.sql.query('select public.erp_restore_staged_cloud_snapshot($1,$2,$3,$4,$5)',[randomUUID(),proof.proof_id,c.manifest.snapshotFingerprint,c.manifest,'isolated']);
 const snapshot=async()=>(await db.sql.query('select public.erp_cloud_restore_snapshot() d')).rows[0].d;
 const epoch=async()=>(await db.sql.query('select (select epoch from public.erp_cloud_restore_epoch where singleton) epoch,(select generation from public.erp_restore_business_generation where singleton) generation')).rows[0];
 const before=await snapshot(), beforeGeneration=await epoch();
 const names=['erp_restore_staged_cloud_snapshot','erp_restore_proven_cloud_snapshot_attempt','erp_prepare_cloud_restore_attempt','erp_export_cloud_restore_snapshot_json','erp_cloud_restore_validate_waca_dataset','erp_stage_restore_upload_resource','erp_finalize_restore_upload'];
 const defs=async()=>(await db.sql.query("select proname,md5(prosrc) hash,proconfig from pg_proc where pronamespace='public'::regnamespace and proname=any($1) order by proname",[names])).rows;
 const priorDefs=await defs();await db.sql.query(await readFile('supabase/sql/'+migration,'utf8'));
 assert.deepEqual(await defs(),priorDefs);assert.deepEqual(await epoch(),beforeGeneration);assert.deepEqual(await snapshot(),before);
 await db.startPostgrest();
 const rpc=async(name,args)=>{const x=await db.http('/rpc/'+name,args,undefined,{headers:{host:'rhfdjsklfrgpoqsaqpkn.supabase.co'}});return {data:x.status===200?x.data:null,error:x.status===200?null:x.data,status:x.status};};
 const prepare=async()=>{const id=randomUUID(),start=performance.now();let calls;const p=await upload.uploadCloudRestoreCandidate(rpc,c,c.data,'strict',id,undefined,x=>{calls=x;});assert.equal(p.candidate_valid,true);return {id,p,ms:performance.now()-start,calls};};
 const seed=await prepare();
 const stageTables=(await db.sql.query("select tablename from pg_tables where schemaname='public' and tablename like 'erp_restore_stage_%' order by tablename")).rows.map(x=>x.tablename);
 const cloneRow=async(table,pk,seedId,newId,overrides)=>{
  const cols=(await db.sql.query("select attname from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum",['public.'+table])).rows.map(x=>'"'+x.attname+'"').join(',');
  const value=(await db.sql.query(`select to_jsonb(t) d from public.${table} t where ${pk}=$1`,[seedId])).rows[0].d;
  const row={...value,...overrides,[pk]:newId};
  if(table==='erp_cloud_restore_candidate_proofs')await db.sql.query(`update public.${table} set (${cols})=(select ${cols} from jsonb_populate_record(null::public.${table},$2)) where ${pk}=$1`,[newId,JSON.stringify(row)]);
  else await db.sql.query(`insert into public.${table} select * from jsonb_populate_record(null::public.${table},$1)`,[JSON.stringify(row)]);
 };
 const expired=[];
 const copy=async({expired:expire=false,unresolved=false}={})=>{
  const id=randomUUID();const times=expire?{created_at:new Date(Date.now()-7200000).toISOString(),expires_at:new Date(Date.now()-3600000).toISOString()}:{};
  await cloneRow('erp_restore_upload_requests','request_id',seed.id,id,{});
  await cloneRow('erp_cloud_restore_candidate_proofs','proof_id',seed.id,id,{...times,...(unresolved?{effective_fingerprint:'f'.repeat(64)}:{})});
  for(const table of stageTables){const cols=(await db.sql.query("select attname from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum",['public.'+table])).rows.map(x=>x.attname==='restore_proof_id'?'$2::uuid':'"'+x.attname+'"').join(',');await db.sql.query(`insert into public.${table} select ${cols} from public.${table} where restore_proof_id=$1`,[seed.id,id]);}
  await db.sql.query('insert into public.erp_cloud_restore_prepared_chunks select $2,actor_key,resource,chunk_ordinal,row_count,rows,payload_hash,$3,$4 from public.erp_cloud_restore_prepared_chunks where proof_id=$1',[seed.id,id,times.created_at??new Date().toISOString(),times.expires_at??new Date(Date.now()+1800000).toISOString()]);
  if(expire)await db.sql.query('update public.erp_restore_upload_requests set created_at=$2,expires_at=$3 where request_id=$1',[id,times.created_at,times.expires_at]);
  return id;
 };
 for(let n=0;n<12;n++)expired.push(await copy({expired:true}));
 const active=await copy(),recent=seed.id,unresolved=await copy({expired:true,unresolved:true});
 await db.sql.query(`insert into public.erp_cloud_restore_attempts(attempt_id,trace_id,actor_key,source_fingerprint,effective_fingerprint,restore_policy,target_environment,expected_epoch,timeout_budget_ms,timeout_contract_version,grace_ms,status)
  select $1,$2,actor_key,source_fingerprint,effective_fingerprint,restore_policy,target_environment,source_restore_epoch,120000,'postgresql-statement-timeout-v1',15000,'prepared' from public.erp_cloud_restore_candidate_proofs where proof_id=$3`,[randomUUID(),randomUUID(),unresolved]);
 const bytes=Number((await db.sql.query('select sum(pg_column_size(rows)) bytes from public.erp_cloud_restore_prepared_chunks where proof_id=any($1::uuid[])',[expired])).rows[0].bytes);
 assert.ok(bytes>=60*1024*1024);report.fixture={expired:12,preparedBytes:bytes,active,recent,unresolved};
 for(let n=0;n<10;n++){const x=await prepare();report.prepareRuns.push({run:n+1,requestId:x.id,totalMs:x.ms,beginMs:x.calls[0].wallMs,beginServerMs:x.calls[0].serverMs});assert.deepEqual(await rpc('erp_finalize_restore_upload',{p_request_id:x.id}),{data:x.p,error:null,status:200});console.log(JSON.stringify(report.prepareRuns.at(-1)));}
 // No work proportional to backlog: lightweight expired intents up to 100.
 for(const scale of [10,50,100]){
  while(expired.length<scale) {const id=randomUUID();await cloneRow('erp_restore_upload_requests','request_id',seed.id,id,{completed_result:null});
   for(const [table,key]of [['erp_restore_upload_requests','request_id'],['erp_cloud_restore_candidate_proofs','proof_id']])await db.sql.query(`update public.${table} set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where ${key}=$1`,[id]);expired.push(id);}
  const times=[];for(let n=0;n<5;n++){const t=performance.now();const result=await rpc('erp_begin_restore_upload',{p_request_id:randomUUID(),p_manifest:c.manifest,p_restore_mode:'strict',p_source_environment:'isolated'});assert.equal(result.error,null);times.push(performance.now()-t);}
  report.beginScale.push({scale,...stats(times)});
 }
 // A maintenance transaction lock must yield without harming a concurrent Begin.
 const conn=new pg.Client({connectionString:db.url.toString()});await conn.connect();
 const first=expired[0];await conn.query('begin');await conn.query('select request_id from public.erp_restore_upload_requests where request_id=$1 for update',[first]);
 assert.equal((await rpc('erp_cleanup_expired_restore_ops',{p_exclude_request_id:null})).data.status,'busy');
 const concurrent=await Promise.all([0,1].map(()=>rpc('erp_begin_restore_upload',{p_request_id:randomUUID(),p_manifest:c.manifest,p_restore_mode:'strict',p_source_environment:'isolated'})));assert.ok(concurrent.every(x=>!x.error));
 await conn.query('rollback');await conn.end();
 // Inject a cleanup-only failure. Atomic OPS rollback, then safe retry.
 await db.sql.query("create function public.cleanup_probe() returns trigger language plpgsql as $$begin raise exception 'CLEANUP_ISOLATED_FAILURE';end$$;create trigger cleanup_probe before delete on public.erp_cloud_restore_prepared_chunks for each statement execute function public.cleanup_probe()");
 assert.ok((await rpc('erp_cleanup_expired_restore_ops',{p_exclude_request_id:null})).error);
 assert.equal((await rpc('erp_begin_restore_upload',{p_request_id:randomUUID(),p_manifest:c.manifest,p_restore_mode:'strict',p_source_environment:'isolated'})).error,null);
 await db.sql.query('drop trigger cleanup_probe on public.erp_cloud_restore_prepared_chunks;drop function public.cleanup_probe()');
 for(let batch=0;batch<500;batch++){
  const result=await rpc('erp_cleanup_expired_restore_ops',{p_exclude_request_id:null});assert.equal(result.error,null);
  if(result.data.status==='idle')break;assert.equal(result.data.status,'progress');assert.ok(result.data.serverMs<5000);report.cleanupBatches.push(result.data);
 }
 const left=(await db.sql.query('select count(*)::int n from public.erp_restore_upload_requests where request_id=any($1::uuid[])',[expired])).rows[0].n;assert.equal(left,0);
 for(const id of [active,recent,unresolved])assert.equal((await db.sql.query('select count(*)::int n from public.erp_cloud_restore_candidate_proofs where proof_id=$1',[id])).rows[0].n,1);
 const denied=await db.http('/rpc/erp_cleanup_expired_restore_ops',{},viewer,{headers:{host:'rhfdjsklfrgpoqsaqpkn.supabase.co'}});assert.equal(denied.status,403);
 const anon=await db.http('/rpc/erp_cleanup_expired_restore_ops',{},null,{headers:{host:'rhfdjsklfrgpoqsaqpkn.supabase.co'}});assert.ok([401,403].includes(anon.status));
 await maint.cleanupExpiredRestoreOps(async()=>{throw Error('maintenance offline');},seed.id);
 let count=0;await maint.cleanupExpiredRestoreOps(async()=>({data:{status:++count<3?'progress':'idle'},error:null}),seed.id);assert.equal(count,3);
 for(const code of ['RESTORE_PREPARE_BEGIN_FAILED','RESTORE_PREPARE_BEGIN_TIMEOUT']){const safe=errors.createCloudRestoreSafeSubmitError({code,reasonCode:code,requestId:seed.id,sqlstate:'57014'},'server-response');const visible=errors.normalizeCloudRestoreSubmitError(safe,'readiness');assert.equal(visible.phase,'prepare-begin');assert.equal(visible.requestId,seed.id);assert.equal(visible.sqlstate,'57014');assert.doesNotMatch(errors.formatCloudRestoreSubmitError(visible),/\[object Object\]|還原交易/u);}
 assert.deepEqual(await snapshot(),before);assert.deepEqual(await epoch(),beforeGeneration);assert.deepEqual(await defs(),priorDefs);
 report.prepareStats=stats(report.prepareRuns.map(x=>x.totalMs));report.beginStats=stats(report.prepareRuns.map(x=>x.beginServerMs));report.cleanupStats=stats(report.cleanupBatches.map(x=>x.serverMs));
 assert.ok(report.prepareStats.median<=5000&&report.prepareStats.p95<=8000);assert.ok(report.beginStats.p95<=2000);assert.ok(report.cleanupStats.p95<=2000);
 report.result='PASS';report.businessMutation=0;report.expiredRemaining=0;report.activePreserved=true;report.unresolvedPreserved=true;report.recentPreserved=true;report.unchangedDefinitions=priorDefs;
 await mkdir(dir,{recursive:true});await writeFile(dir+'/isolated-cleanup-regression.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({result:report.result,fixture:report.fixture,prepare:report.prepareStats,begin:report.beginStats,cleanup:report.cleanupStats,batches:report.cleanupBatches.length,businessMutation:0}));
}catch(error){throw Error(`ISOLATED_CLEANUP_REGRESSION_FAILED:${error.code??'ASSERT'}:${error.message}`);}
finally{await vite.close();await db.close();delete process.env.WACA_ISOLATED_PG_URL;}
