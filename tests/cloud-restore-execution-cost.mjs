import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const TARGET_ROWS = 16_055;
const TARGET_BYTES = 15_532_358;
const ROUNDS = 20;
const TABLE_COUNTS = Object.freeze({
  inventory_items: 5_027,
  product_groups: 791,
  product_categories: 623,
  product_variants: 4_501,
  bundle_components: 318,
  purchase_batches: 602,
  purchase_batch_items: 2_324,
  private_orders: 107,
  private_order_items: 129,
  sales_orders: 0,
  sales_order_items: 0,
  japan_packages: 72,
  japan_package_items: 758,
  outbound_shipments: 25,
  outbound_shipment_items: 778,
});

const uuid = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const digest = value => createHash('sha256').update(value).digest('hex');
const identityOf = (table, row) => table === 'inventory_items' ? row.inventory_key : row.id;
const percentile = (values, proportion) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1)];
};

let nextIdentity = 1;
const data = Object.fromEntries(Object.entries(TABLE_COUNTS).map(([table, count]) => [table,
  Array.from({ length: count }, (_, index) => {
    const identity = uuid(nextIdentity++);
    return table === 'inventory_items'
      ? { inventory_key: `PERF::${String(index).padStart(6, '0')}`, marker: 'CLOUD-RESTORE-PERF', performance_padding: '' }
      : { id: identity, local_id: `metadata-${table}-${index}`, marker: 'CLOUD-RESTORE-PERF', performance_padding: '' };
  }),
]));

const firstId = table => data[table][0]?.id ?? null;
for (const row of data.product_categories) row.product_group_id = firstId('product_groups');
for (const row of data.product_variants) {
  row.product_group_id = firstId('product_groups');
  row.product_category_id = firstId('product_categories');
}
for (const row of data.bundle_components) {
  row.bundle_variant_id = firstId('product_variants');
  row.component_variant_id = firstId('product_variants');
}
for (const row of data.purchase_batches) row.product_group_id = firstId('product_groups');
for (const row of data.purchase_batch_items) {
  row.purchase_batch_id = firstId('purchase_batches');
  row.product_variant_id = firstId('product_variants');
}
for (const row of data.private_orders) row.product_group_id = firstId('product_groups');
for (const row of data.private_order_items) {
  row.private_order_id = firstId('private_orders');
  row.product_variant_id = firstId('product_variants');
}
for (const row of data.japan_package_items) {
  row.japan_package_id = firstId('japan_packages');
  row.product_group_id = firstId('product_groups');
  row.product_variant_id = firstId('product_variants');
  row.purchase_batch_id = firstId('purchase_batches');
  row.purchase_batch_item_id = firstId('purchase_batch_items');
}
for (const row of data.outbound_shipment_items) {
  row.outbound_shipment_id = firstId('outbound_shipments');
  row.japan_package_item_id = firstId('japan_package_items');
  row.product_group_id = firstId('product_groups');
  row.product_variant_id = firstId('product_variants');
}

assert.equal(Object.values(TABLE_COUNTS).reduce((sum, count) => sum + count, 0), TARGET_ROWS);
const allRows = Object.values(data).flat();
const initialBytes = Buffer.byteLength(JSON.stringify(data));
assert(initialBytes < TARGET_BYTES, 'Synthetic fixture metadata unexpectedly exceeds the target payload size');
const paddingBytes = TARGET_BYTES - initialBytes;
const paddingPerRow = Math.floor(paddingBytes / allRows.length);
let paddingRemainder = paddingBytes % allRows.length;
for (const row of allRows) {
  row.performance_padding = 'x'.repeat(paddingPerRow + (paddingRemainder-- > 0 ? 1 : 0));
}
const snapshotJson = JSON.stringify(data);
assert.equal(Buffer.byteLength(snapshotJson), TARGET_BYTES);

const profileTable = (table, rows) => {
  const normalized = rows.map(row => ({ identity: identityOf(table, row) })).sort((left, right) => left.identity.localeCompare(right.identity));
  const identities = normalized.map(entry => entry.identity);
  return {
    count: normalized.length,
    missingIdentityCount: identities.filter(value => !value).length,
    duplicateIdentityCount: identities.length - new Set(identities).size,
    identityHash: digest(identities.join('\n')),
  };
};

const profileSnapshot = snapshot => Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, profileTable(table, rows)]));
const timings = [];
for (let round = 0; round < ROUNDS; round += 1) {
  const totalStarted = performance.now();
  let started = performance.now();
  const expectedProfiles = profileSnapshot(data);
  const inputValidation = performance.now() - started;

  started = performance.now();
  const beforeSnapshot = JSON.parse(snapshotJson);
  const beforeSnapshotMs = performance.now() - started;

  started = performance.now();
  const rollbackFingerprint = digest(JSON.stringify(beforeSnapshot));
  const rollbackRow = performance.now() - started;

  started = performance.now();
  const working = JSON.parse(snapshotJson);
  const bulkReplacement = performance.now() - started;

  started = performance.now();
  const actualProfiles = profileSnapshot(working);
  assert.deepEqual(actualProfiles, expectedProfiles);
  const integrity = performance.now() - started;
  assert.equal(rollbackFingerprint, digest(snapshotJson));

  timings.push({
    inputValidation,
    beforeSnapshot: beforeSnapshotMs,
    rollbackRow,
    bulkReplacement,
    integrity,
    total: performance.now() - totalStarted,
  });
}

const totals = timings.map(timing => timing.total);
const result = {
  evidence: 'deterministic-js-cost-model',
  postgresLive: 'pending-separately-authorized-staging-gate',
  resources: Object.keys(TABLE_COUNTS).length,
  rows: TARGET_ROWS,
  payloadBytes: TARGET_BYTES,
  payloadMiB: Number((TARGET_BYTES / 1024 / 1024).toFixed(2)),
  rounds: ROUNDS,
  beforeFullSnapshotScans: 1,
  afterFullSnapshotScans: 0,
  p50Ms: Number(percentile(totals, 0.5).toFixed(2)),
  p95Ms: Number(percentile(totals, 0.95).toFixed(2)),
  maxMs: Number(Math.max(...totals).toFixed(2)),
  phaseP95Ms: Object.fromEntries(Object.keys(timings[0]).map(phase => [phase, Number(percentile(timings.map(timing => timing[phase]), 0.95).toFixed(2))])),
};

assert.equal(result.resources, 15);
assert(result.p95Ms < 30_000, 'Deterministic execution-cost model exceeded the bounded function timeout');
console.log(JSON.stringify(result, null, 2));
console.log('PASS Cloud Restore 16,055-row / 15.5MB deterministic execution-cost model; live PostgreSQL timing remains a Staging gate');
