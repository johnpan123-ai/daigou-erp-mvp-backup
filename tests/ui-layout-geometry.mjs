import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const phase = process.env.LAYOUT_PHASE || 'after';
const selected = process.env.LAYOUT_ROUTES?.split(',');
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
  for (const width of [1366, 1280, 390]) {
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
        const css = getComputedStyle(element);
        return {
          root: rect(element), available: rect(page), paddingLeft: parseFloat(css.paddingLeft), paddingRight: parseFloat(css.paddingRight),
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1,
          sections: [...element.querySelectorAll('[data-workspace-header], [data-workspace-stats], [data-workspace-toolbar], [data-workspace-content]')].map(node => ({ kind: node.getAttributeNames().find(a => a.startsWith('data-workspace-')), ...rect(node) })),
          headerCount: element.querySelectorAll('[data-workspace-header]').length,
          contentCount: element.querySelectorAll('[data-workspace-content]').length,
          sidebarVisible: document.querySelector('.app-sidebar').getBoundingClientRect().right > 0,
        };
      });
      results.push({ name, width, ...geometry });
      if (phase !== 'before') {
        assert.ok(Math.abs(geometry.root.width - geometry.available.width) <= 1, `${name}/${width}: shell must fill available workspace`);
        assert.equal(geometry.paddingLeft, width < 768 ? 16 : 24, `${name}/${width}: left padding`);
        assert.equal(geometry.paddingRight, geometry.paddingLeft, `${name}/${width}: symmetric padding`);
        assert.equal(geometry.horizontalOverflow, false, `${name}/${width}: page overflow`);
        assert.ok(geometry.headerCount >= 1, `${name}/${width}: shared header`);
        assert.ok(geometry.contentCount >= 1, `${name}/${width}: content shell`);
        const left = geometry.root.x + geometry.paddingLeft;
        const right = geometry.root.right - geometry.paddingRight;
        for (const section of geometry.sections.filter(s => s.width > 0)) {
          assert.ok(section.x >= left - 1 && section.right <= right + 1, `${name}/${width}: ${section.kind} escapes content`);
        }
        if (width >= 768) assert.equal(geometry.sidebarVisible, true);
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
