import assert from 'node:assert/strict';
import { fixtureId, fixtureRows, fixtureRoute } from './fixtures/cloud-fixture-ids.mjs';

const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u;
const ids = Array.from({ length: 10000 }, (_, index) => fixtureId(`fixture-${index}`));
assert.equal(new Set(ids).size, ids.length, 'fixture identities must not collide');
assert.ok(ids.every(id => valid.test(id)));
assert.equal(fixtureId('v-holo'), fixtureId('v-holo'));
assert.notEqual(fixtureId('v-holo'), fixtureId('g-holo'));
assert.equal(fixtureId(ids[0]), ids[0], 'already-valid UUID remains unchanged');
const input = {
  id: 'bi-holo', product_variant_id: 'v-holo', purchase_batch_id: 'batch-holo',
  local_id: 'legacy-local-item', product_id: 'external-marketplace-id',
  inventory_key: 'inv-b', updated_by: 'same-owner', sku: 'SKU-HOLO',
  nested: [{ id: 'v-holo', product_group_id: 'g-holo', quantity: 7 }],
};
const mapped = fixtureRows(input);
assert.equal(mapped.product_variant_id, mapped.nested[0].id, 'FK and PK share the identical UUID');
assert.equal(mapped.purchase_batch_id, fixtureId('batch-holo'));
for (const key of ['local_id', 'product_id', 'inventory_key', 'updated_by', 'sku']) assert.equal(mapped[key], input[key]);
assert.equal(input.id, 'bi-holo', 'mapping must not mutate original fixtures');
assert.equal(mapped.nested[0].quantity, 7);
assert.equal(fixtureRoute('/purchase-records/g-holo?view=items'), `/purchase-records/${fixtureId('g-holo')}?view=items`);
assert.equal(fixtureRoute('/settings'), '/settings');
console.log(JSON.stringify({ result: 'PASS', deterministicIds: ids.length, collisions: 0, coherentForeignKeys: true, preservedExternalAndLocalIds: true }));
