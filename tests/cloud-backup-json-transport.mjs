import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {transform} from 'esbuild';
import {createServer} from 'vite';
const migration=readFileSync('supabase/sql/055_authoritative_backup_json_transport.sql','utf8');
const legacy=readFileSync('supabase/sql/054_authoritative_backup_json_aggregation.sql','utf8');
assert.equal(legacy,execFileSync('git',['show','86820030771f7bfe6916afc456cdf52351e78146:supabase/sql/054_authoritative_backup_json_aggregation.sql'],{encoding:'utf8'}));
assert.match(migration,/returns json\s/i);
assert.doesNotMatch(migration,/::jsonb|alter\s+role|statement_timeout|create\s+table|insert\s+into|update\s+public|delete\s+from/i);
assert.match(migration,/security definer/i);assert.match(migration,/public\.is_owner\(v_actor\)/);
assert.match(migration,/revoke all.+from public, anon, authenticated/);
assert.match(migration,/notify pgrst, 'reload schema'/);
assert.equal(migration.match(/select json_build_object/g).length,1);
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:[]}});
try{
 const contract=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 assert.equal(contract.CLOUD_RESTORE_SCHEMA_VERSION,'cloud-erp-snapshot-v2');
 assert.equal(contract.CLOUD_RESTORE_TABLES.length,24);
 assert.equal(contract.CLOUD_RESTORE_SNAPSHOT_RPC,'erp_export_cloud_restore_snapshot_json');
 for(const [,table]of contract.CLOUD_RESTORE_TABLES)assert.match(migration,new RegExp('from public\\.'+table+' t'));
 const expression=/select (json_build_object\([\s\S]+?)\)\s*(?:::jsonb)? into v_snapshot;/i;
 assert.equal(migration.match(expression)[1],legacy.match(expression)[1]);
 const {formatStructuredError}=await vite.ssrLoadModule('/src/utils/structuredError.ts');
 const source=readFileSync('src/pages/Settings.tsx','utf8');
 const handler=(await transform(source.slice(source.indexOf('  const handleExport = async () => {'),source.indexOf('\n  const handleExportExcel')),{loader:'tsx',target:'esnext'})).code+'\nreturn handleExport;';
 for(const failure of [null,{code:'57014',message:'timeout'},{code:'unsafe secret value',message:'private data'}]){
  const events=[];let calls=0;
  const exported=new Function('dataProvider','setBackupExport','formatStructuredError',handler)(
   {exportData:async()=>{calls++;if(failure)throw failure;}},value=>events.push(value),formatStructuredError);
  await exported();assert.equal(calls,1);assert.equal(events[0].state,'running');
  assert.equal(events.at(-1).state,failure?'error':'complete');
  assert.ok(events.at(-1).elapsedMs>=0);assert.ok(!JSON.stringify(events).includes('private data'));
  if(failure?.code==='57014')assert.equal(events.at(-1).code,'57014');
 }
 console.log('PASS exact 24-resource aggregation, unchanged legacy source/format, strict owner ACL, schema cache notice, safe visible read-only export timing/error states');
}finally{await vite.close();}
