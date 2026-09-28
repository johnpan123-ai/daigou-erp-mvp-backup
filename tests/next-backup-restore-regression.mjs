import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const localFixture = JSON.parse(readFileSync('tests/fixtures/core-regression.json', 'utf8'));
const collections = Object.keys(localFixture);
const viteModule = await createServer({ configFile: false, cacheDir: join(tmpdir(), 'waca-v3-backup-vite'),
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const restore = await viteModule.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const portability = await viteModule.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
  assert.equal(restore.CLOUD_RESTORE_TABLES.length, 24);
  assert.deepEqual(restore.CLOUD_RESTORE_TABLES.map(([collection]) => collection).sort(),
    [...collections, 'dashboardCategoryImages', 'wacaOrders', 'wacaItems', 'wacaMappings', 'myacgMasterLinks',
      'wacaImportBatches', 'wacaCutoverAudit', 'wacaCutoverState'].sort());

  const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const seed = Object.fromEntries(restore.CLOUD_RESTORE_TABLES.map(([collection]) => [collection, []]));
  seed.wacaCutoverState.push({ id: '00000000-0000-4000-8000-000000000001',
    revision: 0, mode: 'LEGACY_QUANTITY_ACTIVE',
    payload: { mode: 'LEGACY_QUANTITY_ACTIVE', updatedAt: '2026-09-28T00:00:00Z', sourceBackupFormatVersion: null },
    updated_by: null });
  seed.inventory.push({ id: uuid(4), inventory_key: 'next::fixture::sku', myacg_item_code: 'SKU2' });
  seed.productGroups.push({ id: uuid(1), local_id: 'next-group', title: 'NEXT backup fixture' });
  seed.productCategories.push({ id: uuid(2), local_id: 'next-category', product_group_id: uuid(1), title: 'Category' });
  seed.productVariants.push({ id: uuid(3), local_id: 'next-variant', product_group_id: uuid(1), product_category_id: uuid(2), myacg_item_code: 'SKU2', waca_auto_quantity: 8 });
  const built = await restore.buildCloudRestoreManifest(seed, seed);
  const deadlineSidecar = { deadlineVerifiedMappings: [], deadlineApplyBatches: [], deadlineApplyItems: [] };
  const document = { schemaVersion: restore.CLOUD_RESTORE_SCHEMA_VERSION, sourceEnvironment: 'isolated-next',
    manifest: built.manifest, data: seed, deadlineSidecar };
  const candidate = await restore.prepareCloudRestoreSnapshot(JSON.stringify(document));
  assert.equal(candidate.manifest.resourceCount, 24);
  assert.equal(candidate.manifest.orphanCount, 0);
  assert.equal(candidate.manifest.duplicateCanonicalIdCount, 0);
  assert.equal(restore.auditCloudRestoreRelations(candidate.data).blockingOrphanCount, 0);
  assert.equal((await portability.assertCloudRestoreEffectiveCandidate(candidate)).mode, 'strict');
  const compatible = structuredClone(document);
  delete compatible.manifest.identityContractVersion;
  assert.equal((await restore.prepareCloudRestoreSnapshot(JSON.stringify(compatible))).sourceIdentityContractVersion, 'current-unversioned');

  const oldTables = restore.CLOUD_RESTORE_TABLES.filter(([, table]) => !restore.CLOUD_PASSTHROUGH_RESTORE_TABLES.has(table));
  assert.equal(oldTables.length, 15);
  const oldData = Object.fromEntries(oldTables.map(([, table]) => [table,
    table === 'inventory_items'
      ? built.data[table].map(row => Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== 'myacg_parent_code')))
      : built.data[table]]));
  const oldCounts = Object.fromEntries(oldTables.map(([, table]) => [table, oldData[table].length]));
  const oldProjection = oldTables.flatMap(([, table]) => oldData[table].map(row => ({
    table, id: row.id,
    relations: Object.fromEntries(Object.entries(row).filter(([key]) => key.endsWith('_id') && key !== 'local_id')),
  }))).sort((left, right) => `${left.table}:${left.id}`.localeCompare(`${right.table}:${right.id}`));
  const oldDocument = { schemaVersion: 'cloud-erp-snapshot-v1', sourceEnvironment: 'isolated-legacy',
    manifest: { schemaVersion: 'cloud-erp-snapshot-v1', resourceCount: 15, counts: oldCounts,
      totalRows: Object.values(oldCounts).reduce((sum, count) => sum + count, 0),
      snapshotFingerprint: await restore.sha256Hex(restore.stableCloudRestoreJson(oldData)),
      relationshipHash: await restore.sha256Hex(restore.stableCloudRestoreJson(oldProjection)) },
    data: Object.fromEntries(oldTables.map(([collection, table]) => [collection, oldData[table]])) };
  const legacy = await restore.prepareCloudRestoreSnapshot(JSON.stringify(oldDocument));
  assert.equal(legacy.legacyWacaBackup, true);
  assert.equal(legacy.data.product_variants[0].waca_auto_quantity, 8);
  assert.equal(legacy.data.waca_state[0].mode, 'ORDER_REBASELINE_REQUIRED');
  assert.equal(legacy.manifest.resourceCount, 24);
  assert.equal((await restore.prepareCloudRestoreSnapshot(JSON.stringify(oldDocument))).manifest.snapshotFingerprint,
    legacy.manifest.snapshotFingerprint, 'same legacy file must produce a stable Cloud restore fingerprint');
  const legacyPreserved = await restore.preserveLegacyCloudDashboardImages(legacy, [{
    id: uuid(20), category_key: 'hololive', image_url: 'https://example.invalid/retained.png',
    storage_path: 'dashboard/retained.png', updated_by: null,
  }]);
  assert.equal(legacyPreserved.data.dashboard_category_images.length, 1);
  assert.equal(legacyPreserved.legacyDashboardPreserved, true);
  assert.equal(legacyPreserved.manifest.counts.dashboard_category_images, 1);

  const modern = structuredClone(seed);
  modern.productVariants[0].waca_auto_quantity = 11;
  modern.wacaCutoverState[0].mode = 'ORDER_DRIVEN_ACTIVE';
  modern.wacaCutoverState[0].payload.mode = 'ORDER_DRIVEN_ACTIVE';
  modern.wacaOrders.push({ id: uuid(10), order_key: 'WACA::A', status: '完成付款',
    payload: { key: 'WACA::A', orderNumber: 'A', status: '完成付款' } });
  modern.wacaItems.push({ id: uuid(11), item_key: 'WACA::A::F', order_id: uuid(10), feature: 'F',
    product_variant_id: uuid(3), quantity: 11, payload: { key: 'WACA::A::F' } });
  modern.wacaMappings.push({ id: uuid(12), feature: 'F', product_variant_id: uuid(3), payload: { feature: 'F' } });
  const modernBuilt = await restore.buildCloudRestoreManifest(modern, modern);
  const modernCandidate = await restore.prepareCloudRestoreSnapshot(JSON.stringify({
    schemaVersion: restore.CLOUD_RESTORE_SCHEMA_VERSION, sourceEnvironment: 'isolated-modern',
    manifest: modernBuilt.manifest, data: modern, deadlineSidecar,
  }));
  assert.equal(modernCandidate.data.waca_order_items.length, 1);
  assert.equal(modernCandidate.data.product_variants[0].waca_auto_quantity, 11);

  if (process.env.CLOUD_RESTORE_REALISTIC_SNAPSHOT) {
    const raw = readFileSync(process.env.CLOUD_RESTORE_REALISTIC_SNAPSHOT, 'utf8');
    const realistic = await restore.prepareCloudRestoreSnapshot(raw, { fileName: 'isolated-real-shape.json' });
    assert.equal(realistic.manifest.resourceCount, 24);
    assert.equal(realistic.manifest.orphanCount, 0);
    assert.equal(realistic.manifest.duplicateCanonicalIdCount, 0);
    assert.equal(realistic.manifest.duplicateVariantIdCount, 0);
    const effective = await portability.prepareCrossEnvironmentCloudRestoreCandidate(realistic, 'rhfdjsklfrgpoqsaqpkn');
    const validated = await portability.assertCloudRestoreEffectiveCandidate(effective);
    assert.equal(validated.mode, 'cross-environment');
    assert.equal(effective.manifest.resourceCount, 24);
    assert.equal(effective.manifest.orphanCount, 0);
    console.log(JSON.stringify({ realisticRows: realistic.manifest.totalRows, resources: 24, orphan: 0,
      duplicateCanonical: 0, transformedAuditValues: validated.transformedValueCount,
      sourceFingerprint: realistic.manifest.snapshotFingerprint,
      effectiveFingerprint: effective.executionFingerprint }));
  }
  console.log('PASS 24-resource cloud manifest/parser, relationships, strict/effective candidate, current-unversioned backup compatibility');
} finally {
  await viteModule.close();
}

const origin = 'http://127.0.0.1:4394';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'next', '--host', '127.0.0.1', '--port', '4394', '--strictPort', '--configLoader', 'runner'], {
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
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const cloudRequests = [];
  await page.route('**/*.supabase.co/**', route => { cloudRequests.push(route.request().url()); return route.abort(); });
  await page.goto(origin + '/inventory', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.dataProvider));
  const restored = await page.evaluate(data => window.dataProvider.restoreBackup(data), localFixture);
  assert.equal(restored, true, 'isolated NEXT fixture import must commit atomically');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出 JSON 備份' }).click();
  const download = await downloadPromise;
  const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
  for (const key of collections) assert.ok(Array.isArray(exported[key]), `${key} missing from JSON backup`);
  for (const key of ['wacaOrders', 'wacaItems', 'wacaMappings', 'wacaImportBatches',
    'myacgMasterLinks', 'wacaCutoverAudit', 'wacaCutoverState',
    'deadlineVerifiedMappings', 'deadlineApplyBatches', 'deadlineApplyItems']) {
    assert.ok(Array.isArray(exported[key]), `${key} missing from modern JSON backup`);
  }
  assert.equal(exported.backupFormatVersion, 2);
  for (const key of collections) {
    assert.ok(Array.isArray(exported[key]), `${key} missing from JSON backup`);
    assert.equal(exported[key].length, localFixture[key].length, `${key} row count changed during export`);
  }
  assert.equal(cloudRequests.length, 0, 'isolated NEXT backup must not call live Supabase');
  await context.close();
  console.log('PASS NEXT JSON export/download, core/WACA/Deadline collections, fixture row counts preserved, live requests 0');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
