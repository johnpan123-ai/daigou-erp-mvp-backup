// Private real ERP2 backup inputs. All mutations stay in a disposable loopback DB.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {isolatedDatabase,owner} from './helpers/saveability-isolated.mjs';
import {sha,source,baseFingerprint,changedFunctions,exactFunctionDelta,rollbackSql} from '../tools/r5-release/contract.mjs';
import {fingerprintStructuralSnapshot} from '../tools/schema-reconciliation/schemaContract.mjs';
const privateDir=resolve(process.env.R5_RELEASE_PRIVATE_DIR||'missing-private-directory');
assert.ok(process.env.R5_RELEASE_PRIVATE_DIR,'Private backup directory required');
assert.ok(!privateDir.toLowerCase().startsWith(process.cwd().toLowerCase()+'/staging-release-artifacts'));
assert.notEqual(process.env.ERP2_CORE_FIX_TEST_CANDIDATE,'1','Start at v32, apply 078 only after original Restore');
const a=readFileSync(resolve(privateDir,'ERP2_AUTH_BACKUP_A.json')),b=readFileSync(resolve(privateDir,'ERP2_AUTH_BACKUP_B.json'));
assert.ok(a.equals(b),'Two independently exported authority backups must match byte for byte');
const doc=JSON.parse(a),raw=JSON.parse(readFileSync(resolve(privateDir,'AUTHORITY_RAW_A.json')));
const live=JSON.parse(readFileSync(resolve(privateDir,'LIVE_READONLY.json')));
const save=(name,value)=>writeFileSync(resolve(privateDir,name),typeof value==='string'?value:JSON.stringify(value,null,2));
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false}});
const db=await isolatedDatabase({safeupdateLibrary:process.env.WACA_TEST_SAFEUPDATE_LIBRARY,postgrestBinary:process.env.WACA_TEST_POSTGREST_BINARY});
try{
 const r=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const upload=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
 const candidate=await r.prepareCloudRestoreSnapshot(doc,{sourceFileSha256:sha(a)});
 assert.equal(doc.sourceEnvironment,'cloud-authoritative');assert.equal(candidate.manifest.resourceCount,24);
 assert.deepEqual(candidate.manifest,doc.manifest);
 const authority=await r.buildCloudRestoreManifest(raw,raw);
 assert.deepEqual(authority.manifest,candidate.manifest,'Fresh SQL authority capture matches actual UI backup');
 for(const k of ['orphanCount','duplicateVariantIdCount','duplicateVariantLocalIdCount','duplicateCanonicalIdCount','canonicalIdentityAnomalyCount'])assert.equal(candidate.manifest[k],0,k);
 const summary={result:'PASS',backupSha256:sha(a),bytes:a.length,resources:24,rows:candidate.manifest.totalRows,
  snapshotFingerprint:candidate.manifest.snapshotFingerprint,relationshipHash:candidate.manifest.relationshipHash,counts:candidate.manifest.counts,
  byteParity:'EXACT_TWO_INDEPENDENT_EXPORTS',authorityParity:'24/24',orphan:0,duplicate:0,deadlineSidecarSha256:candidate.deadlineSidecarSha256,formalWrites:0};
 save('BACKUP_GATE.json',summary);
 // Use actual pre-078 live RPC source, not a reconstructed substitute.
 assert.equal(fingerprintStructuralSnapshot(live.schema),baseFingerprint);
 for(const sig of changedFunctions){
  const liveRpc=live.rpcCatalog[sig.replace('public.','')];
  assert.deepEqual(liveRpc.acl,['postgres=X/postgres','authenticated=X/postgres'],'Exact actual live ACL must match the tested rollback profile');
  assert.equal(liveRpc.owner,'postgres');assert.equal(liveRpc.securityDefiner,true);assert.deepEqual(liveRpc.config,['search_path=""']);
  await db.sql.query(live.schema.functions[sig].definition);
 }
 for(const uid of new Set(Object.values(candidate.data).flatMap(rows=>rows.map(x=>x.updated_by).filter(x=>x&&x!==owner))))
  await db.sql.query('insert into auth.users(id,email) values($1,$2) on conflict do nothing',[uid,'isolated@example.invalid']);
 await db.startPostgrest();
 const host={host:'rhfdjsklfrgpoqsaqpkn.supabase.co'};
 const rpc=async(name,args)=>{const v=await db.http('/rpc/'+name,args,owner,{headers:host});assert.equal(v.status,200,name+': '+JSON.stringify(v.data).slice(0,350));return {data:v.data,error:null};};
 const restore=async()=>{
  const request=randomUUID(),attempt=randomUUID(),trace=randomUUID(),execution=randomUUID();
  const proof=await upload.uploadCloudRestoreCandidate(rpc,{...candidate,sourceEnvironment:'isolated'},candidate.sourceData??candidate.data,'strict',request);
  assert.equal(proof.ok,true);
  await rpc('erp_prepare_cloud_restore_attempt',{p_attempt_id:attempt,p_trace_id:trace,p_source_fingerprint:candidate.manifest.snapshotFingerprint,p_effective_fingerprint:candidate.manifest.snapshotFingerprint,p_restore_policy:'strict',p_target_environment:'rhfdjsklfrgpoqsaqpkn',p_timeout_budget_ms:120000,p_timeout_contract_version:'postgresql-statement-timeout-v1'});
  const committed=(await rpc('erp_restore_proven_cloud_snapshot_attempt',{p_attempt_id:attempt,p_trace_id:trace,p_execution_id:execution,p_proof_id:proof.proof_id,p_request_id:request})).data;
  assert.equal(committed.ok,true,JSON.stringify(committed).slice(0,400));
  const verified=(await rpc('erp_verify_committed_cloud_restore',{p_attempt_id:attempt,p_trace_id:trace,p_execution_id:execution})).data;
  assert.equal(verified.status,'RESTORE_COMMITTED_VERIFIED');assert.equal(verified.generationCertified,true);
  const rawBack=(await db.sql.query('select public.erp_export_cloud_restore_snapshot_json() data')).rows[0].data;
  const back=await r.buildCloudRestoreManifest(rawBack,rawBack);
  assert.deepEqual(back.manifest,candidate.manifest,'Every resource, canonical ID, checksum, relationship and business value restored');
  return verified.status;
 };
 const beforeRestore=await restore();
 const schema=async()=>(await db.sql.query(readFileSync('tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql','utf8'))).rows[0].erp_schema_snapshot;
 const before=await schema();assert.equal(fingerprintStructuralSnapshot(before),baseFingerprint);
 const business=(await db.sql.query('select public.erp_export_cloud_restore_snapshot_json() data')).rows[0].data;
 await db.sql.query(source());const after=await schema();exactFunctionDelta(before,after);
 assert.deepEqual((await db.sql.query('select public.erp_export_cloud_restore_snapshot_json() data')).rows[0].data,business);
 const rollback=rollbackSql(before,after);save('ROLLBACK_078_ACTUAL_LIVE_RPC_TO_V32.sql',rollback);
 await db.sql.query(rollback);assert.equal(fingerprintStructuralSnapshot(await schema()),baseFingerprint);
 assert.deepEqual((await db.sql.query('select public.erp_export_cloud_restore_snapshot_json() data')).rows[0].data,business);
 await db.sql.query(source());const afterRestore=await restore();
 for(const table of ['waca_orders','waca_order_items','waca_state','japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'])await db.sql.query('select count(*) from public.'+table);
 save('AUTHORITATIVE_RESTORE_GATE.json',{...summary,engine:'native PostgreSQL + authenticated PostgREST + safeupdate',originalV32Restore:beforeRestore,candidate078Restore:afterRestore,
  cycle:'ACTUAL_LIVE_v32_RPC -> 078 -> emergency rollback -> v32 -> 078',candidateFingerprint:fingerprintStructuralSnapshot(after),rollbackSha256:sha(rollback),businessAcrossSchemaCycle:'UNCHANGED'});
 console.log(JSON.stringify({...summary,originalV32Restore:beforeRestore,candidate078Restore:afterRestore,actualLiveRollback:'PASS'}));
}finally{await db.close();await vite.close();}
