import assert from 'node:assert/strict';
import { createServer } from 'vite';
globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
try {
  const {BuyAnimeImportPipeline,BuyAnimeResumeError}=await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
  const {planCloudInventoryImport}=await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
  const {finishBuyAnimeImport,coordinateBuyAnimeImport}=await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportCoordinator.ts');
  for(const size of [1505,5000,10000]) {
    let journal=null,rows=[],inventoryCommits=0,reads=0,catalogCommits=0,wacaCommits=0;
    const input=Array.from({length:size},(_,n)=>({id:'G'+n,inventory_key:'Synthetic::G'+n+'::A',myacg_item_code:'G'+n,
      myacg_parent_code:'GP'+n,product_title:'Synthetic '+n,raw_variant_name:'A',listing_type:'',final_price:10,
      myacg_available_quantity:0,myacg_sold_quantity:1,myacg_listed_at:'',latest_catalog_import_id:'catalog_import_411c6e55-cb73-41af-9ff1-61cf39cb532c',catalog_last_seen_at:'2026-10-03T04:52:25.877Z'}));
    const port={load:async()=>structuredClone(journal),save:async(record,version)=>{
      assert.equal(journal?.version||0,version);journal=structuredClone({...record,version:version+1});return structuredClone(journal);},
      prepareInventory:async incoming=>planCloudInventoryImport([],incoming),commitInventory:async plan=>{inventoryCommits++;rows=plan.inventory;},
      readInventory:async()=>{reads++;if(reads===1)throw new TypeError('Failed to fetch');return rows;},
      planCatalog:async()=>null,commitCatalog:async()=>{catalogCommits++;},verifyCatalog:async()=>{},ensureWacaEvidence:async()=>{wacaCommits++;}};
    const t=performance.now();let record;
    try {await new BuyAnimeImportPipeline(port).start(input,'synthetic.xls');assert.fail('Failure missed');}
    catch(error){assert.equal(error.code,'BUYANIME_COMMITTED_READBACK_PENDING');record=error.record;}
    // New pipeline simulates F5/close: downstream retry succeeds without memory or Inventory dispatch.
    const complete=await finishBuyAnimeImport(record,value=>new BuyAnimeImportPipeline(port).resume(value),async()=>{},async()=>{});
    assert.equal(complete.stage,'COMPLETE');assert.equal(inventoryCommits,1);assert.equal(catalogCommits,1);assert.equal(wacaCommits,1);
    assert.equal(new Set(rows.map(r=>r.id)).size,size);assert.equal(new Set(rows.map(r=>r.inventory_key)).size,size);
    console.log(JSON.stringify({size,automaticRecovery:'PASS',inventoryCommits,stage:complete.stage,durationMs:Math.round(performance.now()-t)}));
  }
  let attempts=0;
  await assert.rejects(()=>finishBuyAnimeImport({},async()=>{attempts++;throw new TypeError('Failed to fetch');},async()=>{},async()=>{}),/fetch/u);
  assert.equal(attempts,3,'Retries are bounded');
  attempts=0;
  await assert.rejects(()=>finishBuyAnimeImport({},async()=>{attempts++;throw new BuyAnimeResumeError('BUYANIME_READBACK_IDENTITY_OR_FIELDS_MISMATCH');},async()=>{},async()=>{}),/MISMATCH/u);
  assert.equal(attempts,1,'Integrity failure is NEVER auto bypassed');
  const order=[];
  await Promise.all([coordinateBuyAnimeImport(async()=>{order.push('old-start');await new Promise(r=>setTimeout(r,15));order.push('old-complete');}),coordinateBuyAnimeImport(async()=>{order.push('new-backup');order.push('new-start');})]);
  assert.deepEqual(order,['old-start','old-complete','new-backup','new-start']);
  console.log('PASS bounded automatic reconciliation, 1505/5k/10k, F5, serialized old/new intents, checksum fail-closed, Inventory exactly once');
} finally {await vite.close();}
