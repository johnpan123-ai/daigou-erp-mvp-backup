// Legacy (pre-intent) BuyAnime journal: prove-and-retire, never replay.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
const report=[];
try {
 const R=await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
 const {planCloudInventoryImport}=await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
 const batch='catalog_import_19e3104c-984f-4799-0000-e355f15aa2cc';
 const row=(n,sold)=>({id:`10000000-0000-4000-8000-00000000000${n}`,myacg_item_code:`G-LEGACY-${n}`,product_title:'Legacy synthetic',
  raw_variant_name:String(n),listing_type:'',final_price:10,myacg_available_quantity:5,myacg_sold_quantity:sold,myacg_listed_at:'',
  latest_catalog_import_id:batch,catalog_last_seen_at:'2026-10-10T01:00:00.000Z'});
 const incoming=[row(1,1),row(2,1),row(3,9)];
 // Existing Cloud state: only row 3, older quantity, from an older batch.
 const seed=planCloudInventoryImport([],[row(3,4)]).imported.map(r=>({...r,latest_catalog_import_id:'catalog_import_1791471018130',version:1,deleted_at:null}));
 for(const mode of ['not-committed','committed','tombstone-key','epoch-changed','partial-create','no-create','soft-deleted']){
  let journal,saves=0,commits=0,epoch=25,db=structuredClone(seed),planned;
  const port={
   readRestoreGeneration:async()=>({epoch,restoredAt:'2026-10-09T12:51:37.124Z'}),
   load:async()=>structuredClone(journal),
   save:async(r,v)=>{assert.equal(journal?.version||0,v);saves++;journal=structuredClone({...r,version:v+1});return structuredClone(journal);},
   prepareInventory:async items=>(planned=planCloudInventoryImport(db,items)),
   // Legacy runtime: no reconcileInventory => no exact intent in the journal.
   commitInventory:async()=>{commits++;throw new TypeError('Failed to fetch');},
   readInventory:async r=>db.filter(x=>r.expected.some(p=>p.id===x.id)),
   readLegacyInventoryEvidence:async r=>{
    const ids=new Set(r.expected.map(p=>p.id));const rows=db.filter(x=>ids.has(x.id));
    const present=new Set(rows.map(x=>x.id));const keys=new Set(r.expected.filter(p=>!present.has(p.id)).map(p=>p.key));
    return {rows,keyRows:db.filter(x=>keys.has(x.inventory_key)).map(x=>({id:x.id,inventory_key:x.inventory_key,deleted_at:x.deleted_at??null}))};
   },
   planCatalog:async()=>null,commitCatalog:async()=>assert.fail('no Catalog write'),verifyCatalog:async()=>{},
  };
  const noCreate=mode==='no-create';
  const input=noCreate?[row(3,9)]:incoming;
  await assert.rejects(()=>new R.BuyAnimeImportPipeline(port).start(input,'399375_synthetic.xls'),/OUTCOME_UNKNOWN/);
  assert.equal(journal.stage,'INVENTORY_COMMIT_UNKNOWN'); assert.equal(journal.inventory,undefined);
  assert.ok(R.isUnresolvedLegacyInventoryJournal(journal));
  const creates=planned.operations.filter(o=>o.kind==='create');
  assert.equal(creates.length,noCreate?0:2);
  if(mode==='committed') db=[...planned.imported.map(r=>({...r,version:(r.version||0)+1,deleted_at:null}))];
  if(mode==='tombstone-key') db.push({...planned.imported.find(r=>r.id===creates[0].id),id:'10000000-0000-4000-8000-0000000000aa',deleted_at:'2026-10-09T00:00:00Z'});
  if(mode==='epoch-changed') epoch=26;
  if(mode==='partial-create') db.push({...planned.imported.find(r=>r.id===creates[0].id),version:1,deleted_at:null});
  if(mode==='soft-deleted') db=db.map(r=>({...r,deleted_at:'2026-10-09T00:00:00Z'}));
  const before={stage:journal.stage,version:journal.version,saves}; const dbBefore=JSON.stringify(db);
  if(mode==='not-committed'){
   const result=await new R.BuyAnimeImportPipeline(port).resume(journal);
   assert.equal(result.stage,'FAILED_PRE_COMMIT');
   assert.deepEqual({...result.retirement,verifiedAt:undefined},{kind:'LEGACY_NOT_COMMITTED_VERIFIED',verifiedAt:undefined,previousStage:'INVENTORY_COMMIT_UNKNOWN',
    restoreEpoch:25,expectedRows:3,absentPredictedCreates:2,presentRows:1,targetMatches:0,businessMutation:0,inventoryReplay:0});
   assert.equal(saves,before.saves+1); assert.equal(commits,1); assert.equal(JSON.stringify(db),dbBefore);
   R.assertImportRecord(result);
   const decision=R.classifyBuyAnimeJournalIdentity({id:R.importJournalId(batch),platform:R.BUYANIME_JOURNAL_PLATFORM,deleted_at:null,
    file_name:result.fileName,total_rows:result.expected.length,version:result.version,details:{buyAnimeImport:result}},result,{epoch:25,restoredAt:'2026-10-09T12:51:37.124Z'});
   assert.equal(decision.blockNewImport,false); assert.equal(decision.recoveryAction,'RETIRE_AS_COMPLETE');
   assert.ok(!R.isUnresolvedLegacyInventoryJournal(result));
   await assert.rejects(()=>new R.BuyAnimeImportPipeline(port).resume(result),/BUYANIME_NOT_COMMITTED/);
   assert.match(R.buyAnimeRecoveryMessage(result),/沒有寫入任何主檔資料/);
   // Tampered retirement fails closed at the record contract.
   assert.throws(()=>R.assertImportRecord({...result,retirement:{...result.retirement,inventoryReplay:1}}),/JOURNAL_INVALID/);
   assert.throws(()=>R.assertImportRecord({...result,stage:'INVENTORY_COMMIT_UNKNOWN'}),/JOURNAL_INVALID/);
   report.push({mode,outcome:'RETIRED_NOT_COMMITTED',blockNewImport:false,businessMutation:0,replay:0});
  } else if(mode==='committed'){
   const result=await new R.BuyAnimeImportPipeline(port).resume(journal);
   assert.equal(result.stage,'COMPLETE'); assert.equal(result.retirement,undefined); assert.equal(commits,1);
   report.push({mode,outcome:'EXISTING_READBACK_PATH_COMPLETE',replay:0});
  } else {
   const expected={'tombstone-key':/LEGACY_COMMIT_OUTCOME_UNPROVEN/,'epoch-changed':err=>err?.code==='RECOVERY_STATE_ERROR'&&/STALE_AFTER_RESTORE/.test(String(err.cause?.message)),
    'partial-create':/LEGACY_COMMIT_OUTCOME_UNPROVEN/,'no-create':/LEGACY_COMMIT_OUTCOME_UNPROVEN/,'soft-deleted':/SOFT_DELETED_ROW/}[mode];
   await assert.rejects(()=>new R.BuyAnimeImportPipeline(port).resume(journal),expected);
   assert.equal(saves,before.saves); assert.equal(journal.stage,before.stage); assert.equal(commits,1); assert.equal(JSON.stringify(db),dbBefore);
   report.push({mode,outcome:'BLOCKED_FAIL_CLOSED',journalWrite:0,businessMutation:0,replay:0});
  }
 }
 console.log(JSON.stringify(report));
 console.log('PASS legacy journal: proven NOT_COMMITTED retired (non-blocking, audit kept), committed uses existing readback, every ambiguous shape fail-closed, replay=0');
}finally{await vite.close();}
