import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SQL = readFileSync(new URL('../supabase/sql/023_cloud_atomic_json_restore.sql', import.meta.url), 'utf8');
const PROVIDER = readFileSync(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8');
const CONTEXT = readFileSync(new URL('../src/contexts/CloudRealtimeSyncContext.tsx', import.meta.url), 'utf8');
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));
const collections = {
  inventory: [{ inventory_key: 'restore::SKU::A', myacg_item_code: 'SKU', product_title: 'Restore Product', raw_variant_name: 'A', listing_type: 'normal', final_price: 1, myacg_available_quantity: 0, myacg_sold_quantity: 0, myacg_demand_quantity: 0, myacg_listed_at: '' }],
  productGroups: [{ id: uuid(1), local_id: 'group-1', title: 'Restore Product', priority: 'Medium', purchase_date: '', closing_date: '', release_month: '', has_official_site: false, product_url: '' }],
  productCategories: [{ id: uuid(2), local_id: 'category-1', product_group_id: uuid(1), title: 'Default', sort_order: 0 }],
  productVariants: [{ id: uuid(3), local_id: 'variant-1', product_group_id: uuid(1), product_category_id: uuid(2), myacg_item_code: 'SKU', product_title: 'Restore Product', variant_name: 'A', note: '', sort_order: 0 }],
  bundleComponents: [{ id: uuid(4), bundle_variant_id: uuid(3), component_variant_id: uuid(3) }],
  purchaseBatches: [{ id: uuid(5), local_id: 'batch-1', product_group_id: uuid(1), name: 'Restore batch', date: '2026-09-09', note: '' }],
  purchaseBatchItems: [{ id: uuid(6), local_id: 'batch-item-1', purchase_batch_id: uuid(5), product_variant_id: uuid(3), quantity: 1, cost: 10, note: '' }],
  privateOrders: [{ id: uuid(7), local_id: 'private-1', product_group_id: uuid(1), customer_name: 'Fixture', contact: '', note: '' }],
  privateOrderItems: [{ id: uuid(8), local_id: 'private-item-1', private_order_id: uuid(7), product_variant_id: uuid(3), quantity: 1, amount: 10, note: '' }],
  salesOrders: [{ id: uuid(9), local_id: 'order-1', platform: 'fixture', order_number: 'RESTORE-1', buyer_name: 'Fixture' }],
  salesOrderItems: [{ id: uuid(10), local_id: 'order-item-1', order_id: uuid(9), product_variant_id: uuid(3), myacg_item_code: 'SKU', quantity: 1 }],
  japanPackages: [{ id: uuid(11), title: 'Restore package', status: 'registered' }],
  japanPackageItems: [{ id: uuid(12), japan_package_id: uuid(11), product_group_id: uuid(1), product_variant_id: uuid(3), purchase_batch_id: uuid(5), purchase_batch_item_id: uuid(6), quantity: 1, checked: false }],
  outboundShipments: [{ id: uuid(13), title: 'Restore outbound', status: 'draft' }],
  outboundShipmentItems: [{ id: uuid(14), outbound_shipment_id: uuid(13), japan_package_item_id: uuid(12), product_group_id: uuid(1), product_variant_id: uuid(3), quantity: 1, checked: false }],
};
const documentFor = (suffix = '') => ({ schemaVersion: 'cloud-erp-snapshot-v1', sourceEnvironment: `fixture${suffix}`, data: clone(collections) });

class AtomicServer {
  state = { marker: 'before' };
  requests = new Map();
  rollbackSnapshots = [];
  locked = false;
  epoch = 0;
  async apply(key, candidate, options = {}) {
    if (this.locked) throw new Error('CLOUD_RESTORE_LOCK_CONFLICT');
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.fingerprint !== candidate.manifest.snapshotFingerprint) throw new Error('RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH');
      return { ...clone(previous.result), replayed: true };
    }
    this.locked = true;
    const before = clone(this.state);
    const working = {};
    this.rollbackSnapshots.push(before);
    try {
      let index = 0;
      for (const [, table] of candidateTables) {
        index += 1;
        working[table] = clone(candidate.data[table]);
        if (options.failAt === index) throw new Error(`INJECTED_RESOURCE_FAILURE_${index}`);
      }
      if (options.integrityFailure) throw new Error('CLOUD_RESTORE_POST_INTEGRITY_COUNT_MISMATCH');
      this.state = working;
      this.epoch += 1;
      const result = { ok: true, replayed: false, idempotencyKey: key, snapshotFingerprint: candidate.manifest.snapshotFingerprint, rollbackSnapshotId: uuid(1000 + this.epoch), restoreEpoch: this.epoch, manifest: candidate.manifest };
      this.requests.set(key, { fingerprint: candidate.manifest.snapshotFingerprint, result: clone(result) });
      return result;
    } catch (error) {
      this.state = before;
      this.rollbackSnapshots.pop();
      throw error;
    } finally { this.locked = false; }
  }
}

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
let candidateTables;
try {
  const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const stagingHarness = await vite.ssrLoadModule('/src/lib/stagingCloudRestoreHarness.ts');
  let rejectedCalls = 0;
  for (const environment of [
    { projectRef: 'twzpqyesbtnfxdkorluf', runtimeRole: 'production', viteMode: 'production', deploymentEnvironment: 'production' },
    { projectRef: 'unknown', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' },
    { projectRef: '', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' },
    { projectRef: undefined, runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' },
  ]) {
    assert.throws(() => new stagingHarness.StagingCloudRestoreHarnessController(environment, async () => {
      rejectedCalls += 1; throw new Error('UNREACHABLE');
    }), /STAGING_CLOUD_RESTORE_HARNESS_DISABLED/u);
  }
  assert.equal(rejectedCalls, 0, 'Production/unknown harness construction must make zero Restore requests');
  const mutableBoundary = { projectRef: 'rhfdjsklfrgpoqsaqpkn', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' };
  const safeHarness = new stagingHarness.StagingCloudRestoreHarnessController(mutableBoundary, async command => ({
    ok: true, replayed: false, idempotencyKey: command.idempotencyKey,
    snapshotFingerprint: command.candidate.manifest.snapshotFingerprint,
    rollbackSnapshotId: uuid(990), restoreEpoch: 1, manifest: command.candidate.manifest,
  }));
  mutableBoundary.projectRef = 'twzpqyesbtnfxdkorluf';
  assert.equal(safeHarness.environment.projectRef, 'rhfdjsklfrgpoqsaqpkn');
  assert.equal(Object.isFrozen(safeHarness.environment), true);
  candidateTables = domain.CLOUD_RESTORE_TABLES;
  const candidate = await domain.prepareCloudRestoreSnapshot(JSON.stringify(documentFor()));
  assert.equal(candidate.manifest.resourceCount, 15);
  assert.equal(candidate.manifest.orphanCount, 0);
  assert.equal(candidate.manifest.duplicateVariantIdCount, 0);
  assert.equal(candidate.manifest.snapshotFingerprint.length, 64);
  await assert.rejects(() => domain.prepareCloudRestoreSnapshot('{'), error => error.code === 'MALFORMED_JSON');
  await assert.rejects(() => domain.prepareCloudRestoreSnapshot({ ...documentFor(), schemaVersion: 'old' }), error => error.code === 'UNSUPPORTED_SCHEMA_VERSION');
  const duplicate = documentFor(); duplicate.data.productVariants.push(clone(duplicate.data.productVariants[0]));
  await assert.rejects(() => domain.prepareCloudRestoreSnapshot(duplicate), error => error.code === 'DUPLICATE_CANONICAL_ID');
  const orphan = documentFor(); orphan.data.purchaseBatchItems[0].purchase_batch_id = uuid(999);
  await assert.rejects(() => domain.prepareCloudRestoreSnapshot(orphan), error => error.code === 'ORPHAN_RELATION');
  const localId = documentFor(); localId.data.productVariants[0].id = 'local-only'; delete localId.data.productVariants[0].database_id;
  await assert.rejects(() => domain.prepareCloudRestoreSnapshot(localId), error => error.code === 'CANONICAL_UUID_REQUIRED');

  const metrics = { partial: 0, duplicates: 0, wrongCanonical: 0, stuckLocks: 0, missingRollback: 0 };
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); const key = uuid(2000 + round);
    const result = await server.apply(key, candidate);
    assert.equal(result.ok, true); assert.equal(server.rollbackSnapshots.length, 1);
  }
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); const before = clone(server.state);
    await assert.rejects(() => server.apply(uuid(3000 + round), candidate, { failAt: 10 }), /INJECTED_RESOURCE_FAILURE_10/u);
    assert.deepEqual(server.state, before); assert.equal(server.rollbackSnapshots.length, 0); assert.equal(server.locked, false);
  }
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); const key = uuid(4000 + round);
    const committed = await server.apply(key, candidate); const replay = await server.apply(key, candidate);
    assert.equal(replay.replayed, true); assert.equal(replay.rollbackSnapshotId, committed.rollbackSnapshotId); assert.equal(server.epoch, 1);
  }
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); const key = uuid(5000 + round); await server.apply(key, candidate);
    const otherDoc = documentFor(`-${round}`); otherDoc.data.productGroups[0].title = `Changed ${round}`;
    const other = await domain.prepareCloudRestoreSnapshot(otherDoc);
    await assert.rejects(() => server.apply(key, other), /RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH/u);
  }
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); server.locked = true;
    await assert.rejects(() => server.apply(uuid(6000 + round), candidate), /CLOUD_RESTORE_LOCK_CONFLICT/u);
    server.locked = false;
  }
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); const before = clone(server.state);
    await assert.rejects(() => server.apply(uuid(7000 + round), candidate, { integrityFailure: true }), /POST_INTEGRITY/u);
    assert.deepEqual(server.state, before); assert.equal(server.locked, false);
  }
  assert.deepEqual(metrics, { partial: 0, duplicates: 0, wrongCanonical: 0, stuckLocks: 0, missingRollback: 0 });
} finally { await vite.close(); }

assert.equal((SQL.match(/^begin;$/gimu) || []).length, 1);
assert.equal((SQL.match(/^commit;$/gimu) || []).length, 1);
assert.match(SQL, /security definer[\s\S]+set search_path = pg_catalog, public, extensions/u);
assert.match(SQL, /public\.is_owner\(v_actor\)/u);
assert.match(SQL, /pg_try_advisory_xact_lock\(hashtextextended\('erp-cloud-restore-maintenance-lock'/u);
assert.match(SQL, /create trigger erp_cloud_restore_maintenance_guard before insert or update or delete/u);
assert.match(SQL, /erp_cloud_restore_snapshots/u);
assert.match(SQL, /RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH/u);
assert.match(SQL, /CLOUD_RESTORE_POST_INTEGRITY_COUNT_MISMATCH/u);
assert.match(SQL, /CLOUD_RESTORE_MANIFEST_COUNT_MISMATCH/u);
assert.match(SQL, /CLOUD_RESTORE_MANIFEST_TOTAL_MISMATCH/u);
assert.match(SQL, /erp_cloud_restore_relationship_hash/u);
assert.match(SQL, /alter publication supabase_realtime add table public\.erp_cloud_restore_epoch/u);
assert.doesNotMatch(SQL, /service_role|grant\s+.+\s+to\s+(public|anon)/iu);
assert.match(PROVIDER, /reason: 'reconnect'[\s\S]+resources: \['products', 'purchases'/u);
assert.match(CONTEXT, /erp_cloud_restore_epoch[\s\S]+reconnect\.request/u);

const PORT = process.env.CLOUD_RESTORE_TEST_PORT || '4256';
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const processVite = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--config', 'tests/fixtures/cloud-atomic-restore-vite.config.mjs', '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; processVite.stdout.on('data', chunk => { output += String(chunk); }); processVite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const url = `http://127.0.0.1:${PORT}/tests/fixtures/cloud-atomic-restore.html`;
  for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(url)).ok) break; } catch {} await sleep(250); if (attempt === 79) throw new Error(output); }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage(); const cloudRequests = [];
    page.on('request', request => { if (/\.supabase\.co\//u.test(request.url())) cloudRequests.push(request.url()); });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('staging-cloud-restore-harness').waitFor();
    await page.getByText('STAGING TEST ONLY — CLOUD ATOMIC RESTORE').waitFor();
    await page.getByTestId('cloud-restore-harness-auth').getByText('true').waitFor();
    const input = page.locator('input[type=file]');
    await input.setInputFiles({ name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(documentFor())) });
    await page.getByTestId('cloud-restore-preflight').waitFor();
    assert.match(await page.getByTestId('cloud-restore-status').innerText(), /Preflight/u);
    await page.getByTestId('cloud-restore-confirmation').fill('OVERWRITE CLOUD DATA');
    assert.equal(await page.getByTestId('cloud-restore-submit').isEnabled(), true);
    assert.equal(cloudRequests.length, 0, 'Preflight and confirmation must not write Cloud');
    page.on('dialog', dialog => void dialog.accept());
    await page.getByTestId('cloud-restore-submit').click();
    await page.getByTestId('cloud-restore-result').waitFor();
    assert.match(await page.getByTestId('cloud-restore-result').innerText(), /replayed=false.*epoch=1/u);
    assert.equal(cloudRequests.length, 0, 'Injected deterministic Restore execution must not write Cloud');
  } finally { await browser.close(); }
} finally { processVite.kill(); }

console.log('PASS Cloud Atomic Restore: preflight, SQL contract, 180-round deterministic soak, and real React owner flow');
