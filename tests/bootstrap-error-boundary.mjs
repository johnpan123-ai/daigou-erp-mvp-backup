import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4195';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4195', '--strictPort',
], { cwd: ROOT_PATH, stdio: ['ignore', 'pipe', 'pipe'] });

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const supabaseRequests = [];

try {
  const testContext = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  await testContext.addInitScript(() => localStorage.setItem('erp_provider_mode', 'test'));
  const testPage = await testContext.newPage();
  testPage.on('request', request => {
    if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url());
  });

  await testPage.goto(`${BASE_URL}/?simulateBootstrapError=1`, { waitUntil: 'networkidle' });
  assert.equal(await testPage.locator('h1').innerText(), '系統啟動失敗');
  assert.equal(await testPage.getByRole('button', { name: '重新載入' }).count(), 1);
  assert.equal(await testPage.locator('body').getAttribute('data-bootstrap-error'), 'BOOTSTRAP_FAILED');
  assert.match(await testPage.locator('body').innerText(), /錯誤代碼：BOOTSTRAP_FAILED/);
  assert.doesNotMatch(await testPage.locator('body').innerText(), /TEST_ONLY_BOOTSTRAP_FAILURE/);
  assert.equal(await testPage.title(), '[TEST ERROR] 小河馬 ERP');
  assert.equal(supabaseRequests.length, 0, `Test failure page contacted Supabase: ${JSON.stringify(supabaseRequests)}`);

  await testPage.goto(BASE_URL, { waitUntil: 'networkidle' });
  await testPage.waitForFunction(() => Boolean(window.dataProvider));
  assert.equal(await testPage.title(), '[TEST] 小河馬 ERP');
  assert.equal(await testPage.locator('[data-bootstrap-error]').count(), 0);
  assert.equal(supabaseRequests.length, 0, `Normal Test bootstrap contacted Supabase: ${JSON.stringify(supabaseRequests)}`);
  await testContext.close();

  const localContext = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  await localContext.addInitScript(() => localStorage.setItem('erp_provider_mode', 'local'));
  const localPage = await localContext.newPage();
  await localPage.goto(`${BASE_URL}/?simulateBootstrapError=1`, { waitUntil: 'networkidle' });
  await localPage.waitForFunction(() => Boolean(window.dataProvider));
  assert.equal(await localPage.locator('text=系統啟動失敗').count(), 0, 'Test-only injection affected Local Mode');
  await localContext.close();

  console.log('PASS Test-only bootstrap failure renders a non-React recovery screen');
  console.log('PASS recovery screen exposes reload action without leaking the raw error');
  console.log('PASS normal Test bootstrap recovers and Production Supabase requests remain 0');
  console.log('PASS bootstrap failure injection is ignored outside Test Mode');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
