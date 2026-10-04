import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { isolatedDatabase, owner, viewer } from './helpers/saveability-isolated.mjs';

const privateDir=process.env.BUYANIME_INCIDENT_SNAPSHOT||join(process.cwd(),'scratch','buyanime-forensic-20261003-125225');
const bytes=readFileSync(process.env.BUYANIME_FAILING_FILE||join(homedir(),'Downloads','399375_2026-10-03.xls'));
const db=await isolatedDatabase();
const server=await createServer({configFile:'tests/fixtures/inventory-cloud-import-vite.config.mjs',configLoader:'runner',
  mode:'staging',server:{host:'127.0.0.1',port:4292,strictPort:true}});
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
let browser;
try{
  // Reconstructed pre-readback authority, NOT a claim of an exact pre-import backup.
  // Physical soft-deleted parents are retained. Audit actors are replaced ONLY in this disposable DB.
  const {CLOUD_FIELD_ENTITY_CONTRACTS}=await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  await db.sql.query('delete from public.product_variants; delete from public.product_groups');
  for(const table of ['product_groups','product_categories','product_variants','inventory_items']){
    const source=JSON.parse(readFileSync(join(privateDir,table+'.json'),'utf8'));
    const rows=source.map(row=>({...row,updated_by:owner}));
    const names=['id',...CLOUD_FIELD_ENTITY_CONTRACTS[table].create,'version','updated_by','deleted_at'];
    for(let offset=0;offset<rows.length;offset+=400)await db.sql.query(
      `insert into public.${table} (${names.join(',')}) select ${names.join(',')} from jsonb_populate_recordset(null::public.${table},$1)`,
      [JSON.stringify(rows.slice(offset,offset+400))]);
  }
  await db.startPostgrest();
  await server.listen();
  browser=await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
  const context=await browser.newContext();
  let externalRequests=0;
  context.on('request',request=>{if(new URL(request.url()).hostname.endsWith('.supabase.co'))externalRequests++;});
  const connect=async()=>{
    const page=await context.newPage();
    await page.exposeFunction('__BUYANIME_ISOLATED_HTTP__',request=>db.http(request.path,request.body,owner,
      {method:request.method,headers:{...(request.prefer?{prefer:request.prefer}:{}),...(request.accept?{accept:request.accept}:{})}}));
    await page.goto('http://127.0.0.1:4292/tests/fixtures/buyanime-resume-provider.html');
    await page.waitForFunction(()=>Boolean(window.__BUYANIME_RESUME_PROVIDER__));
    await page.evaluate(actor=>window.__BUYANIME_RESUME_PROVIDER__.setup(actor),owner);
    return page;
  };
  let page=await connect();
  const legacyProbe=await page.evaluate(async()=>{
    const bridge=window.__BUYANIME_RESUME_PROVIDER__;const provider=bridge.provider();
    const record=await provider.getBuyAnimeImportRecovery();await provider.verifyBuyAnimeImportRecovery(record);
    try { await provider.importBuyAnimeInventory([], 'blocked-repeat.xls'); }
    catch(error) { return {legacy:record.legacy,rows:record.expected.length,stage:record.stage,code:error.code,metrics:bridge.metrics()}; }
    return {code:'REPEAT_NOT_BLOCKED'};
  });
  assert.equal(legacyProbe.rows,1505);assert.equal(legacyProbe.legacy,true);
  assert.equal(legacyProbe.code,'BUYANIME_EXISTING_BATCH_PENDING');
  assert.equal(legacyProbe.metrics.inventoryCommits,0);assert.equal(legacyProbe.metrics.catalogRequests,0);assert.equal(legacyProbe.metrics.wacaRequests,0);
  assert.equal((await db.sql.query('select count(*)::int n from import_batches')).rows[0].n,0,'Legacy discovery must be SELECT-only');
  // Reconstruct the pre-commit import metadata ONLY in this disposable DB.
  // Do not claim this as the unavailable exact automatic pre-import backup.
  await db.sql.query('update inventory_items set latest_catalog_import_id=null,catalog_last_seen_at=null');
  await page.close();page=await connect();
  const beforeKeys=(await db.sql.query('select inventory_key,id from public.inventory_items order by inventory_key')).rows;
  const initial=await page.evaluate(async base64=>{
    const bridge=window.__BUYANIME_RESUME_PROVIDER__;
    const provider=bridge.provider();
    // Production exposes the import control only alongside a hydrated Cloud
    // route. Populate the disposable browser cache before starting the same
    // cache-backed planning path.
    await provider.waitForCloudBootstrapConvergence();
    const parsed=await bridge.parse(base64);
    const rows=parsed.map(row=>({...row,latest_catalog_import_id:'catalog_import_411c6e55-cb73-41af-9ff1-61cf39cb532c',
      catalog_last_seen_at:'2026-10-03T04:52:25.877Z'}));
    // Exercise a true one-row business update. The other 1,504 rows are
    // unchanged and must not be rewritten merely for attempt metadata.
    rows[0]={...rows[0],myacg_sold_quantity:Number(rows[0].myacg_sold_quantity||0)+1};
    bridge.loseReadback(true);
    try{await provider.importBuyAnimeInventory(rows,'399375_2026-10-03.xls');throw new Error('FAILURE_INJECTION_MISSED');}
    catch(error){return {rows:parsed.length,code:error.code,name:error.name,causeCode:error.cause?.code,causeName:error.cause?.name,stage:error.record?.stage,metrics:bridge.metrics()};}
  },bytes.toString('base64'));
  if(initial.code!=='BUYANIME_COMMITTED_READBACK_PENDING')console.log(JSON.stringify({phase:'isolated-initial',...initial}));
  assert.equal(initial.rows,1505);assert.equal(initial.code,'BUYANIME_COMMITTED_READBACK_PENDING');
  assert.equal(initial.stage,'INVENTORY_READBACK_PENDING');assert.equal(initial.metrics.inventoryCommits,1);
  assert.equal(hash((await db.sql.query('select inventory_key,id from public.inventory_items order by inventory_key')).rows),hash(beforeKeys));
  assert.equal((await db.sql.query("select count(*)::int n from inventory_items where latest_catalog_import_id=$1",['catalog_import_411c6e55-cb73-41af-9ff1-61cf39cb532c'])).rows[0].n,1,
    'Only the changed Inventory row receives the new attempt metadata');
  const batchCount=(await db.sql.query('select count(*)::int n from import_batches')).rows[0].n;
  await page.close(); // Lose all page memory and client session state.
  page=await connect();
  const verify=await page.evaluate(async()=>{
    const bridge=window.__BUYANIME_RESUME_PROVIDER__;
    const provider=bridge.provider();
    const record=await provider.getBuyAnimeImportRecovery();
    const started=performance.now();await provider.verifyBuyAnimeImportRecovery(record);const latencyMs=performance.now()-started;
    bridge.lastRecord=record;
    return {stage:record.stage,rows:record.expected.length,metrics:bridge.metrics(),latencyMs};
  });
  assert.equal(verify.rows,1505);assert.equal(verify.metrics.inventoryCommits,0);
  assert.equal(verify.metrics.catalogRequests,0);assert.equal(verify.metrics.wacaRequests,0);
  assert.equal((await db.sql.query('select count(*)::int n from import_batches')).rows[0].n,batchCount,'Read-only re-entry wrote journal');
  const beforeLedger=(await db.sql.query('select count(*)::int n from public.erp_idempotency_keys')).rows[0].n;
  const catalogLoss=await page.evaluate(async()=>{
    const bridge=window.__BUYANIME_RESUME_PROVIDER__;bridge.fresh();bridge.loseCatalog(true);
    try{await bridge.provider().resumeBuyAnimeImport(bridge.lastRecord);return {code:'MISSING_INJECTION'};}
    catch(error){return {code:error.code,metrics:bridge.metrics()};}
  });
  assert.equal(catalogLoss.code,'BUYANIME_CATALOG_PENDING');
  assert.equal(catalogLoss.metrics.inventoryCommits,0);
  const ledgerAfter=(await db.sql.query('select count(*)::int n from public.erp_idempotency_keys')).rows[0].n;
  assert.equal(ledgerAfter,beforeLedger+1,'The post-F5 Catalog transaction must commit exactly once before response loss');
  const catalogAfterHash=hash((await db.sql.query(`select jsonb_build_object(
    'g',(select jsonb_agg(g order by id) from product_groups g),
    'c',(select jsonb_agg(c order by id) from product_categories c),
    'v',(select jsonb_agg(v order by id) from product_variants v)) result`)).rows[0].result);
  await page.close();page=await connect();
  const wacaLoss=await page.evaluate(async()=>{
    const bridge=window.__BUYANIME_RESUME_PROVIDER__;bridge.fresh();bridge.loseWaca(true);
    const provider=bridge.provider();
    try{await provider.recoverPendingBuyAnimeImport();return {code:'NO_WACA_WRITE_REQUIRED',metrics:bridge.metrics()};}
    catch(error){return {code:error.message?.includes('WACA')?'WACA_RESPONSE_LOST':'PENDING',metrics:bridge.metrics()};}
  });
  assert.equal(wacaLoss.metrics.inventoryCommits,0);
  assert.equal(wacaLoss.metrics.catalogRequests,1,'Replayed EXACT Catalog request after close/relogin');
  assert.equal(wacaLoss.metrics.wacaRequests,0,'BuyAnime never reads or writes WACA, even when the WACA transport fails');
  const ledgerAfterWaca=(await db.sql.query('select count(*)::int n from public.erp_idempotency_keys')).rows[0].n;
  assert.equal(ledgerAfterWaca,ledgerAfter+wacaLoss.metrics.wacaRequests,
    'A WACA delta must create exactly one idempotency result before response loss');
  assert.equal(hash((await db.sql.query(`select jsonb_build_object(
    'g',(select jsonb_agg(g order by id) from product_groups g),
    'c',(select jsonb_agg(c order by id) from product_categories c),
    'v',(select jsonb_agg(v order by id) from product_variants v)) result`)).rows[0].result),catalogAfterHash,'Catalog replay changed identities/versions');
  const wacaRevision=(await db.sql.query('select revision from waca_state')).rows[0].revision;
  await page.close();page=await connect();
  const final=await page.evaluate(async()=>{
    const bridge=window.__BUYANIME_RESUME_PROVIDER__;bridge.fresh();const provider=bridge.provider();
    try {
      const completed=await provider.recoverPendingBuyAnimeImport();
      if(completed)await provider.recoverPendingBuyAnimeImport();
      return {stage:completed?.stage||'COMPLETE',recovery:await provider.getBuyAnimeImportRecovery(),metrics:bridge.metrics()};
    } catch(error) {
      const chain=[];for(let value=error,depth=0;value&&depth<6;value=value.cause,depth++)
        chain.push({code:value.code,name:value.name,status:value.status});
      return {failure:true,chain,metrics:bridge.metrics()};
    }
  });
  if(final.failure)console.log(JSON.stringify({phase:'final-recovery',...final}));
  assert.equal(final.stage,'COMPLETE');assert.equal(final.recovery,null);
  assert.equal(final.metrics.inventoryCommits,0);assert.equal(final.metrics.catalogRequests,0);
  assert.equal(final.metrics.wacaRequests,0,
    'Response-loss recovery must reconcile committed evidence without replaying the WACA request');
  assert.equal((await db.sql.query('select revision from waca_state')).rows[0].revision,wacaRevision);
  assert.equal((await db.sql.query('select count(*)::int n from erp_idempotency_keys')).rows[0].n,ledgerAfterWaca);
  // An actual older durable WACA stage is closed only after fresh Catalog
  // SELECT verification. Its uncommitted WACA intent is audit, not a receipt.
  const {importWacaDeltaKey}=await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
  const completedJournal=(await db.sql.query('select id,details,version from import_batches limit 1')).rows[0];
  const decode=details=>details.buyAnimeImportGzip
    ? JSON.parse(gunzipSync(Buffer.from(details.buyAnimeImportGzip,'base64')).toString('utf8')):details.buyAnimeImport;
  const completedRecord=decode(completedJournal.details);
  const oldIntent={key:importWacaDeltaKey(completedRecord.batchId),expectedRevision:Number(wacaRevision),
    links:[{mainCode:'GP-SYNTHETIC',childCode:'G-SYNTHETIC',productGroupId:'',productVariantId:'',variantTitle:'A',sourceFile:'synthetic.xls',observedAt:'2026-10-04T00:00:00.000Z'}],
    inserted:1,updated:0,unchanged:0};
  const legacyPending={...completedRecord,stage:'WACA_EVIDENCE_PENDING',waca:oldIntent,version:completedJournal.version};
  const {buyAnimeImportGzip:_gzip,...legacyDetails}=completedJournal.details;
  await db.sql.query('update import_batches set details=$2 where id=$1',[completedJournal.id,{...legacyDetails,buyAnimeImport:legacyPending}]);
  await page.close();page=await connect();
  const legacyWacaRecovery=await page.evaluate(async()=>{
    const bridge=window.__BUYANIME_RESUME_PROVIDER__;bridge.fresh();
    const provider=bridge.provider();await provider.waitForCloudBootstrapConvergence();bridge.resetMetrics();
    const record=await provider.recoverPendingBuyAnimeImport();return {stage:record.stage,metrics:bridge.metrics()};
  });
  assert.equal(legacyWacaRecovery.stage,'COMPLETE');
  assert.equal(legacyWacaRecovery.metrics.inventoryCommits,0);assert.equal(legacyWacaRecovery.metrics.catalogRequests,0);
  assert.equal(legacyWacaRecovery.metrics.wacaRequests,0);assert.equal(legacyWacaRecovery.metrics.fullWacaSnapshotReads,0);
  assert.deepEqual(decode((await db.sql.query('select details from import_batches where id=$1',[completedJournal.id])).rows[0].details).waca,oldIntent);
  assert.equal((await db.sql.query('select revision from waca_state')).rows[0].revision,wacaRevision);
  assert.equal((await db.sql.query('select count(*)::int n from erp_idempotency_keys')).rows[0].n,ledgerAfterWaca);
  assert.equal(externalRequests,0);
  // Existing grants/RLS, no migration changes: authenticated read, viewer/anon cannot write.
  const journal=(await db.sql.query('select id,details,version from import_batches limit 1')).rows[0];
  for(const actor of [viewer,null]){
    const denied=await db.http('/import_batches?id=eq.'+journal.id,{details:journal.details,version:journal.version+1},actor,
      {method:'PATCH',headers:{prefer:'return=representation'}});
    assert.ok([200,401,403].includes(denied.status));
    assert.ok(denied.status!==200 || denied.data.length===0);
  }
  // Concurrent stage claim: stale version updates zero rows, cannot overwrite the pinned intent.
  const stale=await db.http('/import_batches?id=eq.'+journal.id+'&version=eq.1',{version:2,details:{}},owner,
    {method:'PATCH',headers:{prefer:'return=representation'}});
  assert.equal(stale.status,200);assert.deepEqual(stale.data,[]);
  const exported=(await db.sql.query('select public.erp_export_cloud_restore_snapshot() result')).rows[0].result;
  assert.ok(JSON.stringify(exported).includes('BUYANIME_IMPORT_RESUME_V1'),'Existing Backup lost optional journal details');
  console.log(JSON.stringify({result:'PASS',fixture:'exact 399375_2026-10-03.xls + reconstructed authoritative incident state',
    rows:1505,inventoryCommits:1,inventoryUUIDChurn:0,fullFieldHashProof:'PASS',closeReloginRecovery:'PASS',
    catalogReplayNoChange:'PASS',wacaDecoupled:'PASS',legacyWacaFreshCatalogRecovery:'PASS',pipeline:final.stage,journalRlsCas:'PASS',
    existingBackupJournalPreserved:'PASS',legacyIncidentReadOnlyDiscovery:'PASS',readback:{...verify.metrics,totalLatencyMs:verify.latencyMs},externalRequests,liveWrites:0}));
}catch(error){
  // No private source rows, SQL DETAIL, HTTP bodies or credentials in diagnostics.
  const safeCodes=[];for(let value=error,depth=0;value&&depth<6;value=value.cause,depth++){
    safeCodes.push(...String(value.code||value.message||value.name).match(/(?:BUYANIME_|CLOUD_|P0_)[A-Z0-9_]+/gu)||[]);
  }
  if(safeCodes.length)console.log(JSON.stringify({phase:'safe-diagnostic',safeCodes}));
  throw new Error('BUYANIME_ISOLATED_REGRESSION_FAILED: '+(error.code||error.name)+
    (error.name==='AssertionError'?' assertion at '+String(error.stack).split('\n').find(line=>line.includes('buyanime-readback-resume-isolated.mjs')):''));
}finally{await browser?.close();await server.close();await vite.close();await db.close();}
