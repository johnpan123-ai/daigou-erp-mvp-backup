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
  if(process.env.BUYANIME_LEGACY!=='1')await db.sql.query('update inventory_items set latest_catalog_import_id=null,catalog_last_seen_at=null');
  await db.startPostgrest();await server.listen();
  browser=await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
  const context=await browser.newContext();let externalRequests=0;
  context.on('request',r=>{if(new URL(r.url()).hostname.endsWith('.supabase.co'))externalRequests++;});
  const page=await context.newPage();
  await page.exposeFunction('__BUYANIME_ISOLATED_HTTP__',request=>db.http(request.path,request.body,owner,{method:request.method,headers:{...(request.prefer?{prefer:request.prefer}:{}),...(request.accept?{accept:request.accept}:{})}}));
  await page.goto('http://127.0.0.1:4292/tests/fixtures/buyanime-resume-provider.html');
  await page.waitForFunction(()=>Boolean(window.__BUYANIME_RESUME_PROVIDER__));
  await page.evaluate(actor=>window.__BUYANIME_RESUME_PROVIDER__.setup(actor),owner);
  const result=await page.evaluate(async ({base64,automatic,legacy,fault})=>{
    const bridge=window.__BUYANIME_RESUME_PROVIDER__, provider=bridge.provider();
    const stages={}, longTasks=[];
    const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>Math.round(e.duration))));
    observer.observe({type:'longtask',buffered:false});
    const measure=async(name,fn)=>{const t=performance.now();try{return await fn();}finally{stages[name]=(stages[name]||0)+performance.now()-t;}};
    // Instrument only this disposable provider; never change production diagnostics or dump rows.
    const port=provider.buyAnimePipeline.port;
    for(const [name,label]of Object.entries({prepareInventory:'InventoryMatchingPlanning',commitInventory:'InventoryCommit',readInventory:'Readback',planCatalog:'CatalogPlanning',commitCatalog:'CatalogCommit',verifyCatalog:'CatalogReadback',ensureWacaEvidence:'WacaEvidence'})){
      const original=port[name];port[name]=(...args)=>measure(label,()=>original(...args));
    }
    const total=performance.now();
    const {createAndDownloadWorkbenchBackup}=await import('/src/lib/workbenchJsonBackup.ts');
    await measure('Backup',()=>createAndDownloadWorkbenchBackup(provider,'isolated-before-import',new Date(),()=>{}));
    const parsed=await measure('FileReadParse',()=>bridge.parse(base64));
    const rows=await measure('Normalize',async()=>parsed.map(row=>({...row,latest_catalog_import_id:'catalog_import_411c6e55-cb73-41af-9ff1-61cf39cb532c',catalog_last_seen_at:'2026-10-03T04:52:25.877Z'})));
    let record;
    try {
      const cacheRefresh=provider.mutationCache.refresh.bind(provider.mutationCache);
      provider.mutationCache.refresh=(...args)=>measure('FinalTargetedRefresh',()=>cacheRefresh(...args));
      if(fault)bridge.failReadbackRequests(3);
      if(legacy) record=await provider.recoverPendingBuyAnimeImport();
      else if(automatic) record=await provider.completeBuyAnimeImport(rows,'399375_2026-10-03.xls');
      else {record=await provider.importBuyAnimeInventory(rows,'399375_2026-10-03.xls');record=await provider.resumeBuyAnimeImport(record);}
    } catch(error) {
      const chain=[];for(let e=error,n=0;e&&n<6;e=e.cause,n++) chain.push({code:e.code,name:e.name,status:e.status,reason:String(e.message||'').match(/[A-Z][A-Z0-9_]{4,}/gu)});
      return {failure:true,chain,stages,metrics:bridge.metrics()};
    }
    await measure('UiSnapshot',()=>provider.getInventoryCatalogSnapshot());
    // Mount the real read-only Inventory presentation against this disposable
    // provider. No synthetic row progress updates or production app is mounted.
    const {renderReadOnlyUi}=await import('/tests/fixtures/buyanime-performance-ui.tsx');
    const ui=await measure('UiRender',()=>renderReadOnlyUi(provider));
    await new Promise(r=>setTimeout(r,100));observer.disconnect();
    stages.Total=performance.now()-total;
    return {rows:parsed.length,stage:record.stage,stages:Object.fromEntries(Object.entries(stages).map(([k,v])=>[k,Math.round(v)])),longTasks,reactCommits:ui.commits,maxReactDurationMs:ui.maxDurationMs,metrics:bridge.metrics()};
  },{base64:bytes.toString('base64'),automatic:process.env.BUYANIME_AUTO==='1',legacy:process.env.BUYANIME_LEGACY==='1',fault:process.env.BUYANIME_FAULT==='1'});
  if(result.failure) console.log(JSON.stringify(result));
  assert.equal(result.rows,1505);assert.equal(result.stage,'COMPLETE');assert.equal(result.metrics.inventoryCommits,process.env.BUYANIME_LEGACY==='1'?0:1);assert.equal(externalRequests,0);
  const report={label:process.env.BUYANIME_PERF_LABEL||'baseline',...result,externalRequests,liveWrites:0};
  mkdirSync('scratch/buyanime-flow-performance',{recursive:true});
  writeFileSync(join('scratch/buyanime-flow-performance',report.label+'.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} catch(error) {
  const safe=String(error.message).match(/(?:BUYANIME_|CLOUD_|ISOLATED_)[A-Z_]+/gu);
  console.log(JSON.stringify({result:'FAIL',code:error.code||error.name,reasons:safe||[],stack:String(error.stack).split('\n').filter(line=>/^\s+at /u.test(line)).slice(0,6)}));
  throw new Error('BUYANIME_FLOW_PERFORMANCE_FAILED: '+(error.code||error.name)+(error.name==='AssertionError'?' assertion at '+String(error.stack).split('\n').find(l=>l.includes('buyanime-flow-performance')):''));
}
finally {await browser?.close();await server.close();await vite.close();await db.close();}
