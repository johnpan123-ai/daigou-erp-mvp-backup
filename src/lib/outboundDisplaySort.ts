export type OutboundDisplaySortMode = 'original' | 'sku' | 'name';

export interface OutboundDisplayGroup<T> {
  groupName: string;
  items: T[];
}

const compareSku = (a: string, b: string, original: boolean) => {
  if (!a && b) return 1;
  if (a && !b) return -1;
  return a.localeCompare(b, 'ja', original ? { numeric: true } : { numeric: true, sensitivity: 'base' });
};

/** Presentation only. Never reorder or mutate the persisted shipment item array. */
export function sortOutboundDisplayGroups<T>(
  groups: OutboundDisplayGroup<T>[],
  mode: OutboundDisplaySortMode,
  received: boolean,
  skuOf: (item: T) => string,
  nameOf: (item: T, fallback: string) => string,
): OutboundDisplayGroup<T>[] {
  const entries = groups.map(({ groupName, items }) => ({
    groupName,
    items: received || mode === 'sku'
      ? items.map((item, index) => ({ item, index })).sort((a, b) =>
          compareSku(skuOf(a.item), skuOf(b.item), mode === 'original') || a.index - b.index
        ).map(({ item }) => item)
      : items,
  }));

  if (mode === 'original' && !received) return entries;
  return entries.map((entry, index) => ({ entry, index })).sort((a, b) => {
    const comparison = mode === 'name'
      ? nameOf(a.entry.items[0], a.entry.groupName).localeCompare(
          nameOf(b.entry.items[0], b.entry.groupName), 'zh-Hant', { numeric: true, sensitivity: 'base' }
        )
      : compareSku(
          a.entry.items.map(skuOf).find(Boolean) || '',
          b.entry.items.map(skuOf).find(Boolean) || '',
          mode === 'original',
        );
    return comparison || a.index - b.index;
  }).map(({ entry }) => entry);
}
