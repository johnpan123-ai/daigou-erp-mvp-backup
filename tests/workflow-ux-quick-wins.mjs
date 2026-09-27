import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const root = process.cwd();
const origin = 'http://127.0.0.1:4377';
let fixtureHtml;
const base = 'e565d067f49c95cf71dd6c95c5fab5b4749558f8';
// Presentation must not change query, ranking, traffic, safety, or restore contracts.
for (const file of [
  'src/lib/closingDateCandidateRetrievalV2.ts',
  'src/lib/cloudClosingDateWorkbenchApply.ts',
  'src/lib/closingDateWorkbenchAtomicApply.ts',
  'src/providers/dataProvider.ts', 'src/providers/cloud/supabaseProvider.ts',
  'src/providers/cloud/cloudAtomicRestore.ts',
  'src/providers/cloud/cloudRestoreRpcTransport.ts',
  'src/components/CloudAtomicRestorePanel.tsx',
]) {
  assert.equal(readFileSync(file, 'utf8').replaceAll('\r\n', '\n'),
    execFileSync('git', ['show', base + ':' + file], { encoding: 'utf8' }).replaceAll('\r\n', '\n'), file);
}
const workbenchSource = readFileSync('src/components/closingDateResolution/ClosingDateResolutionWorkbench.tsx', 'utf8');
assert.match(workbenchSource, /title: group.title,/u, 'Analysis still receives original title, not display name');

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging', '--host', '127.0.0.1', '--port', '4377', '--strictPort'], {
  cwd: root,
  env: { ...process.env, VITE_DEPLOYMENT_ENV: 'staging', VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co', VITE_SUPABASE_ANON_KEY: 'local-test-no-network' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
vite.stdout.on('data', data => { output += data; });
vite.stderr.on('data', data => { output += data; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    if (i === 79 || vite.exitCode !== null) throw new Error(output);
    await sleep(250);
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  fixtureHtml = await fetch(origin + '/tests/fixtures/cloud-p0-2-react-harness.html').then(response => response.text());
  mkdirSync('scratch/workflow-ux-evidence', { recursive: true });
  for (const width of [1366, 1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
    const page = await context.newPage();
    const errors = [], upstream = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith('/api/catalog/')) {
        upstream.push(url.pathname + url.search);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ schemaVersion: 'deadline-v1', status: 'NOT_FOUND', reason: 'no_candidates', candidates: [], query: url.searchParams.get('q') }) });
      }
      if (request.isNavigationRequest() && !url.pathname.startsWith('/tests/')) {
        return route.fulfill({ contentType: 'text/html', body: fixtureHtml });
      }
      return route.continue();
    });
    await page.goto(origin + '/tests/fixtures/cloud-p0-2-react-harness.html?workflowQuickWins=1&route=/unlisted-items', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__P0_REACT_HARNESS__);
    const expected = await page.evaluate(() => window.__P0_REACT_HARNESS__.server.productGroups.find(g => g.id === 'g-holo').normalized_title);
    const link = page.locator('a[href="/purchase-records/g-holo"]:visible');
    await link.waitFor();
    assert.match(await link.innerText(), /查看訂購紀錄/u);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Pending delist must not overflow');
    await link.click();
    const title = page.getByTestId('purchase-group-detail-title');
    await title.waitFor();
    assert.ok((await title.textContent()).includes(expected));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Purchase Records must not overflow');
    assert.equal(new URL(page.url()).pathname, '/purchase-records/g-holo');
    // Real reload, while serving the isolated App fixture at the same URL.
    await page.reload({ waitUntil: 'networkidle' });
    await title.waitFor();
    assert.ok((await title.textContent()).includes(expected));
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.locator('a[href="/purchase-records/g-holo"]:visible').waitFor();
    assert.equal(new URL(page.url()).pathname, '/unlisted-items');
    await page.goForward({ waitUntil: 'domcontentloaded' });
    await title.waitFor();
    assert.ok((await title.textContent()).includes(expected));
    assert.equal(await page.getByRole('button', { name: '重新載入最新資料', exact: true }).count(), width < 768 ? 1 : 0);
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records/missing'));
    await page.getByTestId('purchase-group-not-found').waitFor();
    assert.equal(await page.getByTestId('purchase-group-detail-title').count(), 0);
    assert.equal(new URL(page.url()).pathname, '/purchase-records/missing');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByTestId('purchase-group-not-found').waitFor();
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records?productGroup=g-holo'));
    await page.getByTestId('purchase-records-group-scope').waitFor();
    // Cloud-only Workbench entry, still backed exclusively by isolated provider.
    await page.evaluate(() => localStorage.setItem('erp_provider_mode', 'cloud'));
    await page.getByTestId('purchase-record-select-g-holo').locator('visible=true').check();
    await page.getByTestId('open-closing-date-workbench').click();
    await page.getByTestId('closing-date-workbench-analyze').click();
    await page.getByTestId('closing-date-result-g-holo').waitFor({ timeout: 30000 });
    assert.equal(await page.getByTestId('closing-date-product-title').textContent(), expected);
    assert.equal(await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes), 0);
    assert.ok(upstream.length > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: 'scratch/workflow-ux-evidence/workbench-' + width + '.png' });
    await page.getByTestId('closing-date-workbench-close').click();
    // ID scopes override unrelated stored filters and pinning, never name-match.
    await page.getByTestId('purchase-records-edit-mode-toggle').click();
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records?productGroup=missing'));
    await page.waitForFunction(() => document.querySelector('[data-testid="purchase-records-group-scope"]')?.textContent.includes('找不到'));
    const hiddenSelectionAction = page.getByTestId('open-closing-date-workbench');
    assert.equal(await hiddenSelectionAction.count() > 0 && await hiddenSelectionAction.isEnabled(), false, 'Invalid scope cannot analyze a hidden previous selection');
    assert.equal(await page.locator('[data-testid="purchase-record-product-title"]:visible').count(), 0);
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records?productGroup=g-holo&productGroup=g-other'));
    assert.equal(await page.locator('[data-testid="purchase-record-product-title"]:visible').count(), 0);
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records?productGroup='));
    assert.equal(await page.locator('[data-testid="purchase-record-product-title"]:visible').count(), 0);
    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/japan-packages/jp-react-1'));
    const copy = page.getByTestId('copy-japan-package-group-g-holo');
    await copy.waitFor();
    assert.equal(await copy.textContent(), '複製商品名稱');
    const box = await copy.boundingBox();
    assert.ok(box.height >= (width < 768 ? 44 : 32) && box.x >= 0 && box.x + box.width <= width + 1);
    await page.evaluate(() => {
      window.__copiedProductName = null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedProductName = text; } } });
    });
    await copy.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="copy-japan-package-group-g-holo"]')?.textContent === '✓ 已複製');
    assert.equal(await page.evaluate(() => window.__copiedProductName), expected);
    await page.waitForFunction(() => document.querySelector('[data-testid="copy-japan-package-group-g-holo"]')?.textContent === '複製商品名稱');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('fixture denied'); } } }));
    await copy.click();
    await page.getByRole('status').filter({ hasText: '複製失敗' }).waitFor();
    assert.equal(await copy.textContent(), '複製商品名稱');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.equal(await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes), 0);
    await page.screenshot({ path: 'scratch/workflow-ux-evidence/japan-' + width + '.png' });
    const helper = await page.evaluate(async () => {
      const m = await import('/src/lib/productGroupDisplayName.ts');
      return {
        fallback: m.productGroupDisplayName({ title: '原始名稱', normalized_title: '' }),
        preserved: m.productGroupDisplayName({ title: 'raw', normalized_title: '【保留】 預購' }),
        id: m.purchaseRecordsGroupScope('?productGroup=A%2FB%20%26C'),
        url: m.purchaseRecordsGroupUrl('A/B &C'),
        detailUrl: m.purchaseRecordsDetailUrl('A/B &C'),
      };
    });
    assert.deepEqual(helper, { fallback: '原始名稱', preserved: '【保留】 預購', id: 'A/B &C', url: '/purchase-records?productGroup=A%2FB+%26C', detailUrl: '/purchase-records/A%2FB%20%26C' });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, titleParity: 'PASS', reload: 'PASS', backForward: 'PASS', invalidId: 'PASS', clipboard: 'success/failure PASS', touchHeight: box.height, overflow: false, analysisWrites: 0, fixtureCatalogQueries: upstream.length }));
    await context.close();
  }
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
