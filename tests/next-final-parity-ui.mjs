import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { chromium } from 'playwright';

const source = readFileSync('src/lib/outboundDisplaySort.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { sortOutboundDisplayGroups } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
const products = [
  { id: 'ten', sku: 'SKU10', name: 'B', checked: true },
  { id: 'missing', sku: '', name: 'A', checked: false },
  { id: 'two', sku: 'SKU2', name: 'C', checked: false },
];
const groups = products.map(item => ({ groupName: item.name, items: [item] }));
const skuOf = item => item.sku;
const nameOf = item => item.name;
assert.deepEqual(sortOutboundDisplayGroups(groups, 'original', false, skuOf, nameOf).map(group => group.items[0].id), ['ten', 'missing', 'two']);
assert.deepEqual(sortOutboundDisplayGroups(groups, 'sku', false, skuOf, nameOf).map(group => group.items[0].id), ['two', 'ten', 'missing']);
assert.deepEqual(sortOutboundDisplayGroups(groups, 'name', false, skuOf, nameOf).map(group => group.items[0].id), ['missing', 'ten', 'two']);
assert.deepEqual(groups.map(group => group.items[0].id), ['ten', 'missing', 'two']);
assert.equal(products[0].checked, true);

const origin = 'http://127.0.0.1:4391';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'next', '--host', '127.0.0.1', '--port', '4391', '--strictPort'], {
  env: { ...process.env, VITE_DEPLOYMENT_ENV: 'next', VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co', VITE_SUPABASE_ANON_KEY: 'local-test-no-network' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
vite.stdout.on('data', bytes => { output += bytes; });
vite.stderr.on('data', bytes => { output += bytes; });
let browser;
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    if (i === 79 || vite.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const fixtureHtml = await fetch(origin + '/tests/fixtures/cloud-p0-2-react-harness.html').then(response => response.text());
  for (const width of [1366, 1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-TW' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/tests/fixtures/core-regression.json') {
        const response = await route.fetch();
        const fixture = await response.json();
        const group = fixture.productGroups.find(row => row.id === 'g-holo');
        group.closing_date = '2020-01-01';
        group.normalized_title = 'NEXT fixture product';
        return route.fulfill({ response, json: fixture });
      }
      if (route.request().isNavigationRequest() && !url.pathname.startsWith('/tests/')) {
        return route.fulfill({ contentType: 'text/html', body: fixtureHtml });
      }
      return route.continue();
    });
    await page.goto(origin + '/tests/fixtures/cloud-p0-2-react-harness.html?providerMode=next&route=/outbound-shipments/out-react-1&outboundReceiving=1', { waitUntil: 'networkidle' });
    await page.getByTestId('outbound-shipment-detail-root').waitFor();
    assert.equal(await page.getByTestId('outbound-page-header-actions').getByRole('button', { name: '刪除出庫單' }).count(), 1);
    const sort = page.getByTestId('outbound-item-display-sort');
    assert.equal(await sort.inputValue(), 'original');
    const before = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes);
    for (const mode of ['sku', 'name', 'original']) await sort.selectOption(mode);
    assert.equal(await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes), before);
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/outbound-shipments'));
    const title = page.getByRole('heading', { name: '出庫管理' });
    await title.waitFor();
    assert.equal(await title.locator('svg[aria-hidden="true"]').count(), 1);
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/unlisted-items'));
    const link = page.locator('a[href="/purchase-records/g-holo"]:visible');
    await link.waitFor();
    await link.click();
    const detail = page.getByTestId('purchase-group-detail-title');
    await detail.waitFor();
    assert.equal(new URL(page.url()).pathname, '/purchase-records/g-holo');
    assert.ok((await detail.textContent()).includes('NEXT fixture product'));
    assert.equal(await page.getByRole('button', { name: '重新載入最新資料', exact: true }).count(), width < 768 ? 1 : 0);
    await page.reload({ waitUntil: 'networkidle' });
    await detail.waitFor();
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await link.waitFor();
    await page.goForward({ waitUntil: 'domcontentloaded' });
    await detail.waitFor();
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records/missing'));
    await page.getByTestId('purchase-group-not-found').waitFor();
    assert.equal(await page.getByTestId('purchase-group-detail-title').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS NEXT shared UI parity ${width}: outbound sort/header, direct detail F5/back/forward/invalid ID, no write/overflow`);
  }
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
