import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const port=4798, base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--configLoader','runner','--mode','experimental','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:['ignore','pipe','pipe']});
let output='';server.stdout.on('data',c=>output+=c);server.stderr.on('data',c=>output+=c);
let browser;
const checks=[];
try {
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}if(server.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,150));}
  browser=await chromium.launch({executablePath:process.env.CORE_TEST_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
  const open=async mode=>{
    const c=await browser.newContext();
    await c.addInitScript(m=>localStorage.setItem('erp_provider_mode',m),mode);
    await c.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    const p=await c.newPage();await p.goto(base+'/tests/fixtures/r5-mode-draft.html');await p.getByLabel('發售月份').waitFor();return {c,p};
  };
  for(const mode of ['cloud','local']) {
    const {c,p}=await open(mode),to=mode==='cloud'?'local':'cloud';
    const input=p.getByLabel('發售月份');await input.fill('old '+mode);
    await p.evaluate(to=>window.r5.switchMode(to),to);
    await input.press('Enter');
    await p.getByRole('status').filter({hasText:'資料模式已變更'}).waitFor();
    assert.deepEqual(await p.evaluate(()=>window.r5.writes),[]);
    const rejected=await p.evaluate(async()=>{try{await window.r5.rawSave();return false;}catch(e){return e.name;}});
    assert.equal(rejected,'ProviderModeChangedError');
    await input.press('Escape');assert.equal(await input.inputValue(),'base');
    await input.fill('discard');await p.getByRole('button',{name:'放棄'}).click();
    assert.deepEqual(await p.evaluate(()=>window.r5.writes),[]);
    checks.push(mode+' -> '+to+': React blur/enter and public Provider dispatch blocked');
    await c.close();
  }
  {
    const {c,p}=await open('cloud');const second=await c.newPage();
    await second.goto(base+'/tests/fixtures/r5-mode-draft.html');await second.getByLabel('發售月份').waitFor();
    await p.getByLabel('發售月份').fill('tab1');await second.getByLabel('發售月份').fill('tab2');
    await second.evaluate(()=>window.r5.switchMode('local'));
    for(const page of [p,second]) {
      await page.getByLabel('發售月份').press('Enter');await page.getByRole('status').filter({hasText:'資料模式已變更'}).waitFor();
      assert.deepEqual(await page.evaluate(()=>window.r5.writes),[]);
    }
    // Changing back is not permission to reuse either tab's original drafts.
    await second.evaluate(()=>window.r5.switchMode('cloud'));
    await p.getByLabel('發售月份').press('Enter');assert.deepEqual(await p.evaluate(()=>window.r5.writes),[]);
    checks.push('real two-page storage events, round trip and old drafts blocked');await c.close();
  }
  {
    const {c,p}=await open('cloud');await p.evaluate(()=>window.r5.hold());
    await p.getByLabel('發售月份').fill('in flight');await p.getByLabel('發售月份').press('Enter');
    await p.waitForFunction(()=>window.r5.writes.length===1);
    await p.evaluate(()=>{window.r5.switchMode('local');window.r5.release();});
    await p.getByRole('status').filter({hasText:'資料模式已變更'}).waitFor();
    assert.deepEqual(await p.evaluate(()=>window.r5.writes),['cloud']);
    assert.equal(await p.getByLabel('發售月份').inputValue(),'in flight');
    checks.push('save/switch race: original provider only, uncertain completion never shown as saved');await c.close();
  }
  {
    const {c,p}=await open('local');await p.getByLabel('發售月份').fill('epoch draft');
    await p.evaluate(()=>window.r5.epoch());await p.getByLabel('發售月份').press('Enter');
    await p.getByRole('status').filter({hasText:'還原'}).waitFor();assert.deepEqual(await p.evaluate(()=>window.r5.writes),[]);
    await p.getByLabel('發售月份').press('Escape');await p.getByLabel('發售月份').fill('new draft');await p.getByLabel('發售月份').press('Enter');
    await p.getByRole('status').filter({hasText:'無草稿'}).waitFor();assert.deepEqual(await p.evaluate(()=>window.r5.writes),['local']);
    await p.reload();await p.getByLabel('發售月份').waitFor();assert.equal(await p.getByLabel('發售月份').inputValue(),'base');
    checks.push('Restore Epoch blocks old draft; cancel/new draft/reload safe');await c.close();
  }
  console.log(JSON.stringify({result:'PASS',scope:'real Chromium two pages, real React draft hook and DynamicDataProvider; persistence spies, no live Cloud/IndexedDB overwrite claim',checks},null,2));
} finally {await browser?.close();server.kill();}
