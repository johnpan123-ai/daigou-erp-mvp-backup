import assert from 'node:assert/strict';
import {createServer} from 'vite';
globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
try {
 const {BuyAnimeImportPipeline}=await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
 const {planCloudInventoryImport}=await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
 for(const mode of ['response-loss','rollback','unknown','stale','receipt-state-mismatch']){
  let journal, rows=[], commits=0,resumeCalls=0,receipt=false,epoch=25, planned;
  const input=[{id:'10000000-0000-4000-8000-000000000001',myacg_item_code:'G-SYNTHETIC',product_title:'Synthetic',raw_variant_name:'A',
   listing_type:'',final_price:10,myacg_available_quantity:0,myacg_sold_quantity:1,myacg_listed_at:'',
   latest_catalog_import_id:'catalog_import_411c6e55-cb73-41af-9ff1-61cf39cb532c',catalog_last_seen_at:'2026-10-10T01:00:00.000Z'}];
  const port={
   readRestoreGeneration:async()=>({epoch,restoredAt:'2026-10-09T00:00:00.000Z'}),
   load:async()=>structuredClone(journal),
   save:async(r,v)=>{assert.equal(journal?.version||0,v);journal=structuredClone({...r,version:v+1});return structuredClone(journal);},
   prepareInventory:async incoming=>(planned=planCloudInventoryImport([],incoming)),
   commitInventory:async(_p,r)=>{assert.ok(r.inventory);commits++;
    if(mode==='response-loss'||mode==='receipt-state-mismatch'){rows=planned.imported;receipt=true;}
    throw new TypeError('Failed to fetch');},
   reconcileInventory:async()=>mode==='unknown'?'UNKNOWN':receipt?'COMMITTED':'NOT_COMMITTED',
   resumeInventory:async r=>{resumeCalls++;assert.deepEqual(r.inventory.request.operations,planned.operations);rows=planned.imported;receipt=true;},
   readInventory:async()=>rows,planCatalog:async()=>null,commitCatalog:async()=>assert.fail('no catalog changes'),verifyCatalog:async()=>{},
  };
  await assert.rejects(()=>new BuyAnimeImportPipeline(port).start(input,'synthetic.xls'),/OUTCOME_UNKNOWN/);
  assert.equal(journal.stage,'INVENTORY_COMMIT_UNKNOWN');
  if(mode==='stale')epoch++;
  if(mode==='receipt-state-mismatch')rows=[];
  if(['unknown','stale','receipt-state-mismatch'].includes(mode)){
   await assert.rejects(()=>new BuyAnimeImportPipeline(port).resume(journal));assert.equal(resumeCalls,0);
  }else{
   const result=await new BuyAnimeImportPipeline(port).resume(journal);assert.equal(result.stage,'COMPLETE');
   assert.equal(resumeCalls,mode==='rollback'?1:0);
   await new BuyAnimeImportPipeline(port).resume(result);assert.equal(resumeCalls,mode==='rollback'?1:0);
  }
  assert.equal(commits,1);
 }
 console.log('PASS receipt recovery: response loss/no replay, proven rollback retry, unknown fail closed, epoch stale, current-state mismatch');
}finally{await vite.close();}
