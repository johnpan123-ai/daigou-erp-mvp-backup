import type { InventoryItem, ProductVariant } from '../lib/db';
import { normalizeWacaText, type MasterVariant } from './orderCore';

/** Evidence captured from a MyACG catalog row, never inferred from a title or code shape. */
export interface MyAcgMasterLink {
  mainCode: string;
  childCode: string;
  productGroupId: string;
  productVariantId: string;
  variantTitle: string;
  sourceFile: string;
  observedAt: string;
}

export interface LinkImportResult {
  links: MyAcgMasterLink[];
  accepted: number;
  missingVariant: number;
  ambiguousVariant: number;
  missingParent: number;
}

export function linksFromMyAcgInventory(
  rows: readonly InventoryItem[],
  variants: readonly ProductVariant[],
  sourceFile: string,
  observedAt: string,
): LinkImportResult {
  const byChild = new Map<string, ProductVariant[]>();
  for (const variant of variants) {
    const child = normalizeWacaText(variant.myacg_item_code);
    byChild.set(child, [...(byChild.get(child) ?? []), variant]);
  }
  const links = new Map<string, MyAcgMasterLink>();
  let missingVariant = 0, ambiguousVariant = 0, missingParent = 0;
  for (const row of rows) {
    const mainCode = normalizeWacaText(row.myacg_parent_code ?? '');
    const childCode = normalizeWacaText(row.myacg_item_code);
    if (!mainCode || !childCode || !mainCode.startsWith('GP')) {
      missingParent += 1;
      continue;
    }
    const candidates = byChild.get(childCode) ?? [];
    if (!candidates.length) { missingVariant += 1; continue; }
    if (candidates.length !== 1 || !candidates[0].product_group_id) {
      ambiguousVariant += 1;
      continue;
    }
    const variant = candidates[0];
    const link: MyAcgMasterLink = {
      mainCode, childCode, productGroupId: variant.product_group_id!,
      productVariantId: variant.id, variantTitle: row.raw_variant_name || variant.raw_variant_name || variant.variant_name,
      sourceFile, observedAt,
    };
    const prior = links.get(childCode);
    if (prior && (prior.mainCode !== link.mainCode || prior.productVariantId !== link.productVariantId)) {
      throw new Error(`MYACG_PARENT_CHILD_CONFLICT:${childCode}`);
    }
    links.set(childCode, link);
  }
  return { links: [...links.values()], accepted: links.size, missingVariant, ambiguousVariant, missingParent };
}

export function mergeMyAcgMasterLinks(
  existing: readonly MyAcgMasterLink[],
  incoming: readonly MyAcgMasterLink[],
): MyAcgMasterLink[] {
  const byChild = new Map(existing.map(link => [link.childCode, link]));
  for (const link of incoming) {
    const prior = byChild.get(link.childCode);
    if (prior && (prior.mainCode !== link.mainCode || prior.productVariantId !== link.productVariantId || prior.productGroupId !== link.productGroupId)) {
      throw new Error(`MYACG_PARENT_CHILD_CONFLICT:${link.childCode}`);
    }
    byChild.set(link.childCode, link);
  }
  return [...byChild.values()].sort((a, b) => a.childCode.localeCompare(b.childCode));
}

export function buildWacaMasterReference(
  variants: readonly ProductVariant[],
  links: readonly MyAcgMasterLink[],
): MasterVariant[] {
  const byVariant = new Map(links.map(link => [link.productVariantId, link]));
  return variants.map(variant => {
    const link = byVariant.get(variant.id);
    const validLink = link
      && link.childCode === normalizeWacaText(variant.myacg_item_code)
      && link.productGroupId === variant.product_group_id;
    return {
      mainCode: validLink ? link.mainCode : '',
      childCode: variant.myacg_item_code,
      variantId: variant.id,
      productGroupId: variant.product_group_id ?? '',
      productTitle: variant.product_title,
      variantTitle: validLink ? link.variantTitle : variant.raw_variant_name || variant.variant_name,
      active: (variant as ProductVariant & { deleted_at?: string | null }).deleted_at == null,
    };
  });
}
