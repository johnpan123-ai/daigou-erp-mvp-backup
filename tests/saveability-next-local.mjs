import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const origin='http://127.0.0.1:4404';let browser;
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--mode','next','--host','127.0.0.1','--port','4404','--strictPort','--configLoader','runner'],{stdio:'ignore'});
try{
  for(let i=0;i<100;i++){try{if((await fetch(origin)).ok)break;}catch{}if(i===99)throw new Error('Disposable NEXT unavailable');await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext();let cloudRequests=0;
  await context.route(/https:\/\/.*\.supabase\.co\//u,r=>{cloudRequests++;return r.abort();});
  const page=await context.newPage();await page.goto(origin);
  const result=await page.evaluate(async()=>{
    const {dataProvider:p}=await import('/src/providers/dataProvider.ts');
    const {getProviderMode}=await import('/src/providers/providerMode.ts');
    const id=n=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    const group={id:id(1),title:'Synthetic NEXT'};const variant={id:id(2),product_group_id:group.id,product_title:group.title,variant_name:'帽子',myacg_item_code:'SYN-NEXT',source:'manual'};
    await p.saveProductGroups([group]);await p.saveProductVariants([variant]);
    const order={id:id(3),product_group_id:group.id,customer_name:'Synthetic only',contact:'',note:'',created_at:new Date().toISOString()};
    const item={id:id(4),private_order_id:order.id,product_variant_id:variant.id,quantity:1,amount:0,note:''};
    const command={idempotencyKey:id(5),order,items:[item],baseItems:[]};
    await p.savePrivateOrderTransaction(command);await p.savePrivateOrderTransaction(command);
    const read=async()=>({orders:await p.getPrivateOrders(),items:await p.getPrivateOrderItems()});
    const before=await read();let rejected=false;
    try{await p.savePrivateOrderTransaction({...command,idempotencyKey:id(6),baseOrder:before.orders[0],baseItems:before.items,items:[{...item,product_variant_id:id(99)}]});}catch{rejected=true;}
    const preserved=JSON.stringify(await read())===JSON.stringify(before);
    await p.savePrivateOrderTransaction({...command,idempotencyKey:id(7),baseOrder:before.orders[0],baseItems:before.items,items:[]});
    const cleared=await read();return {mode:getProviderMode(),orders:cleared.orders.length,items:cleared.items.length,invalidRejected:rejected,preserved,originalItems:before.items.length};
  });
  assert.deepEqual(result,{mode:'next',orders:1,items:0,invalidRejected:true,preserved:true,originalItems:1});
  await page.reload();
  const persisted=await page.evaluate(async()=>{const {dataProvider}=await import('/src/providers/dataProvider.ts');return {orders:(await dataProvider.getPrivateOrders()).length,items:(await dataProvider.getPrivateOrderItems()).length};});
  assert.deepEqual(persisted,{orders:1,items:0});assert.equal(cloudRequests,0);
  console.log('PASS disposable NEXT IndexedDB private create/replay, invalid relationship atomic rollback, last-child delete, reload persistence; Supabase requests=0; normal NEXT data untouched');
}finally{await browser?.close();vite.kill();}
