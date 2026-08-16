import type { ProductCategory, ProductGroup, ProductVariant, PurchaseBatch, PurchaseBatchItem } from './db';

interface PurchaseBatchLedgerContext {
  batchId: string;
  batchItems: readonly PurchaseBatchItem[];
  variants: readonly ProductVariant[];
  categoryById: ReadonlyMap<string, ProductCategory>;
  groupById: ReadonlyMap<string, ProductGroup>;
  getDisplayProductName: (variant: ProductVariant) => string;
}

interface MultipleBatchLedgerContext extends Omit<PurchaseBatchLedgerContext, 'batchId'> {
  batches: readonly PurchaseBatch[];
}

export const formatPurchaseBatchLedger = ({
  batchId,
  batchItems,
  variants,
  categoryById,
  groupById,
  getDisplayProductName,
}: PurchaseBatchLedgerContext): string => {
  const variantById = new Map(variants.map(variant => [variant.id, variant]));
  const ledgerRows = new Map<string, { name: string; quantity: number }>();

  for (const item of batchItems) {
    if (item.purchase_batch_id !== batchId) continue;
    const variant = variantById.get(item.product_variant_id);
    if (!variant) continue;

    const group = variant.product_group_id ? groupById.get(variant.product_group_id) : undefined;
    const groupTitle = group?.normalized_title
      || group?.title
      || variant.product_title
      || '未命名商品';
    const category = variant.product_category_id ? categoryById.get(variant.product_category_id) : undefined;
    const categoryTitle = category?.title && category.title !== '單品' ? category.title : '';
    const displayedProductName = getDisplayProductName(variant);
    const restName = categoryTitle && !displayedProductName.includes(categoryTitle)
      ? `${categoryTitle} - ${displayedProductName}`
      : displayedProductName;
    const name = `${groupTitle} - ${restName}`.replace(/\s*-\s*/g, '-');
    const existing = ledgerRows.get(name);

    if (existing) {
      existing.quantity += item.quantity;
    } else {
      ledgerRows.set(name, { name, quantity: item.quantity });
    }
  }

  return Array.from(ledgerRows.values())
    .map(row => `${row.name}\t${row.quantity}`)
    .join('\n');
};

export const formatMultiplePurchaseBatchLedgers = ({
  batches,
  ...context
}: MultipleBatchLedgerContext): string => batches
  .map(batch => formatPurchaseBatchLedger({ ...context, batchId: batch.id }))
  .filter(Boolean)
  .join('\n');
