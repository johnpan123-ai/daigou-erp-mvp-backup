import assert from 'node:assert/strict';
import { createServer } from 'vite';

globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false } });
try {
  const { BuyAnimeImportPipeline, inventoryProof, importCatalogKey, importWacaDeltaKey,
    proveInventoryRows, assertImportRecord, buyAnimeRecoveryMessage } = await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
  const { planCloudInventoryImport } = await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
  const { CloudMutationBoundaryError } = await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const batchId = 'catalog_import_411c6e55-cb73-41af-9ff1-61cf39cb532c';
  const incoming = Array.from({length:1505}, (_,n) => ({id:uuid(n),version:1, inventory_key:'Synthetic::G'+n+'::A',
    myacg_item_code:'G'+n, myacg_parent_code:'GP1',product_title:'Synthetic',raw_variant_name:'A', listing_type:'',
    final_price:10, myacg_available_quantity:0,myacg_sold_quantity:1,myacg_listed_at:'',
    latest_catalog_import_id:batchId,catalog_last_seen_at:'2026-10-03T04:52:25.877Z'}));
  let journal = null, authoritative = [], inventoryCommits = 0, catalogCommits = 0, wacaCommits = 0;
  let readFailure = true, lostCatalog = true, lostWaca = true;
  const catalogKeys = [], catalogRequests = [], seenKeys = new Set();
  const plan = { request:{family:'catalog', mode:'sync', dependencies:{}, operations:{product_groups:[{kind:'create',id:uuid(900),values:{}}],product_categories:[],product_variants:[]}},
    summary:{filledVariantsCount:0,affectedGroupsCount:0,upgradedSkusCount:0} };
  const port = {
    load: async () => structuredClone(journal),
    save: async (record, version) => {
      assert.equal(journal?.version || 0, version, 'Durable journal CAS');
      journal = structuredClone({...record,version:version+1}); return structuredClone(journal);
    },
    prepareInventory: async rows => planCloudInventoryImport([],rows),
    commitInventory: async mutation => { inventoryCommits++; authoritative = mutation.inventory; },
    readInventory: async () => { if(readFailure) throw new Error('Readback unavailable'); return [...authoritative].reverse(); },
    planCatalog: async () => structuredClone(plan),
    commitCatalog: async catalog => {
      catalogKeys.push(catalog.key); catalogRequests.push(JSON.stringify(catalog.plan));
      if(!seenKeys.has(catalog.key)){ catalogCommits++; seenKeys.add(catalog.key); }
      if(lostCatalog){ lostCatalog=false; throw new CloudMutationBoundaryError('result-unknown',new Error('Failed to fetch')); }
    },
    verifyCatalog: async () => {},
    planWacaEvidence: async record => ({key:importWacaDeltaKey(record.batchId),expectedRevision:0,
      links:[{mainCode:'GP1',childCode:'G1',productGroupId:uuid(900),productVariantId:uuid(901),variantTitle:'A',sourceFile:record.fileName,sourceFiles:[record.fileName],observedAt:record.observedAt}],inserted:1,updated:0,unchanged:0}),
    commitWacaEvidence: async () => {
      if(wacaCommits===0)wacaCommits++;
      if(lostWaca){lostWaca=false;throw new Error('response lost after WACA evidence commit');}
    },
  };
  await assert.rejects(() => new BuyAnimeImportPipeline(port).start(incoming,'399375_2026-10-03.xls'), /COMMITTED_READBACK_PENDING/);
  assert.equal(inventoryCommits,1);
  assert.equal(journal.stage,'INVENTORY_COMMITTING','Durable intent remains sufficient for F5 reconciliation without an extra large journal write');
  assert.match(buyAnimeRecoveryMessage(journal),/雲端核對/u);
  // New instance simulates F5/closed tab/new login. Nothing relies on React/session storage.
  readFailure=false;
  await new BuyAnimeImportPipeline(port).verify(structuredClone(journal));
  assert.equal(inventoryCommits,1);assert.equal(catalogCommits,0);assert.equal(wacaCommits,0,'Verify is read-only');
  await assert.rejects(() => new BuyAnimeImportPipeline(port).resume(structuredClone(journal)), /CATALOG_PENDING/);
  assert.equal(journal.stage,'CATALOG_COMMITTING');
  assert.equal(catalogCommits,1);
  await assert.rejects(() => new BuyAnimeImportPipeline(port).resume(structuredClone(journal)), /response lost/);
  assert.equal(journal.stage,'WACA_EVIDENCE_PENDING');
  const completed = await new BuyAnimeImportPipeline(port).resume(structuredClone(journal));
  assert.equal(completed.stage,'COMPLETE');
  await new BuyAnimeImportPipeline(port).resume(completed);
  assert.equal(inventoryCommits,1);assert.equal(catalogCommits,1);assert.equal(wacaCommits,1);
  assert.deepEqual([...new Set(catalogKeys)],[importCatalogKey(batchId)]);
  assert.equal(new Set(catalogRequests).size,1,'Response-lost replay uses EXACT saved request');
  // A pending provenance-only bulk intent from an older runtime is replanned
  // against current authoritative links and closes without another WACA RPC.
  const pendingBulk={...completed,stage:'WACA_EVIDENCE_PENDING',version:completed.version,waca:{
    key:importWacaDeltaKey(batchId),expectedRevision:8,
    links:Array.from({length:829},(_,index)=>({mainCode:'GP1',childCode:'G'+index,
      productGroupId:uuid(900),productVariantId:uuid(901),variantTitle:'A',sourceFile:'new-file.xls',
      sourceFiles:['old-file.xls','new-file.xls'],observedAt:'2026-10-04T10:25:26.372Z'})),
    inserted:0,updated:829,unchanged:0,
  }};
  journal=structuredClone(pendingBulk);wacaCommits=0;
  const originalPlanWaca=port.planWacaEvidence;
  port.planWacaEvidence=async record=>({key:importWacaDeltaKey(record.batchId),expectedRevision:8,
    links:[],inserted:0,updated:0,unchanged:829});
  const reconciledBulk=await new BuyAnimeImportPipeline(port).resume(structuredClone(pendingBulk));
  assert.equal(reconciledBulk.stage,'COMPLETE');assert.equal(wacaCommits,0,
    'resumed provenance-only intent must not replay the 829-row WACA mutation');
  port.planWacaEvidence=originalPlanWaca;
  await assert.rejects(() => proveInventoryRows(journal,authoritative.slice(1)),/COUNT_MISMATCH/);
  const corrupted = structuredClone(authoritative); corrupted[0].final_price++;
  await assert.rejects(() => proveInventoryRows(journal,corrupted),/FIELDS_MISMATCH/);
  const replacement = structuredClone(authoritative); replacement[0].id=uuid(55555);
  await assert.rejects(() => proveInventoryRows(journal,replacement),/FIELDS_MISMATCH/);
  assert.throws(() => assertImportRecord({...journal,expected:[...journal.expected,journal.expected[0]]}),/JOURNAL_INVALID/);
  // Legacy committed batch adoption: only resume writes optional operational progress,
  // never the existing Inventory or a new business resource.
  journal=null; inventoryCommits=0;catalogCommits=0;wacaCommits=0;seenKeys.clear();
  const legacy={...completed,version:0,stage:'INVENTORY_COMMITTED',legacy:true,catalog:undefined};
  await new BuyAnimeImportPipeline(port).verify(legacy);
  assert.equal(journal,null);
  const legacyResult=await new BuyAnimeImportPipeline(port).resume(legacy);
  assert.equal(legacyResult.stage,'COMPLETE');assert.equal(inventoryCommits,0);
  // Failed precommit and uncertain outcome never dispatch Inventory on resume.
  for(const stage of ['PLANNED','FAILED_PRE_COMMIT']){
    journal={...legacyResult,stage};
    await assert.rejects(() => new BuyAnimeImportPipeline(port).resume(journal),/NOT_COMMITTED/);
  }
  journal={...legacy,version:0,stage:'INVENTORY_COMMIT_UNKNOWN'};
  port.load=async()=>null; authoritative=[];
  await assert.rejects(() => new BuyAnimeImportPipeline(port).resume(journal),/COUNT_MISMATCH/);
  assert.equal(inventoryCommits,0);
  assert.equal((await inventoryProof(incoming[0])).hash.length,64);
  // Parser rows without inventory_key reuse canonical projection, not caller guesses.
  journal=null;authoritative=[];inventoryCommits=0;readFailure=false;
  const unkeyed=incoming.slice(0,3).map(({inventory_key: _key,...row})=>row);
  const keyedResult=await new BuyAnimeImportPipeline(port).start(unkeyed,'parser-without-key.xls');
  assert.equal(keyedResult.expected.length,3);assert.equal(inventoryCommits,1);
  // A lost Inventory response is UNKNOWN, never falsely reported as rolled back.
  const realCommit=port.commitInventory;
  port.commitInventory=async mutation=>{await realCommit(mutation);throw new TypeError('Failed to fetch');};
  journal=null;authoritative=[];inventoryCommits=0;
  await assert.rejects(()=>new BuyAnimeImportPipeline(port).start(unkeyed,'unknown.xls'),/OUTCOME_UNKNOWN/);
  assert.equal(journal.stage,'INVENTORY_COMMIT_UNKNOWN');assert.equal(inventoryCommits,1);
  await new BuyAnimeImportPipeline(port).resume(journal);assert.equal(inventoryCommits,1);
  port.commitInventory=realCommit;
  // A proven Catalog rollback may discard only its intent and replan; Inventory never resends.
  const {BuyAnimeResumeError}=await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
  journal={...keyedResult,stage:'CATALOG_PENDING',catalog:undefined};
  const normalCatalog=port.commitCatalog;
  port.commitCatalog=async()=>{throw new BuyAnimeResumeError('BUYANIME_CATALOG_ROLLED_BACK');};
  await assert.rejects(()=>new BuyAnimeImportPipeline(port).resume(journal),/CATALOG_PENDING/);
  assert.equal(journal.stage,'CATALOG_PENDING');assert.equal(journal.catalog,undefined);
  port.commitCatalog=normalCatalog;
  // Production no-change fast path: the Inventory port receives the empty
  // touched-set but sends no RPC; Catalog/WACA mutation stay skipped, there is
  // no resume read and exactly one durable COMPLETE journal write.
  let noOpLoads=0,noOpSaves=0,noOpInventory=0,noOpCatalog=0,noOpWaca=0,noOpJournal=null;
  const noOpPlan={operations:[],inventory:incoming,imported:incoming,batchId,
    stats:{total:incoming.length,newCount:0,updatedCount:0,unchangedCount:incoming.length,groupCount:1}};
  const noOpPort={
    load:async()=>{noOpLoads++;return structuredClone(noOpJournal);},
    save:async(record,version)=>{noOpSaves++;assert.equal(version,0);noOpJournal={...record,version:1};return structuredClone(noOpJournal);},
    prepareInventory:async()=>noOpPlan,commitInventory:async()=>{noOpInventory++;},readInventory:async()=>[],
    planCatalog:async()=>({request:{family:'catalog',mode:'sync',dependencies:{},operations:{product_groups:[],product_categories:[],product_variants:[]}},summary:{}}),
    commitCatalog:async()=>{noOpCatalog++;},verifyCatalog:async()=>{},
    planWacaEvidence:async record=>({key:importWacaDeltaKey(record.batchId),expectedRevision:7,links:[],inserted:0,updated:0,unchanged:12}),
    commitWacaEvidence:async()=>{noOpWaca++;},
  };
  const noOpPipeline=new BuyAnimeImportPipeline(noOpPort);
  const noOpStarted=await noOpPipeline.start(incoming,'same-file.xls');
  const noOpComplete=await noOpPipeline.resume(noOpStarted);
  assert.equal(noOpComplete.stage,'COMPLETE');
  assert.deepEqual({noOpLoads,noOpSaves,noOpInventory,noOpCatalog,noOpWaca},
    {noOpLoads:0,noOpSaves:1,noOpInventory:1,noOpCatalog:0,noOpWaca:0});
  console.log('PASS 1505 rows: committed/readback-pending, full expected fields+UUID proof, read-only verify, F5/close/relogin, Inventory exactly once, exact Catalog replay, WACA retry, legacy resume, fail-closed unknown, COMPLETE');
} finally { await vite.close(); }
