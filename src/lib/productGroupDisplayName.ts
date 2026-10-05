import type { ProductGroup, ProductVariant } from './db';

/** Presentation only: never use this selector to rewrite search or persisted fields. */
export const productGroupDisplayName = (group: Pick<ProductGroup, 'normalized_title' | 'title'>): string =>
  group.normalized_title || group.title;

export const purchaseRecordsGroupUrl = (groupId: string): string =>
  `/purchase-records?${new URLSearchParams({ productGroup: groupId })}`;

/** Existing second-level detail route, addressed only by canonical ProductGroup ID. */
export const purchaseRecordsDetailUrl = (groupId: string): string =>
  `/purchase-records/${encodeURIComponent(groupId)}`;

/** Inventory-only Product Master rows are valid WACA identities, but are not
 * Purchase Records until the user explicitly projects them. Legacy rows have
 * no source marker and remain projected for backward compatibility. */
export const purchaseRecordGroupIds = (variants: readonly ProductVariant[]): ReadonlySet<string> =>
  new Set(variants.filter(variant => variant.source !== 'inventory_import')
    .map(variant => variant.product_group_id).filter((id): id is string => Boolean(id)));

/** null means no scope; empty/duplicate parameters deliberately match no product. */
export const purchaseRecordsGroupScope = (search: string): string | null => {
  const values = new URLSearchParams(search).getAll('productGroup');
  return values.length === 0 ? null : values.length === 1 ? values[0] : '';
};
