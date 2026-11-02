// Synthetic, private-data-free snapshot for outbound-receiving-save-race (no real names/customers).
// Usage: node tests/fixtures/generate-synthetic-outbound-race-snapshot.mjs <out.json>; then OUTBOUND_RACE_SNAPSHOT=<out.json> node tests/outbound-receiving-save-race.mjs
import { writeFileSync } from 'node:fs';
const at = '2026-10-20T00:00:00.000Z', T = '2f007c6b-deac-4b2c-a211-c8a3b14d23ce';
const productGroups = [], productVariants = [], inventory = [], japanPackages = [], japanPackageItems = [], outboundShipments = [], outboundShipmentItems = [];
for (let g = 0; g < 60; g++) {
  const title = `合成競態測試商品 ${g}`;
  productGroups.push({ id: `sg-${g}`, title, normalized_title: title, purchase_date: '2026/10/01', priority: 'Medium', closing_date: '2026/12/01', release_month: '2026/12', has_official_site: false, product_url: '', listing_type: '日本代購', show_in_purchase_list: true, created_at: at, updated_at: at });
  for (let v = 0; v < 3; v++) {
    const code = `SR${g}-${v}`;
    productVariants.push({ id: `sv-${g}-${v}`, product_group_id: `sg-${g}`, myacg_item_code: code, product_title: title, variant_name: `款 ${v}`, raw_variant_name: `款 ${v}`, note: '', sort_order: v, effective_myacg_quantity: 2 });
    inventory.push({ inventory_key: `${code}::款 ${v}`, myacg_item_code: code, product_title: title, raw_variant_name: `款 ${v}`, listing_type: '日本代購', final_price: 900, myacg_available_quantity: 1, myacg_sold_quantity: 2 });
  }
}
for (let p = 0; p < 6; p++) {
  japanPackages.push({ id: `sjp-${p}`, title: `合成包裹 ${p}`, status: 'confirmed', arrived_at: '2026-10-21', created_at: at, updated_at: at });
  for (let k = 0; k < 10; k++) { const g = p * 10 + k;
    japanPackageItems.push({ id: `sjpi-${p}-${k}`, japan_package_id: `sjp-${p}`, product_group_id: `sg-${g}`, product_variant_id: `sv-${g}-0`, product_title: productGroups[g].title, variant_name: '款 0', sku: `SR${g}-0`, quantity: 2, checked: true, checked_at: at, created_at: at, updated_at: at }); }
}
// One SKU arriving from two packages (two receiving sources for the same line label).
const b2Title = '合成 B2橫幅掛軸 測試品';
productGroups.push({ id: 'sg-b2', title: b2Title, normalized_title: b2Title, purchase_date: '2026/10/01', priority: 'Medium', closing_date: '2026/12/01', release_month: '2026/12', has_official_site: false, product_url: '', listing_type: '日本代購', show_in_purchase_list: true, created_at: at, updated_at: at });
productVariants.push({ id: 'sv-b2', product_group_id: 'sg-b2', myacg_item_code: 'SRB2-0', product_title: b2Title, variant_name: 'B2橫幅掛軸', raw_variant_name: 'B2橫幅掛軸', note: '', sort_order: 0 });
inventory.push({ inventory_key: 'SRB2-0::B2橫幅掛軸', myacg_item_code: 'SRB2-0', product_title: b2Title, raw_variant_name: 'B2橫幅掛軸', listing_type: '日本代購', final_price: 900, myacg_available_quantity: 1, myacg_sold_quantity: 2 });
for (const p of [0, 1]) japanPackageItems.push({ id: `sjpi-b2-${p}`, japan_package_id: `sjp-${p}`, product_group_id: 'sg-b2', product_variant_id: 'sv-b2', product_title: b2Title, variant_name: 'B2橫幅掛軸', sku: 'SRB2-0', quantity: 1, checked: true, checked_at: at, created_at: at, updated_at: at });
const ship = (id, title, status, from, n, extra = []) => {
  outboundShipments.push({ id, title, status, created_at: at, updated_at: at, ...(status === 'received' ? { received_at: at } : {}) });
  const sources = [...japanPackageItems.slice(from, from + n), ...extra];
  for (let k = 0; k < sources.length; k++) { const src = sources[k];
    outboundShipmentItems.push({ id: `${id}-i${k}`, outbound_shipment_id: id, japan_package_item_id: src.id, product_group_id: src.product_group_id, product_variant_id: src.product_variant_id, product_title: src.product_title, variant_name: src.variant_name, sku: src.sku, quantity: 1, checked: false, created_at: at, updated_at: at }); }
};
ship(T, '合成競態出庫單', 'received', 0, 14, japanPackageItems.filter(i => i.product_group_id === 'sg-b2'));
ship('sob-other', '合成其他出庫單', 'received', 20, 8);
const snap = { inventory, salesOrders: [], salesOrderItems: [], productGroups, productCategories: [], productVariants, purchaseBatches: [], purchaseBatchItems: [], privateOrders: [], privateOrderItems: [], bundleComponents: [], japanPackages, japanPackageItems, outboundShipments, outboundShipmentItems };
writeFileSync(process.argv[2], JSON.stringify(snap));
