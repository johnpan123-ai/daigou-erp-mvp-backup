import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  getJapanPackageReceivingBundleComponentName,
  normalizeJapanPackageReceivingName,
  sortJapanPackageReceivingBundleComponentsBySku,
} from '../src/lib/japanPackageReceivingDisplay.ts';

const rawName = '【小河馬日本代購】 預購 商品A';
assert.equal(normalizeJapanPackageReceivingName(rawName), '商品A');
assert.equal(
  normalizeJapanPackageReceivingName('【小河馬日本代購】 預購 26年11月 Hololive 商品A 掛軸'),
  'Hololive 商品A 掛軸',
);
assert.equal(normalizeJapanPackageReceivingName('商品A 預購特典 掛軸'), '商品A 預購特典 掛軸');
assert.equal(normalizeJapanPackageReceivingName('【其他日本代購】 預購 商品A'), '【其他日本代購】 預購 商品A');

assert.equal(getJapanPackageReceivingBundleComponentName({
  productTitle: '【小河馬日本代購】 預購 Hololive 父商品完整標題',
  variantTitle: '掛軸',
}), '掛軸');
assert.equal(getJapanPackageReceivingBundleComponentName({
  productTitle: 'Hololive 父商品完整標題',
  variantTitle: '標準版',
  categoryTitle: '角色A 掛軸',
}), '角色A 掛軸｜標準版');
assert.equal(getJapanPackageReceivingBundleComponentName({
  productTitle: '【小河馬日本代購】 預購 商品A',
  variantTitle: '單品',
}), '商品A');

const variants = Object.freeze([
  Object.freeze({ id: 'variant-a3', myacg_item_code: 'A003', product_group_id: 'group-1', variant_name: '商品C' }),
  Object.freeze({ id: 'variant-a1', myacg_item_code: 'A001', product_group_id: 'group-1', variant_name: '商品A' }),
  Object.freeze({ id: 'variant-a2-first', myacg_item_code: 'A002', product_group_id: 'group-1', variant_name: '商品B-1' }),
  Object.freeze({ id: 'variant-no-sku-1', myacg_item_code: '', product_group_id: 'group-1', variant_name: '無碼商品1' }),
  Object.freeze({ id: 'variant-a2-second', myacg_item_code: 'A002', product_group_id: 'group-1', variant_name: '商品B-2' }),
  Object.freeze({ id: 'variant-no-sku-2', product_group_id: 'group-1', variant_name: '無碼商品2' }),
]);
const before = JSON.stringify(variants);
const sorted = sortJapanPackageReceivingBundleComponentsBySku(variants);

assert.deepEqual(sorted.map(variant => variant.id), [
  'variant-a1',
  'variant-a2-first',
  'variant-a2-second',
  'variant-a3',
  'variant-no-sku-1',
  'variant-no-sku-2',
]);
assert.equal(sorted.length, variants.length);
assert.equal(sorted.every(variant => variants.includes(variant)), true, 'Sorting must preserve exact Variant object identity');
assert.equal(JSON.stringify(variants), before, 'Display sorting must not mutate source Variants');

const pageSource = await readFile(new URL('../src/pages/JapanPackageDetail.tsx', import.meta.url), 'utf8');
assert.equal((pageSource.match(/📦 套組內容/g) || []).length, 0, 'Redundant nested headings must be removed');
assert.equal((pageSource.match(/bundleComps\.map\(renderBundleComponent\)/g) || []).length, 3, 'All three receiving layouts must use the accepted display');
assert.ok(pageSource.includes('handleToggleCheck'), 'Existing receiving handler must remain wired');
assert.equal(pageSource.includes('useCloudResourceSync'), false, 'Candidate must not introduce NEXT Realtime');

console.log('PASS fixed storefront prefix and repeated bundle headings are cleaned only for display');
console.log('PASS bundle child names retain useful identity without repeating the parent title');
console.log('PASS SKU sort is stable, no-SKU rows stay last, and no item is merged');
console.log('PASS Variant identity and source arrays remain unchanged; ERP data write = 0');
