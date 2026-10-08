import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {isolatedDatabase,owner,viewer} from './helpers/saveability-isolated.mjs';

const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},appType:'custom'});
const db=await isolatedDatabase();
const out=process.env.RESTORE_POSTCOMMIT_EVIDENCE_DIR;
const results={liveRestore:0,liveBusinessWrite:0,executeReplay:0,cases:[]};
try {
 const domain=await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePostCommit.ts');
 const atomic=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const portability=await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
 const upload=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
 const current=process.env.ERP2_CURRENT_REAL_SNAPSHOT;
 assert.ok(current,'Exact current 24-resource backup required');
 const original=await atomic.prepareCloudRestoreSnapshot(await readFile(current,'utf8'));
 await db.sql.query("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
 const candidate=await portability.prepareCrossEnvironmentCloudRestoreCandidate(original,'rhfdjsklfrgpoqsaqpkn');
 const attempt=randomUUID(),trace=randomUUID(),execution=randomUUID(),request=randomUUID();
 const proof=await upload.uploadCloudRestoreCandidate(async(name,args)=>{
  const keys={erp_begin_restore_upload:['p_request_id','p_manifest','p_restore_mode','p_source_environment'],
   erp_upload_restore_chunk:['p_request_id','p_resource','p_ordinal','p_rows'],erp_upload_restore_chunk_batch:['p_request_id','p_chunks'],
   erp_stage_restore_upload_resource:['p_request_id','p_resource'],erp_finalize_restore_upload:['p_request_id']};
  const values=keys[name].map(k=>typeof args[k]==='object'?JSON.stringify(args[k]):args[k]);
  return {data:(await db.sql.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) result`,values)).rows[0].result,error:null};
 },{...candidate,sourceEnvironment:'isolated'},candidate.sourceData??candidate.data,
  candidate.portability?'cross-environment':'strict',request);
 await db.sql.query('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,$7,$8)',
  [attempt,trace,candidate.portability?.sourceSnapshotFingerprint??candidate.manifest.snapshotFingerprint,
   candidate.manifest.snapshotFingerprint,candidate.portability?.policyVersion??'strict','rhfdjsklfrgpoqsaqpkn',120000,'postgresql-statement-timeout-v1']);
 const result=(await db.sql.query('select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result',
  [attempt,trace,execution,proof.proof_id,request])).rows[0].result;
 assert.equal(result.ok,true);
 const identity={attemptId:attempt,traceId:trace,executionId:execution};
 const read=async()=>domain.parseRestoreVerificationSummary((await db.sql.query(
  'select public.erp_verify_committed_cloud_restore($1,$2,$3) result',[attempt,trace,execution])).rows[0].result,identity);
 const summary=await domain.verifyCommittedRestore(read,result,async()=>{});
 assert.equal(summary.generationCertified,true);
 assert.equal(summary.status,'RESTORE_COMMITTED_VERIFIED');
 assert.equal(summary.totalRows,candidate.manifest.totalRows);
 assert.ok(JSON.stringify(summary).length<10000,'Small summary, not 24MB response');
 results.summaryBytes=JSON.stringify(summary).length;results.serverMs=summary.elapsedMs;
 results.cases.push('A committed + verified');
 for(const [label,error]of [['B network',new TypeError('private transport detail')],
  ['C 5xx',new domain.RestoreReadbackError('RESTORE_READBACK_SERVER_ERROR',undefined,503)],
  ['D timeout',new domain.RestoreReadbackError('RESTORE_READBACK_TIMEOUT','57014',500)]]){
  let calls=0;const delays=[];
  await domain.verifyCommittedRestore(async()=>{if(++calls===1)throw error;return read();},result,async ms=>delays.push(ms));
  assert.equal(calls,2);assert.deepEqual(delays,[1000]);results.cases.push(label+' retry verified');
 }
 let calls=0;const waits=[];
 await assert.rejects(domain.verifyCommittedRestore(async()=>{calls++;throw new TypeError('private');},result,
  async ms=>waits.push(ms)),e=>e.code==='RESTORE_READBACK_NETWORK_ERROR');
 assert.equal(calls,4);assert.deepEqual(waits,[1000,2000,4000]);results.cases.push('bounded exhaustion retains committed pending');
 const lost=(await db.sql.query('select public.erp_reconcile_cloud_restore_attempt($1,$2) result',[attempt,trace])).rows[0].result;
 assert.equal(lost.status,'completed');await domain.verifyCommittedRestore(read,lost.restoreResult,async()=>{});
 results.cases.push('E response loss / reload receipt reconcile without Execute');
 const before=(await db.sql.query('select generation from public.erp_restore_business_generation')).rows[0].generation;
 await db.sql.query('update public.product_groups set title=title||$1 where id=$2',['-changed-after-commit',candidate.data.product_groups[0].id]);
 assert.notEqual((await db.sql.query('select generation from public.erp_restore_business_generation')).rows[0].generation,before);
 calls=0;await assert.rejects(domain.verifyCommittedRestore(async()=>{calls++;return read();},result,async()=>{}),
  e=>e.code==='RESTORE_COMMITTED_STATE_MISMATCH');assert.equal(calls,1);
 results.cases.push('F same counts + changed field fails closed');
 await assert.rejects(db.sql.query('select public.erp_verify_committed_cloud_restore($1,$2,$3)',[randomUUID(),trace,execution]),
  e=>e.code==='22023');results.cases.push('G uncommitted / wrong receipt rejected');
 const panel=await readFile('src/components/CloudAtomicRestorePanel.tsx','utf8');
 const global=await readFile('src/contexts/CloudRealtimeSyncContext.tsx','utf8');
 assert.match(panel,/activeVerificationRef\.current !== unresolvedAttempt\.attemptId/u);
 assert.match(panel,/if \(!matching\(\)\) return/u);
 assert.match(global,/previous === attemptId \? null : previous/u);
 const complete=panel.slice(panel.indexOf('const completeRestore ='),panel.indexOf('const checkOutcome ='));
 assert.ok(complete.indexOf('verifyCommittedRestore')<complete.indexOf('clearCloudRestoreUnresolvedAttempt()'));
 assert.ok(complete.indexOf('await refreshAuthoritative')<complete.indexOf('clearCloudRestoreUnresolvedAttempt()'));
 assert.match(complete,/if \(!readOnly\) await restoreDeadlineDurableBackup/u);
 assert.doesNotMatch(complete,/executeRestore|restoreCloudSnapshot|prepareCloudRestoreAttempt/u);
 results.cases.push('H old completion cannot unpause newer request');
 await db.startPostgrest();
 for(const actor of [null,viewer]){
  const denied=await db.http('/rpc/erp_verify_committed_cloud_restore',
   {p_attempt_id:attempt,p_trace_id:trace,p_execution_id:execution},actor);
  assert.ok([401,403].includes(denied.status));
 }
 const other=randomUUID();await db.sql.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'other@invalid.test','{}')",[other]);
 await db.sql.query("update public.profiles set role='owner' where user_id=$1",[other]);
 const denied=await db.http('/rpc/erp_verify_committed_cloud_restore',
  {p_attempt_id:attempt,p_trace_id:trace,p_execution_id:execution},other);
 assert.equal(denied.status,400);assert.equal(denied.data.code,'22023');
 results.security='PASS';results.result='PASS';
 if(out){await mkdir(out,{recursive:true});await writeFile(out+'/postcommit-regression.json',JSON.stringify(results,null,2));}
 console.log(JSON.stringify(results));
} finally {await db.close();await vite.close();}
