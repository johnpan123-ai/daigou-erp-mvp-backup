// Actual L1/L2 React pages and shared draft hook; synthetic provider persistence only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const port='4791', base=`http://127.0.0.1:${port}`;
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--mode','experimental','--host','127.0.0.1','--port',port,'--strictPort','--configLoader','runner'],{stdio:['ignore','pipe','pipe']});
let log='';vite.stdout.on('data',c=>log+=c);vite.stderr.on('data',c=>log+=c);
let browser;
const checks={};
try {
  for(let i=0;i<100;i++){
    if(vite.exitCode!==null)throw Error(log);
    try{if((await fetch(base)).ok)break;}catch{}
    if(i===99)throw Error(log);
    await new Promise(r=>setTimeout(r,200));
  }
  browser=await chromium.launch({executablePath:process.env.CORE_TEST_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  for(const level of [1,2]){
    const context=await browser.newContext({viewport:{width:1600,height:1000},timezoneId:'America/Los_Angeles'});
    const external=[];await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.hostname!=='127.0.0.1'){external.push(url.origin);return route.abort();}return route.continue();
    });
    await context.addInitScript(()=>{localStorage.setItem('erp_provider_mode','experimental');localStorage.setItem('purchase_management_edit_mode','true');});
    const page=await context.newPage();const dialogs=[];let confirm=true;
    page.on('dialog',async d=>{dialogs.push(d.message());await (confirm?d.accept():d.dismiss());});
    await page.clock.setFixedTime(new Date('2026-10-22T04:00:00Z'));
    const route=level===1?'/purchase-records':'/purchase-records/g-holo';
    await page.goto(base+'/tests/fixtures/cloud-p0-2-react-harness.html?uuidFixtures=1&route='+encodeURIComponent(route));
    await page.waitForFunction(()=>Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
    let input,preview,error;
    if(level===1){
      const row=page.getByRole('row').filter({hasText:'hololive active'}).first();await row.waitFor();
      if(!(await row.locator('input[data-field="closing_date"]').count()))await page.getByTestId('purchase-records-edit-mode-toggle').click();
      input=row.locator('input[data-field="closing_date"]').first();preview=row.getByTestId('closing-date-save-preview');error=row.getByTestId('closing-date-save-error');
    }else{
      input=page.getByTestId('purchase-group-closing-date');preview=page.getByTestId('purchase-group-closing-date-preview');error=page.getByTestId('purchase-group-closing-date-error');
    }
    const writes=()=>page.evaluate(()=>window.__P0_REACT_HARNESS__.snapshot().writesByMethod.saveProductGroups||0);
    const stored=()=>page.evaluate(()=>{const h=window.__P0_REACT_HARNESS__;return h.server.productGroups.find(g=>g.id===h.fixtureId('g-holo')).closing_date;});
    const results=[];
    for(const [value,full] of [['10/25','2026/10/25'],['11/15','2026/11/15'],['1/15','2027/01/15'],['3/5','2027/03/05'],['10/22','2026/10/22'],['2/29','2028/02/29'],['2026/03/05','2026/03/05']]){
      const before=await writes();await input.fill(value);
      if(value.split('/').length===2){await preview.waitFor();assert.ok((await preview.innerText()).includes(full));}
      assert.equal(await writes(),before,'typing and preview never save');
      await input.press('Enter');await page.waitForFunction(expected=>{const h=window.__P0_REACT_HARNESS__;return h.server.productGroups.find(g=>g.id===h.fixtureId('g-holo')).closing_date===expected;},full);
      await input.press('Tab');assert.equal(await writes(),before+1,'Enter then Blur saves once');results.push({input:value,saved:await stored()});
    }
    for(const invalid of ['2/31','2027/02/29','2026/04/31']){
      const before=await writes(),original=await stored();await input.fill(invalid);await input.press('Tab');await error.waitFor();assert.ok((await error.innerText()).includes('日期不存在'));
      await input.press('Enter');assert.equal(await writes(),before);assert.equal(await stored(),original);await input.press('Escape');assert.equal(await input.inputValue(),original);
    }
    // Midnight cannot silently change the already displayed preview or save a passed shorthand date.
    await page.clock.setFixedTime(new Date('2026-10-22T15:59:59Z'));await input.fill('10/22');
    assert.ok((await preview.innerText()).includes('2026/10/22'));const before=await writes();
    await page.clock.setFixedTime(new Date('2026-10-22T16:00:00Z'));await input.press('Enter');
    await error.waitFor();assert.ok((await preview.innerText()).includes('2027/10/22'));assert.equal(await writes(),before);
    await input.press('Enter');await page.waitForFunction(()=>{const h=window.__P0_REACT_HARNESS__;return h.server.productGroups.find(g=>g.id===h.fixtureId('g-holo')).closing_date==='2027/10/22';});
    assert.equal(await writes(),before+1);
    if(level===1){
      const paste=async text=>input.evaluate((el,value)=>{const data=new DataTransfer();data.setData('text',value);el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},text);
      const beforePaste=await writes();confirm=false;await paste('1/15');await page.waitForFunction(()=>true);assert.ok(dialogs.at(-1).includes('2027/01/15'));assert.equal(await writes(),beforePaste);
      confirm=true;await paste('2/31');assert.ok(dialogs.at(-1).includes('尚未儲存'));assert.equal(await writes(),beforePaste);
    }
    assert.deepEqual(external,[]);checks['L'+level]={vectors:results,nonexistentZeroWrites:true,midnightPreviewReconfirmed:true,externalRequests:external.length};
    await context.close();
  }
  console.log(JSON.stringify({result:'PASS',checks},null,2));
}finally{await browser?.close();vite.kill();}
