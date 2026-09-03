import type { ProductCategory, ProductGroup, ProductVariant } from './db';

export interface BundleComponentDisplay {
  productTitle: string;
  variantTitle: string;
  sku: string;
  label: string;
}

interface BundleComponentDisplayContext {
  categoryById: ReadonlyMap<string, ProductCategory>;
  productGroupById: ReadonlyMap<string, ProductGroup>;
  fallbackGroup?: ProductGroup | null;
}

const GENERIC_PRODUCT_TITLES = new Set(['單品', '單一品項']);

const parseLegacySingleItemName = (name: string) => {
  const match = name.match(/^(.+?)\s+(單一品項|單品)$/);
  if (!match) return null;
  return {
    productTitle: match[1].trim(),
    variantTitle: match[2],
  };
};

export const getBundleComponentDisplay = (
  variant: ProductVariant,
  context: BundleComponentDisplayContext,
): BundleComponentDisplay => {
  const productCategory = variant.product_category_id
    ? context.categoryById.get(variant.product_category_id)
    : undefined;
  const categoryTitle = productCategory?.title?.trim() || '';
  const rawVariantTitle = (variant.variant_name || variant.raw_variant_name || '').trim();
  const legacySingleItem = !categoryTitle ? parseLegacySingleItemName(rawVariantTitle) : null;
  const groupId = variant.product_group_id || productCategory?.product_group_id || '';
  const ownerGroup = context.productGroupById.get(groupId) || context.fallbackGroup;

  const productTitle = (
    categoryTitle && !GENERIC_PRODUCT_TITLES.has(categoryTitle)
      ? categoryTitle
      : legacySingleItem?.productTitle
        || ownerGroup?.title?.trim()
        || variant.product_title?.trim()
  ) || '未命名商品';
  const variantTitle = legacySingleItem?.variantTitle || rawVariantTitle || '單一品項';
  const sku = (variant.myacg_item_code || '').trim();

  return {
    productTitle,
    variantTitle,
    sku,
    label: `${productTitle}｜${variantTitle}`,
  };
};
