import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium} from 'playwright';
import {recognitionPreview} from './helpers/waca-recognition-preview.mjs';
const preview=await recognitionPreview(Number(process.env.WACA_RECOGNITION_PORT??4742));
if(process.argv[2]==='--serve') {
  console.log('OWNER_PREVIEW='+preview.url+'\nSYNTHETIC_DATABASE_ONLY; Ctrl+C closes this test database.');
  process.on('SIGINT',async()=>{await preview.close();process.exit();});
  process.on('SIGTERM',async()=>{await preview.close();process.exit();});
} else {
  let browser;try {
    browser=await chromium.launch({executablePath:process.env.CORE_TEST_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],external=[],previewRequests=[];
    page.on('request',request=>{if(request.url().endsWith('/__recognition_db')){
      const call=request.postDataJSON();if(call.path==='/rpc/erp_preview_waca_recognition')previewRequests.push(call.body.p_request);
    }});
    await page.route('https://**/*',r=>{external.push(r.request().url());return r.abort();});page.on('pageerror',e=>errors.push(e.message));
    const out=process.env.WACA_RECOGNITION_SCREENSHOTS;if(out)mkdirSync(out,{recursive:true});
    await page.goto(preview.url);await page.getByRole('button',{name:'來源訂單',exact:true}).click();
    await page.getByRole('button',{name:'查看／管理 DEMO-ORDER-001',exact:true}).click();
    const manager=page.getByLabel('管理訂單 DEMO-ORDER-001');await manager.waitFor();
    const before=await preview.db.state();
    await manager.getByLabel('認列 DEMO-ORDER-001 G-SYNTHETIC',{exact:true}).selectOption('INCLUDED');
    const previewButton=manager.getByRole('button',{name:'預覽認列調整',exact:true});
    assert.equal(await previewButton.isDisabled(),true,'Reason must be chosen explicitly');
    await manager.getByLabel('認列調整原因',{exact:true}).selectOption('OTHER');
    assert.equal(await previewButton.isDisabled(),true,'Other requires a note');
    await manager.getByLabel('其他調整原因備註',{exact:true}).fill('  ');
    assert.equal(await previewButton.isDisabled(),true,'Whitespace is not an audit reason');
    await manager.getByLabel('其他調整原因備註',{exact:true}).fill('  Owner 確認此明細已含原本歷史數量  ');
    assert.deepEqual(await preview.db.state(),before,'Changing selection/reason writes nothing');
    await previewButton.click();
    await manager.getByLabel('認列調整預覽').waitFor();assert.match(await manager.innerText(),/13 → 11/);
    assert.equal(previewRequests.at(-1).reason,'Owner 確認此明細已含原本歷史數量');
    const identityKeys=['requestId','revision','restoreEpoch','orderKey','reason','choices'].sort();
    assert.deepEqual(Object.keys(previewRequests.at(-1)).sort(),identityKeys,'RPC request contract unchanged');
    const originalChoices=previewRequests.at(-1).choices;
    for(const reason of ['先前認列錯誤','暫時不計入','已包含原本 WACA 數量']){
      await manager.getByLabel('認列調整原因',{exact:true}).selectOption(reason);
      assert.equal(await manager.getByLabel('認列調整預覽').count(),0,'Reason change invalidates old preview');
      assert.equal(await manager.getByLabel('其他調整原因備註',{exact:true}).count(),0);
      await previewButton.click();await manager.getByLabel('認列調整預覽').waitFor();
      assert.match(await manager.innerText(),/13 → 11/,'Reason selection cannot change recognition arithmetic');
      assert.equal(previewRequests.at(-1).reason,reason);assert.deepEqual(previewRequests.at(-1).choices,originalChoices);
      assert.deepEqual(Object.keys(previewRequests.at(-1)).sort(),identityKeys);
      assert.deepEqual(await preview.db.state(),before,'Every quick-reason preview is read-only');
    }
    assert.deepEqual(await preview.db.state(),before,'Preview is read-only');
    if(out)await page.screenshot({path:out+'/01-recognition-preview.png',fullPage:true});
    await manager.getByRole('button',{name:'確認保存認列調整',exact:true}).click();
    await page.getByText('認列調整已保存，來源訂單、認列紀錄及商品數量已權威讀回確認。',{exact:true}).waitFor();
    assert.equal(await preview.db.display(),11);assert.equal(await preview.db.display('G-SECOND'),23);
    assert.equal((await preview.db.snapshot()).batches.find(batch=>batch.recognition).recognition.request.reason,'已包含原本 WACA 數量');
    assert.equal((await manager.locator('tr').filter({hasText:'G-SYNTHETIC'}).locator('td').nth(3).innerText()).trim(),'0','UI counted quantity is authoritative without F5');
    assert.equal((await preview.db.snapshot()).items.find(i=>i.orderKey==='WACA::DEMO-ORDER-002').countedQuantity,1);
    assert.equal(await page.getByRole('button',{name:'查看／管理 DEMO-ORDER-001',exact:true}).getAttribute('aria-expanded'),'true');
    if(out)await page.screenshot({path:out+'/02-recognition-committed.png',fullPage:true});
    await page.getByRole('button',{name:'匯入紀錄',exact:true}).click();
    const history=page.locator('section').filter({has:page.getByRole('heading',{name:'WACA 匯入紀錄',exact:true})});
    assert.equal(await history.getByText('來源訂單認列調整',{exact:true}).count(),0,'Management receipts are not Excel imports');
    const persistedBatches=(await preview.db.snapshot()).batches;
    assert.equal(await history.locator('tbody tr').count(),persistedBatches.filter(batch=>!batch.recognition).length);
    assert.ok(persistedBatches.some(batch=>batch.recognition),'Recognition audit is still durable');
    await page.reload();await page.getByRole('button',{name:'來源訂單',exact:true}).click();await page.getByRole('button',{name:'查看／管理 DEMO-ORDER-001',exact:true}).click();
    assert.equal(await manager.getByLabel('認列 DEMO-ORDER-001 G-SYNTHETIC',{exact:true}).inputValue(),'INCLUDED');
    const noOpBefore=await preview.db.state();
    await manager.getByLabel('認列 DEMO-ORDER-001 G-SYNTHETIC',{exact:true}).selectOption('INCLUDED');
    await manager.getByLabel('認列調整原因',{exact:true}).selectOption('先前認列錯誤');
    await manager.getByRole('button',{name:'預覽認列調整',exact:true}).click();
    await manager.getByText('沒有實際差異，不會產生寫入或新增紀錄。',{exact:true}).waitFor();
    assert.deepEqual(await preview.db.state(),noOpBefore);
    await page.getByRole('button',{name:'查看／管理 DEMO-CANCELLED',exact:true}).click();
    const invalid=page.getByLabel('管理訂單 DEMO-CANCELLED');
    assert.equal(await invalid.locator('option[value="COUNT"]').isDisabled(),true);
    if(out)await page.screenshot({path:out+'/03-cancelled-protection.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.goto(preview.url+'?role=viewer');await page.getByRole('button',{name:'來源訂單',exact:true}).click();await page.getByRole('button',{name:'查看／管理 DEMO-ORDER-001',exact:true}).click();
    assert.equal(await manager.getByLabel('認列 DEMO-ORDER-001 G-SYNTHETIC',{exact:true}).isDisabled(),true);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[],'No production network requests');
    console.log(JSON.stringify({result:'PASS',engine:'Actual React + Cloud Provider + GlobalSync + authenticated native PostgreSQL/PostgREST',
      quickReasons:3,otherRequiresNote:true,requestContractUnchanged:true,reasonAuditExact:true,reasonDoesNotChangeQuantities:true,
      previewReadOnly:true,uiDatabaseParity:true,otherSkuUntouched:true,otherOrderUntouched:true,reload:true,expandedStable:true,cancelProtected:true,ownerUi:true,mobileNoOverflow:true,externalRequests:external.length,cloudWrites:0},null,2));
  } finally {await browser?.close();await preview.close();}
}
