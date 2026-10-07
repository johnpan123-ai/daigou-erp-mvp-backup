import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { isolatedDatabase, uuid } from './helpers/saveability-isolated.mjs';

const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false } });
const db = await isolatedDatabase();

const reasonFrom = error => {
  if (typeof error?.code === 'string' && error.code.startsWith('WACA_')) return error.code;
  const match = /RESTORE_VALIDATION_ERROR\|prepare\|[^|]+\|[^|]+\|([A-Z0-9_]+)/u.exec(String(error?.message ?? error));
  return match?.[1] ?? String(error?.code ?? 'UNKNOWN');
};

try {
  const restore = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const submit = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreSubmit.ts');
  const data = structuredClone((await db.sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data);
  const now = '2026-10-07T00:00:00.000Z';
  data.waca_orders = [{ id: uuid(10), order_key: 'order-1', status: '處理中',
    payload: { key: 'order-1' }, created_at: now, updated_at: now, updated_by: null }];
  data.waca_order_items = [{ id: uuid(11), item_key: 'item-1', order_id: uuid(10), feature: 'feature-1',
    product_variant_id: uuid(2), quantity: 1, payload: { key: 'item-1' }, created_at: now, updated_at: now, updated_by: null }];
  data.waca_mappings = [{ id: uuid(12), feature: 'feature-1', product_variant_id: uuid(2), payload: {},
    created_at: now, updated_at: now, updated_by: null }];
  data.waca_master_links = [{ id: uuid(13), child_code: 'child-1', main_code: 'main-1',
    product_variant_id: uuid(2), payload: {}, created_at: now, updated_at: now, updated_by: null }];
  data.waca_import_batches = [{ id: uuid(14), batch_key: 'batch-1', payload: {},
    created_at: now, updated_at: now, updated_by: null }];
  data.waca_cutover_audit = [{ id: uuid(15), product_variant_id: uuid(2), payload: {},
    created_at: now, updated_at: now, updated_by: null }];
  const valid = await restore.buildCloudRestoreManifest(data, data);

  const documentFor = candidate => ({ schemaVersion: restore.CLOUD_RESTORE_SCHEMA_VERSION,
    sourceEnvironment: 'isolated-validator-parity', manifest: valid.manifest,
    data: Object.fromEntries(restore.CLOUD_RESTORE_TABLES.map(([collection, table]) => [collection, candidate[table]])),
    deadlineSidecar: { deadlineVerifiedMappings: [], deadlineApplyBatches: [], deadlineApplyItems: [] } });

  const cases = [
    ['missing outbound timestamp', 'OUTBOUND_TIMESTAMP_EVIDENCE_MISSING', value => {
      value.outbound_shipments=[{id:uuid(77),status:'pending'}];
    }],
    ['valid order + valid item', null, () => {}],
    ['missing payload.key', 'WACA_PAYLOAD_KEY_MISSING', value => { value.waca_orders[0].payload = {}; }],
    ['order payload.key mismatch', 'WACA_PAYLOAD_KEY_MISMATCH', value => { value.waca_orders[0].payload.key = 'wrong'; }],
    ['item payload.key mismatch', 'WACA_PAYLOAD_KEY_MISMATCH', value => { value.waca_order_items[0].payload.key = 'wrong'; }],
    ['missing canonical identity', 'WACA_CANONICAL_IDENTITY_MISSING', value => { value.waca_orders[0].id = ''; }],
    ['duplicate business key', 'WACA_DUPLICATE_BUSINESS_KEY', value => {
      value.waca_orders.push({ ...structuredClone(value.waca_orders[0]), id: uuid(16) });
    }],
    ['orphan order item', 'WACA_ORDER_ITEM_ORPHAN', value => { value.waca_order_items[0].order_id = uuid(99); }],
    ['invalid mapping', 'WACA_MAPPING_VARIANT_INVALID', value => { value.waca_mappings[0].product_variant_id = uuid(99); }],
    ['invalid master link', 'WACA_MASTER_LINK_INVALID', value => { value.waca_master_links[0].product_variant_id = uuid(99); }],
    ['bad state', 'WACA_CUTOVER_STATE_INVALID', value => { value.waca_state[0].mode = 'BAD'; }],
  ];
  const matrix = [];
  for (const [name, expected, mutate] of cases) {
    const candidate = structuredClone(valid.data); mutate(candidate);
    const results = {};
    for (const [layer, run] of [
      ['local', async () => restore.assertCurrentCloudRestoreDataContract(candidate)],
      ['client', async () => restore.prepareCloudRestoreSnapshot(documentFor(candidate))],
      ['server', async () => db.sql.query('select public.erp_cloud_restore_validate_waca_dataset($1)', [candidate])],
    ]) {
      try { await run(); results[layer] = 'PASS'; }
      catch (error) { results[layer] = reasonFrom(error); }
    }
    const expectedResult = expected ?? 'PASS';
    assert.deepEqual(results, { local: expectedResult, client: expectedResult, server: expectedResult }, name);
    matrix.push({ name, ...results });
  }
  const visible = submit.normalizeCloudRestoreSubmitError({
    code: '22023',
    message: 'RESTORE_VALIDATION_ERROR|prepare|waca_orders|order-1|WACA_PAYLOAD_KEY_MISSING',
  }, 'proof', { source: 'server-response', attemptCorrelationId: uuid(88) });
  assert.equal(visible.reasonCode, 'WACA_PAYLOAD_KEY_MISSING');
  assert.equal(visible.resource, 'waca_orders');
  assert.equal(visible.rowIdentity, 'order-1');
  assert.match(visible.message, /格式不完整/u);
  const formatted = submit.formatCloudRestoreSubmitError(visible);
  assert.match(formatted, /resource：waca_orders/u);
  assert.match(formatted, /row：order-1/u);
  assert.match(formatted, /reason：WACA_PAYLOAD_KEY_MISSING/u);
  assert.doesNotMatch(formatted, /\[object Object\]/u);
  console.log(JSON.stringify({ validatorParity: 'PASS', mismatchCount: 0, matrix }));
} finally {
  await vite.close();
  await db.close();
}
