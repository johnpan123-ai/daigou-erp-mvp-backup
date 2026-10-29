import type { JapanPackage, JapanPackageItem } from './db';

/**
 * Read-only package search over the already-loaded package/item caches.
 * No network access: matches package fields and the package's item names/SKUs.
 */
export const normalizePackageSearchText = (value: string | null | undefined): string =>
  (value || '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export interface PackageSearchItem {
  item: JapanPackageItem;
  text: string;
}

/** One pass over the cached items; rebuilt only when the item cache changes. */
export function buildPackageItemSearchIndex(items: readonly JapanPackageItem[]): Map<string, PackageSearchItem[]> {
  const byPackage = new Map<string, PackageSearchItem[]>();
  for (const item of items) {
    if ((item as JapanPackageItem & { deleted_at?: string | null }).deleted_at || !item.japan_package_id) continue;
    const text = normalizePackageSearchText([item.product_title, item.category_name, item.variant_name, item.sku].filter(Boolean).join('\n'));
    const list = byPackage.get(item.japan_package_id);
    if (list) list.push({ item, text });
    else byPackage.set(item.japan_package_id, [{ item, text }]);
  }
  return byPackage;
}

export const packageFieldsMatch = (pkg: JapanPackage, query: string): boolean =>
  [pkg.title, pkg.vendor_name, pkg.tracking_number].some(field => normalizePackageSearchText(field).includes(query));

/** Every matching item of every package (an item in several packages is found in each). */
export function matchPackageItems(index: ReadonlyMap<string, PackageSearchItem[]>, query: string): Map<string, JapanPackageItem[]> {
  const matches = new Map<string, JapanPackageItem[]>();
  if (!query) return matches;
  for (const [packageId, entries] of index) {
    const hits = entries.filter(entry => entry.text.includes(query)).map(entry => entry.item);
    if (hits.length) matches.set(packageId, hits);
  }
  return matches;
}
