import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {isolatedDatabase,uuid} from './helpers/saveability-isolated.mjs';
const db=await isolatedDatabase();let vite,browser;
const origin='http://127.0.0.1:4401';
const bridge=createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Headers','content-type');
  if(req.method==='OPTIONS'){res.end();return;}
  const path=req.url;
  if(!/^\/(?:rpc\/erp_apply_(?:private_order|catalog|field_mutations|related)_?transaction|rpc\/erp_reconcile_private_order_transaction|rpc\/erp_apply_field_mutations|[a-z_]+)(?:\?.*)?$/u.test(path)){
    res.writeHead(403);res.end('{}');return;
  }
  try{
    let body; if(req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);body=JSON.parse(Buffer.concat(chunks));}
    const result=await db.http(path,body);res.writeHead(result.status,{'content-type':'application/json'});res.end(JSON.stringify(result.data));
  }catch{res.writeHead(500,{'content-type':'application/json'});res.end('{"code":"SYNTHETIC_BRIDGE_FAILED"}');}
});
try{
  await db.sql.query("update public.product_groups set listing_type='代理版',show_in_purchase_list=true where id=$1",[uuid(1)]);
  await db.startPostgrest();await new Promise(resolve=>bridge.listen(4403,'127.0.0.1',resolve));
  vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--mode','staging','--host','127.0.0.1','--port','4401','--strictPort'],
    {stdio:'ignore',env:{...process.env,VITE_DEPLOYMENT_ENV:'staging',VITE_SUPABASE_URL:'https://rhfdjsklfrgpoqsaqpkn.supabase.co',VITE_SUPABASE_ANON_KEY:'isolated-test-public-key'}});
  for(let i=0;i<100;i++){try{if((await fetch(origin)).ok)break;}catch{}if(i===99)throw new Error('Disposable Vite unavailable');await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext();let liveRequests=0;const errors=[];const messages=[];
  await context.route(/https:\/\/.*\.supabase\.co\//u,r=>{liveRequests++;return r.abort();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{messages.push(d.message());void d.accept();});
  const entry=origin+'/tests/fixtures/saveability-native.html';
  await page.goto(entry);await page.waitForFunction(()=>Boolean(window.saveabilityFixture));
  const open=async()=>{await page.getByRole('button',{name:/其他操作/}).first().click();await page.getByRole('menuitem',{name:'私下登記',exact:true}).click();await page.getByRole('heading',{name:'新增私下登記'}).waitFor();};
  const modal=page.locator('.card').filter({has:page.getByRole('heading',{name:/私下登記/})});
  await open();const inputs=modal.locator('input');await inputs.nth(0).fill('Synthetic buyer');await inputs.nth(3).fill('1');await inputs.nth(4).fill('0');
  await page.evaluate(()=>window.saveabilityFixture.loseNext());await modal.getByRole('button',{name:'儲存',exact:true}).click();
  await modal.getByRole('button',{name:'查證同一筆儲存結果'}).waitFor();assert.equal(await inputs.nth(0).isDisabled(),true);
  const count=async()=>Number((await db.sql.query('select count(*) n from public.private_orders where deleted_at is null')).rows[0].n);
  assert.equal(await count(),1,'response loss committed one order');
  // Fresh browser bootstrap must recover the exact pending key and frozen draft.
  await page.goto(entry);await page.waitForFunction(()=>Boolean(window.saveabilityFixture));await open();
  assert.equal(await inputs.nth(0).inputValue(),'Synthetic buyer');
  await modal.getByRole('button',{name:'查證同一筆儲存結果'}).click();await modal.waitFor({state:'hidden'});
  assert.equal(await count(),1,'retry after reload duplicated order');
  await open();await inputs.nth(0).fill('Synthetic second');await inputs.nth(3).fill('2');
  await modal.getByRole('button',{name:'儲存',exact:true}).click();await modal.waitFor({state:'hidden'});assert.equal(await count(),2);
  await page.goto(entry);await page.waitForFunction(()=>Boolean(window.saveabilityFixture));await open();
  await inputs.nth(0).fill('Synthetic committed pending readback');await inputs.nth(3).fill('1');
  await page.evaluate(()=>window.saveabilityFixture.failRead());await modal.getByRole('button',{name:'儲存',exact:true}).click();
  await modal.getByRole('button',{name:'查證同一筆儲存結果'}).waitFor();assert.equal(await count(),3);
  assert.ok(messages.some(m=>m.includes('已儲存')||m.includes('已提交')),'committed readback failure misreported as rollback');
  await modal.getByRole('button',{name:'查證同一筆儲存結果'}).click();
  try{await modal.waitFor({state:'hidden',timeout:10000});}catch{throw new Error('Synthetic retry diagnosis:'+JSON.stringify({messages,calls:await page.evaluate(()=>window.saveabilityFixture.calls())}));}
  assert.equal(await count(),3);
  const invalid=await page.evaluate(async()=>{
    const {dataProvider}=await import('/src/providers/dataProvider.ts');const before=window.saveabilityFixture.calls().length;
    try{await dataProvider.saveProductGroups([{id:'not-a-canonical-id',title:'Synthetic invalid'}]);return {rejected:false};}
    catch{return {rejected:true,rpcs:window.saveabilityFixture.calls().length-before};}
  });assert.deepEqual(invalid,{rejected:true,rpcs:0});
  // Catalog native provider readback; second action must remain stable.
  await db.sql.query("insert into public.inventory_items(id,inventory_key,myacg_item_code,product_title,raw_variant_name,listing_type,final_price,myacg_sold_quantity) values($1,'SYN-UI','G-UI','Synthetic UI Catalog','帽子','代理版',0,3)",[uuid(70)]);
  await page.goto(entry+'?view=catalog');await page.getByText('Synthetic UI Catalog',{exact:true}).first().waitFor();
  const action=page.getByRole('button',{name:/匯入訂購紀錄|建立訂購紀錄/}).first();await action.click();
  await page.waitForFunction(()=>window.saveabilityFixture.calls().some(c=>c.name==='erp_apply_catalog_transaction'));
  await page.waitForTimeout(500);
  const catalog=(await db.sql.query("select id from public.product_groups where title='Synthetic UI Catalog' and deleted_at is null")).rows;
  assert.equal(catalog.length,1);assert.equal(Number((await db.sql.query('select myacg_auto_quantity from public.product_variants where myacg_item_code=$1 and deleted_at is null',['G-UI'])).rows[0].myacg_auto_quantity),3);
  assert.equal(liveRequests,0);assert.deepEqual(errors,[]);
  console.log('PASS actual Private form -> facade -> Cloud provider -> native PostgREST: response lost, frozen draft, same-key reload retry, second save, zero price, committed/readback-pending retry; invalid canonical ID blocked before RPC');
  console.log('PASS actual Catalog UI -> atomic provider -> native PostgREST/readback; real Supabase requests=0');
}finally{await browser?.close();vite?.kill();await new Promise(r=>bridge.close(r));await db.close();}
