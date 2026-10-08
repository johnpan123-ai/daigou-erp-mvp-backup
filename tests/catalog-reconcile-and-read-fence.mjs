import assert from 'node:assert/strict';
import {createServer} from 'vite';
globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
 const {BuyAnimeImportPipeline,inventoryProof,importCatalogKey,buyAnimeRecoveryUserMessage}=await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
 const {classifyCatalogRpcError}=await vite.ssrLoadModule('/src/providers/cloud/catalogTransaction.ts');
 const {classifyMyAcgImportError,myAcgImportDiagnostic}=await vite.ssrLoadModule('/src/utils/myacgImportErrors.ts');
 const {beginCatalogCommitReadFence,awaitCatalogCommitReadFence}=await vite.ssrLoadModule('/src/providers/cloud/catalogCommitReadFence.ts');
 const batchId='catalog_import_00000000-0000-4000-8000-000000000001';
 const row={id:'00000000-0000-4000-8000-000000000002',inventory_key:'synthetic::1',myacg_item_code:'TEST1',product_title:'Synthetic',raw_variant_name:'A',version:1};
 const plan={request:{family:'catalog',mode:'sync',dependencies:{},operations:{product_groups:[{kind:'create',id:row.id,values:{title:'Synthetic'}}],product_categories:[],product_variants:[]}},summary:{}};
 const original={format:'BUYANIME_IMPORT_RESUME_V1',batchId,fileName:'synthetic.xls',observedAt:'2026-10-09T00:00:00Z',stage:'CATALOG_COMMITTING',version:1,expected:[await inventoryProof(row)],stats:{},catalog:{key:importCatalogKey(batchId),plan}};
 for(const outcome of ['COMMITTED','NOT_COMMITTED','UNKNOWN']) {
  let journal=structuredClone(original),writes=0,inventoryWrites=0,verifies=0,saves=0;
  const port={load:async()=>structuredClone(journal),save:async(r,version)=>{assert.equal(journal.version,version);saves++;journal={...r,version:version+1};return structuredClone(journal);},readInventory:async()=>[row],prepareInventory:async()=>{inventoryWrites++;throw Error('NO INVENTORY REPLAY');},commitInventory:async()=>{inventoryWrites++;},planCatalog:async()=>plan,commitCatalog:async()=>{writes++;},reconcileCatalog:async()=>outcome,verifyCatalog:async()=>{verifies++;}};
  const pipeline=new BuyAnimeImportPipeline(port);
  if(outcome==='UNKNOWN') {await assert.rejects(()=>pipeline.resume(journal),/CATALOG_COMMIT_UNKNOWN/);assert.equal(writes,0);assert.equal(saves,0);}
  else {const result=await pipeline.resume(journal);assert.equal(result.stage,'COMPLETE');assert.equal(writes,outcome==='COMMITTED'?0:1);assert.equal(verifies,1);assert.equal(saves,1);}
  assert.equal(inventoryWrites,0);
 }
 // First dispatch commits on the server and loses its response; reconcile
 // closes the journal and readback in this attempt without a second dispatch.
 let journal={...structuredClone(original),stage:'CATALOG_PENDING',catalog:undefined},writes=0,committed=false;
 const port={load:async()=>structuredClone(journal),save:async(r,v)=>{assert.equal(journal.version,v);journal={...r,version:v+1};return structuredClone(journal);},readInventory:async()=>[row],prepareInventory:async()=>{throw Error('NO INVENTORY');},commitInventory:async()=>{throw Error('NO INVENTORY');},planCatalog:async()=>plan,commitCatalog:async()=>{writes++;committed=true;throw new TypeError('Failed to fetch');},reconcileCatalog:async()=>committed?'COMMITTED':'NOT_COMMITTED',verifyCatalog:async()=>{}};
 const complete=await new BuyAnimeImportPipeline(port).resume(journal);assert.equal(complete.stage,'COMPLETE');assert.equal(writes,1);
 await new BuyAnimeImportPipeline(port).resume(complete);assert.equal(writes,1);
 const timeout=classifyCatalogRpcError({code:'57014',message:'canceling statement due to statement timeout'},row.id);
 assert.equal(timeout.category,'CATALOG_COMMIT_TIMEOUT_NOT_COMMITTED');
 const human=classifyMyAcgImportError(timeout,'commit');assert.equal(human.code,timeout.category);assert.equal(myAcgImportDiagnostic(human,row.id).postgresCode,'57014');assert.doesNotMatch(human.message,/\[object Object\]/);
 assert.match(buyAnimeRecoveryUserMessage({cause:timeout}),/商品目錄寫入逾時/);
 const release1=beginCatalogCommitReadFence(),release2=beginCatalogCommitReadFence();let reads=0;
 const pending=Promise.all(Array.from({length:8},()=>awaitCatalogCommitReadFence('targeted-cache:realtime').then(()=>{reads++;})));
 await new Promise(r=>setTimeout(r,5));assert.equal(reads,0);release1();await new Promise(r=>setTimeout(r,5));assert.equal(reads,0);release2();await pending;assert.equal(reads,8,'All queued catch-ups retained');
 const release=beginCatalogCommitReadFence(),abort=new AbortController();const cancelled=awaitCatalogCommitReadFence('targeted-cache:reconnect',abort.signal);abort.abort();await assert.rejects(()=>cancelled);release();
 await awaitCatalogCommitReadFence('provider-bootstrap');
 console.log('PASS committed/not-committed/unknown classification; response loss replay=0; Inventory replay=0; exactly-once finalization; 57014 structured error; deferred Realtime/focus/reconnect retained and abort-safe');
}finally{await vite.close();}
