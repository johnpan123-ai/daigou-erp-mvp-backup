import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.DASHBOARD_CLOUD_RESILIENCE_PORT || '4215';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
for (let attempt = 0; attempt < 80; attempt += 1) {
  if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
  try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
  if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
  await sleep(250);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
const page = await context.newPage();
const supabaseRequests = [];
page.on('request', request => { if (/\.supabase\.co\//iu.test(request.url())) supabaseRequests.push(request.url()); });

try {
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    await environment.clearTestSandboxData();
    window.__dashboardOriginalGetProductGroups = window.dataProvider.getProductGroups.bind(window.dataProvider);
    window.dataProvider.getProductGroups = async () => { throw new Error('Injected dashboard cold-load failure'); };
  });
  await page.getByRole('link', { name: '主頁面' }).click();
  await page.getByText('無法載入首頁資料').waitFor();
  assert.deepEqual(await page.locator('[data-task-count]').allTextContents(), ['…', '…', '…', '…']);
  assert.equal(await page.getByText('資料尚未成功載入，請按上方「重新整理」。').count(), 1);

  await page.evaluate(() => { window.dataProvider.getProductGroups = window.__dashboardOriginalGetProductGroups; });
  await page.getByRole('button', { name: '重新整理' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-task-count]')].every(node => node.textContent === '0'));
  assert.equal(await page.getByText('目前沒有待下架商品。').count(), 1);

  await page.evaluate(() => {
    window.dataProvider.getProductGroups = async () => { throw new Error('Injected dashboard refresh failure'); };
  });
  await page.getByRole('button', { name: '重新整理' }).click();
  await page.getByText('更新失敗，畫面保留上次資料').waitFor();
  assert.deepEqual(await page.locator('[data-task-count]').allTextContents(), ['0', '0', '0', '0']);

  await page.evaluate(() => { window.dataProvider.getProductGroups = window.__dashboardOriginalGetProductGroups; });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-task-count]')].every(node => node.textContent === '0'));
  assert.deepEqual(supabaseRequests, []);
  console.log('PASS Dashboard cold failure never displays fake zero');
  console.log('PASS successful empty load displays real zero');
  console.log('PASS refresh failure retains last successful data and marks it stale');
  console.log('PASS Dashboard reload succeeds and ERP writes = 0');
  console.log('PASS Production/Staging Supabase requests = 0');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
