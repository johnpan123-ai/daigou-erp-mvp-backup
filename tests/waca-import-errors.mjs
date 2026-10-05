import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:[]}});
try {
 const {formatStructuredError}=await vite.ssrLoadModule('/src/utils/structuredError.ts');
 const {classifyWacaError,wacaNotice}=await vite.ssrLoadModule('/src/waca/importErrors.ts');
 const timeout={code:'57014',message:'canceling statement due to statement timeout',details:null,hint:null};
 for(const value of [new Error('test'),timeout,'test',{},null,[{error:timeout}],{message:{error:timeout}}]){
  assert.equal(formatStructuredError(value).message.includes('[object Object]'),false);
 }
 const cycle={};cycle.error=cycle;assert.ok(formatStructuredError(cycle).message);
 assert.equal(formatStructuredError({error:timeout}).code,'57014');
 assert.equal(formatStructuredError({message:{error:timeout}}).code,'57014');
 assert.equal(classifyWacaError({code:'unsafe credential text',message:'error'},'backup').diagnostic.code,undefined);
 assert.equal(classifyWacaError(timeout,'backup').category,'BACKUP_TIMEOUT');
 assert.equal(classifyWacaError({code:'42501',message:'permission denied'},'read').category,'PERMISSION_ERROR');
 assert.equal(classifyWacaError(new Error('Failed to fetch'),'commit').category,'WACA_COMMIT_UNKNOWN');
 assert.equal(classifyWacaError(timeout,'commit').category,'WACA_COMMIT_REJECTED');
 assert.equal(classifyWacaError(timeout,'readback').category,'READBACK_FAILED');
 assert.equal(classifyWacaError(new Error('secret customer row'),'backup').diagnostic.reason,'STRUCTURED_ERROR');
 assert.equal(wacaNotice('PENDING').label,'待處理');assert.equal(wacaNotice('CONFLICT').label,'需核對衝突');
 const source=readFileSync('src/pages/WacaIntegration.tsx','utf8');
 assert.doesNotMatch(source,/String\(cause\)|cause instanceof Error \? cause.message/);
 const handler=source.slice(source.indexOf('  const confirmImport = async () => {'),source.indexOf('\n  const handleMasterFile'));
 assert.doesNotMatch(handler,/exportData|stage = 'backup'|erp_export_cloud_restore_snapshot|download/);
 assert.match(handler,/commitAndVerifyWaca/);
 assert.equal(classifyWacaError({code:'40001',message:'WACA_STALE_REVISION'},'commit').category,'STALE_CONFLICT');
 assert.equal(classifyWacaError(new Error('WACA_STALE_REVISION'),'validation').category,'STALE_CONFLICT');
 // Other explicit maintenance operations retain Backup protection/formatting.
 assert.match(source.slice(source.indexOf('  const confirmMasterLinks')),/await dataProvider.exportData\(\)/);
 console.log('PASS structured errors, stale CAS, no full Backup in normal Confirm; maintenance Backup preserved');
}finally{await vite.close();}
