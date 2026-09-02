import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4295';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4295', '--strictPort',
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
      // Vite is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
await context.addInitScript(() => {
  window.__dataSizeTestAlerts = [];
  window.__dataSizeTestWarnings = [];
  window.alert = message => window.__dataSizeTestAlerts.push(String(message));
  const originalWarn = console.warn.bind(console);
  console.warn = (...args) => {
    window.__dataSizeTestWarnings.push(args.map(String).join(' '));
    originalWarn(...args);
  };
});
const page = await context.newPage();
const supabaseRequests = [];
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url());
});

try {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const firstRun = await page.evaluate(async () => {
    sessionStorage.clear();
    document.body.innerHTML = '';
    const advisory = await import('/src/lib/dataSizeAdvisory.ts?test=first');
    advisory.checkDataSizeWarnings({ product_variants: 3074 }, 'owner');
    advisory.checkDataSizeWarnings({ product_variants: 3074 }, 'owner');
    const notice = document.getElementById('erp-data-size-advisory');
    return {
      noticeCount: document.querySelectorAll('#erp-data-size-advisory').length,
      noticeText: notice?.textContent || '',
      pointerEvents: notice?.style.pointerEvents || '',
      storageValue: sessionStorage.getItem('erp:data-size-advisory-shown:v1'),
      alerts: window.__dataSizeTestAlerts,
      warnings: window.__dataSizeTestWarnings.filter(message => message.includes('[Data Size Advisory]')),
      thresholds: advisory.DATA_SIZE_THRESHOLDS,
    };
  });

  assert.equal(firstRun.noticeCount, 1, 'Repeated checks must render one notice only');
  assert.match(firstRun.noticeText, /商品規格資料量已超過目前效能觀察值（3074 \/ 3000）/);
  assert.match(firstRun.noticeText, /系統仍可正常使用/);
  assert.equal(firstRun.pointerEvents, 'none', 'Notice must not block ERP interaction');
  assert.equal(firstRun.storageValue, '1');
  assert.deepEqual(firstRun.alerts, [], 'The advisory must never call browser alert');
  assert.equal(firstRun.warnings.length, 2, 'console.warn remains available for every observation');
  assert.deepEqual(firstRun.thresholds, {
    product_variants: 3000,
    purchase_batch_items: 5000,
    private_order_items: 3000,
    sales_order_items: 5000,
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  const afterReload = await page.evaluate(async () => {
    document.body.innerHTML = '';
    const advisory = await import('/src/lib/dataSizeAdvisory.ts?test=reload');
    advisory.checkDataSizeWarnings({ product_variants: 3074 }, 'owner');
    return {
      noticeCount: document.querySelectorAll('#erp-data-size-advisory').length,
      storageValue: sessionStorage.getItem('erp:data-size-advisory-shown:v1'),
      alerts: window.__dataSizeTestAlerts,
    };
  });
  assert.equal(afterReload.noticeCount, 0, 'F5/reload must not repeat the UI notice in the same session');
  assert.equal(afterReload.storageValue, '1');
  assert.deepEqual(afterReload.alerts, []);

  const visibilityRules = await page.evaluate(async () => {
    sessionStorage.clear();
    document.body.innerHTML = '';
    const belowThreshold = await import('/src/lib/dataSizeAdvisory.ts?test=below');
    belowThreshold.checkDataSizeWarnings({ product_variants: 2999 }, 'owner');
    const belowCount = document.querySelectorAll('#erp-data-size-advisory').length;

    const staffCase = await import('/src/lib/dataSizeAdvisory.ts?test=staff');
    staffCase.checkDataSizeWarnings({ product_variants: 3074 }, 'staff');
    const staffCount = document.querySelectorAll('#erp-data-size-advisory').length;
    return { belowCount, staffCount, storageValue: sessionStorage.getItem('erp:data-size-advisory-shown:v1') };
  });
  assert.deepEqual(visibilityRules, { belowCount: 0, staffCount: 0, storageValue: null });

  const providerSource = await readFile(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8');
  assert.ok(providerSource.includes('checkDataSizeWarnings({'));
  assert.ok(providerSource.includes('}, role);'), 'Owner role must be passed to the advisory');
  assert.ok(!providerSource.includes('⚠️ 資料量警告'), 'Blocking data-size alert must be removed');
  assert.deepEqual(supabaseRequests, [], 'Regression must perform no Supabase requests or ERP writes');

  console.log('PASS threshold warning uses a non-blocking owner-only advisory');
  console.log('PASS same runtime and F5/reload do not repeat the UI advisory');
  console.log('PASS below-threshold and non-owner users receive no UI advisory');
  console.log('PASS console.warn remains and browser alert is never called');
  console.log('PASS thresholds unchanged and 0 Supabase requests / 0 ERP writes');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
