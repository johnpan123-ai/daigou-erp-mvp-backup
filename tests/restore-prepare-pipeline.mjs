import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {isolatedDatabase,owner} from './helpers/saveability-isolated.mjs';
import {CANONICAL_FRESH_INSTALL_V3} from '../supabase/canonicalFreshInstallV3.mjs';
const migration='063_restore_prepare_draft_proof_initialization.sql';
const db=await isolatedDatabase({migrations:CANONICAL_FRESH_INSTALL_V3.filter(f=>![migration,'064_restore_bounded_chunk_batch_and_identity_profile.sql','066_restore_prepare_set_based_resource_staging.sql','067_restore_begin_independent_bounded_ops_cleanup.sql','068_restore_ops_conservative_batch_envelope.sql','069_restore_finalize_server_resource_semantic_proof.sql'].includes(f))});
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
const a=new pg.Client({connectionString:db.url.toString()}),b=new pg.Client({connectionString:db.url.toString()});
try {
 await a.connect();await b.connect();
 const restore=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const upload=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
 const safe=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreSubmit.ts');
 const connectivity=await vite.ssrLoadModule('/src/providers/cloud/cloudConnectivity.ts');
 const candidate=await restore.prepareCloudRestoreSnapshot(await readFile(process.env.ERP2_CHAOS_BASELINE_B,'utf8'));
 for(const client of [db.sql,a,b]){await client.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await client.query("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);}
 for(const id of new Set(Object.values(candidate.data).flatMap(rows=>rows.map(x=>x.updated_by).filter(Boolean))))await db.sql.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3) on conflict do nothing',[id,'fixture@example.invalid',{}]);
 const contention=async(expectedWait)=>{
  const request=randomUUID();await db.sql.query('select public.erp_begin_restore_upload($1,$2,$3,$4)',[request,candidate.manifest,'strict','isolated']);
  if(!expectedWait){const proof=(await db.sql.query('select prepared_payload_hash,source_generation,expected_relationship_hash,proof_result from public.erp_cloud_restore_candidate_proofs where proof_id=$1',[request])).rows[0];assert.equal(proof.prepared_payload_hash,null);assert.equal(proof.source_generation,null);assert.equal(proof.expected_relationship_hash,null);assert.equal(proof.proof_result.candidate_valid,false);}
  for(const resource of ['inventory_items','product_variants'])for(let i=0;i<candidate.data[resource].length;i+=512)await db.sql.query('select public.erp_upload_restore_chunk($1,$2,$3,$4)',[request,resource,i/512,JSON.stringify(candidate.data[resource].slice(i,i+512))]);
  await a.query('begin');await a.query('select public.erp_stage_restore_upload_resource($1,$2)',[request,'inventory_items']);
  let settled=false;const pending=b.query('select public.erp_stage_restore_upload_resource($1,$2)',[request,'product_variants']).then(r=>{settled=true;return r;});
  await new Promise(r=>setTimeout(r,1000));
  const wait=(await db.sql.query('select wait_event_type,wait_event from pg_stat_activity where pid=$1',[b.processID])).rows[0];
  const settledBeforeCommit=settled;
  await a.query('commit');await pending;
  if(expectedWait){assert.equal(settledBeforeCommit,false);assert.equal(wait.wait_event,'transactionid');}
  else {assert.equal(settledBeforeCommit,true);assert.notEqual(wait.wait_event,'transactionid');}
  return {settledBeforeCommit,wait};
 };
 const before=await contention(true);
 const snapshot=(await db.sql.query('select public.erp_cloud_restore_snapshot() d')).rows[0].d;
 await db.sql.query(await readFile('supabase/sql/'+migration,'utf8'));
 assert.deepEqual((await db.sql.query('select public.erp_cloud_restore_snapshot() d')).rows[0].d,snapshot);
 const after=await contention(false);
 const calls=[];const completed=new Map();let active=0,maxActive=0;
 await upload.uploadCloudRestoreCandidate(async(name,args)=>{
  calls.push({name,resource:args.p_resource});active++;maxActive=Math.max(maxActive,active);
  if(name==='erp_stage_restore_upload_resource')assert.equal(completed.get(args.p_resource)??0,Math.ceil(candidate.data[args.p_resource].length/512));
  await new Promise(r=>setTimeout(r,2));
  for(const part of name==='erp_upload_restore_chunk'?[args]:name==='erp_upload_restore_chunk_batch'?args.p_chunks:[])
   completed.set(part.p_resource,(completed.get(part.p_resource)??0)+1);
  active--;return {data:{ok:true},error:null};
 },candidate,candidate.data,'strict',randomUUID());
 assert.ok(maxActive<=4);
 const firstNonemptyStage=calls.findIndex(c=>c.name==='erp_stage_restore_upload_resource'&&candidate.data[c.resource].length>0);
 assert.ok(calls.slice(firstNonemptyStage+1).some(c=>c.name.startsWith('erp_upload_restore_chunk')));
 assert.equal(calls.at(-1).name,'erp_finalize_restore_upload');
 for(const failure of ['erp_upload_restore_chunk_batch','erp_stage_restore_upload_resource']){
  let finalized=false;
  await assert.rejects(()=>upload.uploadCloudRestoreCandidate(async(name)=>{if(name==='erp_finalize_restore_upload')finalized=true;return {data:{},error:name===failure?{code:'42501'}:null};},candidate,candidate.data,'strict',randomUUID()),upload.CloudRestoreUploadServerError);
  assert.equal(finalized,false);
 }
 const singletonData=Object.fromEntries(restore.CLOUD_RESTORE_TABLES.map(([,resource])=>[resource,resource==='inventory_items'?candidate.data.inventory_items.slice(0,1):[]]));
 let singletonFinalized=false;
 await assert.rejects(()=>upload.uploadCloudRestoreCandidate(async(name)=>{if(name==='erp_finalize_restore_upload')singletonFinalized=true;return {data:{},error:name==='erp_upload_restore_chunk'?{code:'42501'}:null};},candidate,singletonData,'strict',randomUUID()),upload.CloudRestoreUploadServerError);
 assert.equal(singletonFinalized,false);
 const input={cloudMode:true,authenticated:true,owner:true};let refreshCalls=0;
 connectivity.markCloudReadFresh(1);
 assert.equal((await safe.ensureCloudRestorePrepareReadiness(input,async()=>{refreshCalls++;return true;})).allowed,true);assert.equal(refreshCalls,0);
 connectivity.markCloudReadDeferred(true);
 assert.equal((await safe.ensureCloudRestorePrepareReadiness(input,async()=>{refreshCalls++;connectivity.markCloudReadFresh(1);return true;})).allowed,true);assert.equal(refreshCalls,1);
 connectivity.markCloudReadFailed('isolated',true);
 assert.equal((await safe.ensureCloudRestorePrepareReadiness(input,async()=>false)).allowed,false);
 assert.equal((await safe.ensureCloudRestorePrepareReadiness({...input,owner:false},async()=>{throw Error('MUST_NOT_REFRESH');})).allowed,false);
 console.log(JSON.stringify({before,after,migrationBusinessMutation:0,draftUnexecutable:'PASS',pipeline:'PASS',maxActive,noFinalizeOnFailure:'PASS',freshReadReuse:'PASS',staleReadRefresh:'PASS'}));
}finally{await a.query('rollback').catch(()=>{});await a.end();await b.end();await vite.close();await db.close();}
