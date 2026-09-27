import assert from 'node:assert/strict';
import { sortJapanPackageDisplayGroups } from '../src/components/japanPackageDisplaySort.ts';

const batches = [
  { id: 'late', date: '2026-09-10', created_at: '2026-09-10T01:00:00Z' },
  { id: 'early', date: '2026-09-02', created_at: '2026-09-02T01:00:00Z' },
];
const items = [
  { id: 'sku10', sku: 'SKU10', category_name: '壓克力立牌 C', purchase_batch_id: 'late', checked: true },
  { id: 'sku2', sku: 'SKU2', category_name: '壓克力立牌 A', purchase_batch_id: 'early', checked: false },
  { id: 'missing', category_name: '壓克力立牌 B', checked: false },
];
const groups = [
  { id: 'late-group', title: '壓克力立牌 B', items: [items[0], items[2]] },
  { id: 'early-group', title: '壓克力立牌 A', items: [items[1]] },
];
const skuMap = new Map();
const sorted = mode => sortJapanPackageDisplayGroups(groups, mode, batches, skuMap);
const ids = result => result.map(group => group.id);

assert.deepEqual(ids(sorted('original')), ['late-group', 'early-group']);
assert.deepEqual(sorted('original')[0].items.map(item => item.id), ['sku10', 'missing']);
assert.deepEqual(ids(sorted('sku')), ['early-group', 'late-group']);
assert.deepEqual(sorted('sku')[1].items.map(item => item.id), ['sku10', 'missing']);
assert.deepEqual(ids(sorted('order')), ['early-group', 'late-group']);
assert.deepEqual(ids(sorted('name')), ['early-group', 'late-group']);
assert.deepEqual(ids(sorted('similar-name')), ['early-group', 'late-group']);
assert.deepEqual(sorted('similar-name')[1].items.map(item => item.id), ['missing', 'sku10']);

const sameName = [
  { id: 'one', title: '壓克力立牌 A', items: [items[0]] },
  { id: 'two', title: '壓克力立牌 Ａ', items: [items[1]] },
];
assert.deepEqual(ids(sortJapanPackageDisplayGroups(sameName, 'similar-name', batches, skuMap)), ['one', 'two'], 'similar-name ties are stable');
for (const mode of ['sku', 'similar-name', 'order', 'name', 'original']) {
  const result = sorted(mode);
  assert.equal(result.flatMap(group => group.items).length, 3);
  for (const item of items) assert.ok(result.some(group => group.items.includes(item)), `${mode}: original item identity preserved`);
  assert.equal(items[0].checked, true, `${mode}: receiving state unchanged`);
  assert.equal(groups[0].items[0], items[0], `${mode}: input untouched`);
}
console.log('PASS default SKU natural order, similar-name and purchase chronology, original order, stable keys and receiving state');
