import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transform} from 'esbuild';
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
 const handler=(await transform(source.slice(source.indexOf('  const confirmImport = async () => {'),source.indexOf('\n  const handleMasterFile')),{loader:'tsx',target:'esnext'})).code+'\nreturn confirmImport;';
 for(const failure of [timeout,{code:'42501',message:'permission denied'},new Error('Failed to fetch'),{error:[timeout]}]){
  let error;let mutationCalls=0;
  const confirm=new Function('pendingImport','snapshot','dataProvider','setBusy','setError','setMessage','run','classifyWacaError',handler)(
   {revision:8,importId:'isolated-request',result:{errors:[]}},{revision:8},
   {getNextWacaSnapshot:async()=>({revision:8}),exportData:async()=>{throw failure;},commitNextWacaSnapshot:async()=>{mutationCalls++;}},
   ()=>{},value=>{error=value;},()=>{},()=>{throw new Error('DOMAIN_MUST_NOT_RUN');},classifyWacaError);
  await confirm();assert.equal(mutationCalls,0);assert.match(error.message,/尚未寫入/);
  assert.equal(error.diagnostic.stage,'backup');assert.equal(error.diagnostic.requestId,'isolated-request');
 }
 console.log('PASS WACA structured envelopes/cycles/nesting, stage classification, no raw object render, backup failure mutation=0');
}finally{await vite.close();}
