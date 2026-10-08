import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transform} from 'esbuild';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:[]}});
try {
 const d=await vite.ssrLoadModule('/src/providers/cloud/cloudBackupDiagnostics.ts');
 const context={requestId:'isolated-request',rpc:'erp_export_cloud_restore_snapshot_json',startedAt:'isolated',phase:'RPC_REQUEST',elapsedMs:8,httpStatus:null,sqlstate:null,timingsMs:{}};
 for(const [error,phase,expected] of [
  [{code:'57014',message:'canceling statement due to statement timeout',details:'PRIVATE_SENTINEL'},'RPC_REQUEST','BACKUP_STATEMENT_TIMEOUT'],
  [{code:'42501',message:'permission denied'},'RPC_REQUEST','BACKUP_PERMISSION_ERROR'],
  [new TypeError('Failed to fetch'),'RPC_REQUEST','BACKUP_NETWORK_ERROR'],
  [new Error('AbortError connection interrupted'),'RPC_REQUEST','BACKUP_NETWORK_ERROR'],
  [new SyntaxError('Unexpected JSON token'),'RPC_REQUEST','BACKUP_CLIENT_PARSE_ERROR'],
  [new Error('CLOUD_RESTORE_SNAPSHOT_INVALID'),'RPC_REQUEST','BACKUP_VALIDATION_ERROR'],
  [new Error('bad checksum PRIVATE_SENTINEL'),'MANIFEST_AND_CHECKSUMS','BACKUP_VALIDATION_ERROR'],
  [{code:'XX000',message:'PRIVATE_SENTINEL'},'RPC_REQUEST','BACKUP_SERVER_ERROR'],
 ]) {
  const safe=d.classifyCloudBackupError(error,{...context,phase});
  assert.equal(safe.code,expected);assert.equal(safe.diagnostic.code,expected);
  assert.doesNotMatch(JSON.stringify(safe)+safe.message,/PRIVATE_SENTINEL|\[object Object\]/);
  assert.match(safe.message,/沒有修改任何資料/);
 }
 const provider=readFileSync('src/providers/cloud/supabaseProvider.ts','utf8');
 const body=provider.slice(provider.indexOf('  async exportData(): Promise<void> {'),provider.indexOf('\n  async importData(',provider.indexOf('  async exportData(): Promise<void> {')));
 const js=(await transform(body.replace('  async exportData(): Promise<void> {','async function exportData() {'),{loader:'ts',target:'esnext'})).code+'\nreturn exportData;';
 for(const mode of ['success','timeout','network','cancel','validation']) {
  let calls=0,downloads=0,releases=0;
  const execute=new Function('supabase','CLOUD_RESTORE_SNAPSHOT_RPC','markCloudRequestFailed','markCloudReachable','buildCloudRestoreManifest','CLOUD_RESTORE_TABLES','CLOUD_RESTORE_SCHEMA_VERSION','readDeadlineDurableBackup','recordCloudBackupDiagnostic','classifyCloudBackupError','crypto','document','URL',js)(
   {rpc:async()=>{calls++;if(mode==='network'||mode==='cancel')throw new Error(mode==='cancel'?'AbortError':'Failed to fetch');return{status:mode==='timeout'?500:200,error:mode==='timeout'?{code:'57014',message:'timeout'}:null,data:{inventory_items:[]}};}},context.rpc,()=>{},()=>{},
   async()=>{if(mode==='validation')throw new Error('MANIFEST_INVALID');return{manifest:{resourceCount:24,totalRows:0,snapshotFingerprint:'fixed',relationshipHash:'fixed'},data:{inventory_items:[]}};},[['inventory','inventory_items']],'cloud-erp-snapshot-v2',async()=>({stores:[]}),d.recordCloudBackupDiagnostic,d.classifyCloudBackupError,{randomUUID:()=>mode},
   {body:{appendChild(){}},createElement:()=>({click(){downloads++;},remove(){}})},
   {createObjectURL:()=> 'blob:isolated',revokeObjectURL(){releases++;}});
  if(mode==='success'){await execute();assert.equal(downloads,1);assert.equal(releases,1);assert.equal(d.getCloudBackupDiagnostic().phase,'COMPLETE');}
  else {await assert.rejects(execute(),e=>e instanceof d.CloudBackupError);assert.equal(downloads,0);}
  assert.equal(calls,1,'No automatic replay or parallel backup');
  assert.doesNotMatch(body,/\.from\(|insert\(|update\(|delete\(|restoreEpoch/);
 }
 const sql=readFileSync('supabase/sql/065_cloud_backup_stable_readonly_execution.sql','utf8');
 assert.match(sql,/alter function public\.erp_export_cloud_restore_snapshot_json\(\) stable/i);
 assert.doesNotMatch(sql,/alter role|statement_timeout|create index|create table|create or replace|insert into|update public|delete from/i);
 console.log('PASS backup-only 065 marker, safe six-category errors, no secret DETAIL, one RPC/no retry, validation/network/cancel/timeout failures produce no download or business mutation, identical export format');
} finally {await vite.close();}
