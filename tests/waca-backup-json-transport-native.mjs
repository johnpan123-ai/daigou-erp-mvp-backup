import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createServer} from 'vite';
import {isolatedDatabase,owner} from './helpers/saveability-isolated.mjs';
import {CANONICAL_FRESH_INSTALL_V3} from '../supabase/canonicalFreshInstallV3.mjs';
import {fingerprintStructuralSnapshot} from '../tools/schema-reconciliation/schemaContract.mjs';
import {buildMigrationEffectRegistry} from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import {planSchemaDelta} from '../tools/schema-reconciliation/reconcile.mjs';
const migrationFile='055_authoritative_backup_json_transport.sql';
const migration=readFileSync('supabase/sql/'+migrationFile,'utf8');
assert.doesNotMatch(migration,/alter\s+role|set\s+statement_timeout|insert\s+into|update\s+public|create\s+table|alter\s+table/iu);
const path=process.env.WACA_BACKUP_SCALE_FIXTURE;
assert.ok(path,'WACA_BACKUP_SCALE_FIXTURE required: safe LOCAL snapshot only');
const snapshot=JSON.parse(readFileSync(path,'utf8'));
assert.equal(Object.keys(snapshot).length,24);
assert.ok(Object.values(snapshot).reduce((n,rows)=>n+rows.length,0)>=25000);
const db=await isolatedDatabase({migrations:CANONICAL_FRESH_INSTALL_V3.filter(file=>file!==migrationFile)});
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:[]}});
const stats=times=>{const a=[...times].sort((a,b)=>a-b);return {runs:a.length,medianMs:a[Math.floor(a.length/2)],p95Ms:a[Math.ceil(a.length*.95)-1],minMs:a[0],maxMs:a.at(-1),timesMs:times};};
let useJsonTransport=false;
const rpc=async(name,body={})=>{if(useJsonTransport&&name==='erp_export_cloud_restore_snapshot')name='erp_export_cloud_restore_snapshot_json';const result=await db.http('/rpc/'+name,body);if(result.status!==200)throw result.data;return result.data;};
const summary={engine:'native PostgreSQL + PostgREST JSON transport',resources:24,liveMutation:0};
const assertRestoreParity=(expected,actual)=>{
 const differences={};let disallowed=0;
 for(const [table,rows]of Object.entries(expected)){
  assert.equal(actual[table].length,rows.length,'RESTORE_COUNT:'+table);
  const byId=new Map(actual[table].map(row=>[String(row.id??row.inventory_key),row]));
  for(const row of rows){
   const found=byId.get(String(row.id??row.inventory_key));assert.ok(found,'RESTORE_IDENTITY:'+table);
   for(const key of new Set([...Object.keys(row),...Object.keys(found)])){
    if(JSON.stringify(row[key])===JSON.stringify(found[key]))continue;
    const equivalent=key.endsWith('_at')&&Number.isFinite(Date.parse(row[key]))&&Date.parse(row[key])===Date.parse(found[key]);
    differences[table+'.'+key]=(differences[table+'.'+key]??0)+1;if(!equivalent)disallowed++;
   }
  }
 }
 console.log(JSON.stringify({stage:'restore-parity',disallowed,differences}));
 assert.equal(disallowed,0,'RESTORE_SEMANTIC_PARITY');
};
let stage='restore';
try {
 const {sql}=db;
 for(const id of new Set(Object.values(snapshot).flatMap(rows=>rows.map(row=>row.updated_by).filter(id=>id&&id!==owner)))){
  await sql.query('insert into auth.users(id,email) values($1,$2) on conflict do nothing',[id,'isolated@example.invalid']);
 }
 const audit=(await sql.query('select public.erp_cloud_restore_audit_dataset($1) report',[snapshot])).rows[0].report;
 const manifest={schemaVersion:'cloud-erp-snapshot-v2',resourceCount:24,counts:audit.table_counts,totalRows:Number(audit.total_rows),orphanCount:0,duplicateVariantIdCount:0,duplicateVariantLocalIdCount:0};
 assert.equal((await sql.query("select public.erp_restore_cloud_snapshot($1,repeat('a',64),$2,$3,'isolated-native') result",[randomUUID(),snapshot,manifest])).rows[0].result.ok,true);
 const timestamps=(await sql.query('select id,status_changed_at from public.outbound_shipments')).rows;
 assert.equal(timestamps.length,37);
 for(const row of timestamps)assert.equal(row.status_changed_at===null?null:new Date(row.status_changed_at).getTime(),snapshot.outbound_shipments.find(expected=>expected.id===row.id).status_changed_at===null?null:Date.parse(snapshot.outbound_shipments.find(expected=>expected.id===row.id).status_changed_at));
 summary.outboundTimestamps='37/37 MATCH';summary.rows=manifest.totalRows;
 // Database-local role configuration cannot change any other isolated database
 // or production role. It disappears when this disposable database is dropped.
 const database=(await sql.query('select current_database() name')).rows[0].name;
 assert.match(database,/^waca_v3_save_[a-f0-9]+$/u);
 await sql.query(`alter role authenticated in database ${database} set statement_timeout='8s'`);
 // PostgREST does not necessarily hoist database-local role settings. Set the
 // disposable connection startup budget too, and verify it inside HTTP rather
 // than assuming an ALTER ROLE command proves the effective request budget.
 db.url.searchParams.set('options','-cstatement_timeout=8s');
 await sql.query("create function public.erp2_backup_probe_budget() returns text language sql stable as $$ select current_setting('statement_timeout') $$; grant execute on function public.erp2_backup_probe_budget() to authenticated");
 await db.startPostgrest();
 assert.equal(await rpc('erp2_backup_probe_budget'),'8s');
 await sql.query('drop function public.erp2_backup_probe_budget()');
 const capture=async()=>{
  const schema=(await sql.query(readFileSync('tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql','utf8'))).rows[0].erp_schema_snapshot;
  schema.identity.projectRef='rhfdjsklfrgpoqsaqpkn';
  schema.integrity.inventoryItems=(await sql.query(readFileSync('tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql','utf8'))).rows[0].inventory_items_integrity;
  schema.completeness.inventoryIntegrity=true;return schema;
 };
 const freshLive=JSON.parse(readFileSync('scratch/outbound-status-restore-v7/pre-production-backup-path-after-export/fresh-live-schema-snapshot.json','utf8'));
 const target=JSON.parse(readFileSync('scratch/production-backup-path/canonical-target-v9.json','utf8'));
 summary.preFingerprint=fingerprintStructuralSnapshot(await capture());
 assert.equal(summary.preFingerprint,fingerprintStructuralSnapshot(freshLive),'TRUE_LIVE_STATE_SCHEMA');
 const effects=await buildMigrationEffectRegistry();
 const beforePlan=planSchemaDelta(await capture(),effects,{expectedSnapshot:target});
 assert.equal(beforePlan.blockers.length,0);assert.deepEqual(beforePlan.applyPlan.map(x=>x.migrationId),['055']);
 let original;
 stage='http-before';const before=[];
 for(let n=0;n<5;n++){const start=performance.now();const value=await rpc('erp_export_cloud_restore_snapshot');before.push(performance.now()-start);if(!original)original=value;else assert.deepEqual(value,original);}
 summary.before=stats(before);console.log(JSON.stringify({stage,...summary.before}));
 await sql.query(migration);useJsonTransport=true;
 let schemaReady=false;
 for(let probe=0;probe<30;probe++){
  const schema=await db.http('/');
  if(schema.data?.paths?.['/rpc/erp_export_cloud_restore_snapshot_json']){schemaReady=true;break;}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(schemaReady,'POSTGREST_JSON_RPC_SCHEMA_CACHE');
 summary.postFingerprint=fingerprintStructuralSnapshot(await capture());
 assert.equal(summary.postFingerprint,fingerprintStructuralSnapshot(target),'CANONICAL_AFTER_055');
 const afterPlan=planSchemaDelta(await capture(),effects,{expectedSnapshot:target});
 assert.equal(afterPlan.blockers.length,0);assert.equal(afterPlan.applyPlan.length,0);
 summary.trueLiveStateApply='PASS';
 stage='http-after';const after=[];
 for(let n=0;n<5;n++){const start=performance.now();const value=await rpc('erp_export_cloud_restore_snapshot');after.push(performance.now()-start);assert.deepEqual(value,original);}
 summary.after=stats(after);assert.ok(summary.after.p95Ms<6500);console.log(JSON.stringify({stage,...summary.after}));
 const profile=(await sql.query("select proconfig from pg_proc where oid='public.erp_export_cloud_restore_snapshot()'::regprocedure")).rows[0].proconfig;
 assert.equal(profile.some(value=>value.startsWith('statement_timeout=')),false);
 assert.notEqual((await db.http('/rpc/erp_export_cloud_restore_snapshot_json',{},null)).status,200);
 assert.notEqual((await db.http('/rpc/erp_export_cloud_restore_snapshot_json',{},'00000000-0000-4000-8000-000000000098')).status,200);
 summary.acl='PASS';summary.outputParity='PASS';summary.executionBudget='authenticated 8s unchanged';
 const {buildCloudRestoreManifest}=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const built=await buildCloudRestoreManifest(original,original);assert.ok(built);assert.equal(built.manifest.resourceCount,24);
 summary.manifest='PASS';summary.relationships='PASS';summary.checksums='PASS';
 stage='restore-after-export';
 assert.equal((await sql.query("select public.erp_restore_cloud_snapshot($1,repeat('b',64),$2,$3,'isolated-optimized-backup') result",[randomUUID(),built.data,built.manifest])).rows[0].result.ok,true);
 const restoredSnapshot=await rpc('erp_export_cloud_restore_snapshot');
 const restoredManifest=await buildCloudRestoreManifest(restoredSnapshot,restoredSnapshot);assert.ok(restoredManifest);
 // Existing official restore normalization resets CAS versions (they are not
 // durable business history). Compare the official effective contract, not raw
 // versions against the normalized Restore input; do not invent an ignorelist.
 assertRestoreParity(built.data,restoredManifest.data);
 assert.equal(restoredManifest.manifest.snapshotFingerprint,built.manifest.snapshotFingerprint);
 assert.equal(restoredManifest.manifest.relationshipHash,built.manifest.relationshipHash);
 summary.restore='PASS';
 await sql.query("create function public.erp2_backup_restore_fault() returns trigger language plpgsql as $$ begin raise exception 'ISOLATED_ROLLBACK_PROOF'; end $$; create trigger erp2_backup_restore_fault before insert on public.waca_state for each row execute function public.erp2_backup_restore_fault();");
 await assert.rejects(()=>sql.query("select public.erp_restore_cloud_snapshot($1,repeat('c',64),$2,$3,'isolated-fault')",[randomUUID(),built.data,built.manifest]),/ISOLATED_ROLLBACK_PROOF/);
 await sql.query('drop trigger erp2_backup_restore_fault on public.waca_state; drop function public.erp2_backup_restore_fault()');
 assert.deepEqual(await rpc('erp_export_cloud_restore_snapshot'),restoredSnapshot);summary.atomicRollback='PASS';
 // Normal Confirm no longer invokes Backup. Its real XLS, response-loss,
 // rollback, readback and synced-modal benchmark now live in the native
 // tests/waca-atomic-confirm-native.mjs suite. Keep this suite focused on
 // the unchanged manual Backup / Restore and migration transport contracts.
 stage='bounded-pathological-rpc';
 await sql.query("create or replace function public.erp_export_cloud_restore_snapshot_json() returns json language plpgsql security definer set search_path=pg_catalog,public,extensions as $$ begin perform pg_sleep(9); return '{}'::json; end $$;");
 const started=performance.now();const slow=await db.http('/rpc/erp_export_cloud_restore_snapshot_json',{});
 assert.equal(slow.data.code,'57014');assert.ok(performance.now()-started<10000);summary.boundedTimeout='PASS';
 await sql.query(migration);
 mkdirSync('scratch/production-backup-path',{recursive:true});writeFileSync('scratch/production-backup-path/native-regression.json',JSON.stringify(summary,null,2));
 console.log(JSON.stringify(summary));
}catch(error){console.error(JSON.stringify({result:'FAIL',stage,code:error.code,message:error.code==='ERR_ASSERTION'?'ASSERTION_FAILED':String(error.message).slice(0,180)}));process.exitCode=1;}finally{await vite.close();await db.close();}
