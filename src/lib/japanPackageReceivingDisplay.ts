import type { JapanPackageItem, ProductVariant } from './db';

const FIXED_STOREFRONT_PREFIX = '【小河馬日本代購】';
const GENERIC_COMPONENT_NAMES = new Set(['單品', '單一品項']);

export const normalizeJapanPackageReceivingName = (value: string): string => {
  const original = value.trim();
  if (!original.startsWith(FIXED_STOREFRONT_PREFIX)) return original;

  let normalized = original.slice(FIXED_STOREFRONT_PREFIX.length).trimStart();
  const hasImmediatePreorderMarker = /^預購(?=\s|$)/u.test(normalized);
  normalized = normalized.replace(/^預購(?=\s|$)/u, '').trimStart();
  if (hasImmediatePreorderMarker) {
    normalized = normalized.replace(/^(?:\d{2,4}年)?\d{1,2}月(?=\s|$)/u, '').trimStart();
  }
  return normalized || original;
};

export const getJapanPackageReceivingBundleComponentName = (input: {
  productTitle: string;
  variantTitle: string;
  categoryTitle?: string;
}): string => {
  const productTitle = normalizeJapanPackageReceivingName(input.productTitle);
  const variantTitle = normalizeJapanPackageReceivingName(input.variantTitle);
  const categoryTitle = normalizeJapanPackageReceivingName(input.categoryTitle || '');
  const hasSpecificCategory = categoryTitle && !GENERIC_COMPONENT_NAMES.has(categoryTitle);
  const hasSpecificVariant = variantTitle && !GENERIC_COMPONENT_NAMES.has(variantTitle);

  if (hasSpecificCategory) {
    return hasSpecificVariant && variantTitle !== categoryTitle
      ? `${categoryTitle}｜${variantTitle}`
      : categoryTitle;
  }
  if (hasSpecificVariant) return variantTitle;
  return productTitle || variantTitle || '未命名商品';
};

export const sortJapanPackageReceivingBundleComponentsBySku = <T extends Pick<ProductVariant, 'myacg_item_code'>>(
  components: readonly T[]
): T[] => components
  .map((component, originalIndex) => ({
    component,
    originalIndex,
    sku: (component.myacg_item_code || '').trim()
  }))
  .sort((left, right) => {
    if (left.sku && !right.sku) return -1;
    if (!left.sku && right.sku) return 1;
    if (!left.sku && !right.sku) return left.originalIndex - right.originalIndex;

    const skuOrder = left.sku.localeCompare(right.sku, 'en', {
      numeric: true,
      sensitivity: 'base'
    });
    return skuOrder || left.originalIndex - right.originalIndex;
  })
  .map(({ component }) => component);

export const sortJapanPackageReceivingItemsByBatchThenSku = <T extends Pick<
  JapanPackageItem,
  'purchase_batch_id' | 'product_variant_id' | 'sku'
>>(
  items: readonly T[],
  purchaseBatchIds: readonly string[],
  variantSkuById: ReadonlyMap<string, string>
): T[] => {
  const batchOrder = new Map<string, number>();
  purchaseBatchIds.forEach((batchId, index) => {
    if (!batchOrder.has(batchId)) batchOrder.set(batchId, index);
  });
  let nextBatchIndex = batchOrder.size;
  items.forEach(item => {
    const batchId = item.purchase_batch_id;
    if (batchId && !batchOrder.has(batchId)) {
      batchOrder.set(batchId, nextBatchIndex);
      nextBatchIndex += 1;
    }
  });

  return items
    .map((item, originalIndex) => ({
      item,
      originalIndex,
      batchIndex: item.purchase_batch_id
        ? (batchOrder.get(item.purchase_batch_id) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER,
      sku: (
        item.sku
        || (item.product_variant_id ? variantSkuById.get(item.product_variant_id) : '')
        || ''
      ).trim()
    }))
    .sort((left, right) => {
      const batchOrderResult = left.batchIndex - right.batchIndex;
      if (batchOrderResult !== 0) return batchOrderResult;
      if (left.sku && !right.sku) return -1;
      if (!left.sku && right.sku) return 1;
      if (!left.sku && !right.sku) return left.originalIndex - right.originalIndex;
      const skuOrder = left.sku.localeCompare(right.sku, 'en', {
        numeric: true,
        sensitivity: 'base'
      });
      return skuOrder || left.originalIndex - right.originalIndex;
    })
    .map(({ item }) => item);
};

type ClipboardWriter = (value: string) => Promise<void>;

export const copyJapanPackageReceivingGroupTitle = (
  title: string,
  writeClipboard: ClipboardWriter = value => navigator.clipboard.writeText(value)
): Promise<void> => writeClipboard(title);
