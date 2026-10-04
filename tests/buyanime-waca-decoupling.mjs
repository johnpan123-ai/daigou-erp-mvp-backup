import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
try {
  const {BuyAnimeImportPipeline,inventoryProof,importWacaDeltaKey,BUYANIME_COMPLETION_CONTRACT}=await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
  const {planCloudInventoryImport}=await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
  const {linksFromMyAcgInventory,buildWacaMasterReference}=await vite.ssrLoadModule('/src/waca/masterReference.ts');
  assert.equal(BUYANIME_COMPLETION_CONTRACT,'INVENTORY_CATALOG_AUTHORITATIVE');
  const uuid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const batchId='catalog_import_00000000-0000-4000-8000-000000000010';
  const row={id:uuid(1),version:1,inventory_key:'Synthetic::G1::A',myacg_item_code:'G1',myacg_parent_code:'GP1',
    product_title:'Synthetic',raw_variant_name:'A',listing_type:'',final_price:10,myacg_available_quantity:0,
    myacg_sold_quantity:1,myacg_listed_at:'',latest_catalog_import_id:batchId,catalog_last_seen_at:'2026-10-04T00:00:00.000Z'};
  const beforeWaca={revision:8,quantity:11,orders:[{id:'synthetic-order'}]};
  let journal=null,inventory=[],saves=0,inventoryWrites=0,catalogWrites=0,wacaReads=0,wacaWrites=0;
  const waca=structuredClone(beforeWaca);
  const port={
    load:async()=>structuredClone(journal),
    save:async(record,version)=>{assert.equal(journal?.version||0,version);saves++;journal={...structuredClone(record),version:version+1};return structuredClone(journal);},
    prepareInventory:async incoming=>planCloudInventoryImport([],incoming),
    commitInventory:async plan=>{inventoryWrites++;inventory=plan.inventory;},readInventory:async()=>structuredClone(inventory),
    planCatalog:async()=>null,commitCatalog:async()=>{catalogWrites++;},verifyCatalog:async()=>{},
    planWacaEvidence:async()=>{wacaReads++;throw new Error('WACA read/RLS unavailable');},
    commitWacaEvidence:async()=>{wacaWrites++;throw new Error('WACA RPC unavailable');},
  };
  const pipeline=new BuyAnimeImportPipeline(port);
  const started=await pipeline.start([row],'synthetic.xls');
  const completed=await pipeline.resume(started);
  assert.equal(completed.stage,'COMPLETE');
  assert.deepEqual({inventoryWrites,catalogWrites,wacaReads,wacaWrites},{inventoryWrites:1,catalogWrites:0,wacaReads:0,wacaWrites:0});
  assert.deepEqual(waca,beforeWaca,'BuyAnime cannot change WACA orders, quantity or revision');
  // WACA derives the same parent/child evidence when its own route is opened.
  const variant={id:uuid(2),productGroupId:uuid(3),productGroupID:uuid(3),product_group_id:uuid(3),
    myacg_item_code:'G1',myacgItemCode:'G1',productTitle:'Synthetic',variantName:'A',variant_name:'A'};
  const derived=linksFromMyAcgInventory(inventory,[variant],'NEXT_CURRENT_MYACG_CATALOG','');
  assert.equal(derived.links.length,1);assert.equal(derived.links[0].childCode,'G1');assert.equal(derived.links[0].mainCode,'GP1');
  assert.ok(buildWacaMasterReference([variant],derived.links));
  for(const size of [0,1,10,100,829,1000]) {
    const intent={key:importWacaDeltaKey(batchId),expectedRevision:8,inserted:size,updated:0,unchanged:0,
      links:Array.from({length:size},(_,n)=>({mainCode:'GP1',childCode:'G'+n,productGroupId:uuid(3),productVariantId:uuid(2),variantTitle:'A',sourceFile:'synthetic.xls',sourceFiles:['synthetic.xls'],observedAt:row.catalog_last_seen_at}))};
    journal={...structuredClone(completed),stage:'WACA_EVIDENCE_PENDING',waca:intent};
    let freshChecks=0;
    port.planCatalog=async(_rows,_inventory,fresh)=>{assert.equal(fresh,true);freshChecks++;return null;};
    const beforeWrites={inventoryWrites,catalogWrites,wacaWrites};
    const result=await new BuyAnimeImportPipeline(port).resume(structuredClone(journal));
    assert.equal(result.stage,'COMPLETE');assert.equal(freshChecks,1);
    assert.deepEqual(result.waca,intent,'Historical intent is retained without asserting it committed');
    assert.deepEqual({inventoryWrites,catalogWrites,wacaWrites},beforeWrites,'No business replay in legacy recovery');
    assert.deepEqual(waca,beforeWaca);
  }
  const pending={...structuredClone(completed),stage:'WACA_EVIDENCE_PENDING',waca:{key:importWacaDeltaKey(batchId),expectedRevision:8,links:[],inserted:0,updated:0,unchanged:0}};
  const validInventory=structuredClone(inventory);
  journal=structuredClone(pending);
  const saveCount=saves;
  port.planCatalog=async()=>({request:{operations:{product_groups:[{kind:'patch'}]}}});
  await assert.rejects(()=>new BuyAnimeImportPipeline(port).resume(pending),/CATALOG_RECOVERY_FIELDS_MISMATCH/);
  assert.equal(saves,saveCount,'Catalog drift cannot falsely complete the journal');
  port.planCatalog=async()=>null;
  inventory=[{...inventory[0],final_price:11}];
  await assert.rejects(()=>new BuyAnimeImportPipeline(port).resume(pending),/FIELDS_MISMATCH/);
  assert.equal(saves,saveCount,'Inventory drift remains fail-closed');
  inventory=validInventory;
  assert.deepEqual(await inventoryProof(inventory[0]),pending.expected[0]);
  const normalSave=port.save;
  port.save=async()=>{throw new Error('Journal CAS conflict');};
  await assert.rejects(()=>new BuyAnimeImportPipeline(port).resume(pending),/Journal CAS conflict/);
  port.save=normalSave;
  assert.equal(journal.stage,'WACA_EVIDENCE_PENDING','Failed CAS never claims completion');
  assert.equal(wacaReads,0);assert.equal(wacaWrites,0);
  const provider=readFileSync('src/providers/cloud/supabaseProvider.ts','utf8');
  const buyAnimePort=provider.slice(provider.indexOf('new BuyAnimeImportPipeline('),provider.indexOf('private getBuyAnimeJournal'));
  assert.ok(buyAnimePort.includes('planCatalog'));
  assert.doesNotMatch(buyAnimePort,/planWacaEvidence|commitWacaEvidence|erp_merge_waca_master_links/);
  const page=readFileSync('src/pages/Inventory.tsx','utf8');
  assert.doesNotMatch(page,/getWacaSnapshot|saveWacaSnapshot|mergeMyAcgMasterLinks/,'NEXT import is equally decoupled');
  assert.match(readFileSync('src/pages/WacaIntegration.tsx','utf8'),/linksFromMyAcgInventory/,'Independent WACA catalog derivation remains present');
  console.log('PASS BuyAnime independent of WACA availability; 0/1/10/100/829/1000 legacy deltas, no business replay, audit preserved, Catalog/Inventory/CAS fail-closed, NEXT independent, WACA derivation preserved');
} finally {await vite.close();}
