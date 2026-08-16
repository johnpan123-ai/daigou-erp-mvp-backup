import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || 'C:\\Users\\小河馬\\Downloads\\workbench-backup-2026-08-15.json';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const servers = [
  { mode: 'next', port: 4212, db: 'daigou-erp-db-next-v1' },
  { mode: 'experimental', port: 4213, db: 'daigou-erp-db-experimental-v1' },
];
if (!existsSync(SNAPSHOT_PATH)) throw new Error(`Snapshot not found: ${SNAPSHOT_PATH}`);
if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const bytes = [...await readFile(SNAPSHOT_PATH)];
const fileName = SNAPSHOT_PATH.split(/[\\/]/).at(-1);
const children = servers.map(({ mode, port }) => spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', mode, '--host', '127.0.0.1', '--port', String(port), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }));
const output = children.map(() => '');
children.forEach((child, index) => {
  child.stdout.on('data', chunk => { output[index] += String(chunk); });
  child.stderr.on('data', chunk => { output[index] += String(chunk); });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer(port, child, index) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited:\n${output[index]}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Server start timeout:\n${output[index]}`);
}
const stop = () => children.forEach(child => child.kill('SIGTERM'));
process.on('exit', stop);

let browser;
try {
  await Promise.all(servers.map((server, index) => waitForServer(server.port, children[index], index)));
  browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  const results = [];
  for (const server of servers) {
    const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
    const page = await context.newPage();
    const cloudRequests = [];
    page.on('request', request => {
      if (/supabase\.co/i.test(request.url())) cloudRequests.push(request.url());
    });
    await page.goto(`http://127.0.0.1:${server.port}/settings`, { waitUntil: 'networkidle' });
    const result = await page.evaluate(async ({ bytes: inputBytes, name }) => {
      const importer = await import('/src/lib/testSnapshotImport.ts');
      const file = new File([new Uint8Array(inputBytes)], name, { type: 'application/json' });
      const candidate = await importer.prepareTestSnapshotFile(file);
      return importer.importTestSnapshot(candidate);
    }, { bytes, name: fileName });
    const verified = await page.evaluate(async expectedDb => {
      const environment = await import('/src/lib/testSandboxEnvironment.ts');
      return environment.readPhysicalIndexedDbSnapshot(expectedDb);
    }, server.db);
    assert.equal(result.productionIndexedDbUnchanged, true);
    assert.equal(result.productionLocalStorageUnchanged, true);
    assert.equal(cloudRequests.length, 0);
    results.push({ mode: server.mode, db: server.db, result, verified });
    await context.close();
  }

  const first = results[0].result.metadata;
  const second = results[1].result.metadata;
  assert.deepEqual(first.counts, second.counts, 'Snapshot collection counts differ between Sandbox DBs');
  assert.deepEqual(first.collectionHashes, second.collectionHashes, 'Snapshot collection checksums differ between Sandbox DBs');
  for (const entry of results) {
    for (const [key, expected] of Object.entries(entry.result.verifiedCounts)) {
      const storageKey = ({
        inventory: 'erp_inventory', salesOrders: 'erp_sales_orders', salesOrderItems: 'erp_sales_order_items',
        productGroups: 'erp_product_groups', productCategories: 'erp_product_categories', productVariants: 'erp_product_variants',
        purchaseBatches: 'erp_purchase_batches', purchaseBatchItems: 'erp_purchase_batch_items', privateOrders: 'erp_private_orders',
        privateOrderItems: 'erp_private_order_items', bundleComponents: 'erp_bundle_components', japanPackages: 'erp_japan_packages',
        japanPackageItems: 'erp_japan_package_items', outboundShipments: 'erp_outbound_shipments', outboundShipmentItems: 'erp_outbound_shipment_items',
      })[key];
      assert.equal(entry.verified[storageKey].length, expected, `${entry.mode} ${key} count mismatch after readback`);
    }
  }
  console.log('PASS same Production JSON Snapshot imported atomically into both Sandbox DBs');
  console.log(JSON.stringify({ source: fileName, counts: first.counts, collectionHashes: first.collectionHashes }, null, 2));
} finally {
  if (browser) await browser.close();
  stop();
}
