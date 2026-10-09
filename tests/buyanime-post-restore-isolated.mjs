// Permanent release gate. Exact private files stay outside Git; transport is
// hard-bound to a disposable native PostgreSQL/PostgREST and fresh browser.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {isolatedDatabase,owner} from './helpers/saveability-isolated.mjs';
// The Catalog planner is pure, but its shared db.ts module also exports browser
// adapters. Keep those adapters unopened in this Node-side Restore gate.
globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const root='scratch/buyanime-post-restore-recovery-20261005';
const legacyRaw=await readFile(process.env.ERP1_V1_REAL_SNAPSHOT,'utf8');
assert.equal(createHash('sha256').update(legacyRaw).digest('hex'),'0048b8b66542d09bbabaad6b7f7741c11f687449d1711cacd6e62e24ef5500e4');
const currentRaw=await readFile(process.env.ERP2_CURRENT_REAL_SNAPSHOT,'utf8');
const xls=await readFile(process.env.BUYANIME_POST_RESTORE_FILE);
assert.equal(xls.length,1003843);
assert.equal(createHash('sha256').update(xls).digest('hex'),'5e1189d60a756da470222ed83c85603c52210ae1c17baed055ba48e285f9756d');
const db=await isolatedDatabase();
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
const server=await createServer({configFile:'tests/fixtures/inventory-cloud-import-vite.config.mjs',configLoader:'runner',mode:'staging',server:{host:'127.0.0.1',port:4292,strictPort:true,hmr:false,watch:null}});
let browser,context,page,stage='prepare';const result={liveMutation:0,externalRequests:0,runs:[]};
try{
 const r=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const portability=await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
 const current=await r.prepareCloudRestoreSnapshot(currentRaw);
 for(const id of new Set(Object.values(current.data).flatMap(rows=>rows.map(x=>x.updated_by).filter(id=>id&&id!==owner))))
  await db.sql.query('insert into auth.users(id,email) values($1,$2) on conflict do nothing',[id,'isolated@example.invalid']);
 await db.sql.query("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
 const restore=async(candidate)=>{
  const request=randomUUID(),attempt=randomUUID(),trace=randomUUID();
  const proof=(await db.sql.query('select public.erp_prove_cloud_restore_candidate_v2($1,$2,$3,$4,$5) result',
   [candidate.sourceData??candidate.data,candidate.manifest,candidate.portability?'cross-environment':'strict','isolated',request])).rows[0].result;
  assert.equal(proof.ok,true);
  await db.sql.query('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,$7,$8)',[attempt,trace,candidate.portability?.sourceSnapshotFingerprint??candidate.manifest.snapshotFingerprint,candidate.manifest.snapshotFingerprint,candidate.portability?.policyVersion??'strict','rhfdjsklfrgpoqsaqpkn',120000,'postgresql-statement-timeout-v1']);
  const body={p_attempt_id:attempt,p_trace_id:trace,p_execution_id:randomUUID(),p_proof_id:proof.proof_id,p_request_id:request};
  assert.equal(Buffer.byteLength(JSON.stringify(body)),269);
  const out=(await db.sql.query('select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result',Object.values(body))).rows[0].result;
  assert.equal(out.ok,true);return out;
 };
 await restore(current);
 let legacy=await r.prepareCloudRestoreSnapshot(legacyRaw);
 legacy=await r.preserveLegacyCloudDashboardImages(legacy,current.data.dashboard_category_images);
 const portable=await portability.prepareCrossEnvironmentCloudRestoreCandidate(legacy,'rhfdjsklfrgpoqsaqpkn');
 await restore(portable);
 result.legacyRestore='PASS';
 const catalog=await vite.ssrLoadModule('/src/providers/cloud/catalogTransaction.ts');
 const projectMaterialized=async(label)=>{
  const inventoryId=randomUUID(),groupId=randomUUID(),variantId=randomUUID();
  const code=`G-POST-RESTORE-${label}`,title=`Post Restore ${label}`,raw=`${label} Variant`;
  await db.sql.query(`insert into inventory_items(id,inventory_key,myacg_item_code,product_title,raw_variant_name,myacg_sold_quantity,import_sort_index)
    values($1,$2,$3,$4,$5,1,1)`,[inventoryId,`post-restore-${label}`,code,title,raw]);
  await db.sql.query('insert into product_groups(id,title,show_in_purchase_list) values($1,$2,false)',[groupId,title]);
  await db.sql.query(`insert into product_variants(id,product_group_id,myacg_item_code,product_title,variant_name,raw_variant_name,source,waca_auto_quantity)
    values($1,$2,$3,$4,$5,$5,'inventory_import',7)`,[variantId,groupId,code,title,raw]);
  const snapshot={};
  for(const [key,table] of Object.entries({inventory:'inventory_items',groups:'product_groups',categories:'product_categories',variants:'product_variants'}))
   snapshot[key]=(await db.sql.query(`select * from ${table} where deleted_at is null order by id`)).rows;
  const plan=await catalog.planCatalogTransaction(snapshot,'create',[code]);
  const committed=(await db.sql.query('select public.erp_apply_catalog_transaction($1,$2) result',[randomUUID(),plan.request])).rows[0].result;
  assert.equal(committed.ok,true,JSON.stringify(committed));
  const row=(await db.sql.query(`select g.show_in_purchase_list,v.source,v.waca_auto_quantity from product_variants v
    join product_groups g on g.id=v.product_group_id where v.id=$1`,[variantId])).rows[0];
  assert.deepEqual([row.show_in_purchase_list,row.source,Number(row.waca_auto_quantity)],[true,'myacg_order_import',7]);
 };
 await projectMaterialized('ERP1');result.erp1PurchaseProjection='PASS';
 await db.startPostgrest();await server.listen();
 browser=await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 const connect=async()=>{
  if(context)await context.close();context=await browser.newContext({acceptDownloads:false});
  await context.route('https://**/*',route=>{result.externalRequests++;return route.abort();});
  page=await context.newPage();
  await page.exposeFunction('__BUYANIME_ISOLATED_HTTP__',request=>db.http(request.path,request.body,owner,{method:request.method,headers:{...(request.prefer?{prefer:request.prefer}:{}),...(request.accept?{accept:request.accept}:{})}}));
  await page.goto('http://127.0.0.1:4292/tests/fixtures/buyanime-resume-provider.html');
  await page.waitForFunction(()=>Boolean(window.__BUYANIME_RESUME_PROVIDER__));
  await page.evaluate(actor=>window.__BUYANIME_RESUME_PROVIDER__.setup(actor),owner);
 };
 const run=async(label)=>{
  await connect();
  return page.evaluate(async({base64,label})=>{
   const bridge=window.__BUYANIME_RESUME_PROVIDER__,provider=bridge.provider();
   await provider.waitForCloudBootstrapConvergence();
   const parsed=await bridge.parse(base64);if(parsed.length!==1551)throw new Error('EXACT_PARSE_PARITY_FAILED');
   const recovery=await provider.getBuyAnimeImportRecovery();if(recovery)throw new Error('STALE_RECOVERY_BLOCK');
   bridge.resetMetrics();
   const {renderImportBenchmarkUi}=await import('/tests/fixtures/buyanime-performance-ui.tsx');
   try {
    const ui=await renderImportBenchmarkUi(provider,base64,'399375_2026-10-05 (2).xls');
    return {label,parsedRows:parsed.length,totalMs:ui.totalMs,syncText:ui.syncText,successVisible:ui.modalText.includes('匯入成功'),trace:ui.trace,metrics:bridge.metrics()};
   } catch(error) {
    return {label,parsedRows:parsed.length,error:String(error?.message||error),
      trace:window.__ERP2_BUYANIME_PRODUCTION_TRACE__,metrics:bridge.metrics()};
   }
  },{base64:xls.toString('base64'),label});
 };
 stage='ERP1 Restore -> immediate BuyAnime';
 for(let n=0;n<5;n++){
  const runResult=await run('ERP1-repeat-'+(n+1));
  assert.equal(runResult.error,undefined,JSON.stringify(runResult));
  assert.equal(runResult.successVisible,true);assert.match(runResult.syncText,/已同步/u);
  assert.equal(runResult.metrics.wacaRequests,0);result.runs.push(runResult);
 }
 result.erp1BuyAnime='PASS';result.sameFile5x='PASS';
 const keys=(await db.sql.query('select count(*)::int n,count(distinct inventory_key)::int unique_keys from inventory_items')).rows[0];
 assert.equal(keys.n,keys.unique_keys,'DUPLICATE_INVENTORY_KEY');
 const oldJournal=(await db.sql.query("select id,details from import_batches where platform='buyanime-catalog-resume-v1' order by imported_at desc limit 1")).rows[0];
 const oldRecord=oldJournal.details.buyAnimeImportGzip
  ?JSON.parse(gunzipSync(Buffer.from(oldJournal.details.buyAnimeImportGzip,'base64')).toString('utf8')):oldJournal.details.buyAnimeImport;
 const {buyAnimeImportGzip:_compressed,...detailArrays}=oldJournal.details;
 // Explicit unknown-outcome fixture: Restore must supersede it without
 // deleting its original record or attempting its old business dispatch.
 oldJournal.details={...detailArrays,buyAnimeImport:{...oldRecord,stage:'INVENTORY_COMMIT_UNKNOWN'}};
 await db.sql.query('update import_batches set details=$2 where id=$1',[oldJournal.id,oldJournal.details]);
 const oldDetails=oldJournal.details;
 // Real current-v2 Restore retains its operational journal subtype literally;
 // the scanner must retire it by generation rather than delete or rewrite it.
 const currentWithJournal=await r.buildCloudRestoreManifest((await db.sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data);
 await restore(currentWithJournal);await connect();
 await projectMaterialized('ERP2');result.erp2PurchaseProjection='PASS';
 stage='stale retained journal';
 const stale=await page.evaluate(async(oldRecord)=>{
  const {readEligibleBuyAnimeJournals}=await import('/src/providers/cloud/buyAnimeImportJournal.ts');
  const epoch=await import('/src/providers/cloud/buyAnimeRecoveryEpoch.ts');
  const journal=oldRecord;const current=await epoch.readBuyAnimeRestoreGeneration();
  const scanned=await readEligibleBuyAnimeJournals(current);
  if(scanned.active || !scanned.completedBatchIds.has(journal.batchId)) throw new Error('STALE_JOURNAL_NOT_RETIRED');
  const provider=window.__BUYANIME_RESUME_PROVIDER__.provider();
  const validity=epoch.classifyBuyAnimeRecoveryGeneration(journal,current);
  const pending=await provider.getBuyAnimeImportRecovery();
  let directResumeBlocked=false;try{await provider.resumeBuyAnimeImport(journal);}catch(e){directResumeBlocked=e.code==='RECOVERY_STATE_ERROR';}
  return {validity,oldStage:journal.stage,pending:pending===null,directResumeBlocked,metrics:window.__BUYANIME_RESUME_PROVIDER__.metrics()};
 },{...oldRecord,stage:'INVENTORY_COMMIT_UNKNOWN'});
 assert.equal(stale.validity,'STALE_AFTER_RESTORE');assert.equal(stale.pending,true);assert.equal(stale.directResumeBlocked,true);
 assert.equal(stale.oldStage,'INVENTORY_COMMIT_UNKNOWN');
 assert.equal(stale.metrics.inventoryCommits,0);assert.equal(stale.metrics.catalogRequests,0);
 assert.ok(isDeepStrictEqual((await db.sql.query('select details from import_batches where id=$1',[oldJournal.id])).rows[0].details,oldDetails),'RETAINED_JOURNAL_CONTENT_CHANGED');
 result.oldAuditPreserved='PASS';result.staleRecordNoReplay='PASS';
 stage='ERP2 current Restore -> immediate BuyAnime';
 result.runs.push(await run('ERP2-current-restored'));result.erp2BuyAnime='PASS';
 // Independent ERP1 Restore -> immediate real WACA import uses the identical
 // resolver, native atomic commit/readback and legacy rebaseline contract.
 stage='ERP1 Restore -> immediate WACA';
 // The prepared-attempt API intentionally reuses an already completed proof
 // for an identical historical snapshot. This SECOND independent gate calls
 // that same canonical transactional writer with a fresh isolated request;
 // the earlier real short-envelope tests still verify 041/042/043 dispatch.
 assert.equal((await db.sql.query('select public.erp_restore_cloud_snapshot($1,$2,$3,$4,$5) result',
  [randomUUID(),portable.manifest.snapshotFingerprint,portable.data,portable.manifest,'isolated-post-restore-waca'])).rows[0].result.ok,true);
 const core=await vite.ssrLoadModule('/src/waca/orderCore.ts');
 const storage=await vite.ssrLoadModule('/src/waca/nextStorage.ts');
 const master=await vite.ssrLoadModule('/src/waca/masterReference.ts');
 const parser=await vite.ssrLoadModule('/src/waca/workbookParser.ts');
 const confirm=await vite.ssrLoadModule('/src/waca/confirmFlow.ts');
 const rpc=async(name,args)=>{const response=await db.http('/rpc/'+name,args);assert.equal(response.status,200);return response.data;};
 const currentWaca=await rpc('erp_read_waca_snapshot',{});
 const variants=async()=>(await db.sql.query('select * from product_variants where deleted_at is null')).rows;
 const variantRows=await variants(),inventory=(await db.sql.query('select * from inventory_items where deleted_at is null')).rows;
 const links=master.mergeMyAcgMasterLinks(master.linksFromMyAcgInventory(inventory,variantRows,'POST_RESTORE_REAL_XLS','').links,currentWaca.masterLinks);
 const reference=master.buildWacaMasterReference(variantRows,links);
 const repository=storage.repositoryFromSnapshot(currentWaca,variantRows);
 const orderRows=parser.parseWacaWorkbook(await readFile(process.env.WACA_INCIDENT_FILE)).rows;
 const request=randomUUID();const imported=core.importWacaRows(orderRows,repository,reference,request);core.refreshWacaMasterStatus(repository,reference);
 assert.equal(imported.errors.length,0);
 const batch={id:request,fileName:'isolated-real.xlsx',importedAt:new Date().toISOString(),rows:orderRows.length,inserted:imported.inserted,updated:imported.updated,unchanged:imported.unchanged,result:imported,conflictRows:[]};
 const candidate=storage.snapshotFromRepository(currentWaca,repository,[...currentWaca.batches,batch],links);
 const provider={getNextWacaSnapshot:()=>rpc('erp_read_waca_snapshot',{}),getAuthoritativeWacaVariants:variants,
 commitNextWacaSnapshot:async(s,revision,update)=>(await rpc('erp_commit_waca_snapshot',{p_snapshot:s,p_expected_revision:revision,p_update_auto_quantity:update})).revision};
 const verified=await confirm.commitAndVerifyWaca({current:currentWaca,candidate,requestId:request,cloud:true,onStage(){},provider});
 assert.ok(verified.snapshot.orders.length>0);result.erp1Waca='PASS';
 assert.equal(result.externalRequests,0);result.result='PASS';
 await mkdir(root,{recursive:true});await writeFile(root+'/post-restore-regression.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify({result:'PASS',parsedRows:1551,legacyRestore:result.legacyRestore,erp1PurchaseProjection:result.erp1PurchaseProjection,erp2PurchaseProjection:result.erp2PurchaseProjection,erp1BuyAnime:result.erp1BuyAnime,erp2BuyAnime:result.erp2BuyAnime,oldAuditPreserved:result.oldAuditPreserved,sameFile5x:result.sameFile5x,erp1Waca:result.erp1Waca,externalRequests:0,liveMutation:0}));
}catch(e){console.log(JSON.stringify({stage,errorCode:e.code,errorName:e.name,errorMessage:e.message}));throw new Error('POST_RESTORE_ISOLATED_GATE_FAILED: '+stage);}
finally{if(browser)await browser.close();await server.close();await vite.close();await db.close();}
