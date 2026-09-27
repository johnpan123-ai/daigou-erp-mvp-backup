import type { ProductGroup } from './db';

/** Presentation only: never use this selector to rewrite search or persisted fields. */
export const productGroupDisplayName = (group: Pick<ProductGroup, 'normalized_title' | 'title'>): string =>
  group.normalized_title || group.title;

export const purchaseRecordsGroupUrl = (groupId: string): string =>
  `/purchase-records?${new URLSearchParams({ productGroup: groupId })}`;

/** null means no scope; empty/duplicate parameters deliberately match no product. */
export const purchaseRecordsGroupScope = (search: string): string | null => {
  const values = new URLSearchParams(search).getAll('productGroup');
  return values.length === 0 ? null : values.length === 1 ? values[0] : '';
};
