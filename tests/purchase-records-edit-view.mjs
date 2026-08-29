import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  capturePurchaseRecordsEditView,
  resolvePurchaseRecordsEditView,
} from '../src/lib/purchaseRecordsEditView.ts';

const originalMain = [{ id: 'closed-a', title: 'old title', version: 1 }];
const snapshot = capturePurchaseRecordsEditView(originalMain, []);
const latestGroups = [
  { id: 'closed-a', title: 'Realtime latest title', version: 2 },
  { id: 'newly-reclassified', title: 'Must wait until edit exit', version: 4 },
];
assert.deepEqual(snapshot, { mainGroupIds: ['closed-a'], completedGroupIds: [] });
assert.deepEqual(
  resolvePurchaseRecordsEditView(snapshot.mainGroupIds, latestGroups),
  [latestGroups[0]],
  'Pinned edit position must use the latest row object/version without admitting reclassified rows',
);

const PORT = 4287;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const vite = spawn(process.execPath, [VITE, '--mode', 'experimental', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForVite() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try { if ((await fetch(BASE_URL)).ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
}

let browser;
try {
  await waitForVite();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const supabaseRequests = [];
  const pageErrors = [];
  page.on('request', request => {
    if (/\.supabase\.co\//iu.test(request.url())) supabaseRequests.push(request.url());
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const { dataProvider } = await import('/src/providers/dataProvider.ts');
    const base = (id, title, closingDate) => ({
      id,
      title,
      normalized_title: title,
      purchase_date: '2026/08/01',
      priority: 'Medium',
      closing_date: closingDate,
      release_month: '2026/10',
      has_official_site: false,
      product_url: '',
      listing_type: '一般預購',
      source_type: 'direct',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    });
    await dataProvider.saveProductGroups([
      base('closed-a', 'Expired Product A', '2026/08/20'),
      base('progress-b', 'Progress Product B', '2026/09/20'),
    ]);
    await dataProvider.saveProductVariants([
      { id: 'variant-a', product_group_id: 'closed-a', product_title: 'Expired Product A', variant_name: '單品', myacg_item_code: 'EDIT-A', sort_order: 0 },
      { id: 'variant-b', product_group_id: 'progress-b', product_title: 'Progress Product B', variant_name: '單品', myacg_item_code: 'EDIT-B', sort_order: 0 },
    ]);
  });

  await page.goto(`${BASE_URL}/purchase-records`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^已結單/u }).click();
  const expiredRow = page.getByRole('row').filter({ hasText: 'Expired Product A' });
  await expiredRow.waitFor();
  await page.getByTestId('purchase-records-edit-mode-toggle').click();
  assert.equal(await expiredRow.count(), 1, 'Entering edit mode must preserve the current closed row');
  const closingInput = expiredRow.locator('input[data-field="closing_date"]');
  await closingInput.fill('');
  await closingInput.blur();
  await page.waitForFunction(async () => {
    const { dataProvider } = await import('/src/providers/dataProvider.ts');
    const groups = await dataProvider.getProductGroups();
    return groups.find(group => group.id === 'closed-a')?.closing_date === '';
  });
  assert.equal(await expiredRow.count(), 1, 'Cleared row must remain in its pinned closed list while edit mode is active');
  assert.equal(await page.getByTestId('closing-date-save-error').count(), 0, 'Successful row save must not show an error');

  await page.getByTestId('purchase-records-edit-mode-toggle').click();
  await expiredRow.waitFor({ state: 'detached' });
  assert.equal(await expiredRow.count(), 0, 'Leaving edit mode must reclassify from the latest saved closing date');
  assert.deepEqual(supabaseRequests, [], 'Experimental local regression must not call Supabase');
  assert.deepEqual(pageErrors, [], `Unexpected browser errors: ${JSON.stringify(pageErrors)}`);

  console.log('PASS clearing a closing date saves immediately but keeps the row pinned during edit mode');
  console.log('PASS leaving edit mode reclassifies from the latest persisted data');
  console.log('PASS pinned identity resolves latest row content/version and does not snapshot data');
  console.log('PASS Production/Preview Supabase requests = 0');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
  await Promise.race([new Promise(resolve => vite.once('exit', resolve)), sleep(2_000)]);
}
