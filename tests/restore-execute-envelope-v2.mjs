import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {CANONICAL_FRESH_INSTALL_V3} from '../supabase/canonicalFreshInstallV3.mjs';
import {isolatedDatabase,owner,viewer} from './helpers/saveability-isolated.mjs';
import {buildMigrationEffectRegistry} from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';

for(const entry of Object.values(await buildMigrationEffectRegistry())) {
 assert.ok(Array.isArray(entry.preconditions)&&Array.isArray(entry.postconditions)&&typeof entry.risk==='string');
}

const migration='058_restore_execute_generation_and_typed_stage.sql';
const sql=await readFile('supabase/sql/'+migration,'utf8');
const executeBody=sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.erp_restore_staged_cloud_snapshot'),sql.indexOf('-- A server restart'));
assert.doesNotMatch(executeBody,/erp_cloud_restore_snapshot\(|jsonb_populate_recordset|jsonb_to_recordset|jsonb_agg/u);
assert.match(executeBody,/STALE_RESTORE_PREPARE/u);
const compatibility='059_restore_typed_stage_dashboard_compatibility.sql';
const finalizeMigration='060_restore_prepare_bounded_finalize.sql';
const singlePassMigration='061_restore_prepare_single_pass_json.sql';
const resourceStageMigration='062_restore_resource_stage_and_projected_proof.sql';
const draftProofMigration='063_restore_prepare_draft_proof_initialization.sql';
const batchMigration='064_restore_bounded_chunk_batch_and_identity_profile.sql';
const db=await isolatedDatabase({migrations:CANONICAL_FRESH_INSTALL_V3.filter(f=>![migration,compatibility,finalizeMigration,singlePassMigration,resourceStageMigration,draftProofMigration,batchMigration].includes(f))});
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
try {
 const r=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const upload=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
 const candidate=await r.prepareCloudRestoreSnapshot(await readFile(process.env.ERP2_CHAOS_BASELINE_B,'utf8'));
 // Model the actual Live physical dashboard contract; its optional fields are
 // excluded from canonical business parity, but typed staging must be explicit.
 await db.sql.query('alter table public.dashboard_category_images drop column local_id,drop column version');
 const users=new Set(Object.values(candidate.data).flatMap(rows=>rows.map(x=>x.updated_by).filter(Boolean)));
 for(const id of users) await db.sql.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3) on conflict do nothing',[id,'fixture@example.invalid',{}]);
 const req=randomUUID(); await db.sql.query("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
 const proof=(await db.sql.query('select public.erp_prove_cloud_restore_candidate_v2($1,$2,$3,$4,$5) r',[candidate.data,candidate.manifest,'strict','isolated',req])).rows[0].r;
 assert.equal((await db.sql.query('select public.erp_restore_staged_cloud_snapshot($1,$2,$3,$4,$5) r',[randomUUID(),proof.proof_id,candidate.manifest.snapshotFingerprint,candidate.manifest,'isolated'])).rows[0].r.ok,true);
 const before=(await db.sql.query('select public.erp_cloud_restore_snapshot() d')).rows[0].d;
 await db.sql.query(sql);
 await db.sql.query(await readFile('supabase/sql/'+compatibility,'utf8'));
 await db.sql.query(await readFile('supabase/sql/'+finalizeMigration,'utf8'));
 await db.sql.query(await readFile('supabase/sql/'+singlePassMigration,'utf8'));
 await db.sql.query(await readFile('supabase/sql/'+resourceStageMigration,'utf8'));
 await db.sql.query(await readFile('supabase/sql/'+draftProofMigration,'utf8'));
 await db.sql.query(await readFile('supabase/sql/'+batchMigration,'utf8'));
 assert.deepEqual((await db.sql.query('select public.erp_cloud_restore_snapshot() d')).rows[0].d,before);
 const typedProof=(await db.sql.query('select public.erp_prove_cloud_restore_candidate_v2($1,$2,$3,$4,$5) r',[candidate.data,candidate.manifest,'strict','isolated',randomUUID()])).rows[0].r;
 assert.equal(typedProof.prepared_payload_hash,proof.prepared_payload_hash);
 assert.deepEqual(typedProof.table_counts,proof.table_counts);
 assert.deepEqual(typedProof.integrity,proof.integrity);
 const suppliedKeys=(await db.sql.query(`with supplied_columns as materialized (
   select distinct supplied.key from jsonb_array_elements($1::jsonb) row_value
   cross join lateral jsonb_object_keys(row_value) supplied(key)
 ) select array_agg(key order by key) keys from supplied_columns`,
 [JSON.stringify([{id:'first'},{id:'second',late_nullable:null,late_value:'present'}])])).rows[0].keys;
 assert.deepEqual(suppliedKeys,['id','late_nullable','late_value']);
 assert.equal((await db.sql.query('select public.erp_restore_staged_cloud_snapshot($1,$2,$3,$4,$5) r',[randomUUID(),typedProof.proof_id,candidate.manifest.snapshotFingerprint,candidate.manifest,'isolated'])).rows[0].r.ok,true);
 assert.deepEqual((await db.sql.query('select public.erp_cloud_restore_snapshot() d')).rows[0].d,before);
 const invalidGrants=(await db.sql.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and (c.relname like 'erp_restore_stage_%' or c.relname in ('erp_restore_upload_requests','erp_restore_upload_chunks','erp_restore_business_generation')) and (not c.relrowsecurity or not c.relforcerowsecurity or has_table_privilege('anon',c.oid,'SELECT') or has_table_privilege('authenticated',c.oid,'SELECT'))")).rows[0].n;
 assert.equal(invalidGrants,0);
 await db.sql.query("select set_config('request.jwt.claim.sub',$1,false)",[viewer]);
 await assert.rejects(()=>db.sql.query('select public.erp_begin_restore_upload($1,$2,$3,$4)',[randomUUID(),candidate.manifest,'strict','isolated']),e=>e.code==='42501');
 await db.sql.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
 assert.equal((await db.sql.query('select public.erp_restore_audit_identity_compatibility($1) ok',[[owner]])).rows[0].ok,true);
 assert.equal((await db.sql.query('select public.erp_restore_audit_identity_compatibility($1) ok',[[randomUUID()]])).rows[0].ok,false);
 const uploadId=randomUUID();
 await db.sql.query('select public.erp_begin_restore_upload($1,$2,$3,$4)',[uploadId,candidate.manifest,'strict','isolated']);
 await assert.rejects(()=>db.sql.query('select public.erp_finalize_restore_upload($1)',[uploadId]),/CLOUD_RESTORE_UPLOAD_INCOMPLETE/u);
 const chunk=candidate.data.inventory_items.slice(0,512);
 const chunkArgs=[uploadId,'inventory_items',0,JSON.stringify(chunk)];
 const saved=(await db.sql.query('select public.erp_upload_restore_chunk($1,$2,$3,$4) r',chunkArgs)).rows[0].r;
 assert.deepEqual((await db.sql.query('select public.erp_upload_restore_chunk($1,$2,$3,$4) r',chunkArgs)).rows[0].r,saved);
 const changed=structuredClone(chunk);changed[0].title='IMMUTABLE CHUNK PROBE';
 await assert.rejects(()=>db.sql.query('select public.erp_upload_restore_chunk($1,$2,$3,$4)',[uploadId,'inventory_items',0,JSON.stringify(changed)]),/CLOUD_RESTORE_UPLOAD_CHUNK_IDENTITY_MISMATCH/u);
 await assert.rejects(()=>db.sql.query('select public.erp_upload_restore_chunk($1,$2,$3,$4)',[uploadId,'auth.users',0,JSON.stringify(chunk)]),/CLOUD_RESTORE_UPLOAD_CHUNK_INVALID/u);
 await db.sql.query("select set_config('request.jwt.claim.sub',$1,false)",[viewer]);
 await assert.rejects(()=>db.sql.query('select public.erp_upload_restore_chunk($1,$2,$3,$4)',chunkArgs),e=>e.code==='42501');
 await db.sql.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
 await db.sql.query("update public.erp_restore_upload_requests set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where request_id=$1",[uploadId]);
 await assert.rejects(()=>db.sql.query('select public.erp_finalize_restore_upload($1)',[uploadId]),/CLOUD_RESTORE_UPLOAD_NOT_FOUND/u);
 const names=[];let active=0,maxActive=0;
 await upload.uploadCloudRestoreCandidate(async(name,args)=>{names.push(name);active++;maxActive=Math.max(active,maxActive);
  if(name==='erp_upload_restore_chunk')assert.ok(args.p_rows.length<=512);
  await new Promise(resolve=>setTimeout(resolve,1));active--;return {data:{ok:true},error:null};
 },candidate,candidate.data,'strict',randomUUID());
 assert.equal(names[0],'erp_begin_restore_upload');assert.equal(names.at(-1),'erp_finalize_restore_upload');assert.ok(maxActive<=4);
 let finalized=false;
 await assert.rejects(()=>upload.uploadCloudRestoreCandidate(async(name)=>{
   if(name==='erp_finalize_restore_upload')finalized=true;
   return {data:{},error:name.startsWith('erp_upload_restore_chunk')?{code:'42501'}:null};
 },candidate,candidate.data,'strict',randomUUID()),upload.CloudRestoreUploadServerError);
 assert.equal(finalized,false);
 // Exercise the actual authenticated PostgREST entry point with the exact
 // dataset, not only a postgres/direct call to the nested proof function.
 const timeoutConfig=(await db.sql.query("select proconfig from pg_proc where oid='public.erp_finalize_restore_upload(uuid)'::regprocedure")).rows[0].proconfig;
 assert.ok(timeoutConfig.includes('statement_timeout=25s'));
 await db.sql.query(`alter role authenticated in database ${new URL(db.url).pathname.slice(1)} set statement_timeout='8s'`);
 await db.startPostgrest();
 const transportRuns=[];
 for(let run=0;run<5;run++){
  const transportStarted=performance.now();
  const completed=await upload.uploadCloudRestoreCandidate(async(name,args)=>{
   const response=await db.http('/rpc/'+name,args,owner,{headers:{host:'rhfdjsklfrgpoqsaqpkn.supabase.co'}});
   return {data:response.data,error:response.status>=400?response.data:null};
  },candidate,candidate.data,'strict',randomUUID());
  assert.equal(completed.ok,true);
  assert.equal(completed.prepared_row_count,candidate.manifest.totalRows);
  assert.equal(completed.prepared_payload_hash,typedProof.prepared_payload_hash);
  assert.deepEqual((await db.sql.query('select public.erp_cloud_restore_snapshot() d')).rows[0].d,before);
  transportRuns.push({totalMs:performance.now()-transportStarted,assemblyMs:completed.uploadAssemblyMs,
   serverMs:completed.finalizeServerMs,proof:completed.prepareTimingsMs});
 }
 const safe=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreSubmit.ts');
 const failed={status:'not_committed',attemptId:randomUUID(),traceId:randomUUID(),expectedEpoch:1,effectiveFingerprint:'a'.repeat(64),
  failure:{phase:'reconcile',category:'DATABASE_INTERRUPTED',code:'CLOUD_RESTORE_FAILURE_DATABASE_INTERRUPTED',sqlstate:null,timeoutClassification:'unobserved',evidence:'reconciled-noncommit',failedAt:new Date().toISOString()}};
 assert.equal(r.classifyCloudRestoreCommitOutcome({outcome:r.assertCloudRestoreAttemptOutcome(failed)}),'DATABASE_INTERRUPTED_NOT_COMMITTED');
 assert.match(safe.normalizeCloudRestoreSubmitError({code:failed.failure.code},'rpc',{source:'server-response'}).message,/原資料保持不變/u);
 assert.match(safe.normalizeCloudRestoreSubmitError({code:'57014',message:'CLOUD_RESTORE_PREPARE_TIMEOUT'},'readiness',{source:'server-response'}).message,/尚未進入業務還原/u);
 const summary={trueLiveState057to064:'PASS',migrationBusinessMutation:0,preparedHashParity:'PASS',lateSuppliedColumns:'PASS',stageACL:'PASS',viewerDenied:'PASS',auditIdentityProof:'PASS',chunkIdempotency:'PASS',changedChunkRejected:'PASS',missingChunkRejected:'PASS',expiredUploadRejected:'PASS',boundedUpload:'PASS',noFinalizeOnUploadFailure:'PASS',authenticatedTransport:'PASS',transportRuns,sourceCAS:'REQUIRED',databaseInterruptedClassification:'PASS',prepareTimeoutHumanMessage:'PASS'};
 if(process.env.ERP2_RESTORE_TRANSPORT_TEST_OUTPUT){
  assert.match(process.env.ERP2_RESTORE_TRANSPORT_TEST_OUTPUT,/^scratch\//u);
  await writeFile(process.env.ERP2_RESTORE_TRANSPORT_TEST_OUTPUT,JSON.stringify(summary,null,2));
 }
 console.log(JSON.stringify(summary));
}finally{await vite.close();await db.close();}
