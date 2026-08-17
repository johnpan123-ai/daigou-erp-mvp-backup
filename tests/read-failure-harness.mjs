import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4252';
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SNAPSHOT = process.env.NEXT_NIGHTLY_SNAPSHOT
  ?? 'C:\\Users\\小河馬\\Downloads\\workbench-backup-2026-08-15.json';
if (!existsSync(CHROME) || !existsSync(SNAPSHOT)) throw new Error('Chrome or Snapshot is missing');

const snapshotText = readFileSync(SNAPSHOT, 'utf8');
const stable = value => JSON.stringify(value, (_key, nested) => {
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
  return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
});
const targets = [
  { label: 'ProductGroups', key: 'erp_product_groups', method: 'getProductGroups' },
  { label: 'Variants', key: 'erp_product_variants', method: 'getProductVariants' },
  { label: 'PurchaseBatches', key: 'erp_purchase_batches', method: 'getPurchaseBatches' },
  { label: 'PurchaseBatchItems', key: 'erp_purchase_batch_items', method: 'getPurchaseBatchItems' },
  { label: 'JapanPackages', key: 'erp_japan_packages', method: 'getJapanPackages' },
  { label: 'OutboundShipments', key: 'erp_outbound_shipments', method: 'getOutboundShipments' },
  { label: 'Inventory', key: 'erp_inventory', method: 'getInventory' },
];

const vite = spawn(process.execPath, [VITE, '--mode', 'next', '--host', '127.0.0.1', '--port', '4252', '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) return; } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${output}`);
}
async function rawSnapshot(page) {
  return page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
  });
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'next'));
const page = await context.newPage();
const supabaseRequests = [];
const pageErrors = [];
page.on('request', request => { if (/\.supabase\.co\//i.test(request.url())) supabaseRequests.push(request.url()); });
page.on('pageerror', error => pageErrors.push(error.message));

try {
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
  await page.evaluate(async text => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const importer = await import('/src/lib/testSnapshotImport.ts');
    await environment.clearTestSandboxData();
    const file = new File([text], 'workbench-backup-2026-08-15.json', { type: 'application/json' });
    await importer.importTestSnapshot(await importer.prepareTestSnapshotFile(file));
  }, snapshotText);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.dataProvider));
  const baseline = await rawSnapshot(page);
  const baselineSerialized = stable(baseline);
  const results = [];

  for (const target of targets) {
    const readResult = await page.evaluate(async ({ key, method }) => {
      const originalGet = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function injectReadFailure(requestedKey) {
        if (this.name === 'kv' && requestedKey === key) throw new Error(`Injected read failure: ${key}`);
        return originalGet.call(this, requestedKey);
      };
      try {
        const provider = window.dataProvider;
        try {
          const value = await provider[method]();
          return { returnedArray: Array.isArray(value), count: Array.isArray(value) ? value.length : null, rejected: false };
        } catch (error) {
          return {
            returnedArray: false,
            count: null,
            rejected: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      } finally {
        IDBObjectStore.prototype.get = originalGet;
      }
    }, target);
    const after = await rawSnapshot(page);
    assert.equal(stable(after), baselineSerialized, `${target.label} failure changed Test DB`);
    results.push({ ...target, ...readResult, maskedAsEmpty: readResult.returnedArray && readResult.count === 0 });
  }

  const variantSync = await page.evaluate(async () => {
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function injectVariantReadFailure(requestedKey) {
      if (this.name === 'kv' && requestedKey === 'erp_product_variants') throw new Error('Injected Variant read failure');
      return originalGet.call(this, requestedKey);
    };
    try {
      await window.dataProvider.syncProductGroupsWithInventory();
      return { rejected: false };
    } catch (error) {
      return {
        rejected: true,
        code: error?.code ?? null,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }
  });
  const final = await rawSnapshot(page);
  assert.equal(stable(final), baselineSerialized, 'Variant sync fault changed Test DB');
  assert.deepEqual(supabaseRequests, [], 'Read failure harness must make zero Production Supabase requests');
  assert.equal(variantSync.rejected, true);
  assert.equal(variantSync.code, 'VARIANT_DESTRUCTIVE_SYNC_GUARD');
  console.log(JSON.stringify({
    database: 'daigou-erp-db-next-v1',
    readFailures: results,
    expectedMaskedEmptyFindings: results.filter(result => result.maskedAsEmpty).map(result => result.label),
    variantSync,
    testDbUnchanged: true,
    productionSupabaseRequests: 0,
    expectedInjectedPageErrors: pageErrors,
  }, null, 2));
  console.log('PASS read-failure harness: failures classified without writes; Variant sync fail-closed');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
