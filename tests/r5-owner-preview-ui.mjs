// Actual React App + actual Cloud/Local providers. Auth/Realtime transport is synthetic;
// all Cloud reads, field CAS and receiving RPC writes use isolated native PostgreSQL/PostgREST.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {chromium} from 'playwright';
const server=spawn(process.execPath,['scripts/r5-seven-owner-preview.mjs'],{env:{...process.env,R5_PREVIEW_PORT:'4793',R5_PREVIEW_POSTGREST_PORT:'4500'},stdio:['pipe','pipe','pipe']});
let log='',browser,page;const errors=[];server.stdout.on('data',c=>log+=c);server.stderr.on('data',c=>log+=c);
const base='http://127.0.0.1:4793',pid='10000000-0000-4000-8000-000000000301';
const read=async path=>{const r=await fetch(base+'/__r5/rest/'+path);assert.equal(r.status,200);return r.json();};
const snap=async()=>({packages:await read('japan_packages'),items:await read('japan_package_items'),outbound:await read('outbound_shipment_items')});
try{
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(log);if(log.includes('"result":"READY"'))break;if(i===99)throw Error(log);await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.launch({executablePath:process.env.CORE_TEST_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const context=await browser.newContext({viewport:{width:1600,height:1100}});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const external=[],dialogs=[],rpc=[];
 page.on('request',r=>{if(!r.url().startsWith(base)&&!r.url().startsWith('data:'))external.push(r.url());if(r.url().includes('/__r5/rest/rpc/'))rpc.push({url:r.url(),body:r.postDataJSON()});});
 page.on('dialog',async d=>{dialogs.push(d.message());await d.accept();});
 const ready=async path=>{await page.goto(base+path);await page.getByText('● 已同步',{exact:true}).waitFor();};
 const before=await snap();await ready('/japan-packages/'+pid);
 // Manual confirmed is rejected while rows are unfinished.
 await page.getByRole('button',{name:'已點收',exact:true}).click();
 await page.waitForFunction(()=>!document.body.innerText.includes('儲存中'));
 await page.waitForTimeout(200);assert.deepEqual(await snap(),before);assert.ok(dialogs.some(t=>t.includes('未點收')));
 // Partial -> all: only 2 changed rows, original checked_at remains exact.
 await page.getByRole('button',{name:'全選已點收',exact:true}).first().click();
 await page.waitForFunction(()=>document.body.innerText.includes('完成 1 / 1')&&document.querySelectorAll('.checklist-item-row input[type="checkbox"]:checked').length===3);
 const all=await snap();assert.equal(all.packages[0].status,'confirmed');assert.equal(all.items.filter(i=>i.checked).length,3);
 const receiving=rpc.filter(r=>r.url.endsWith('/erp_apply_japan_package_transaction'));
 assert.equal(receiving.at(-1).body.p_request.itemOperations.length,2);
 assert.equal(all.items.find(i=>i.id.endsWith('302')).checked_at,before.items.find(i=>i.id.endsWith('302')).checked_at);
 // The actual browser and Provider preserve the CORE error; every row rolls back.
 await page.getByRole('button',{name:'全取消點收',exact:true}).first().click();await page.waitForTimeout(400);
 assert.deepEqual(await snap(),all);assert.ok(dialogs.includes('本次操作包含已配置出庫的商品，因此無法全部取消點收。所有商品均維持原狀。'),JSON.stringify(dialogs));
 await page.locator('.checklist-item-row').filter({hasText:'已點收來源'}).locator('input[type="checkbox"]').click();await page.waitForTimeout(400);
 assert.deepEqual(await snap(),all);assert.ok(dialogs.includes('此商品已有 3 件配置至出庫單，因此無法取消整筆點收。請先解除相關出庫配置。'),JSON.stringify(dialogs));
 const free=page.locator('.checklist-item-row').filter({hasText:'來源 B'}).locator('input[type="checkbox"]');assert.equal(await free.isChecked(),true);await free.click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.checklist-item-row')].find(el=>el.textContent.includes('來源 B'))?.querySelector('input[type="checkbox"]').checked===false);
 assert.equal((await snap()).items.filter(i=>i.checked).length,2);assert.equal((await snap()).packages[0].status,'registered');
 // Real field CAS persists the same complete date previewed by L2.
 await page.evaluate(()=>localStorage.setItem('purchase_management_edit_mode','true'));
 await page.getByRole('link',{name:'商品詳情 L2',exact:true}).click();
 const date=page.getByTestId('purchase-group-closing-date');await date.fill('1/15');
 assert.ok((await page.getByTestId('purchase-group-closing-date-preview').innerText()).includes('2027/01/15'));
 await date.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-testid="purchase-group-closing-date"]').value==='2027/01/15');
 assert.equal((await read('product_groups'))[0].closing_date,'2027/01/15');
 const month=page.getByTestId('purchase-group-release-month');const cloudBefore=(await read('product_groups'))[0];await month.fill('Cloud 未保存草稿');
 const beforeSwitchRpc=rpc.length;await page.getByRole('button',{name:'切換 Local 示範',exact:true}).click();await month.press('Enter');
 assert.ok((await page.getByTestId('purchase-group-closing-date-error').innerText()).includes('模式已變更'));
 assert.equal(rpc.length,beforeSwitchRpc);assert.equal((await read('product_groups'))[0].release_month,cloudBefore.release_month);
 const localBefore=await page.evaluate(async()=>{const {localDb}=await import('/src/lib/db.ts');return localDb.getProductGroups();});assert.equal(localBefore.length,0,'Cloud draft did not create Local data');
 await page.locator('#root').getByRole('button',{name:'放棄草稿並重新載入',exact:true}).click();await page.getByTestId('purchase-group-release-month').waitFor();
 const localMonth=page.getByTestId('purchase-group-release-month');await localMonth.fill('Local 自由輸入月份');await localMonth.press('Enter');await page.waitForTimeout(250);
 const localAfter=await page.evaluate(async()=>{const {localDb}=await import('/src/lib/db.ts');return localDb.getProductGroups();});assert.equal(localAfter[0].release_month,'Local 自由輸入月份');
 assert.equal((await read('product_groups'))[0].release_month,cloudBefore.release_month);assert.deepEqual(external,[]);
 mkdirSync('scratch/r5-seven-evidence/ui',{recursive:true});await page.screenshot({path:'scratch/r5-seven-evidence/ui/native-owner-preview-local.png',fullPage:true});
 console.log(JSON.stringify({result:'PASS',engine:'actual React App + DynamicDataProvider + SupabaseProvider + native PostgreSQL/PostgREST/safeupdate',checks:{manualStatusRejected:true,partialBulkChangedRows:2,checkedAtPreserved:true,allocatedBulkCancelRollback:true,freeRowCancel:true,datePreviewStored:'2027/01/15',cloudDraftNoLocalWrite:true,localSaveNoCloudWrite:true,externalRequests:external.length},limits:['synthetic Owner Auth and Realtime notifications; no live ERP interaction']},null,2));
 await context.close();
}catch(error){console.error(JSON.stringify({body:await page?.locator('body').innerText(),errors},null,2));throw error;}finally{
 await browser?.close();
 const stopped=new Promise(resolve=>server.once('exit',resolve));server.stdin.end('close\n');await stopped;
}
