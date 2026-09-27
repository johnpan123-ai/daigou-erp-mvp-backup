import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const phase = process.env.LAYOUT_PHASE || 'after';
const selected = process.env.LAYOUT_ROUTES?.split(',');
const mobileBaseline = JSON.parse(readFileSync('tests/fixtures/ui-layout-mobile-baseline.json', 'utf8'));
const cases = [
  ['dashboard', '/dashboard', '.daily-dashboard'],
  ['inventory', '/inventory', '.inventory-container'],
  ['purchase-records', '/purchase-records', '[data-testid="purchase-records-root"]'],
  ['recent-purchases', '/recent-purchases', '[data-testid="recent-purchases-page"]'],
  ['purchasing', '/purchasing', '.mobile-summary-container'],
  ['japan-packages', '/japan-packages', '[data-testid="japan-packages-list-root"]'],
  ['outbound', '/outbound-shipments', '[data-testid="outbound-shipments-list-root"]'],
  ['unlisted', '/unlisted-items', '[data-testid="unlisted-items-root"]'],
  ['duplicates', '/duplicate-variants', '[data-testid="duplicate-variants-root"]'],
].filter(([name]) => !selected || selected.includes(name));
const origin = 'http://127.0.0.1:4388';
const outputDir = `scratch/ui-layout-evidence/${phase}`;
mkdirSync(outputDir, { recursive: true });
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging', '--host', '127.0.0.1', '--port', '4388', '--strictPort'], {
  env: { ...process.env, VITE_DEPLOYMENT_ENV: 'staging', VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co', VITE_SUPABASE_ANON_KEY: 'local-test-no-network' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
vite.stdout.on('data', chunk => { output += chunk; });
vite.stderr.on('data', chunk => { output += chunk; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
const results = [];
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* local server starting */ }
    if (i === 99 || vite.exitCode !== null) throw new Error(output);
    await sleep(200);
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  for (const width of (process.env.LAYOUT_WIDTHS || '1366,1280,390').split(',').map(Number)) {
    for (const [name, route, selector] of cases) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', request => new URL(request.request().url()).origin === origin ? request.continue() : request.abort());
      await page.goto(`${origin}/tests/fixtures/cloud-p0-2-react-harness.html?workflowQuickWins=1&route=${encodeURIComponent(route)}`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
      const root = name === 'purchase-records' && phase === 'before' ? page.locator('.page-content > div').last() : page.locator(selector);
      await root.waitFor();
      await page.screenshot({ path: `${outputDir}/${name}-${width}.png`, fullPage: true });
      const geometry = await root.evaluate(element => {
        const rect = node => { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, right: b.right, height: b.height }; };
        const page = document.querySelector('.page-content');
        const main = document.querySelector('.main-area');
        const header = element.querySelector('[data-workspace-header]');
        const firstContent = header?.nextElementSibling;
        const css = getComputedStyle(element);
        return {
          root: rect(element), available: rect(page), paddingLeft: parseFloat(css.paddingLeft), paddingRight: parseFloat(css.paddingRight),
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1,
          headerToFirstContent: header && firstContent ? firstContent.getBoundingClientRect().top - header.getBoundingClientRect().bottom : null,
          purchaseRefreshInHeader: element.querySelector('[data-workspace-header] .cloud-refresh-control') !== null,
          sections: [...element.querySelectorAll('[data-workspace-header], [data-workspace-stats], [data-workspace-toolbar], [data-workspace-content]')].map(node => ({ kind: node.getAttributeNames().find(a => a.startsWith('data-workspace-')), ...rect(node) })),
          headerCount: element.querySelectorAll('[data-workspace-header]').length,
          contentCount: element.querySelectorAll('[data-workspace-content]').length,
          heading: element.querySelector('[data-workspace-header] h1') ? rect(element.querySelector('[data-workspace-header] h1')) : null,
          stats: [...element.querySelectorAll('[data-workspace-stats] > *')].map(rect),
          sidebarVisible: document.querySelector('.app-sidebar').getBoundingClientRect().right > 0,
        };
      });
      results.push({ name, width, ...geometry });
      if (phase !== 'before' && width >= 768) {
        assert.ok(Math.abs(geometry.root.width - geometry.available.width) <= 1, `${name}/${width}: shell must fill available workspace`);
        assert.equal(geometry.paddingLeft, width < 768 ? 16 : 24, `${name}/${width}: left padding`);
        assert.equal(geometry.paddingRight, geometry.paddingLeft, `${name}/${width}: symmetric padding`);
        assert.equal(geometry.horizontalOverflow, false, `${name}/${width}: page overflow`);
        assert.ok(geometry.headerCount >= 1, `${name}/${width}: shared header`);
        assert.ok(geometry.headerToFirstContent >= 16 && geometry.headerToFirstContent <= 24, `${name}/${width}: shared header-to-content spacing ${geometry.headerToFirstContent}`);
        if (name === 'purchase-records') assert.equal(geometry.purchaseRefreshInHeader, true, `${name}/${width}: refresh is a page-header action`);
        assert.ok(geometry.contentCount >= 1, `${name}/${width}: content shell`);
        const left = geometry.root.x + geometry.paddingLeft;
        const right = geometry.root.right - geometry.paddingRight;
        assert.ok(geometry.heading && geometry.heading.x >= left - 1 && geometry.heading.x <= left + 44, `${name}/${width}: title must be left aligned`);
        for (const section of geometry.sections.filter(s => s.width > 0)) {
          assert.ok(section.x >= left - 1 && section.right <= right + 1, `${name}/${width}: ${section.kind} escapes content`);
        }
        if (width >= 768) assert.equal(geometry.sidebarVisible, true);
        for (const card of geometry.stats) {
          for (const peer of geometry.stats.filter(other => Math.abs(other.y - card.y) < 1)) {
            assert.ok(Math.abs(peer.height - card.height) <= 1, `${name}/${width}: same-row stats height`);
          }
        }
        assert.ok(geometry.sections.some(s => s.kind === 'data-workspace-content' && s.width >= (right - left) * 0.95), `${name}/${width}: full width list shell`);
        if (name === 'purchasing') {
          const title = root.locator('.summary-card .workspace-product-title').first();
          const original = await title.textContent();
          await title.evaluate((node, value) => { node.textContent = value.repeat(12); }, original);
          const before = await root.locator('.workspace-row-actions').first().boundingBox();
          const titleGeometry = await title.evaluate(node => ({ height: node.getBoundingClientRect().height, scrollHeight: node.scrollHeight, lineHeight: parseFloat(getComputedStyle(node).lineHeight), clamp: getComputedStyle(node).webkitLineClamp }));
          assert.equal(titleGeometry.clamp, '2');
          assert.ok(titleGeometry.height <= titleGeometry.lineHeight * 2 + 1);
          assert.ok(titleGeometry.scrollHeight > titleGeometry.height, 'long fixture is genuinely truncated');
          await title.evaluate(node => { node.textContent = '短商品名稱'; });
          const after = await root.locator('.workspace-row-actions').first().boundingBox();
          assert.ok(Math.abs(before.x - after.x) <= 1 && Math.abs(before.width - after.width) <= 1, 'operation column must not be pushed by long titles');
          await title.evaluate((node, value) => { node.textContent = value; }, original);
        }
        if (name === 'inventory') {
          // The legacy harness stubs getInventory, not the newer paired snapshot reader.
          // Supply a read-only snapshot only inside this disposable browser context.
          await page.evaluate(async () => {
            const { dataProvider } = await import('/src/providers/dataProvider.ts');
            const fixture = await fetch('/tests/fixtures/core-regression.json').then(response => response.json());
            fixture.inventory[0].normalized_product_title = '隔離測試商品名稱'.repeat(30);
            dataProvider.getInventoryCatalogSnapshot = async () => ({ inventory: fixture.inventory, productGroups: fixture.productGroups });
          });
          await root.locator('.btn-refresh-inv').click();
          await root.locator('.inventory-list-card table').waitFor();
          await page.screenshot({ path: `${outputDir}/${name}-${width}-populated.png`, fullPage: true });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.querySelector('.main-area').scrollWidth > document.querySelector('.main-area').clientWidth + 1), false, 'populated inventory overflow');
        }
        // Search affects fixture UI only; never edits a ProductGroup or dispatches a write.
        const search = root.getByPlaceholder(/搜尋/).first();
        if (await search.count()) await search.fill('NO_MATCH_LAYOUT_FIXTURE_8e2d');
        else if (name === 'dashboard') await root.locator('.daily-task-card').last().click();
        await page.waitForTimeout(350);
        await page.screenshot({ path: `${outputDir}/${name}-${width}-empty.png`, fullPage: true });
        const empty = await root.evaluate(element => ({
          overflow: document.documentElement.scrollWidth > innerWidth + 1 || document.querySelector('.main-area').scrollWidth > document.querySelector('.main-area').clientWidth + 1,
          emptyHeight: element.querySelector('.workspace-empty')?.getBoundingClientRect().height ?? null,
        }));
        assert.equal(empty.overflow, false, `${name}/${width}: empty-state overflow`);
        if (empty.emptyHeight !== null) assert.ok(empty.emptyHeight < 280, `${name}/${width}: compact empty state`);
        results.at(-1).empty = empty;
      }
      if (phase !== 'before' && width === 390) {
        const original = mobileBaseline.pages[name];
        assert.equal(geometry.root.x, mobileBaseline.rootX, `${name}: original mobile left edge`);
        assert.equal(geometry.root.width, mobileBaseline.rootWidth, `${name}: original mobile width`);
        assert.equal(geometry.paddingLeft, original.padding, `${name}: original mobile padding`);
        assert.equal(geometry.paddingRight, original.padding, `${name}: original mobile padding`);
        assert.ok(Math.abs(geometry.root.height - original.height) <= 1, `${name}: original mobile height ${original.height}, actual ${geometry.root.height}`);
        assert.equal(geometry.horizontalOverflow, false, `${name}: no new mobile overflow`);
        assert.equal(await root.evaluate(element => element.classList.contains('workspace-page')), false, `${name}: desktop workspace styling must not apply to mobile`);
      }
      assert.deepEqual(errors, [], `${name}/${width}: runtime errors`);
      assert.equal(await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().writes), 0);
      console.log(JSON.stringify({ name, width, phase, contentWidth: geometry.root.width, horizontalOverflow: geometry.horizontalOverflow }));
      await context.close();
    }
  }
} finally {
  writeFileSync(`${outputDir}/geometry.json`, JSON.stringify(results, null, 2));
  await browser?.close();
  vite.kill('SIGTERM');
}
