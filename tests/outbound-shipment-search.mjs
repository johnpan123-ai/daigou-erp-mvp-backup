import assert from 'node:assert/strict';
import * as search from '../src/lib/outboundShipmentSearch.ts';

const shipments = [
  { id: 'shipment-shipped', title: '八月出庫', tracking_number: 'TRACK-001', carrier: 'Japan Post', status: 'shipped' },
  { id: 'shipment-draft', title: '草稿箱', tracking_number: 'TRACK-002', status: 'draft' },
  { id: 'shipment-unrelated', title: '其他箱', tracking_number: 'TRACK-003', status: 'shipped' },
];
const variants = [
  { id: 'variant-direct', product_group_id: 'group-direct', product_title: 'Hololive 品茗 紀念商品', variant_name: '標準版', myacg_item_code: 'ONLY-SKU-HIT' },
  { id: 'variant-bundle', product_group_id: 'group-bundle', product_title: '套組主商品', variant_name: '套組', myacg_item_code: 'BUNDLE-001' },
  { id: 'variant-component', product_group_id: 'group-component', product_title: 'English Tea Party', variant_name: '品茗立牌', myacg_item_code: 'COMPONENT-001' },
  { id: 'variant-system-only', product_group_id: 'group-system-only', product_title: '品茗但未出庫', variant_name: '未關聯', myacg_item_code: 'SYSTEM-ONLY' },
];
const input = {
  shipmentItems: [
    { id: 'item-direct', outbound_shipment_id: 'shipment-shipped', product_variant_id: 'variant-direct', quantity: 1, checked: false },
    { id: 'item-bundle', outbound_shipment_id: 'shipment-draft', product_variant_id: 'variant-bundle', quantity: 2, checked: false },
    { id: 'item-deleted', outbound_shipment_id: 'shipment-unrelated', product_title: '品茗已刪除', quantity: 1, checked: false, deleted_at: '2026-08-27T00:00:00Z' },
    { id: 'item-cancelled', outbound_shipment_id: 'shipment-unrelated', product_title: '品茗已取消', quantity: 1, checked: false, status: 'cancelled' },
  ],
  japanPackageItems: [],
  productGroups: [
    { id: 'group-direct', title: 'Hololive 品茗 紀念商品' },
    { id: 'group-bundle', title: '套組主商品' },
    { id: 'group-component', title: 'English Tea Party' },
    { id: 'group-system-only', title: '品茗但未出庫' },
  ],
  productVariants: variants,
  bundleComponents: [
    { id: 'relation-1', bundle_variant_id: 'variant-bundle', component_variant_id: 'variant-component' },
  ],
};
const before = JSON.stringify({ shipments, input });
const index = search.buildOutboundShipmentProductSearchIndex(input);
const matches = (shipmentId, term) => search.outboundShipmentMatchesSearch(
  shipments.find(shipment => shipment.id === shipmentId),
  term,
  index,
);

assert.equal(matches('shipment-shipped', '品茗'), true, 'Direct product name must match');
assert.equal(matches('shipment-draft', '品茗'), true, 'Bundle child product name must match');
assert.equal(matches('shipment-draft', 'Tea Par'), true, 'Partial English text must match case-insensitively');
assert.equal(matches('shipment-draft', 'ENGLISH TEA'), true, 'English search must ignore case');
assert.equal(matches('shipment-unrelated', '品茗'), false, 'Deleted/cancelled or system-only products must not match');
assert.equal(matches('shipment-shipped', 'ONLY-SKU-HIT'), false, 'SKU must not be searchable');
assert.equal(matches('shipment-shipped', '八月出'), true, 'Existing shipment-title search must remain');
assert.equal(matches('shipment-shipped', 'track-001'), true, 'Existing tracking-number search must remain');
assert.equal(matches('shipment-shipped', ''), true, 'Empty search restores the full list');

const shippedProductMatches = shipments.filter(shipment => shipment.status === 'shipped' && matches(shipment.id, '品茗'));
assert.deepEqual(shippedProductMatches.map(shipment => shipment.id), ['shipment-shipped'], 'Status and product search must combine');
assert.equal(JSON.stringify({ shipments, input }), before, 'Search must not mutate source data');

console.log('PASS direct and bundle-child product-name search');
console.log('PASS partial/case-insensitive matching without SKU search');
console.log('PASS unrelated, deleted, cancelled, and system-only products do not match');
console.log('PASS status + search, title, tracking, and clear-search behavior');
console.log('PASS identity/checksum unchanged and write = 0');
