import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';

// A disposable browser context owns all fixture writes. The regular NEXT
// profile and every Cloud transport remain untouched.
const origin = 'http://127.0.0.1:4396';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'next',
  '--host', '127.0.0.1', '--port', '4396', '--strictPort', '--configLoader', 'runner'], {
  env: { ...process.env, VITE_DEPLOYMENT_ENV: 'next' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
vite.stdout.on('data', bytes => { output += bytes; });
vite.stderr.on('data', bytes => { output += bytes; });
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* startup */ }
    if (attempt === 79 || vite.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 900 } });
  let cloudRequests = 0;
  await context.route('**/*.supabase.co/**', route => { cloudRequests++; return route.abort(); });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/waca');
  await page.waitForFunction(() => Boolean(window.dataProvider));
  const audit = { productVariantId: 'deleted-audit-variant', sku: 'G-OLD', productTitle: '歷史商品',
    variantTitle: '歷史規格', legacyWacaQuantity: 8, legacyAutoQuantity: 8,
    unverifiedPreCutoverManualQuantity: 0, newOrderDerivedQuantity: 0, difference: -8,
    cutoverAt: '2026-09-28T00:00:00Z' };
  const backup = Object.fromEntries(['inventory', 'salesOrders', 'salesOrderItems', 'productGroups',
    'productCategories', 'productVariants', 'purchaseBatches', 'purchaseBatchItems', 'privateOrders',
    'privateOrderItems', 'japanPackages', 'japanPackageItems', 'outboundShipments', 'outboundShipmentItems',
    'bundleComponents', 'importBatches', 'wacaOrders', 'wacaItems', 'wacaMappings', 'wacaImportBatches',
    'myacgMasterLinks', 'dashboardCategoryImages', 'deadlineVerifiedMappings', 'deadlineApplyBatches',
    'deadlineApplyItems'].map(key => [key, []]));
  const group = { id: 'existing-group', title: '既有商品', purchase_date: '', priority: 'Low',
    closing_date: '', release_month: '', has_official_site: false, product_url: '', created_at: '', updated_at: '' };
  const variant = { id: 'existing-variant', product_group_id: group.id, myacg_item_code: 'G-EXISTING',
    product_title: group.title, variant_name: '標準規格', raw_variant_name: '標準規格', note: '', sort_order: 0,
    waca_auto_quantity: 0, waca_manual_adjustment: 0 };
  Object.assign(backup, { backupFormatVersion: 2, productGroups: [group], productVariants: [variant],
    dashboardCategoryImages: ['all', 'hololive', 'vspo', 'agency', 'other'].map(categoryKey => ({ categoryKey, dataUrl: '' })),
    wacaCutoverAudit: [audit], wacaCutoverState: [{ mode: 'ORDER_DRIVEN_ACTIVE',
      updatedAt: '2026-09-28T00:00:00Z', sourceBackupFormatVersion: 2 }],
    inventory: [
      { myacg_item_code: 'G-EXISTING', myacg_parent_code: 'GP-EXISTING', product_title: group.title,
        raw_variant_name: variant.variant_name, listing_type: '', final_price: 100, myacg_sold_quantity: 0 },
      { myacg_item_code: 'G-CAP', myacg_parent_code: 'GP-CAP', product_title: '胡桃誕生日記念',
        raw_variant_name: '棒球帽', listing_type: '', final_price: 100, myacg_sold_quantity: 0 },
    ] });
  assert.equal(await page.evaluate(value => window.dataProvider.importData(JSON.stringify(value)), backup), true,
    'modern NEXT restore accepts and preserves historical orphan cutover audit');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('input[aria-label="選擇 WACA Excel"]')?.disabled === false);
  assert.equal(await page.getByRole('alert').count(), 0);
  const headers = ['訂單狀態', '訂單編號', '購買日期', '商品編號', '品名', '多規格名稱一',
    '多規格名稱二', '規格編號', '訂單商品數量', '小計'];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers.map(() => '訂單資訊'), headers,
    ['完成付款', 'ORDER-EXISTING', '2026-10-01', 'GP-EXISTING', group.title, variant.variant_name, '', 'G-EXISTING', 2, 200],
    ['處理中', 'ORDER-CAP', '2026-10-01', 'GP-CAP', '胡桃誕生日記念', '棒球帽', '', 'G-CAP', 1, 100],
  ]), 'orders');
  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const upload = async () => {
    await page.getByLabel('選擇 WACA Excel').setInputFiles({ name: 'cap-and-existing.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    await page.getByRole('heading', { name: '匯入預覽：cap-and-existing.xlsx' }).waitFor();
  };
  const confirm = async () => {
    await page.getByRole('button', { name: '確認更新' }).click();
    await page.getByRole('dialog', { name: 'WACA 更新完成' }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '確定' }).click();
  };
  const read = () => page.evaluate(async () => ({
    snapshot: await window.dataProvider.getNextWacaSnapshot(),
    variants: await window.dataProvider.getAuthoritativeWacaVariants(),
  }));
  await upload();
  assert.equal(await page.getByRole('button', { name: '確認更新' }).isEnabled(), true);
  await confirm();
  await page.getByRole('status').filter({ hasText: '保留為待處理' }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0, 'pending is a saved result, not an import failure');
  let saved = await read();
  assert.equal(saved.snapshot.orders.length, 2);
  assert.equal(saved.snapshot.items.length, 2);
  assert.equal(saved.variants.find(row => row.id === variant.id).waca_auto_quantity, 2);
  assert.equal(saved.snapshot.items.find(row => row.productCode === 'GP-CAP').productVariantId, null);
  assert.deepEqual(saved.snapshot.cutoverAudit, [audit]);
  const pendingBackup = await page.evaluate(async () => {
    const { collectWorkbenchBackupData } = await import('/src/lib/workbenchJsonBackup.ts');
    return collectWorkbenchBackupData(window.dataProvider);
  });
  const restoredContext = await browser.newContext();
  await restoredContext.route('**/*.supabase.co/**', route => route.abort());
  const restored = await restoredContext.newPage();
  await restored.goto(origin + '/waca');
  await restored.waitForFunction(() => Boolean(window.dataProvider));
  assert.equal(await restored.evaluate(value => window.dataProvider.importData(JSON.stringify(value)), pendingBackup), true);
  const restoredLedger = await restored.evaluate(() => window.dataProvider.getNextWacaSnapshot());
  assert.deepEqual(restoredLedger.cutoverAudit, [audit]);
  assert.equal(restoredLedger.items.filter(row => !row.productVariantId).length, 1);
  await restoredContext.close();

  // The user adds the missing Product Master. WACA owns the next atomic rematch;
  // no historical Excel upload is required.
  await page.evaluate(async ({ group, variant }) => {
    await window.dataProvider.saveProductGroups([{ ...group, id: 'cap-group', title: '胡桃誕生日記念' }]);
    await window.dataProvider.saveProductVariants([{ ...variant, id: 'cap-variant', product_group_id: 'cap-group',
      myacg_item_code: 'G-CAP', product_title: '胡桃誕生日記念', variant_name: '棒球帽', raw_variant_name: '棒球帽' }]);
  }, { group, variant });
  saved = await read();
  assert.equal(saved.variants.find(row => row.id === 'cap-variant').waca_auto_quantity, 0);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('input[aria-label="選擇 WACA Excel"]')?.disabled === false);
  await page.getByRole('status').filter({ hasText: '歷史待處理資料' }).waitFor();
  saved = await read();
  assert.equal(saved.variants.find(row => row.id === 'cap-variant').waca_auto_quantity, 1);
  assert.equal(saved.variants.find(row => row.id === variant.id).waca_auto_quantity, 2);
  assert.equal(saved.snapshot.items.find(row => row.productCode === 'GP-CAP').productVariantId, 'cap-variant');
  assert.deepEqual(saved.snapshot.cutoverAudit, [audit]);
  assert.equal(saved.snapshot.orders.length, 2);
  assert.equal(saved.snapshot.items.length, 2);
  for (let attempt = 0; attempt < 5; attempt++) {
    await upload();
    assert.equal(await page.locator('.waca-group').count(), 0, 'repeat import produces no quantity changes');
    await confirm();
    await page.getByRole('status').filter({ hasText: 'WACA 更新完成' }).waitFor();
    saved = await read();
    assert.equal(saved.variants.find(row => row.id === 'cap-variant').waca_auto_quantity, 1);
  }
  await page.goto(origin + '/purchase-records');
  await page.getByRole('row').filter({ hasText: '胡桃誕生日記念' }).first().waitFor();
  assert.match(await page.getByRole('row').filter({ hasText: '胡桃誕生日記念' }).first().innerText(), /\b1\b/);
  assert.equal(cloudRequests, 0, 'NEXT must never contact Supabase');
  assert.deepEqual(errors, []);
  console.log('PASS orphan cutover read/restore, mixed import, pending preservation, Product Master add + automatic historical rematch 0→1 without reupload, 5x idempotency, Purchase Records and zero Cloud requests');
  await context.close();
} finally {
  await browser?.close();
  vite.kill();
}
