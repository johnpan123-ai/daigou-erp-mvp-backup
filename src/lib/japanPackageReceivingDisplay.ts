import type { ProductVariant } from './db';

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
  components: readonly T[],
): T[] => components
  .map((component, originalIndex) => ({
    component,
    originalIndex,
    sku: (component.myacg_item_code || '').trim(),
  }))
  .sort((left, right) => {
    if (left.sku && !right.sku) return -1;
    if (!left.sku && right.sku) return 1;
    if (!left.sku && !right.sku) return left.originalIndex - right.originalIndex;

    const skuOrder = left.sku.localeCompare(right.sku, 'en', {
      numeric: true,
      sensitivity: 'base',
    });
    return skuOrder || left.originalIndex - right.originalIndex;
  })
  .map(({ component }) => component);
