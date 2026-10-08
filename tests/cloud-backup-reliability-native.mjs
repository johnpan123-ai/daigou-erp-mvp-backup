// Exact private snapshots are provided through local paths; never connect to Live.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'vite';
import {CANONICAL_FRESH_INSTALL_V3} from '../supabase/canonicalFreshInstallV3.mjs';
import {isolatedDatabase,owner,viewer} from './helpers/saveability-isolated.mjs';
import {fingerprintStructuralSnapshot} from '../tools/schema-reconciliation/schemaContract.mjs';
const migration='065_cloud_backup_stable_readonly_execution.sql';
// Model the observed production 8s budget through this disposable connection
// only. Never ALTER ROLE, even on the shared local test cluster.
const localUrl=new URL(process.env.WACA_ISOLATED_PG_URL);
assert.equal(localUrl.hostname,'127.0.0.1');assert.equal(localUrl.port,'55492');
localUrl.searchParams.set('options','-c statement_timeout=8000');
process.env.WACA_ISOLATED_PG_URL=localUrl.toString().replace(/\+/g,'%20');
const db=await isolatedDatabase({migrations:CANONICAL_FRESH_INSTALL_V3.filter(x=>x!==migration)});
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
const report={liveBusinessWrite:0,liveRestore:0,resources:24,failures:[],runs:[]};
try {
 const r=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const text=await readFile(process.env.ERP2_CURRENT_REAL_SNAPSHOT,'utf8');
 const candidate=await r.prepareCloudRestoreSnapshot(text);
 assert.equal(candidate.manifest.resourceCount,24);assert.equal(candidate.manifest.totalRows,25031);
 if(candidate.data.dashboard_category_images.every(x=>!Object.hasOwn(x,'local_id')&&!Object.hasOwn(x,'version')))
  await db.sql.query('alter table public.dashboard_category_images drop column local_id,drop column version');
 for(const id of new Set(Object.values(candidate.data).flatMap(rows=>rows.map(x=>x.updated_by).filter(Boolean))))
  await db.sql.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3) on conflict do nothing',[id,'fixture@example.invalid',{}]);
 await db.sql.query("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
 const upload=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
 const request=randomUUID(),attempt=randomUUID(),trace=randomUUID();
 const proof=await upload.uploadCloudRestoreCandidate(async(name,args)=>{
  const keys={erp_begin_restore_upload:['p_request_id','p_manifest','p_restore_mode','p_source_environment'],
   erp_upload_restore_chunk:['p_request_id','p_resource','p_ordinal','p_rows'],
   erp_upload_restore_chunk_batch:['p_request_id','p_chunks'],erp_stage_restore_upload_resource:['p_request_id','p_resource'],erp_finalize_restore_upload:['p_request_id']};
  const values=keys[name].map(key=>typeof args[key]==='object'?JSON.stringify(args[key]):args[key]);
  return {data:(await db.sql.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) result`,values)).rows[0].result,error:null};
 },{...candidate,sourceEnvironment:'isolated'},candidate.data,'strict',request);
 await db.sql.query('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,$7,$8)',
  [attempt,trace,candidate.manifest.snapshotFingerprint,candidate.manifest.snapshotFingerprint,'strict','rhfdjsklfrgpoqsaqpkn',120000,'postgresql-statement-timeout-v1']);
 const executeArgs=[attempt,trace,randomUUID(),proof.proof_id,request];
 assert.equal(Buffer.byteLength(JSON.stringify(Object.fromEntries(['p_attempt_id','p_trace_id','p_execution_id','p_proof_id','p_request_id'].map((k,i)=>[k,executeArgs[i]])))),269);
 assert.equal((await db.sql.query('select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) r',executeArgs)).rows[0].r.ok,true);
 const metadata=async()=>(await db.sql.query("select oid,prosrc,provolatile,prosecdef,proowner,proacl,proconfig,prorettype from pg_proc where oid='public.erp_export_cloud_restore_snapshot_json()'::regprocedure")).rows[0];
 const state=async()=>(await db.sql.query('select (select epoch from public.erp_cloud_restore_epoch where singleton) restore_epoch,(select generation from public.erp_restore_business_generation where singleton) source_generation')).rows[0];
 const before=await metadata(),beforeState=await state();
 const beforeData=(await db.sql.query('select public.erp_export_cloud_restore_snapshot_json() data')).rows[0].data;
 console.log('Loaded exact isolated authoritative fixture; checking compact parity hashes.');
 // PostgreSQL JSON timestamp spelling is not necessarily the input spelling.
 // Compare every value, with timestamps normalized to exact microseconds.
 const canonical=(v,k='')=>Array.isArray(v)?v.map(x=>canonical(x)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
  :v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k],k)]))
  :k.endsWith('_at')&&typeof v==='string'&&Number.isFinite(Date.parse(v))?
    (BigInt(Math.floor(Date.parse(v)/1000))*1000000n+BigInt((String(v).match(/\.(\d+)/)?.[1]??'').padEnd(6,'0').slice(0,6)||'0')).toString():v;
 const digest=v=>createHash('sha256').update(JSON.stringify(v)??'<undefined>').digest('hex');
 // The established Backup contract excludes operational version metadata.
 // Use that SAME public manifest builder, not a test-specific ignore list.
 const baselinePrepared=await r.buildCloudRestoreManifest(beforeData,beforeData);
 const currentSemantic=canonical(baselinePrepared.data),sourceSemantic=canonical(candidate.data);
 if(digest(currentSemantic)!==digest(sourceSemantic)) {
  const differingTables=Object.keys(baselinePrepared.data).filter(t=>digest(currentSemantic[t])!==digest(sourceSemantic[t]));
  const fields={};for(const t of differingTables){const actual=new Map(baselinePrepared.data[t].map(x=>[x.id,x]));
   for(const row of candidate.data[t])for(const key of new Set([...Object.keys(row),...Object.keys(actual.get(row.id)??{})]))
    if(digest(canonical(row[key],key))!==digest(canonical(actual.get(row.id)?.[key],key)))fields[t+'.'+key]=(fields[t+'.'+key]??0)+1;
  }
  console.log(JSON.stringify({isolatedFixtureDifferingTables:differingTables,fields}));
  throw Error('ISOLATED_FIXTURE_SEMANTIC_PARITY_FAILED');
 }
 const baselineManifest=baselinePrepared.manifest;
 await db.sql.query(await readFile('supabase/sql/'+migration,'utf8'));
 const after=await metadata();assert.equal(before.provolatile,'v');assert.equal(after.provolatile,'s');
 assert.deepEqual({...after,provolatile:'v'},before,'Only execution volatility changes');
 assert.deepEqual(await state(),beforeState,'Migration has zero business generation/epoch mutation');
 const schema=(await db.sql.query(await readFile('tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql','utf8'))).rows[0].erp_schema_snapshot;
 report.canonicalFingerprint=fingerprintStructuralSnapshot(schema);
 assert.equal(report.canonicalFingerprint,JSON.parse(await readFile('config/erp-environment-identity.json','utf8')).schemaBaseline.canonicalFingerprint);
 // Scoped, disposable probes verify the same authenticated PostgREST timeout
 // and STABLE transaction semantics. These functions are not release SQL.
 await db.sql.query(`create function public.backup_budget_probe() returns json language sql stable as $$select json_build_object('timeout',current_setting('statement_timeout'),'readonly',current_setting('transaction_read_only'))$$;
 create function public.ordinary_budget_probe() returns json language sql volatile as $$select json_build_object('timeout',current_setting('statement_timeout'),'readonly',current_setting('transaction_read_only'))$$;
 create function public.backup_timeout_probe() returns void language sql volatile as $$select pg_sleep(9)$$;
 revoke all on function public.backup_budget_probe(),public.ordinary_budget_probe(),public.backup_timeout_probe() from public;
 grant execute on function public.backup_budget_probe(),public.ordinary_budget_probe(),public.backup_timeout_probe() to authenticated;`);
 await db.startPostgrest();
 const backupBudget=await db.http('/rpc/backup_budget_probe',{},owner);
 const ordinaryBudget=await db.http('/rpc/ordinary_budget_probe',{},owner);
 assert.equal(backupBudget.status,200);assert.equal(backupBudget.data.timeout,'8s');assert.equal(backupBudget.data.readonly,'on');
 assert.equal(ordinaryBudget.data.timeout,'8s');assert.equal(ordinaryBudget.data.readonly,'off');
 report.budgets={backup:backupBudget.data,ordinary:ordinaryBudget.data};
 for(let i=0;i<5;i++) {
  const start=performance.now();const response=await db.http('/rpc/erp_export_cloud_restore_snapshot_json',{},owner);
  assert.equal(response.status,200);assert.deepEqual(response.data,beforeData);
  const generated=await r.buildCloudRestoreManifest(response.data,response.data);
  assert.equal(generated.manifest.snapshotFingerprint,baselineManifest.snapshotFingerprint);
  assert.equal(generated.manifest.relationshipHash,baselineManifest.relationshipHash);
  assert.equal(generated.manifest.totalRows,25031);
  report.runs.push({run:i+1,ms:performance.now()-start,status:response.status,parity:'EXACT'});
  console.log(JSON.stringify(report.runs.at(-1)));
 }
 for(const sub of [null,viewer]){
  const response=await db.http('/rpc/erp_export_cloud_restore_snapshot_json',{},sub);
  assert.ok(response.status>=400);report.failures.push({case:sub?'nonOwner':'anon',status:response.status,code:response.data?.code});
 }
 const timeout=await db.http('/rpc/backup_timeout_probe',{},owner);
 assert.equal(timeout.data.code,'57014');report.failures.push({case:'serverTimeout',status:timeout.status,code:timeout.data.code});
 assert.deepEqual(await state(),beforeState);
 assert.deepEqual((await db.sql.query('select public.erp_export_cloud_restore_snapshot_json() data')).rows[0].data,beforeData);
 report.businessStateAfterFailures='EXACT';report.restoreEpochAfterFailures='UNCHANGED';report.format='UNCHANGED';report.migrationMutation=0;
 if(process.env.BACKUP_RELIABILITY_NATIVE_EVIDENCE_OUT)await writeFile(process.env.BACKUP_RELIABILITY_NATIVE_EVIDENCE_OUT,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
} finally {await vite.close();await db.close();}
