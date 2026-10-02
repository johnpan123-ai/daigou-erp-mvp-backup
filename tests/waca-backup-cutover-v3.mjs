import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:4395';
const fixture = JSON.parse(readFileSync('tests/fixtures/core-regression.json', 'utf8'));
assert.ok(fixture.productVariants.length > 0);
const targetId = fixture.productVariants[0].id;
fixture.productVariants = fixture.productVariants.map(row => row.id === targetId
  ? { ...row, waca_auto_quantity: 8, waca_manual_adjustment: 0 } : row);
for (const key of ['wacaOrders', 'wacaItems', 'wacaMappings', 'wacaImportBatches',
  'myacgMasterLinks', 'wacaCutoverAudit', 'wacaCutoverState', 'backupFormatVersion']) delete fixture[key];

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'next',
  '--host', '127.0.0.1', '--port', '4395', '--strictPort', '--configLoader', 'runner'], {
  env: { ...process.env, VITE_DEPLOYMENT_ENV: 'next', VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'isolated-test-no-network' }, stdio: ['ignore', 'pipe', 'pipe'],
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
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME ||
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/*.supabase.co/**', route => route.abort());
  await page.goto(origin + '/waca', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.dataProvider));
  const legacy = await page.evaluate(async ({ backup, id }) => {
    const provider = window.dataProvider;
    const restored = await provider.importData(JSON.stringify(backup));
    const first = await provider.getNextWacaSnapshot();
    const variantBefore = (await provider.getProductVariants({ raw: true })).find(row => row.id === id);
    const feature = JSON.stringify(['G-TARGET', 'TEST', 'SPEC', '']);
    const orderKey = 'WACA::CUTOVER-1';
    const next = { ...first,
      orders: [{ key: orderKey, orderNumber: 'CUTOVER-1', status: '完成付款', purchasedAt: '2026-09-28' }],
      items: [{ key: `${orderKey}::${feature}`, orderKey, feature, productCode: 'G-TARGET',
        productTitle: 'TEST', spec1: 'SPEC', spec2: '', specCode: '', quantity: 11, subtotal: 110,
        productVariantId: id, match: 'MANUAL_MATCH', diagnostic: null }],
      mappings: [{ feature, myacgMainId: 'GP-TARGET', myacgVariantId: 'G-TARGET',
        productVariantId: id, method: 'MANUAL', confirmedAt: '2026-09-28',
        historicalProductTitle: 'TEST', historicalVariantTitle: 'SPEC', masterStatus: 'ACTIVE' }],
    };
    await provider.commitNextWacaSnapshot(next, first.revision, true);
    const after = await provider.getNextWacaSnapshot();
    const variantAfter = (await provider.getProductVariants({ raw: true })).find(row => row.id === id);
    await provider.commitNextWacaSnapshot(after, after.revision, true);
    const repeat = (await provider.getProductVariants({ raw: true })).find(row => row.id === id);
    const { saveDashboardCategoryImage } = await import('/src/lib/dashboardImageStore.ts');
    await saveDashboardCategoryImage('hololive', 'data:image/png;base64,AAAA');
    const { restoreDeadlineDurableBackup } = await import('/src/lib/closingDateSidecarBackup.ts');
    await restoreDeadlineDurableBackup('next', {
      deadlineVerifiedMappings: [{ id: 'mapping-1', erpProductGroupId: 'group-1', sourceIdentityKey: 'source-1', mapping: { id: 'mapping-1' } }],
      deadlineApplyBatches: [{ id: 'apply-1', idempotencyKey: 'apply-key-1', resolutionBatchId: 'batch-1', itemIds: ['item-1'], audit: { id: 'apply-1' } }],
      deadlineApplyItems: [{ id: 'item-1', applyBatchId: 'apply-1', resolutionResultId: 'result-1', itemOrder: 0, audit: { id: 'item-1' } }],
    });
    const { collectWorkbenchBackupData } = await import('/src/lib/workbenchJsonBackup.ts');
    const modern = await collectWorkbenchBackupData(provider);
    return { restored, state: first.cutoverState?.mode, before: variantBefore.waca_auto_quantity,
      after: variantAfter.waca_auto_quantity, manual: variantAfter.waca_manual_adjustment,
      audit: after.cutoverAudit.find(row => row.productVariantId === id),
      repeat: repeat.waca_auto_quantity, modern };
  }, { backup: fixture, id: targetId });
  assert.equal(legacy.restored, true);
  assert.equal(legacy.state, 'ORDER_REBASELINE_REQUIRED');
  assert.equal(legacy.before, 8);
  assert.equal(legacy.after, 11);
  assert.equal(legacy.manual, 0);
  assert.equal(legacy.audit.legacyWacaQuantity, 8);
  assert.equal(legacy.repeat, 11);
  assert.equal(legacy.modern.backupFormatVersion, 2);
  assert.equal(legacy.modern.wacaCutoverState[0].mode, 'ORDER_DRIVEN_ACTIVE');
  assert.equal(legacy.modern.dashboardCategoryImages.find(row => row.categoryKey === 'hololive').dataUrl,
    'data:image/png;base64,AAAA');
  assert.equal(legacy.modern.deadlineVerifiedMappings.length, 1);
  assert.equal(legacy.modern.deadlineApplyBatches.length, 1);
  assert.equal(legacy.modern.deadlineApplyItems.length, 1);

  const replacementContext = await browser.newContext();
  const replacementPage = await replacementContext.newPage();
  await replacementPage.route('**/*.supabase.co/**', route => route.abort());
  await replacementPage.goto(origin + '/waca', { waitUntil: 'networkidle' });
  await replacementPage.waitForFunction(() => Boolean(window.dataProvider));
  const replacement = await replacementPage.evaluate(async ({ backup, id }) => {
    const provider = window.dataProvider;
    await provider.importData(JSON.stringify(backup));
    // Model the restored aggregate as the Purchase Records-visible legacy 4,
    // with an existing historical audit row. The first ledger cutover must
    // replace all four pieces, never carry them forward as a manual +4.
    const { NEXT_SANDBOX_INDEXED_DB_NAME } = await import('/src/lib/testSandboxEnvironment.ts');
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(NEXT_SANDBOX_INDEXED_DB_NAME, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      const store = transaction.objectStore('kv');
      const request = store.get('erp_product_variants');
      request.onsuccess = () => store.put(request.result.map(row => row.id === id
        ? { ...row, waca_auto_quantity: 0, waca_manual_adjustment: 4 } : row), 'erp_product_variants');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    const first = await provider.getNextWacaSnapshot();
    const feature = JSON.stringify(['GP-TARGET', 'TEST', 'SPEC', '', 'G-TARGET']);
    const orderKey = 'WACA::REBASELINE-4';
    const next = { ...first,
      orders: [{ key: orderKey, orderNumber: 'REBASELINE-4', status: '完成付款', purchasedAt: '2026-10-02' }],
      items: [{ key: `${orderKey}::${feature}`, orderKey, feature, productCode: 'GP-TARGET',
        productTitle: 'TEST', spec1: 'SPEC', spec2: '', specCode: 'G-TARGET', quantity: 4, subtotal: 400,
        productVariantId: id, match: 'AUTO_MATCH', diagnostic: null, resolution: 'SPEC_CODE_EXACT' }],
      mappings: [{ feature, myacgMainId: 'GP-TARGET', myacgVariantId: 'G-TARGET', productVariantId: id,
        method: 'AUTO', confirmedAt: '2026-10-02', historicalProductTitle: 'TEST',
        historicalVariantTitle: 'SPEC', masterStatus: 'ACTIVE', resolution: 'SPEC_CODE_EXACT' }],
      cutoverAudit: [{ productVariantId: id, sku: 'G-TARGET', productTitle: 'TEST', variantTitle: 'SPEC',
        legacyWacaQuantity: 4, legacyAutoQuantity: 0, unverifiedPreCutoverManualQuantity: 4,
        newOrderDerivedQuantity: 4, difference: 0, cutoverAt: '2026-10-02T00:00:00.000Z' }],
    };
    await provider.commitNextWacaSnapshot(next, first.revision, true);
    const saved = (await provider.getProductVariants({ raw: true })).find(row => row.id === id);
    const { purchaseRecordsWacaQuantity } = await import('/src/waca/reconciliation.ts');
    return { auto: saved.waca_auto_quantity, manual: saved.waca_manual_adjustment,
      displayed: purchaseRecordsWacaQuantity(saved, true) };
  }, { backup: fixture, id: targetId });
  assert.deepEqual(replacement, { auto: 4, manual: 0, displayed: 4 }, 'legacy 4 must be replaced by ledger 4, not become 8');
  await replacementContext.close();

  const restoredContext = await browser.newContext();
  const restoredPage = await restoredContext.newPage();
  await restoredPage.route('**/*.supabase.co/**', route => route.abort());
  await restoredPage.goto(origin + '/waca', { waitUntil: 'networkidle' });
  await restoredPage.waitForFunction(() => Boolean(window.dataProvider));
  const modern = await restoredPage.evaluate(async ({ backup, id }) => {
    const provider = window.dataProvider;
    const restored = await provider.importData(JSON.stringify(backup));
    const snapshot = await provider.getNextWacaSnapshot();
    const variant = (await provider.getProductVariants({ raw: true })).find(row => row.id === id);
    const { getDashboardCategoryImage } = await import('/src/lib/dashboardImageStore.ts');
    const { readDeadlineDurableBackup } = await import('/src/lib/closingDateSidecarBackup.ts');
    const deadline = await readDeadlineDurableBackup('next');
    return { restored, orders: snapshot.orders.length, items: snapshot.items.length,
      mappings: snapshot.mappings.length, state: snapshot.cutoverState?.mode,
      auto: variant.waca_auto_quantity, manual: variant.waca_manual_adjustment,
      dashboardImage: await getDashboardCategoryImage('hololive'),
      deadlineMappings: deadline.deadlineVerifiedMappings.length,
      deadlineApplyBatches: deadline.deadlineApplyBatches.length,
      deadlineApplyItems: deadline.deadlineApplyItems.length };
  }, { backup: legacy.modern, id: targetId });
  assert.deepEqual(modern, { restored: true, orders: 1, items: 1, mappings: 1,
    state: 'ORDER_DRIVEN_ACTIVE', auto: 11, manual: 0, dashboardImage: 'data:image/png;base64,AAAA',
    deadlineMappings: 1, deadlineApplyBatches: 1, deadlineApplyItems: 1 });
  const stageId = '00000000-0000-4000-8000-000000000077';
  await restoredPage.evaluate(async ({ id, sidecar }) => {
    const { stageCloudDeadlineRestore } = await import('/src/lib/cloudDeadlineRestoreStage.ts');
    await stageCloudDeadlineRestore({ id, sourceFingerprint: 'a'.repeat(64), legacyBackup: false,
      deadlineSidecar: sidecar, deadlineSidecarSha256: 'b'.repeat(64) });
  }, { id: stageId, sidecar: {
    deadlineVerifiedMappings: legacy.modern.deadlineVerifiedMappings,
    deadlineApplyBatches: legacy.modern.deadlineApplyBatches,
    deadlineApplyItems: legacy.modern.deadlineApplyItems,
  } });
  await restoredPage.reload({ waitUntil: 'networkidle' });
  const staged = await restoredPage.evaluate(async id => {
    const { readCloudDeadlineRestoreStage, clearCloudDeadlineRestoreStage } =
      await import('/src/lib/cloudDeadlineRestoreStage.ts');
    const found = await readCloudDeadlineRestoreStage(id);
    await clearCloudDeadlineRestoreStage(id);
    return { mappings: found?.deadlineSidecar?.deadlineVerifiedMappings.length,
      cleared: await readCloudDeadlineRestoreStage(id) };
  }, stageId);
  assert.deepEqual(staged, { mappings: 1, cleared: null });
  console.log('PASS legacy 8→11 and 4→4 replacement cutover (never 8), repeat idempotency, modern WACA/Deadline/dashboard restore without Excel');
  console.log('PASS Cloud Deadline restore hand-off survives F5 and is cleared after verification');
} finally {
  await browser?.close();
  vite.kill();
}
