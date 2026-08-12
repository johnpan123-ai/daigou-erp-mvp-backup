import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = new URL('../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const BASE_URL = 'http://127.0.0.1:4188';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`找不到 Chrome：${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4188', '--strictPort',
], { cwd: ROOT_PATH, stdio: ['ignore', 'pipe', 'pipe'] });

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stableStringify = value => JSON.stringify(value, (_key, nestedValue) => {
  if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) return nestedValue;
  return Object.fromEntries(Object.entries(nestedValue).sort(([left], [right]) => left.localeCompare(right)));
});

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite 提前結束：\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite 啟動逾時：\n${viteOutput}`);
}

async function waitForProvider(page) {
  await page.waitForFunction(() => Boolean(window.dataProvider));
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
const page = await context.newPage();
const cloudWrites = [];
const unexpectedConsoleErrors = [];

page.on('dialog', dialog => { void dialog.dismiss(); });
page.on('console', message => {
  if (message.type() === 'error' && !message.text().includes('[Test Sandbox Guard]')) {
    unexpectedConsoleErrors.push(message.text());
  }
});
page.on('pageerror', error => unexpectedConsoleErrors.push(error.message));

page.on('request', request => {
  const url = request.url();
  const method = request.method().toUpperCase();
  if (url.includes('.supabase.co/') && !['GET', 'HEAD'].includes(method) && !url.includes('/auth/v1/')) {
    cloudWrites.push({ method, url });
  }
});

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.setItem('erp_provider_mode', 'local'));
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);

  await page.evaluate(async () => {
    await window.dataProvider.clearData();
    await window.dataProvider.saveProductGroups([{
      id: 'production-sentinel',
      title: 'Production sentinel',
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z',
    }]);
  });

  const productionBefore = await page.evaluate(async () => {
    const { readPhysicalIndexedDbSnapshot } = await import('/src/lib/testSandboxEnvironment.ts');
    return readPhysicalIndexedDbSnapshot('daigou-erp-db');
  });
  const productionChecksumBefore = stableStringify(productionBefore);

  await page.evaluate(() => localStorage.setItem('erp_provider_mode', 'test'));
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProvider(page);

  assert.equal(await page.title(), '[TEST] 小河馬 ERP');
  assert.match(await page.locator('body').innerText(), /測試模式｜所有修改只存在本機，不會寫入正式雲端/);

  await page.locator('.btn-change-image').first().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'sandbox-dashboard-image.png',
    mimeType: 'image/png',
    buffer: Buffer.from('test-sandbox-image'),
  });
  await page.waitForTimeout(150);
  assert.deepEqual(cloudWrites, [], 'Dashboard image upload attempted a Supabase write in Test Mode');

  await page.evaluate(async () => {
    await window.dataProvider.clearData();
    const base = {
      id: 'test-only-group',
      title: 'Test only group',
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z',
    };
    await window.dataProvider.saveProductGroups([base]);
    await window.dataProvider.saveProductGroups([{ ...base, title: 'Test group updated' }]);
    const updated = await window.dataProvider.getProductGroups();
    if (updated.length !== 1 || updated[0].title !== 'Test group updated') {
      throw new Error('Test Sandbox update did not persist');
    }
    await window.dataProvider.deleteProductGroup(base.id);
    if ((await window.dataProvider.getProductGroups()).length !== 0) {
      throw new Error('Test Sandbox delete did not persist');
    }
  });

  const isolation = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return {
      production: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db'),
      test: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1'),
    };
  });
  assert.equal(stableStringify(isolation.production), productionChecksumBefore, 'Production IndexedDB changed in Test Mode');
  assert.notEqual(isolation.production, isolation.test, 'Production and Test DB must be physically separate');

  const guardResult = await page.evaluate(async () => {
    const { createGuardedSupabaseFetch, TestSandboxCloudWriteBlockedError } = await import('/src/lib/cloudWriteGuard.ts');
    let forwarded = 0;
    const mockFetch = async () => {
      forwarded += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const guardedFetch = createGuardedSupabaseFetch('https://sandbox-test.supabase.co', mockFetch);
    const blocked = [];
    const cases = [
      ['POST', '/rest/v1/product_groups'],
      ['PUT', '/rest/v1/product_groups?id=eq.1'],
      ['PATCH', '/rest/v1/product_groups?id=eq.1'],
      ['DELETE', '/rest/v1/product_groups?id=eq.1'],
      ['POST', '/rest/v1/rpc/test_write'],
      ['POST', '/storage/v1/object/dashboard-category-images/file.png'],
      ['DELETE', '/storage/v1/object/dashboard-category-images/file.png'],
    ];
    for (const [method, path] of cases) {
      try {
        await guardedFetch(`https://sandbox-test.supabase.co${path}`, { method });
      } catch (error) {
        if (error instanceof TestSandboxCloudWriteBlockedError) blocked.push(`${method} ${path}`);
      }
    }
    await guardedFetch('https://sandbox-test.supabase.co/rest/v1/product_groups?select=*', { method: 'GET' });
    await guardedFetch('https://sandbox-test.supabase.co/auth/v1/token?grant_type=refresh_token', { method: 'POST' });
    return { blocked, forwarded };
  });

  assert.equal(guardResult.blocked.length, 7, 'Every REST/RPC/Storage write must be blocked');
  assert.equal(guardResult.forwarded, 2, 'Only read and Auth requests should be forwarded');
  assert.deepEqual(cloudWrites, [], 'No Supabase business write request may leave the browser');

  await page.evaluate(async () => {
    const { clearTestSandboxData } = await import('/src/lib/testSandboxEnvironment.ts');
    await clearTestSandboxData();
  });
  const afterClear = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return {
      production: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db'),
      test: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-test-v1'),
    };
  });
  assert.equal(stableStringify(afterClear.production), productionChecksumBefore, 'Clearing Test DB changed Production DB');
  assert.deepEqual(afterClear.test, {}, 'Test DB was not cleared');

  const productionSwitch = await page.evaluate(async () => {
    const { setProviderMode } = await import('/src/providers/providerMode.ts');
    let confirmations = 0;
    const originalConfirm = window.confirm;
    window.confirm = () => {
      confirmations += 1;
      return true;
    };
    try {
      const switched = setProviderMode('cloud');
      const storedMode = localStorage.getItem('erp_provider_mode');
      localStorage.setItem('erp_provider_mode', 'test');
      return { switched, confirmations, storedMode };
    } finally {
      window.confirm = originalConfirm;
    }
  });
  assert.deepEqual(productionSwitch, { switched: true, confirmations: 2, storedMode: 'cloud' });
  assert.deepEqual(unexpectedConsoleErrors, [], 'Unexpected browser console/page error in Test Mode');

  console.log('PASS Test Sandbox 使用獨立 IndexedDB，Production IndexedDB checksum 不變');
  console.log('PASS REST POST/PUT/PATCH/DELETE、RPC、Storage upload/remove 全部被阻擋');
  console.log('PASS Auth POST 與 REST GET 仍可通過 Guard');
  console.log('PASS 清空 Test Sandbox 不影響 Production IndexedDB');
  console.log('PASS Test → Production 必須通過兩次確認');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
