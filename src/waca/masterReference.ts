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

export interface MyAcgMasterLinkDelta {
  links: MyAcgMasterLink[];
  inserted: number;
  updated: number;
  unchanged: number;
}

const comparableMasterLink = (link: MyAcgMasterLink) => JSON.stringify({
  mainCode: link.mainCode,
  childCode: link.childCode,
  productGroupId: link.productGroupId || '',
  productVariantId: link.productVariantId || '',
  productTitle: link.productTitle || '',
  variantTitle: link.variantTitle || '',
  // File names and observation timestamps are diagnostic provenance, not the
  // durable parent/Variant relationship. Re-observing the same relationship
  // in a newly downloaded catalog must not turn every master link into a
  // business mutation.
});

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

/**
 * Plan only the durable master-link rows whose semantic evidence changed.
 * Re-observing the same relationship is a no-op even when the import file or
 * timestamp differs. Provenance is retained whenever a relationship itself
 * is inserted or updated, but provenance alone never triggers an update.
 */
export function planMyAcgMasterLinkDelta(
  existing: readonly MyAcgMasterLink[],
  incoming: readonly MyAcgMasterLink[],
): MyAcgMasterLinkDelta {
  const current = new Map(existing.map(link => [link.childCode, link]));
  const merged = new Map(mergeMyAcgMasterLinks(existing, incoming).map(link => [link.childCode, link]));
  const links: MyAcgMasterLink[] = [];
  let inserted = 0, updated = 0, unchanged = 0;
  for (const childCode of new Set(incoming.map(link => link.childCode))) {
    const target = merged.get(childCode);
    if (!target) throw new Error(`MYACG_MASTER_DELTA_TARGET_MISSING:${childCode}`);
    const prior = current.get(childCode);
    if (!prior) { inserted += 1; links.push(target); continue; }
    if (comparableMasterLink(prior) === comparableMasterLink(target)) { unchanged += 1; continue; }
    updated += 1;
    links.push(target);
  }
  return { links: links.sort((a, b) => a.childCode.localeCompare(b.childCode)), inserted, updated, unchanged };
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
      productTitle: variant.product_title || link.productTitle || '',
      variantTitle: link.variantTitle || variant.raw_variant_name || variant.variant_name,
      variantTitles: [link.variantTitle, variant.raw_variant_name ?? '', variant.variant_name].filter(Boolean),
      active: (variant as ProductVariant & { deleted_at?: string | null }).deleted_at == null,
      sourceFile: link.sourceFile,
    });
  }
  for (const variant of variants) {
    if (linkedChildren.has(normalizeWacaText(variant.myacg_item_code))) continue;
    result.push({ mainCode: '', childCode: variant.myacg_item_code, variantId: variant.id,
      productGroupId: variant.product_group_id ?? '', productTitle: variant.product_title,
      variantTitle: variant.raw_variant_name || variant.variant_name,
      variantTitles: [variant.raw_variant_name ?? '', variant.variant_name].filter(Boolean),
      active: (variant as ProductVariant & { deleted_at?: string | null }).deleted_at == null,
      sourceFile: '',
    });
  }
  return result;
}
