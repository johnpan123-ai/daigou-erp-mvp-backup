import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {isolatedDatabase,owner} from './helpers/saveability-isolated.mjs';
import {readUtf8Json} from './helpers/utf8-json-stream.mjs';
const utf8Probe={feature:'中文／日文【規格】',productTitle:'代理版 商品 Ａ'};
const probeBytes=Buffer.from(JSON.stringify(utf8Probe));
assert.deepEqual(await readUtf8Json((async function*(){for(const byte of probeBytes)yield Buffer.from([byte]);})()),utf8Probe);
const fixture=process.env.WACA_INCIDENT_FILE;
assert.ok(fixture,'WACA_INCIDENT_FILE required');
assert.equal(createHash('sha256').update(readFileSync(fixture)).digest('hex'),'310de252a5ac987f7a3c9dea09424a200a3b0d0a9f1f17f43308a45a1891a304');
const fixtureDocument=JSON.parse(readFileSync(process.env.WACA_BACKUP_SCALE_FIXTURE,'utf8'));
const fixtureData=fixtureDocument.data??fixtureDocument;
const collectionTables={inventory:'inventory_items',productGroups:'product_groups',productCategories:'product_categories',
 dashboardCategoryImages:'dashboard_category_images',productVariants:'product_variants',bundleComponents:'bundle_components',
 purchaseBatches:'purchase_batches',purchaseBatchItems:'purchase_batch_items',privateOrders:'private_orders',
 privateOrderItems:'private_order_items',salesOrders:'sales_orders',salesOrderItems:'sales_order_items',importBatches:'import_batches',
 japanPackages:'japan_packages',japanPackageItems:'japan_package_items',outboundShipments:'outbound_shipments',
 outboundShipmentItems:'outbound_shipment_items',wacaOrders:'waca_orders',wacaItems:'waca_order_items',
 wacaMappings:'waca_mappings',myacgMasterLinks:'waca_master_links',wacaImportBatches:'waca_import_batches',
 wacaCutoverAudit:'waca_cutover_audit',wacaCutoverState:'waca_state'};
const data=Object.hasOwn(fixtureData,'inventory_items')?fixtureData:Object.fromEntries(
 Object.entries(collectionTables).map(([collection,table])=>[table,fixtureData[collection]]));
assert.equal(Object.keys(data).length,24);
const db=await isolatedDatabase();let browser;
const allowedTables=new Set(Object.keys(data));
const allowedRpc=new Set(['erp_read_waca_snapshot','erp_commit_waca_snapshot']);
let backupCalls=0,lastCommitPayload;
const vite=await createServer({configFile:false,mode:'staging',define:{
 'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://rhfdjsklfrgpoqsaqpkn.supabase.co'),
 'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('isolated-not-a-credential'),
 'import.meta.env.VITE_DEPLOYMENT_ENV':JSON.stringify('staging')},
 esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:4396,strictPort:true,hmr:false},
 cacheDir:'node_modules/.vite-waca-atomic-native',
 optimizeDeps:{include:['react','react-dom/client','react-router-dom','react/jsx-runtime','lucide-react','xlsx','@supabase/supabase-js']},plugins:[{name:'isolated-native-transport',configureServer(server){
  server.middlewares.use('/__waca_isolated',async(req,res)=>{
   try{const {path,body}=await readUtf8Json(req);assert.equal(req.method,'POST');
    if(path==='/rpc/erp_commit_waca_snapshot')lastCommitPayload=body.p_snapshot;
    if(path.startsWith('/rpc/'))assert.ok(allowedRpc.has(path.slice(5)),'RPC_NOT_ALLOWED');
    else assert.ok(allowedTables.has(path.slice(1).split('?')[0]),'TABLE_NOT_ALLOWED');
    if(/export_cloud_restore|backup/i.test(path)){backupCalls++;throw new Error('BACKUP_FORBIDDEN');}
    const result=await db.http(path,body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
   }catch{res.statusCode=500;res.end(JSON.stringify({status:500,data:{message:'ISOLATED_TRANSPORT_REJECTED'}}));}
  });
 }}]});
const summary={engine:'actual React WacaIntegration + GlobalSync + Cloud provider + native PostgREST/PostgreSQL',liveMutation:0,backupCalls:0,runs:[]};
let stage='restore';
const rpc=async(name,body={})=>{const r=await db.http('/rpc/'+name,body);if(r.status!==200)throw r.data;return r.data;};
try{
 for(const id of new Set(Object.values(data).flatMap(rows=>rows.map(r=>r.updated_by).filter(id=>id&&id!==owner))))await db.sql.query('insert into auth.users(id,email) values($1,$2) on conflict do nothing',[id,'isolated@example.invalid']);
 const audit=(await db.sql.query('select public.erp_cloud_restore_audit_dataset($1) report',[data])).rows[0].report;
 const manifest={schemaVersion:'cloud-erp-snapshot-v2',resourceCount:24,counts:audit.table_counts,totalRows:Number(audit.total_rows),orphanCount:0,duplicateVariantIdCount:0,duplicateVariantLocalIdCount:0};
 const reset=async()=>assert.equal((await db.sql.query("select public.erp_restore_cloud_snapshot($1,repeat('a',64),$2,$3,'isolated-waca-confirm') result",[randomUUID(),data,manifest])).rows[0].result.ok,true);
 await reset();await db.startPostgrest();
 const {buildCloudRestoreManifest}=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const exported=await rpc('erp_export_cloud_restore_snapshot_json');
 const built=await buildCloudRestoreManifest(exported,exported);assert.equal(built.manifest.resourceCount,24);
 const expectedManifest=await buildCloudRestoreManifest(data,data);
 // PostgreSQL formats timestamptz as +00:00 instead of the source's Z. Compare
 // exact microseconds, not byte spelling and not millisecond-truncated Dates.
 const instant=value=>BigInt(Math.floor(Date.parse(value)/1000))*1000000n+BigInt((value.match(/\.(\d+)/u)?.[1]??'').padEnd(6,'0').slice(0,6)||'0');
 {
  const differences={};for(const [table,expected]of Object.entries(expectedManifest.data)){
   assert.equal(built.data[table].length,expected.length,'RESTORE_ROW_PARITY');
   const found=new Map(built.data[table].map(row=>[row.id??row.inventory_key,row]));
   for(const row of expected){const actual=found.get(row.id??row.inventory_key);if(!actual){differences[table+'.missing']=(differences[table+'.missing']??0)+1;continue;}
    for(const key of new Set([...Object.keys(row),...Object.keys(actual)]))if(JSON.stringify(row[key])!==JSON.stringify(actual[key])){
     const timeEquivalent=key.endsWith('_at')&&typeof row[key]==='string'&&typeof actual[key]==='string'
      &&Number.isFinite(Date.parse(row[key]))&&Number.isFinite(Date.parse(actual[key]))&&instant(row[key])===instant(actual[key]);
     if(!timeEquivalent)differences[table+'.'+key]=(differences[table+'.'+key]??0)+1;
    }}
  }assert.deepEqual(differences,{},'RESTORE_EXACT_SEMANTIC_PARITY');
 }
 assert.equal(built.manifest.relationshipHash,expectedManifest.manifest.relationshipHash);
 assert.equal(exported.outbound_shipments.length,37);
 for(const row of exported.outbound_shipments){const original=data.outbound_shipments.find(x=>x.id===row.id);assert.equal(row.status_changed_at===null?null:Date.parse(row.status_changed_at),original.status_changed_at===null?null:Date.parse(original.status_changed_at));}
 summary.backupRestore='PASS';summary.outboundTimestamps='37/37';
 const {commitAndVerifyWaca,wacaAtomicDelta}=await vite.ssrLoadModule('/src/waca/confirmFlow.ts');
 const core=await vite.ssrLoadModule('/src/waca/orderCore.ts');
 const storage=await vite.ssrLoadModule('/src/waca/nextStorage.ts');
 const masterModule=await vite.ssrLoadModule('/src/waca/masterReference.ts');
 const {parseWacaWorkbook}=await vite.ssrLoadModule('/src/waca/workbookParser.ts');
 const rows=parseWacaWorkbook(readFileSync(fixture)).rows;
 const variants=async()=>{let all=[];for(let offset=0;;offset+=1000){const r=await db.http('/product_variants?select=*&deleted_at=is.null&order=id&offset='+offset+'&limit=1000');assert.equal(r.status,200);all.push(...r.data);if(r.data.length<1000)return all;}};
 const make=async()=>{
  const current=await rpc('erp_read_waca_snapshot');const v=await variants();
  const inventory=(await db.sql.query('select * from public.inventory_items where deleted_at is null')).rows;
  const links=masterModule.mergeMyAcgMasterLinks(masterModule.linksFromMyAcgInventory(inventory,v,'NEXT_CURRENT_MYACG_CATALOG','').links,current.masterLinks);
  const master=masterModule.buildWacaMasterReference(v,links);const requestId=randomUUID();
  const candidate=core.cloneWacaRepository(storage.repositoryFromSnapshot(current,v));const result=core.importWacaRows(rows,candidate,master,requestId);core.refreshWacaMasterStatus(candidate,master);
  assert.equal(result.errors.length,0);
  const batch={id:requestId,fileName:'isolated-real-fixture.xlsx',importedAt:new Date().toISOString(),rows:rows.length,inserted:result.inserted,updated:result.updated,unchanged:result.unchanged,result,conflictRows:[]};
  return {current,candidate:storage.snapshotFromRepository(current,candidate,[...current.batches,batch],links),requestId,cloud:true,onStage(){}};
 };
 let commits=0;
 const provider={getNextWacaSnapshot:()=>rpc('erp_read_waca_snapshot'),getAuthoritativeWacaVariants:variants,
 commitNextWacaSnapshot:async(s,r,u)=>{commits++;return (await rpc('erp_commit_waca_snapshot',{p_snapshot:s,p_expected_revision:r,p_update_auto_quantity:u})).revision;}};
 stage='rollback';const attempt=await make();
 assert.ok(Number.isSafeInteger(attempt.current.revision)&&attempt.current.revision>=0);
 const baselineRevision=attempt.current.revision;
 const before=await rpc('erp_export_cloud_restore_snapshot_json');
 await db.sql.query("create function public.isolated_waca_fault() returns trigger language plpgsql as $$ begin raise exception 'ISOLATED_WACA_FAULT'; end $$; create trigger isolated_waca_fault before update on public.waca_state for each row execute function public.isolated_waca_fault()");
 await assert.rejects(()=>commitAndVerifyWaca({...attempt,provider}));
 await db.sql.query('drop trigger isolated_waca_fault on public.waca_state; drop function public.isolated_waca_fault()');
 assert.deepEqual(await rpc('erp_export_cloud_restore_snapshot_json'),before);summary.atomicRollback='PASS';
 stage='stale';await assert.rejects(()=>provider.commitNextWacaSnapshot(wacaAtomicDelta(attempt.current,attempt.candidate),Math.max(0,baselineRevision-1),true),e=>e.code==='40001');
 assert.deepEqual(await rpc('erp_export_cloud_restore_snapshot_json'),before);summary.cas='PASS';
 stage='response-lost';commits=0;
 const lost={...provider,commitNextWacaSnapshot:async(...args)=>{await provider.commitNextWacaSnapshot(...args);throw new Error('Failed to fetch');}};
 const verified=await commitAndVerifyWaca({...attempt,provider:lost});assert.equal(commits,1);assert.equal(verified.snapshot.revision,baselineRevision+1);summary.responseLoss='PASS';
 stage='idempotency';
 for(let n=0;n<5;n++){
  const result=await commitAndVerifyWaca({...await make(),provider});
  for(const [sku,quantity]of [['G07595265',1],['G07607190',2]])assert.equal(result.variants.find(x=>x.myacg_item_code===sku).waca_auto_quantity,quantity);
  assert.equal(new Set(result.snapshot.items.map(x=>x.key)).size,result.snapshot.items.length);
  assert.equal(result.snapshot.items.length,verified.snapshot.items.length);
 }
 summary.idempotency='PASS';
 stage='browser';await vite.listen();
 browser=await chromium.launch({executablePath:process.env.CORE_TEST_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 for(let n=0;n<6;n++){
  await reset();const context=await browser.newContext({viewport:{width:1366,height:900}});let external=0,downloads=0;const errors=[];
  await context.route('https://**/*',route=>{external++;return route.abort();});
  const page=await context.newPage();page.on('pageerror',()=>errors.push('PAGE_ERROR'));page.on('download',()=>downloads++);
  await page.goto('http://127.0.0.1:4396/tests/fixtures/waca-atomic-confirm.html');
  await page.waitForFunction(()=>document.querySelector('input[aria-label="選擇 WACA Excel"]')?.disabled===false);
  await page.getByLabel('選擇 WACA Excel').setInputFiles(fixture);
  await page.getByRole('button',{name:'確認更新',exact:true}).waitFor();
  const revisionBeforeUiConfirm=(await rpc('erp_read_waca_snapshot')).revision;
  await page.evaluate(()=>window.wacaAtomicTest.reset());
  const start=performance.now();await page.getByRole('button',{name:'確認更新',exact:true}).click();
  try {await page.getByRole('dialog',{name:'WACA 更新完成'}).waitFor({timeout:30000});}
  catch(error){
    const actual=await rpc('erp_read_waca_snapshot');
    const canonical=value=>JSON.stringify(value,(key,item)=>key==='productVariantId'&&(item===null||item==='')?null:
      item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
    const differences=[];
    for(const [collection,key]of [['orders','key'],['items','key'],['mappings','feature'],['masterLinks','childCode']]){
      const byKey=new Map(actual[collection].map(r=>[r[key],r]));
      if(byKey.size!==actual[collection].length)differences.push({collection,duplicateKeys:true});
      for(const row of lastCommitPayload?.[collection]??[]){const saved=byKey.get(row[key]);
        if(!saved){differences.push({collection,missing:true});continue;}
        if(canonical(row)!==canonical(saved)){
          const changed=Object.keys(row).filter(k=>canonical({[k]:row[k]})!==canonical({[k]:saved[k]}));
          const strings=changed.map(k=>{const a=String(row[k]),b=String(saved[k]);let at=0;while(at<Math.min(a.length,b.length)&&a[at]===b[at])at++;
            return {field:k,expectedType:typeof row[k],actualType:typeof saved[k],expectedLength:a.length,actualLength:b.length,
              firstDifference:at,expectedCodes:[...a.slice(at,at+5)].map(c=>c.codePointAt(0)),actualCodes:[...b.slice(at,at+5)].map(c=>c.codePointAt(0))};});
          differences.push({collection,fields:changed,strings,inDelta:(lastCommitPayload?.[collection]??[]).some(r=>r[key]===row[key])});
        }
      }
    }
    console.error(JSON.stringify({run:n,uiErrors:await page.locator('.waca-error').allTextContents(),differences,
      sync:await page.getByTestId('actual-global-sync').innerText(),metrics:await page.evaluate(()=>window.wacaAtomicTest.metrics())}));throw error;}
  assert.equal(await page.getByTestId('actual-global-sync').innerText(),'fresh');
  const elapsed=performance.now()-start;const metrics=await page.evaluate(()=>({...window.wacaAtomicTest.metrics(),stages:performance.getEntriesByType('mark').filter(x=>x.name.startsWith('waca-confirm:')).map(x=>({name:x.name,time:x.startTime}))}));
  assert.equal(metrics.calls.backup,0);assert.equal(metrics.calls.commit,1);assert.equal(downloads,0);assert.equal(external,0);assert.deepEqual(errors,[]);
  const state=await rpc('erp_read_waca_snapshot');assert.equal(state.revision,revisionBeforeUiConfirm+1);
  const values=await variants();for(const [sku,q]of [['G07595265',1],['G07607190',2]])assert.equal(values.find(r=>r.myacg_item_code===sku).waca_auto_quantity,q);
  if(n)summary.runs.push({totalMs:elapsed,...metrics.timings,stages:metrics.stages});else summary.warmupMs=elapsed;
  console.log(JSON.stringify({stage:'confirm-synced-modal',run:n,totalMs:elapsed,backupCalls:0,commitCalls:1,stages:metrics.stages}));await context.close();
 }
 const sorted=summary.runs.map(x=>x.totalMs).sort((a,b)=>a-b);Object.assign(summary,{medianMs:sorted[2],p95Ms:sorted[4],minMs:sorted[0],maxMs:sorted[4],backupCalls});
 mkdirSync('scratch/waca-no-full-backup',{recursive:true});writeFileSync('scratch/waca-no-full-backup/native-benchmark.json',JSON.stringify(summary,null,2));
 assert.ok(summary.medianMs<=4000,'CONFIRM_MEDIAN_4S');assert.ok(summary.p95Ms<=5500,'CONFIRM_P95_5_5S');
 console.log(JSON.stringify(summary));
}catch(error){console.error(JSON.stringify({stage,result:'FAIL',code:error.code,
 message:error.code==='ERR_ASSERTION'?String(error.message).slice(0,500):String(error.message).slice(0,240)}));process.exitCode=1;}
finally{await browser?.close();await vite.close();await db.close();}
