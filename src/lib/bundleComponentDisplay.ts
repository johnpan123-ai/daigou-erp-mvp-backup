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
    variantTitle: match[2]
  };
};

export const getBundleComponentDisplay = (
  variant: ProductVariant,
  context: BundleComponentDisplayContext
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
    label: `${productTitle}｜${variantTitle}`
  };
};

const isGenericTitle = (value: string) => !value || GENERIC_PRODUCT_TITLES.has(value);

/**
 * Short name for a bundle's physical component in the outbound list:
 * own category / variant name only. Never the owning group's storefront
 * listing title (e.g. 【小河馬日本代購】預購 26年12月 …), which is what the
 * generic label falls back to when a component has no specific category.
 */
export const getBundleComponentShortLabel = (
  variant: ProductVariant,
  context: Pick<BundleComponentDisplayContext, 'categoryById'>
): string => {
  const productCategory = variant.product_category_id
    ? context.categoryById.get(variant.product_category_id)
    : undefined;
  const categoryTitle = productCategory?.title?.trim() || '';
  const rawVariantTitle = (variant.variant_name || variant.raw_variant_name || '').trim();
  const legacySingleItem = !categoryTitle ? parseLegacySingleItemName(rawVariantTitle) : null;
  const productTitle = !isGenericTitle(categoryTitle) ? categoryTitle : legacySingleItem?.productTitle || '';
  const variantTitle = legacySingleItem?.variantTitle || rawVariantTitle;
  if (productTitle && !isGenericTitle(variantTitle) && variantTitle !== productTitle) return `${productTitle}｜${variantTitle}`;
  return productTitle || (!isGenericTitle(variantTitle) ? variantTitle : '') || variantTitle || '單一品項';
};
