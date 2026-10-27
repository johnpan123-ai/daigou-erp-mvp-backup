// Synthetic, private-data-free companion of buyanime-post-restore-isolated.
// Root cause guarded here: timestamptz CAS evidence (catalog_last_seen_at) is
// compared as JSON text inside UTC-pinned inventory RPCs. If the disposable
// PostgREST session inherited a non-UTC cluster default, the same instant was
// rendered with a different offset (+08:00 vs +00:00) and the immediate
// post-Restore import was rejected as FIELD_CONFLICT, then surfaced as
// BUYANIME_INVENTORY_READBACK_IDENTITY_ERROR / ISOLATED_IMPORT_SUCCESS_SYNC_TIMEOUT.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {isolatedDatabase,owner} from './helpers/saveability-isolated.mjs';
globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const db=await isolatedDatabase();
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
const server=await createServer({configFile:'tests/fixtures/inventory-cloud-import-vite.config.mjs',configLoader:'runner',mode:'staging',server:{host:'127.0.0.1',port:4292,strictPort:true,hmr:false,watch:null}});
let browser,context,page,stage='prepare';const summary={};
try{
 const dbm=await vite.ssrLoadModule('/src/lib/db.ts');
 const r=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const catalog=await vite.ssrLoadModule('/src/providers/cloud/catalogTransaction.ts');
 // Synthetic catalog: 90 families x 4 specs. Prior import evidence is present,
 // like a restored ERP1 catalog, so the next import PATCHes with timestamptz CAS.
 const rows=[];
 for(let f=0;f<90;f++)for(let v=0;v<4;v++){
  const code=`SYN${String(f).padStart(3,'0')}${v}`,title=`合成測試商品 ${f}`,raw=`規格 ${v}`;
  rows.push({id:randomUUID(),code,parent:`SYNP${String(f).padStart(3,'0')}`,title,raw,
   key:`${dbm.normalizeProductTitle(title)}::${code}::${raw}`,norm:dbm.normalizeProductTitle(title),sort:rows.length});
 }
 for(const x of rows)await db.sql.query(`insert into inventory_items(id,inventory_key,myacg_item_code,myacg_parent_code,product_id,product_title,normalized_product_title,
   raw_variant_name,listing_type,final_price,myacg_available_quantity,myacg_sold_quantity,import_sort_index,latest_catalog_import_id,catalog_last_seen_at,updated_by)
   values($1,$2,$3,$4,$3,$5,$6,$7,'日本代購',800,1,2,$8,'catalog_import_1791127492375','2026-10-04T23:24:52.375+08:00',$9)`,
   [x.id,x.key,x.code,x.parent,x.title,x.norm,x.raw,x.sort,owner]);
 await db.sql.query("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
 const restore=async()=>{
  const candidate=await r.buildCloudRestoreManifest((await db.sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data);
  const request=randomUUID(),attempt=randomUUID(),trace=randomUUID();
  const proof=(await db.sql.query('select public.erp_prove_cloud_restore_candidate_v2($1,$2,$3,$4,$5) result',
   [candidate.data,candidate.manifest,'strict','isolated',request])).rows[0].result;
  assert.equal(proof.ok,true);
  await db.sql.query('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,$7,$8)',[attempt,trace,candidate.manifest.snapshotFingerprint,candidate.manifest.snapshotFingerprint,'strict','rhfdjsklfrgpoqsaqpkn',120000,'postgresql-statement-timeout-v1']);
  const out=(await db.sql.query('select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result',
   [attempt,trace,randomUUID(),proof.proof_id,request])).rows[0].result;
  assert.equal(out.ok,true);
 };
 stage='restore';
 await restore();
 await db.sql.query('update inventory_items set final_price=final_price+1 where import_sort_index<20');
 await restore();
 const epoch=Number((await db.sql.query('select epoch from erp_cloud_restore_epoch')).rows[0].epoch);
 assert.equal(epoch,2);summary.restoreEpoch=epoch;
 // Same Catalog projection step as the real gate.
 {
  const inventoryId=randomUUID(),groupId=randomUUID(),variantId=randomUUID(),code='G-POST-RESTORE-SYN',title='Post Restore SYN',raw='SYN Variant';
  await db.sql.query(`insert into inventory_items(id,inventory_key,myacg_item_code,product_title,raw_variant_name,myacg_sold_quantity,import_sort_index) values($1,'post-restore-SYN',$2,$3,$4,1,1)`,[inventoryId,code,title,raw]);
  await db.sql.query('insert into product_groups(id,title,show_in_purchase_list) values($1,$2,false)',[groupId,title]);
  await db.sql.query(`insert into product_variants(id,product_group_id,myacg_item_code,product_title,variant_name,raw_variant_name,source,waca_auto_quantity) values($1,$2,$3,$4,$5,$5,'inventory_import',7)`,[variantId,groupId,code,title,raw]);
  const snapshot={};
  for(const [key,table] of Object.entries({inventory:'inventory_items',groups:'product_groups',categories:'product_categories',variants:'product_variants'}))
   snapshot[key]=(await db.sql.query(`select * from ${table} where deleted_at is null order by id`)).rows;
  const plan=await catalog.planCatalogTransaction(snapshot,'create',[code]);
  assert.equal((await db.sql.query('select public.erp_apply_catalog_transaction($1,$2) result',[randomUUID(),plan.request])).rows[0].result.ok,true);
 }
 await db.startPostgrest();await server.listen();
 stage='timezone parity';
 // PostgREST readers must render the same timestamptz text as UTC-pinned RPCs.
 const probe=await db.http('/inventory_items?select=catalog_last_seen_at&id=eq.'+rows[0].id,undefined,owner,{method:'GET'});
 assert.equal(probe.status,200);assert.equal(probe.data[0].catalog_last_seen_at,'2026-10-04T15:24:52.375+00:00');
 summary.postgrestTimezone='UTC';
 browser=await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
 let externalRequests=0;const rpc=[];
 const connect=async()=>{
  if(context)await context.close();context=await browser.newContext({acceptDownloads:false});
  await context.route('https://**/*',route=>{externalRequests++;return route.abort();});
  page=await context.newPage();
  await page.exposeFunction('__BUYANIME_ISOLATED_HTTP__',async request=>{
   const res=await db.http(request.path,request.body,owner,{method:request.method,headers:{...(request.prefer?{prefer:request.prefer}:{}),...(request.accept?{accept:request.accept}:{})}});
   if(/rpc\/erp_(apply|reconcile)_inventory_import/.test(request.path))rpc.push({path:request.path,ok:res.data?.ok,code:res.data?.code,outcome:res.data?.outcome});
   return res;
  });
  await page.goto('http://127.0.0.1:4292/tests/fixtures/buyanime-resume-provider.html');
  await page.waitForFunction(()=>Boolean(window.__BUYANIME_RESUME_PROVIDER__));
  await page.evaluate(actor=>window.__BUYANIME_RESUME_PROVIDER__.setup(actor),owner);
 };
 const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
 // Changed quantities on every existing row (PATCH) plus 12 new specs (CREATE).
 const fileRows=[...rows.map((x,i)=>[x.code,x.parent,x.title,x.raw,'日本代購',800,i%3,5+(i%4),'2026-10-01']),
  ...Array.from({length:12},(_,i)=>[`SYNNEW${String(i).padStart(2,'0')}`,'',`合成新品 ${i}`,`款 ${i%2}`,'日本代購',500,1,1,'2026-10-20'])];
 const html='<table><tr><th>子編號(商品編號)</th><th>主編號(多規格編號)</th><th>商品名稱</th><th>規格項目</th><th>商品種類</th><th>價格</th><th>庫存</th><th>已售</th><th>刊登時間</th></tr>'+
  fileRows.map(c=>'<tr>'+c.map(v=>`<td>${esc(v)}</td>`).join('')+'</tr>').join('')+'</table>';
 const base64=Buffer.from(html,'utf8').toString('base64');
 const run=async label=>{await connect();return page.evaluate(async({base64,label,expected})=>{
  const bridge=window.__BUYANIME_RESUME_PROVIDER__,provider=bridge.provider();
  await provider.waitForCloudBootstrapConvergence();
  const parsed=await bridge.parse(base64);if(parsed.length!==expected)throw new Error('SYNTHETIC_PARSE_PARITY_FAILED');
  if(await provider.getBuyAnimeImportRecovery())throw new Error('STALE_RECOVERY_BLOCK');
  bridge.resetMetrics();
  const {renderImportBenchmarkUi}=await import('/tests/fixtures/buyanime-performance-ui.tsx');
  try{const ui=await renderImportBenchmarkUi(provider,base64,'synthetic-post-restore.xls');
   return {label,syncText:ui.syncText,successVisible:ui.modalText.includes('匯入成功'),metrics:bridge.metrics()};}
  catch(error){return {label,error:String(error?.message||error),metrics:bridge.metrics()};}
 },{base64,label,expected:fileRows.length});};
 stage='Restore -> immediate BuyAnime';
 for(let n=0;n<5;n++){
  const out=await run('repeat-'+(n+1));
  assert.equal(out.error,undefined,JSON.stringify({out,rpc}));
  assert.equal(out.successVisible,true);assert.match(out.syncText,/已同步/u);assert.equal(out.metrics.wacaRequests,0);
 }
 // Exactly one Inventory transaction committed; repeats are proven no-ops.
 assert.deepEqual(rpc,[{path:'/rpc/erp_apply_inventory_import',ok:true,code:undefined,outcome:'COMMITTED'}]);
 summary.immediateImport='PASS';summary.sameFile5x='PASS';
 stage='database identity';
 const keys=(await db.sql.query('select count(*)::int n,count(distinct inventory_key)::int u,count(distinct myacg_item_code)::int c from inventory_items where deleted_at is null')).rows[0];
 assert.deepEqual(keys,{n:rows.length+13,u:rows.length+13,c:rows.length+13});
 const kept=(await db.sql.query('select count(*)::int n from inventory_items where id=any($1::uuid[]) and deleted_at is null',[rows.map(x=>x.id)])).rows[0].n;
 assert.equal(kept,rows.length,'EXISTING_INVENTORY_UUID_REPLACED');
 const patched=(await db.sql.query("select count(*)::int n from inventory_items where id=any($1::uuid[]) and latest_catalog_import_id<>'catalog_import_1791127492375'",[rows.map(x=>x.id)])).rows[0].n;
 assert.equal(patched,rows.length);
 // One durable completion journal per import attempt; none may stay blocking.
 const journal=(await db.sql.query("select count(*)::int n,count(distinct id)::int u from import_batches where platform='buyanime-catalog-resume-v1'")).rows[0];
 assert.deepEqual(journal,{n:5,u:5});
 assert.equal(Number((await db.sql.query('select epoch from erp_cloud_restore_epoch')).rows[0].epoch),epoch,'IMPORT_MUST_NOT_ADVANCE_RESTORE_EPOCH');
 summary.identity='PASS';
 stage='refresh consistency';
 await connect();
 const refreshed=await page.evaluate(async()=>{const provider=window.__BUYANIME_RESUME_PROVIDER__.provider();
  await provider.waitForCloudBootstrapConvergence();const inv=await provider.getInventory();
  return {n:inv.length,pending:await provider.getBuyAnimeImportRecovery()};});
 assert.equal(refreshed.n,rows.length+13);assert.equal(refreshed.pending,null);
 summary.refresh='PASS';
 assert.equal(externalRequests,0);summary.result='PASS';
 console.log(JSON.stringify(summary));
}catch(e){console.log(JSON.stringify({stage,error:String(e.message).slice(0,1500)}));throw new Error('BUYANIME_POST_RESTORE_TIMEZONE_GATE_FAILED: '+stage);}
finally{if(browser)await browser.close();await server.close();await vite.close();await db.close();}
