import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { chromium } from 'playwright';

const source = readFileSync('src/lib/outboundDisplaySort.ts', 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { sortOutboundDisplayGroups } = await import(`data:text/javascript,${encodeURIComponent(output)}`);
const items = [
  { id: 'ten', sku: 'SKU10', name: 'B', checked: true },
  { id: 'missing', sku: '', name: 'A', checked: false },
  { id: 'two', sku: 'SKU2', name: 'C', checked: false },
];
const groups = items.map(item => ({ groupName: item.name, items: [item] }));
const skuOf = item => item.sku;
const nameOf = item => item.name;
assert.deepEqual(sortOutboundDisplayGroups(groups, 'original', false, skuOf, nameOf).map(group => group.items[0].id), ['ten', 'missing', 'two']);
assert.deepEqual(sortOutboundDisplayGroups(groups, 'sku', false, skuOf, nameOf).map(group => group.items[0].id), ['two', 'ten', 'missing']);
assert.deepEqual(sortOutboundDisplayGroups(groups, 'name', false, skuOf, nameOf).map(group => group.items[0].id), ['missing', 'ten', 'two']);
assert.deepEqual(groups.map(group => group.items[0].id), ['ten', 'missing', 'two'], 'source order was not mutated');
assert.equal(items[0].checked, true, 'checkbox state was not mutated');

const origin = 'http://127.0.0.1:4391';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging', '--host', '127.0.0.1', '--port', '4391', '--strictPort'], {
  env: { ...process.env, VITE_DEPLOYMENT_ENV: 'staging', VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co', VITE_SUPABASE_ANON_KEY: 'local-test-no-network' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let outputLog = '';
vite.stdout.on('data', data => { outputLog += data; });
vite.stderr.on('data', data => { outputLog += data; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    if (i === 79 || vite.exitCode !== null) throw new Error(outputLog);
    await sleep(250);
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  for (const width of [1366, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const fixtureHtml = await fetch(origin + '/tests/fixtures/cloud-p0-2-react-harness.html').then(response => response.text());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (route.request().isNavigationRequest() && !url.pathname.startsWith('/tests/')) {
        return route.fulfill({ contentType: 'text/html', body: fixtureHtml });
      }
      return route.continue();
    });
    await page.goto(origin + '/tests/fixtures/cloud-p0-2-react-harness.html?route=/outbound-shipments/out-react-1&outboundReceiving=1', { waitUntil: 'networkidle' });
    await page.getByTestId('outbound-shipment-detail-root').waitFor();
    const header = page.getByTestId('outbound-page-header-actions');
    assert.equal(await header.getByRole('button', { name: '刪除出庫單' }).count(), 1);
    assert.equal(await page.getByTestId('outbound-item-display-sort').inputValue(), 'original');
    const before = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes);
    await page.getByTestId('outbound-item-display-sort').selectOption('sku');
    await page.getByTestId('outbound-item-display-sort').selectOption('name');
    await page.getByTestId('outbound-item-display-sort').selectOption('original');
    assert.equal(await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes), before, 'display sort caused a business write');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'horizontal overflow');
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/outbound-shipments'));
    const listTitle = page.getByRole('heading', { name: '出庫管理' });
    await listTitle.waitFor();
    assert.equal(await listTitle.locator('svg[aria-hidden="true"]').count(), 1, 'Outbound list title uses a leading icon');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS outbound natural SKU/name/original display order, stable fallback, no mutation, header delete placement and list icon, 1366/1280');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
