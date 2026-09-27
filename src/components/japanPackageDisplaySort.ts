import type { JapanPackageItem, PurchaseBatch } from '../lib/db';

export type JapanPackageDisplaySort = 'sku' | 'similar-name' | 'order' | 'name' | 'original';
export type JapanPackageDisplayGroup = { id: string; title: string; items: JapanPackageItem[] };

const natural = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
const skuNatural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const text = (value?: string) => (value || '').trim();
const similar = (value: string) => value.normalize('NFKC').toLocaleLowerCase('zh-Hant').replace(/[\s\p{P}\p{S}]+/gu, '');
const comparePresent = (left: string, right: string, collator: Intl.Collator) => {
  if (left && !right) return -1;
  if (!left && right) return 1;
  return collator.compare(left, right);
};
const itemName = (item: JapanPackageItem) => text([item.category_name, item.variant_name].filter(Boolean).join(' ')) || text(item.product_title);

/** Presentation-only ordering; no item identity or receiving state is rebuilt. */
export function sortJapanPackageDisplayGroups(
  groups: readonly JapanPackageDisplayGroup[],
  mode: JapanPackageDisplaySort,
  batches: readonly PurchaseBatch[],
  variantSkuById: ReadonlyMap<string, string>,
): JapanPackageDisplayGroup[] {
  if (mode === 'original') return [...groups];

  // The existing batch date and creation time are the only available order chronology.
  // Items within a batch retain their existing rendered order when no sequence exists.
  const batchRank = new Map(batches
    .map((batch, index) => ({ batch, index }))
    .sort((left, right) =>
      natural.compare(text(left.batch.date) || text(left.batch.created_at), text(right.batch.date) || text(right.batch.created_at))
      || natural.compare(text(left.batch.created_at), text(right.batch.created_at))
      || left.index - right.index)
    .map(({ batch }, index) => [batch.id, index] as const));
  const sku = (item: JapanPackageItem) => text(item.sku) || text(item.product_variant_id ? variantSkuById.get(item.product_variant_id) : '');
  const rank = (item: JapanPackageItem) => item.purchase_batch_id ? batchRank.get(item.purchase_batch_id) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;

  const sorted = groups.map((group, index) => {
    const items = group.items.map((item, itemIndex) => ({ item, itemIndex })).sort((left, right) => {
      let result = 0;
      if (mode === 'sku') result = comparePresent(sku(left.item), sku(right.item), skuNatural);
      if (mode === 'similar-name') result = natural.compare(similar(itemName(left.item)), similar(itemName(right.item)));
      if (mode === 'name') result = natural.compare(itemName(left.item), itemName(right.item));
      if (mode === 'order') result = rank(left.item) - rank(right.item);
      return result || left.itemIndex - right.itemIndex;
    }).map(({ item }) => item);
    return { group: { ...group, items }, index };
  });

  sorted.sort((left, right) => {
    let result = 0;
    if (mode === 'sku') {
      const firstSku = (items: JapanPackageItem[]) => items.map(sku).filter(Boolean).sort(skuNatural.compare)[0] || '';
      result = comparePresent(firstSku(left.group.items), firstSku(right.group.items), skuNatural);
    }
    if (mode === 'similar-name') result = natural.compare(similar(left.group.title), similar(right.group.title));
    if (mode === 'name') result = natural.compare(left.group.title, right.group.title);
    if (mode === 'order') result = Math.min(...left.group.items.map(rank)) - Math.min(...right.group.items.map(rank));
    return result || left.index - right.index;
  });
  return sorted.map(({ group }) => group);
}
