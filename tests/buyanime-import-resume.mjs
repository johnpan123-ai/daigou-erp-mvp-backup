import assert from 'node:assert/strict';
import { createServer } from 'vite';

globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false } });
try {
  const { BuyAnimeImportPipeline, inventoryProof, importCatalogKey, proveInventoryRows, assertImportRecord, buyAnimeRecoveryMessage } = await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
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
  const plan = { request:{family:'catalog', mode:'sync', dependencies:{}, operations:{product_groups:[],product_categories:[],product_variants:[]}},
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
    ensureWacaEvidence: async () => {
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
  console.log('PASS 1505 rows: committed/readback-pending, full expected fields+UUID proof, read-only verify, F5/close/relogin, Inventory exactly once, exact Catalog replay, WACA retry, legacy resume, fail-closed unknown, COMPLETE');
} finally { await vite.close(); }
