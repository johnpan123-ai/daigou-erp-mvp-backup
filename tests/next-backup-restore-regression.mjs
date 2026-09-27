import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const localFixture = JSON.parse(readFileSync('tests/fixtures/core-regression.json', 'utf8'));
const collections = Object.keys(localFixture);
const viteModule = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const restore = await viteModule.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const portability = await viteModule.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
  assert.equal(restore.CLOUD_RESTORE_TABLES.length, 15);
  assert.deepEqual(restore.CLOUD_RESTORE_TABLES.map(([collection]) => collection).sort(),
    collections.filter(collection => collection !== 'importBatches').sort());

  const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const seed = Object.fromEntries(restore.CLOUD_RESTORE_TABLES.map(([collection]) => [collection, []]));
  seed.inventory.push({ id: uuid(4), inventory_key: 'next::fixture::sku', myacg_item_code: 'SKU2' });
  seed.productGroups.push({ id: uuid(1), local_id: 'next-group', title: 'NEXT backup fixture' });
  seed.productCategories.push({ id: uuid(2), local_id: 'next-category', product_group_id: uuid(1), title: 'Category' });
  seed.productVariants.push({ id: uuid(3), local_id: 'next-variant', product_group_id: uuid(1), product_category_id: uuid(2), myacg_item_code: 'SKU2' });
  const built = await restore.buildCloudRestoreManifest(seed, seed);
  const document = { schemaVersion: restore.CLOUD_RESTORE_SCHEMA_VERSION, sourceEnvironment: 'isolated-next', manifest: built.manifest, data: seed };
  const candidate = await restore.prepareCloudRestoreSnapshot(JSON.stringify(document));
  assert.equal(candidate.manifest.resourceCount, 15);
  assert.equal(candidate.manifest.orphanCount, 0);
  assert.equal(candidate.manifest.duplicateCanonicalIdCount, 0);
  assert.equal(restore.auditCloudRestoreRelations(candidate.data).blockingOrphanCount, 0);
  assert.equal((await portability.assertCloudRestoreEffectiveCandidate(candidate)).mode, 'strict');
  const compatible = structuredClone(document);
  delete compatible.manifest.identityContractVersion;
  assert.equal((await restore.prepareCloudRestoreSnapshot(JSON.stringify(compatible))).sourceIdentityContractVersion, 'current-unversioned');

  if (process.env.CLOUD_RESTORE_REALISTIC_SNAPSHOT) {
    const raw = readFileSync(process.env.CLOUD_RESTORE_REALISTIC_SNAPSHOT, 'utf8');
    const realistic = await restore.prepareCloudRestoreSnapshot(raw, { fileName: 'isolated-real-shape.json' });
    assert.equal(realistic.manifest.resourceCount, 15);
    assert.equal(realistic.manifest.orphanCount, 0);
    assert.equal(realistic.manifest.duplicateCanonicalIdCount, 0);
    assert.equal(realistic.manifest.duplicateVariantIdCount, 0);
    const effective = await portability.prepareCrossEnvironmentCloudRestoreCandidate(realistic, 'rhfdjsklfrgpoqsaqpkn');
    const validated = await portability.assertCloudRestoreEffectiveCandidate(effective);
    assert.equal(validated.mode, 'cross-environment');
    assert.equal(effective.manifest.resourceCount, 15);
    assert.equal(effective.manifest.orphanCount, 0);
    console.log(JSON.stringify({ realisticRows: realistic.manifest.totalRows, resources: 15, orphan: 0,
      duplicateCanonical: 0, transformedAuditValues: validated.transformedValueCount,
      sourceFingerprint: realistic.manifest.snapshotFingerprint,
      effectiveFingerprint: effective.executionFingerprint }));
  }
  console.log('PASS 15-resource cloud manifest/parser, relationships, strict/effective candidate, current-unversioned backup compatibility');
} finally {
  await viteModule.close();
}

const origin = 'http://127.0.0.1:4394';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'next', '--host', '127.0.0.1', '--port', '4394', '--strictPort'], {
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
  assert.deepEqual(Object.keys(exported).sort(), collections.slice().sort());
  for (const key of collections) {
    assert.ok(Array.isArray(exported[key]), `${key} missing from JSON backup`);
    assert.equal(exported[key].length, localFixture[key].length, `${key} row count changed during export`);
  }
  assert.equal(cloudRequests.length, 0, 'isolated NEXT backup must not call live Supabase');
  await context.close();
  console.log('PASS NEXT JSON export/download and all 16 local collections (15 cloud-restorable + importBatches), fixture row counts preserved, live requests 0');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
