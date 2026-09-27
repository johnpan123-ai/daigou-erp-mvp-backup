import type { InventoryItem, ProductVariant } from '../lib/db';
import { normalizeWacaText, type MasterVariant } from './orderCore';

/** Evidence captured from a MyACG catalog row, never inferred from a title or code shape. */
export interface MyAcgMasterLink {
  mainCode: string;
  childCode: string;
  productGroupId: string;
  productVariantId: string;
  productTitle?: string;
  variantTitle: string;
  sourceFile: string;
  sourceFiles?: string[];
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
    if (!candidates.length) missingVariant += 1;
    if (candidates.length > 1) ambiguousVariant += 1;
    const variant = candidates.length === 1 ? candidates[0] : null;
    const link: MyAcgMasterLink = {
      mainCode, childCode, productGroupId: variant?.product_group_id ?? '',
      productVariantId: variant?.id ?? '', productTitle: row.product_title,
      variantTitle: row.raw_variant_name || variant?.raw_variant_name || variant?.variant_name || '',
      sourceFile, sourceFiles: [sourceFile], observedAt,
    };
    const prior = links.get(childCode);
    if (prior && prior.mainCode !== link.mainCode) {
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
    if (prior && (prior.mainCode !== link.mainCode
      || (prior.productVariantId && link.productVariantId && prior.productVariantId !== link.productVariantId)
      || (prior.productGroupId && link.productGroupId && prior.productGroupId !== link.productGroupId))) {
      throw new Error(`MYACG_PARENT_CHILD_CONFLICT:${link.childCode}`);
    }
    byChild.set(link.childCode, {
      ...prior, ...link,
      productGroupId: link.productGroupId || prior?.productGroupId || '',
      productVariantId: link.productVariantId || prior?.productVariantId || '',
      productTitle: link.productTitle || prior?.productTitle || '',
      variantTitle: link.variantTitle || prior?.variantTitle || '',
      sourceFiles: [...new Set([...(prior?.sourceFiles ?? (prior?.sourceFile ? [prior.sourceFile] : [])),
        ...(link.sourceFiles ?? [link.sourceFile])])],
    });
  }
  return [...byChild.values()].sort((a, b) => a.childCode.localeCompare(b.childCode));
}

export function buildWacaMasterReference(
  variants: readonly ProductVariant[],
  links: readonly MyAcgMasterLink[],
): MasterVariant[] {
  const byChild = new Map<string, ProductVariant[]>();
  for (const variant of variants) {
    const child = normalizeWacaText(variant.myacg_item_code);
    byChild.set(child, [...(byChild.get(child) ?? []), variant]);
  }
  const linkedChildren = new Set<string>();
  const result: MasterVariant[] = [];
  for (const link of links) {
    const child = normalizeWacaText(link.childCode);
    linkedChildren.add(child);
    const candidates = byChild.get(child) ?? [];
    if (!candidates.length) {
      result.push({ mainCode: link.mainCode, childCode: link.childCode, variantId: '',
        productGroupId: '', productTitle: link.productTitle ?? '', variantTitle: link.variantTitle,
        active: true, sourceFile: link.sourceFile });
      continue;
    }
    for (const variant of candidates) result.push({
      mainCode: link.mainCode, childCode: link.childCode, variantId: variant.id,
      productGroupId: variant.product_group_id ?? '',
      productTitle: link.productTitle || variant.product_title,
      variantTitle: link.variantTitle || variant.raw_variant_name || variant.variant_name,
      active: (variant as ProductVariant & { deleted_at?: string | null }).deleted_at == null,
      sourceFile: link.sourceFile,
    });
  }
  for (const variant of variants) {
    if (linkedChildren.has(normalizeWacaText(variant.myacg_item_code))) continue;
    result.push({ mainCode: '', childCode: variant.myacg_item_code, variantId: variant.id,
      productGroupId: variant.product_group_id ?? '', productTitle: variant.product_title,
      variantTitle: variant.raw_variant_name || variant.variant_name,
      active: (variant as ProductVariant & { deleted_at?: string | null }).deleted_at == null,
      sourceFile: '',
    });
  }
  return result;
}
