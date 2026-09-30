import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';
import { createServer } from 'vite';

const ssr = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { supportsWacaProvider } = await ssr.ssrLoadModule('/src/waca/providerSupport.ts');
  for (const mode of ['cloud', 'fallback']) {
    assert.equal(supportsWacaProvider(mode, 'rhfdjsklfrgpoqsaqpkn'), true);
    assert.equal(supportsWacaProvider(mode, 'twzpqyesbtnfxdkorluf'), false);
    assert.equal(supportsWacaProvider(mode, ''), false);
  }
  assert.equal(supportsWacaProvider('next', ''), true);
  for (const mode of ['local', 'test', 'experimental']) assert.equal(supportsWacaProvider(mode, 'rhfdjsklfrgpoqsaqpkn'), false);
} finally { await ssr.close(); }

const origin = 'http://127.0.0.1:4398';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging',
  '--host', '127.0.0.1', '--port', '4398', '--strictPort', '--configLoader', 'runner'],
{ env: { ...process.env, VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'isolated-test-key-not-a-real-credential', VITE_DEPLOYMENT_ENV: 'staging' },
  stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += chunk; });
vite.stderr.on('data', chunk => { output += chunk; });
let browser;
const timings = [];
try {
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* isolated server starting */ }
    if (n === 99 || vite.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const labels = ['主頁', '買動漫匯入', 'WACA 匯入', '訂購紀錄表', '近期採購', '採購總表',
    '日本包裹管理', '出庫管理', '待下架商品', '重複品項管理', '設定'];
  const fixture = '/tests/fixtures/waca-cloud-ui-parity.html';
  for (const mode of ['cloud', 'fallback']) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    let forbiddenRequests = 0;
    await context.route('https://**/*', route => { forbiddenRequests++; return route.abort(); });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}${fixture}?mode=${mode}`);
    await page.getByRole('button', { name: '匯入 WACA Excel', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.file-upload-button button')?.disabled
      && window.wacaUiFixture.calls().reads > 0);
    await page.waitForFunction(() => !document.body.textContent.includes('正在讀取 WACA 訂單資料'));
    assert.deepEqual(await page.locator('.sidebar-nav-container .nav-label').allTextContents(), labels);
    assert.equal(await page.locator('.nav-item[href="/waca"]').count(), 1);
    assert.equal(await page.locator('input[type="file"]').first().isVisible(), false);
    assert.doesNotMatch(await page.locator('body').innerText(), /只在 NEXT 4192 開放|商品清單匯入/);
    const before = await page.evaluate(() => window.wacaUiFixture.calls());
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const name of ['來源訂單', '商品對照', '匯入紀錄', '待處理 0', 'WACA 匯入']) {
        const start = performance.now();
        await page.getByRole('navigation', { name: 'WACA 功能' }).getByRole('button', { name, exact: true }).click();
        timings.push(performance.now() - start);
      }
    }
    assert.deepEqual(await page.evaluate(() => window.wacaUiFixture.calls()), before, 'tabs must not reread or write');
    assert.equal(await page.evaluate(() => window.wacaUiFixture.providerCommit()), 1);
    assert.equal((await page.evaluate(() => window.wacaUiFixture.calls())).commits, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('erp_waca_revision_v1')), null);
    assert.equal(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'daigou-erp-db-next-v1')), false);
    assert.equal(forbiddenRequests, 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.route('https://**/*', route => route.abort());
  const page = await context.newPage();
  await page.goto(`${origin}${fixture}?populated=1`);
  await page.waitForFunction(() => window.wacaUiFixture?.calls().reads > 0
    && !document.body.textContent.includes('正在讀取 WACA 訂單資料'));
  await page.waitForFunction(() => document.querySelector('input[aria-label="選擇 WACA Excel"]')?.disabled === false);
  const headers = ['訂單狀態', '訂單編號', '購買日期', '商品編號', '品名', '多規格名稱一',
    '多規格名稱二', '規格編號', '訂單商品數量', '小計'];
  const sheet = XLSX.utils.aoa_to_sheet([headers.map(() => '訂單資訊'), headers, ...[10, 2].map(n =>
    ['完成付款', `ORDER-${n}`, '2026-09-30', 'GP-A',
      '【小河馬日本代購】 預購 27年02月 代理版 GSC 換裝玩偶 BanG Dream! Morfonica',
      `規格${n}`, '', '', 2, 200])]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'orders');
  await page.getByLabel('選擇 WACA Excel').setInputFiles({ name: 'synthetic-waca.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
  await page.waitForFunction(() => document.body.textContent.includes('匯入預覽：synthetic-waca.xlsx')
    || document.querySelector('.waca-error'));
  assert.equal(await page.locator('.waca-error').count(), 0, await page.locator('.waca-page').innerText());
  assert.equal(await page.locator('.waca-group').count(), 1, await page.locator('.waca-page').innerText());
  assert.equal(await page.locator('.waca-group').count(), 1);
  assert.equal(await page.locator('.waca-group summary strong').innerText(), '代理版 GSC 換裝玩偶 BanG Dream! Morfonica');
  await page.locator('.waca-group summary').click();
  assert.deepEqual(await page.locator('.waca-group tbody td small').allTextContents(), ['SKU G2', 'SKU G10']);
  await page.getByLabel('顯示未變更商品').check();
  assert.deepEqual(await page.locator('.waca-group tbody td small').allTextContents(), ['SKU G1', 'SKU G2', 'SKU G10']);
  assert.equal((await page.evaluate(() => window.wacaUiFixture.calls())).commits, 0, 'preview is readonly');
  for (const width of [1366, 1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
  }
  await page.goto(`${origin}${fixture}?failure=1`);
  await page.getByRole('alert').filter({ hasText: '隔離測試：訂單讀取失敗' }).waitFor();
  await page.evaluate(() => window.wacaUiFixture.recover());
  await page.getByRole('button', { name: '重新讀取' }).click();
  await page.waitForFunction(() => !document.querySelector('.waca-error'));
  await page.goto(`${origin}${fixture}?role=viewer`);
  await page.waitForFunction(() => Boolean(document.querySelector('.sidebar-nav-container')));
  assert.equal(await page.locator('.nav-item[href="/waca"]').count(), 0, 'permissions unchanged');
  assert.match(readFileSync('src/pages/Inventory.tsx', 'utf8'), /<h1>買動漫匯入<\/h1>/);
  assert.match(readFileSync('src/App.tsx', 'utf8'), /path="\/waca"/);
  console.log(JSON.stringify({ result: 'PASS', modes: ['cloud', 'fallback'], providerTransport: 'real routing / isolated synthetic transport',
    tabSwitchReads: 0, tabSwitchWrites: 0, tabSwitchP95Ms: Math.round(timings.sort((a, b) => a - b)[Math.floor(timings.length * .95)]),
    changedOnly: true, skuNaturalSort: true, canonicalTitle: true, gpEvidenceFirstLoad: true,
    dimensions: [1366, 1280, 390], errorRecovery: true, permissionsPreserved: true }));
} finally {
  await browser?.close();
  vite.kill();
}
