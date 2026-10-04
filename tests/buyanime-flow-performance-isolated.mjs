import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';

const privateDir=process.env.BUYANIME_INCIDENT_SNAPSHOT||join(process.cwd(),'scratch','buyanime-forensic-20261003-125225');
const bytes=readFileSync(process.env.BUYANIME_FAILING_FILE||join(homedir(),'Downloads','399375_2026-10-03.xls'));
const db=await isolatedDatabase();
const immutableBase=process.env.BUYANIME_PERF_BASE;
const baselinePlugin={name:'immutable-performance-baseline',enforce:'pre',load(id){
  if(!immutableBase || !/^[0-9a-f]{40}$/u.test(immutableBase)) return null;
  const file=id.split('?')[0].replaceAll('\\','/'),root=process.cwd().replaceAll('\\','/')+'/';
  if(!file.startsWith(root+'src/'))return null;
  try{return execFileSync('git',['show',immutableBase+':'+file.slice(root.length)],{encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch{return null;}
}};
const server=await createServer({configFile:'tests/fixtures/inventory-cloud-import-vite.config.mjs',configLoader:'runner',mode:'staging',plugins:[baselinePlugin],server:{host:'127.0.0.1',port:4292,strictPort:true}});
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
let browser;
try {
  const {CLOUD_FIELD_ENTITY_CONTRACTS}=await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  await db.sql.query('delete from public.product_variants; delete from public.product_groups');
  for(const table of ['product_groups','product_categories','product_variants','inventory_items']) {
    const rows=JSON.parse(readFileSync(join(privateDir,table+'.json'),'utf8')).map(row=>({...row,updated_by:owner}));
    const names=['id',...CLOUD_FIELD_ENTITY_CONTRACTS[table].create,'version','updated_by','deleted_at'];
    for(let offset=0;offset<rows.length;offset+=400)await db.sql.query(`insert into public.${table} (${names.join(',')}) select ${names.join(',')} from jsonb_populate_recordset(null::public.${table},$1)`,[JSON.stringify(rows.slice(offset,offset+400))]);
  }
  // Production-like repeat import: seed the already-known master-link index.
  // This is disposable evidence only; it proves time grows with delta size,
  // not with the full WACA snapshot.
  const inventoryRows=(await db.sql.query(`select myacg_parent_code,myacg_item_code,product_title,raw_variant_name
    from inventory_items where deleted_at is null order by inventory_key`)).rows;
  const variantRows=(await db.sql.query(`select id,product_group_id,myacg_item_code,raw_variant_name,variant_name
    from product_variants where deleted_at is null order by id`)).rows;
  const variantsByChild=new Map();
  for(const row of variantRows)variantsByChild.set(row.myacg_item_code,[...(variantsByChild.get(row.myacg_item_code)||[]),row]);
  const seededLinks=new Map();
  for(const row of inventoryRows){
    if(!row.myacg_parent_code?.startsWith('GP')||!row.myacg_item_code)continue;
    const candidates=variantsByChild.get(row.myacg_item_code)||[];
    const variant=candidates.length===1?candidates[0]:null;
    const payload={mainCode:row.myacg_parent_code,childCode:row.myacg_item_code,
      productGroupId:variant?.product_group_id||'',productVariantId:variant?.id||'',productTitle:row.product_title,
      variantTitle:row.raw_variant_name||variant?.raw_variant_name||variant?.variant_name||'',
      sourceFile:'399375_2026-10-03.xls',sourceFiles:['399375_2026-10-03.xls'],observedAt:'2026-10-03T04:52:25.877Z'};
    const prior=seededLinks.get(payload.childCode);
    if(prior&&prior.mainCode!==payload.mainCode)throw new Error('ISOLATED_MASTER_LINK_CONFLICT');
    seededLinks.set(payload.childCode,payload);
  }
  for(const rows of Array.from(seededLinks.values()).reduce((chunks,row,index)=>{
    const at=Math.floor(index/400);(chunks[at]??=[]).push(row);return chunks;
  },[]))await db.sql.query(`insert into public.waca_master_links(child_code,main_code,product_variant_id,payload,updated_by)
    select x."childCode",x."mainCode",nullif(x."productVariantId",'')::uuid,to_jsonb(x),$2::uuid
    from jsonb_to_recordset($1::jsonb) x("mainCode" text,"childCode" text,"productGroupId" text,
      "productVariantId" text,"productTitle" text,"variantTitle" text,"sourceFile" text,"sourceFiles" text[],"observedAt" text)`,
    [JSON.stringify(rows),owner]);
  if(seededLinks.size)await db.sql.query('update public.waca_state set revision=1');
  if(process.env.BUYANIME_LEGACY!=='1')await db.sql.query('update inventory_items set latest_catalog_import_id=null,catalog_last_seen_at=null');
  await db.startPostgrest();await server.listen();
  browser=await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
  const context=await browser.newContext();let externalRequests=0;
  context.on('request',r=>{if(new URL(r.url()).hostname.endsWith('.supabase.co'))externalRequests++;});
  const page=await context.newPage();
  await page.exposeFunction('__BUYANIME_ISOLATED_HTTP__',request=>db.http(request.path,request.body,owner,{method:request.method,headers:{...(request.prefer?{prefer:request.prefer}:{}),...(request.accept?{accept:request.accept}:{})}}));
  await page.exposeFunction('__BUYANIME_ISOLATED_WACA_DELTA__',async()=>{
    await db.sql.query(`delete from public.waca_master_links where child_code=(select child_code from public.waca_master_links order by child_code limit 1)`);
  });
  await page.goto('http://127.0.0.1:4292/tests/fixtures/buyanime-resume-provider.html');
  await page.waitForFunction(()=>Boolean(window.__BUYANIME_RESUME_PROVIDER__));
  await page.evaluate(actor=>window.__BUYANIME_RESUME_PROVIDER__.setup(actor),owner);
  const result=await page.evaluate(async ({base64,fileName,automatic,legacy,fault,uiBenchmark,changeOne,wacaDelta,preconditionWarm})=>{
    const bridge=window.__BUYANIME_RESUME_PROVIDER__, provider=bridge.provider();
    // T0 starts after the normal app bootstrap has a fresh authoritative
    // cache. Initial route loading is not part of selecting the XLS file.
    await provider.waitForCloudBootstrapConvergence();
    if(preconditionWarm){
      // Bring this disposable incident snapshot to the same already-imported
      // state as production before measuring a repeat import. This setup is
      // deliberately outside the wall clock and metrics; the measured run
      // must prove Inventory/Catalog/WACA are all semantic no-ops.
      const parsed=await bridge.parse(base64);
      const observedAt='2026-10-04T00:00:00.000Z';
      const batchId='catalog_import_00000000-0000-4000-8000-000000000052';
      const rows=parsed.map(row=>({...row,latest_catalog_import_id:batchId,catalog_last_seen_at:observedAt}));
      const precondition=await provider.completeBuyAnimeImport(rows,'399375_2026-10-03.xls');
      if(precondition.stage!=='COMPLETE')throw new Error('ISOLATED_WARM_PRECONDITION_INCOMPLETE');
    }
    if(wacaDelta)await window.__BUYANIME_ISOLATED_WACA_DELTA__();
    bridge.resetMetrics();
    const stages={}, longTasks=[], timeline=[];let inventoryPlanSummary=null,catalogPlanSummary=null;
    const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>Math.round(e.duration))));
    observer.observe({type:'longtask',buffered:false});
    const measure=async(name,fn)=>{const t=performance.now();try{return await fn();}finally{const end=performance.now();stages[name]=(stages[name]||0)+end-t;timeline.push({name,start:t,end,duration:end-t});}};
    // Instrument only this disposable provider; never change production diagnostics or dump rows.
    const port=provider.buyAnimePipeline.port;
    for(const [name,label]of Object.entries({load:'JournalLoad',save:'JournalSave',prepareInventory:'InventoryMatchingPlanning',commitInventory:'InventoryCommit',readInventory:'Readback',planCatalog:'CatalogPlanning',commitCatalog:'CatalogCommit',verifyCatalog:'CatalogReadback',planWacaEvidence:'WacaEvidencePlanning',commitWacaEvidence:'WacaEvidenceCommit'})){
      const original=port[name];
      if(typeof original!=='function')continue;
      port[name]=(...args)=>measure(label,async()=>{
        const value=await original(...args);
        if(name==='prepareInventory') {
          const changedFields={};
          for(const operation of value.operations)for(const field of Object.keys(operation.changes||{}))
            changedFields[field]=(changedFields[field]||0)+1;
          inventoryPlanSummary={operations:value.operations.length,stats:value.stats,changedFields};
        }
        if(name==='planCatalog') catalogPlanSummary=value?Object.fromEntries(Object.entries(value.request.operations).map(([table,ops])=>[table,ops.length])):{};
        return value;
      });
    }
    for(const name of ['getBuyAnimeImportRecovery','prepareBuyAnimeRecovery']) {
      const original=provider[name].bind(provider);provider[name]=(...args)=>measure(name,()=>original(...args));
    }
    const total=performance.now();
    let record;
    let ui;
    let postSuccessCriticalRequests=0;
    try {
      const cacheRefresh=provider.mutationCache.refresh.bind(provider.mutationCache);
      provider.mutationCache.refresh=(...args)=>measure('FinalTargetedRefresh',()=>cacheRefresh(...args));
      if(fault)bridge.failReadbackRequests(3);
      if(uiBenchmark) {
        const complete=provider.completeBuyAnimeImport.bind(provider);
        provider.completeBuyAnimeImport=async(items,...args)=>{
          const candidate=changeOne
            ? items.map((row,index)=>index===0?{...row,myacg_sold_quantity:Number(row.myacg_sold_quantity||0)+1}:row)
            : items;
          record=await complete(candidate,...args);return record;
        };
        const {renderImportBenchmarkUi}=await import('/tests/fixtures/buyanime-performance-ui.tsx');
        ui=await renderImportBenchmarkUi(provider,base64,fileName);
      } else {
        const {createAndDownloadWorkbenchBackup}=await import('/src/lib/workbenchJsonBackup.ts');
        await measure('Backup',()=>createAndDownloadWorkbenchBackup(provider,'isolated-before-import',new Date(),()=>{}));
        const parsed=await measure('FileReadParse',()=>bridge.parse(base64));
        const rows=await measure('Normalize',async()=>parsed.map((row,index)=>({...row,
          ...(fault&&index===0?{myacg_sold_quantity:Number(row.myacg_sold_quantity||0)+1}:{}),
          latest_catalog_import_id:'catalog_import_411c6e55-cb73-41af-9ff1-61cf39cb532c',catalog_last_seen_at:'2026-10-03T04:52:25.877Z'})));
        if(legacy) record=await provider.recoverPendingBuyAnimeImport();
        else if(automatic) record=await provider.completeBuyAnimeImport(rows,fileName);
        else {record=await provider.importBuyAnimeInventory(rows,fileName);record=await provider.resumeBuyAnimeImport(record);}
      }
    } catch(error) {
      const chain=[];for(let e=error,n=0;e&&n<6;e=e.cause,n++) chain.push({code:e.code,name:e.name,status:e.status,message:String(e.message||'')});
      return {failure:true,chain,inventoryPlanSummary,catalogPlanSummary,stages,metrics:bridge.metrics()};
    }
    if (!uiBenchmark) {
      await measure('UiSnapshot',()=>provider.getInventoryCatalogSnapshot());
      // Mount the real read-only Inventory presentation against this disposable
      // provider. No synthetic row progress updates or production app is mounted.
      const {renderReadOnlyUi}=await import('/tests/fixtures/buyanime-performance-ui.tsx');
      ui=await measure('UiRender',()=>renderReadOnlyUi(provider));
    } else {
      const atSuccess=bridge.metrics();
      await new Promise(resolve=>setTimeout(resolve,250));
      const afterSuccess=bridge.metrics();
      postSuccessCriticalRequests=afterSuccess.totalRequests-atSuccess.totalRequests;
    }
    await new Promise(r=>setTimeout(r,100));observer.disconnect();
    stages.Total=uiBenchmark?ui.totalMs:performance.now()-total;
    const spans=[...timeline].sort((a,b)=>a.start-b.start);let cursor=total,uncovered=[];
    for(const span of spans){if(span.start>cursor)uncovered.push({start:cursor-total,end:span.start-total,duration:span.start-cursor});cursor=Math.max(cursor,span.end);}
    if(performance.now()>cursor)uncovered.push({start:cursor-total,end:performance.now()-total,duration:performance.now()-cursor});
    return {rows:record?.stats?.total??1505,stage:record.stage,inventoryPlanSummary,catalogPlanSummary,stages:Object.fromEntries(Object.entries(stages).map(([k,v])=>[k,Math.round(v)])),timeline:timeline.map(s=>({...s,start:Math.round(s.start-total),end:Math.round(s.end-total),duration:Math.round(s.duration)})),uncovered,longTasks,reactCommits:ui.commits,maxReactDurationMs:ui.maxDurationMs,modalText:ui.modalText,syncText:ui.syncText,trace:ui.trace,postSuccessCriticalRequests,metrics:bridge.metrics()};
  },{base64:bytes.toString('base64'),fileName:process.env.BUYANIME_PERF_FILE_NAME||'399375_2026-10-04 (3).xls',automatic:process.env.BUYANIME_AUTO==='1',legacy:process.env.BUYANIME_LEGACY==='1',fault:process.env.BUYANIME_FAULT==='1',uiBenchmark:process.env.BUYANIME_UI_BENCHMARK==='1',changeOne:process.env.BUYANIME_CHANGE_ONE==='1',wacaDelta:process.env.BUYANIME_WACA_DELTA==='1',preconditionWarm:process.env.BUYANIME_PRECONDITION_WARM!=='0'});
  if(result.failure) console.log(JSON.stringify(result));
  assert.equal(result.rows,Number(process.env.BUYANIME_PERF_EXPECTED_ROWS||1505));assert.equal(result.stage,'COMPLETE');
  if(process.env.BUYANIME_UI_BENCHMARK==='1')assert.equal(result.postSuccessCriticalRequests,0,'No Catalog/WACA/readback/sync request may continue after success');
  assert.equal(result.metrics.inventoryCommits,process.env.BUYANIME_LEGACY==='1'||result.inventoryPlanSummary?.operations===0?0:1);
  assert.equal(result.metrics.fullWacaSnapshotReads,0,'BuyAnime must never read the full WACA snapshot');
  assert.equal(result.metrics.fullWacaSnapshotCommits,0,'BuyAnime must never commit the full WACA snapshot');
  assert.equal(result.metrics.wacaRequests,0,'BuyAnime must never call any WACA mutation, including nonzero evidence deltas');
  assert.equal(result.stages.WacaEvidencePlanning||0,0,'No WACA planning belongs on the BuyAnime critical path');
  assert.equal(result.stages.WacaEvidenceCommit||0,0,'No WACA commit belongs on the BuyAnime critical path');
  if(result.catalogPlanSummary && Object.values(result.catalogPlanSummary).every(count=>count===0))
    assert.equal(result.metrics.catalogRequests,0,'A zero-operation Catalog plan must not call its RPC');
  if(process.env.BUYANIME_UI_BENCHMARK==='1' && result.inventoryPlanSummary?.operations===0
    && result.metrics.catalogRequests===0 && result.metrics.wacaRequests===0)assert.ok(result.metrics.journalRequests<=3,
    `Normal repeat import journal requests must be <= 3, got ${result.metrics.journalRequests}`);
  assert.ok((result.stages.WacaEvidencePlanning||0)+(result.stages.WacaEvidenceCommit||0)<1500,
    `WACA evidence must stay below 1500ms: ${JSON.stringify(result.stages)}`);
  assert.equal(externalRequests,0);
  const report={label:process.env.BUYANIME_PERF_LABEL||'baseline',...result,externalRequests,liveWrites:0};
  mkdirSync('scratch/buyanime-flow-performance',{recursive:true});
  writeFileSync(join('scratch/buyanime-flow-performance',report.label+'.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(process.env.BUYANIME_PERF_COMPACT==='1'?{
    label:report.label,totalMs:report.stages.Total,stage:report.stage,inventory:report.inventoryPlanSummary,
    postSuccessCriticalRequests:report.postSuccessCriticalRequests,longTaskMax:Math.max(0,...report.longTasks),
    reactMax:report.maxReactDurationMs,syncText:report.syncText,externalRequests,liveWrites:0,
  }:report));
} catch(error) {
  const safe=String(error.message).match(/(?:BUYANIME_|CLOUD_|ISOLATED_)[A-Z_]+/gu);
  console.log(JSON.stringify({result:'FAIL',code:error.code||error.name,reasons:safe||[],stack:String(error.stack).split('\n').filter(line=>/^\s+at /u.test(line)).slice(0,6)}));
  throw new Error('BUYANIME_FLOW_PERFORMANCE_FAILED: '+(error.code||error.name)+(error.name==='AssertionError'?' assertion at '+String(error.stack).split('\n').find(l=>l.includes('buyanime-flow-performance')):''));
}
finally {await browser?.close();await server.close();await vite.close();await db.close();}
