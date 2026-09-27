import * as XLSX from 'xlsx';
import { normalizeWacaText, type MasterVariant } from './orderCore.ts';

export interface ErpVariantReference {
  id: string;
  product_group_id: string;
  myacg_item_code: string;
  product_title: string;
  variant_name: string;
  raw_variant_name?: string;
  deleted_at?: string | null;
}

/** Read-only adapter for an actual MyACG export plus an ERP snapshot. */
export function buildWacaMasterReference(
  myacgBytes: ArrayBuffer | Uint8Array,
  erpVariants: readonly ErpVariantReference[],
): MasterVariant[] {
  const workbook = XLSX.read(myacgBytes, { type: 'array' });
  if (workbook.SheetNames.length !== 1) throw new Error('MYACG_MASTER_SHEET_COUNT_INVALID');
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[workbook.SheetNames[0]], { defval: '', raw: false });
  const byChild = new Map<string, ErpVariantReference[]>();
  for (const variant of erpVariants) {
    const key = normalizeWacaText(variant.myacg_item_code);
    byChild.set(key, [...(byChild.get(key) ?? []), variant]);
  }
  const matchedIds = new Set<string>();
  const result: MasterVariant[] = [];
  for (const row of rows) {
    const mainCode = String(row['主編號(多規格編號)'] ?? '');
    const childCode = String(row['子編號(商品編號)'] ?? '');
    if (!mainCode || !childCode) continue;
    for (const variant of byChild.get(normalizeWacaText(childCode)) ?? []) {
      matchedIds.add(variant.id);
      result.push({
        mainCode, childCode, variantId: variant.id, productGroupId: variant.product_group_id,
        productTitle: String(row['商品名稱'] || variant.product_title),
        variantTitle: String(row['規格/項目'] || variant.raw_variant_name || variant.variant_name),
        active: !variant.deleted_at,
      });
    }
  }
  // A current ERP variant can still be directly identified by its child code
  // if it is absent from this particular MyACG export. Never invent a parent.
  for (const variant of erpVariants) {
    if (matchedIds.has(variant.id)) continue;
    result.push({
      mainCode: '', childCode: variant.myacg_item_code,
      variantId: variant.id, productGroupId: variant.product_group_id,
      productTitle: variant.product_title, variantTitle: variant.raw_variant_name || variant.variant_name,
      active: !variant.deleted_at,
    });
  }
  return result;
}
