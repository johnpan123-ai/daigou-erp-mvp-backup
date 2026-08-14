import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4189';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '4189', '--strictPort',
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
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'test'));
const page = await context.newPage();
const supabaseRequests = [];

page.on('request', request => {
  if (request.url().includes('.supabase.co/')) {
    supabaseRequests.push({ method: request.method(), url: request.url() });
  }
});

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.dataProvider));

  assert.equal(await page.title(), '[TEST] 小河馬 ERP');
  const body = await page.locator('body').innerText();
  assert.match(body, /Test Owner/);
  assert.match(body, /OWNER/i);
  assert.match(body, /test-owner@local\.invalid/);

  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.waitForURL(url => url.pathname === '/', { timeout: 5000 });
  assert.equal(await page.locator('input[type="password"]').count(), 0, 'Test Mode exposed the Production login form');

  for (const path of ['/settings', '/purchasing', '/japan-packages', '/outbound-shipments']) {
    await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle' });
    assert.equal(new URL(page.url()).pathname, path, `Test Owner could not access ${path}`);
  }

  await page.reload({ waitUntil: 'networkidle' });
  const reloadedBody = await page.locator('body').innerText();
  assert.match(reloadedBody, /Test Owner/);
  assert.match(reloadedBody, /OWNER/i);
  assert.equal(supabaseRequests.length, 0, `Test Mode made Supabase requests: ${JSON.stringify(supabaseRequests)}`);

  console.log('PASS Test Mode creates local Test Owner without a Production session');
  console.log('PASS Test Owner retains OWNER access after reload');
  console.log('PASS Test Mode Supabase Auth/profile/network requests = 0');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
