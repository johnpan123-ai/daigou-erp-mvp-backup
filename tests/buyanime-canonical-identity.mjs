import assert from 'node:assert/strict';
import { createServer } from 'vite';

globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
try {
  const { planCloudInventoryImport: plan } = await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
  const errors = await vite.ssrLoadModule('/src/utils/myacgImportErrors.ts');
  const { CloudMutationBoundaryError } = await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  const { deterministicCloudUuid } = await vite.ssrLoadModule('/src/providers/cloud/cloudEntityPayload.ts');
  const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const base = { id, database_id: id, version: 9, inventory_key: 'Synthetic::G1::A', myacg_item_code: 'G1',
    myacg_parent_code: 'GP1', product_title: 'Synthetic', raw_variant_name: 'A', listing_type: '預購', final_price: 10,
    myacg_sold_quantity: 1, myacg_available_quantity: 2, myacg_listed_at: '' };
  const incoming = { ...base, id: '00000000-0000-4000-8000-000000000001', database_id: undefined,
    product_title: 'Changed metadata', myacg_item_code: 'G2', myacg_sold_quantity: 4, final_price: 20 };
  const result = plan([base], [incoming]);
  assert.equal(result.inventory[0].id, id);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].kind, 'patch');
  assert.equal(result.operations[0].id, id);
  assert.equal(result.operations[0].observedVersion, 9);
  assert.deepEqual(plan([base], [incoming]).operations, result.operations, 'Deterministic plan');
  const next = { ...incoming, inventory_key: 'True new key' };
  const created = plan([base], [next]);
  assert.equal(created.inventory.find(r => r.inventory_key === next.inventory_key).id,
    deterministicCloudUuid('inventory_items:True new key'));
  const duplicates = plan([], [{ ...base, id: undefined, database_id: undefined }, { ...base, id: undefined, database_id: undefined }]);
  assert.equal(duplicates.operations.length, 1);
  assert.equal(duplicates.operations[0].values.myacg_sold_quantity, 2, 'Existing source duplicate aggregation preserved');
  assert.throws(() => plan([{ ...base, deleted_at: '2026-10-03' }], [incoming]), /KEY_SOFT_DELETED/u);
  assert.throws(() => plan([base, { ...base, id: incoming.id }], [incoming]), /AUTHORITATIVE_KEY_INVALID/u);
  // A forced proposed UUID is rebound to the existing key; no unsafe replacement
  // is ever sent. The adopted soft-delete contract has no legal key-release DML.
  assert.equal(result.operations.filter(o => ['delete', 'create'].includes(o.kind)).length, 0);
  const cases = [
    [{ code: '23505', message: 'duplicate key value violates unique constraint "inventory_items_inventory_key_key"', details: 'PRIVATE ROWS' }, 'commit', 'CLOUD_COMMIT_ERROR'],
    [{ code: '42501', message: 'permission denied' }, 'commit', 'PERMISSION_ERROR'],
    [new Error('Failed to fetch'), 'staging', 'NETWORK_ERROR'],
    [new Error('Failed to fetch'), 'commit', 'COMMIT_RESULT_UNKNOWN'],
    [new Error('bad projection'), 'staging', 'CLOUD_STAGING_ERROR'],
    [new Error('file read'), 'file-read', 'FILE_READ_ERROR'],
    [new Error('bad parser'), 'parse', 'PARSER_ERROR'],
    [new Error('bad data'), 'validation', 'VALIDATION_ERROR'],
    [new CloudMutationBoundaryError('result-unknown', {}), 'commit', 'COMMIT_RESULT_UNKNOWN'],
    [new CloudMutationBoundaryError('committed-readback-pending', {}), 'commit', 'COMMITTED_READBACK_PENDING'],
  ];
  for (const [cause, phase, expected] of cases) {
    const error = errors.classifyMyAcgImportError(cause, phase);
    assert.equal(error.code, expected);
    const diagnostic = errors.myAcgImportDiagnostic(error, 'synthetic-request');
    assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE ROWS'));
    if (expected === 'CLOUD_COMMIT_ERROR') assert.equal(diagnostic.constraint, 'inventory_items_inventory_key_key');
    if (expected === 'COMMIT_RESULT_UNKNOWN') assert.match(error.message, /勿重複匯入/u);
  }
  console.log('PASS canonical UUID reuse/new-key deterministic identity/metadata update/duplicate merge/tombstone fail-closed/determinism/unsafe replacement prevention');
  console.log('PASS file/parser/validation/staging/commit/permission/network/unknown-result/readback diagnostics; no raw business data');
} finally { await vite.close(); }
