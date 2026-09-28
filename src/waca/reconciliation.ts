import type { ProductVariant } from '../lib/db';
import { isEffectiveWacaStatus } from './orderCore';
import type { NextWacaSnapshot, WacaCutoverAudit } from './nextStorage';

export function purchaseRecordsWacaQuantity(variant: ProductVariant, nextMode: boolean): number {
  const manual = Number(variant.waca_manual_adjustment ?? 0);
  if (nextMode) return Math.max(0, Number(variant.waca_auto_quantity ?? 0) + manual);
  const legacy = (variant as ProductVariant & { waca_quantity?: number }).waca_quantity;
  const auto = variant.waca_auto_quantity;
  return Math.max(0, auto !== undefined && auto !== null && auto >= 0 ? auto + manual : legacy ?? manual);
}

export function buildWacaCutoverAudit(
  variants: readonly ProductVariant[], priorDerived: ReadonlyMap<string, number>,
  nextDerived: ReadonlyMap<string, number>, cutoverAt: string,
): WacaCutoverAudit[] {
  return variants.map(variant => {
    const legacyAutoQuantity = Number(variant.waca_auto_quantity ?? 0);
    const unverifiedPreCutoverManualQuantity = Number(variant.waca_manual_adjustment ?? 0);
    const legacyWacaQuantity = legacyAutoQuantity
      - (priorDerived.get(variant.id) ?? 0) + unverifiedPreCutoverManualQuantity;
    const newOrderDerivedQuantity = nextDerived.get(variant.id) ?? 0;
    return {
      productVariantId: variant.id, sku: variant.myacg_item_code,
      productTitle: variant.product_title, variantTitle: variant.variant_name,
      legacyWacaQuantity, legacyAutoQuantity, unverifiedPreCutoverManualQuantity,
      newOrderDerivedQuantity, difference: newOrderDerivedQuantity - legacyWacaQuantity, cutoverAt,
    };
  });
}

export interface WacaReconciliationIssue {
  variantId: string;
  sku: string;
  productTitle: string;
  variantTitle: string;
  sourceQuantity: number;
  storedQuantity: number;
  displayedQuantity: number;
  difference: number;
  reason: 'AUTO_MISMATCH' | 'DISPLAY_MISMATCH' | 'MAPPING_MISMATCH' | 'CUTOVER_MISSING';
}

export interface WacaReconciliation {
  status: 'PASS' | 'FAIL';
  passed: number;
  total: number;
  effectiveQuantity: number;
  issues: WacaReconciliationIssue[];
}

/** Independent read-back of saved ledger, mapping, variant store and Purchase Records quantity. */
export function reconcileWacaReadback(
  snapshot: NextWacaSnapshot, variants: readonly ProductVariant[],
): WacaReconciliation {
  const variantById = new Map(variants.map(row => [row.id, row]));
  const orders = new Map(snapshot.orders.map(row => [row.key, row]));
  const mappings = new Map(snapshot.mappings.map(row => [row.feature, row]));
  const source = new Map<string, number>();
  const featureToVariant = new Map<string, string>();
  const badMapping = new Set<string>();
  let effectiveQuantity = 0;
  for (const item of snapshot.items) {
    if (item.productVariantId) featureToVariant.set(item.feature, item.productVariantId);
    const order = orders.get(item.orderKey);
    if (!order || !isEffectiveWacaStatus(order.status)) continue;
    effectiveQuantity += item.quantity;
    if (!item.productVariantId) continue;
    source.set(item.productVariantId, (source.get(item.productVariantId) ?? 0) + item.quantity);
    if (mappings.get(item.feature)?.productVariantId !== item.productVariantId) badMapping.add(item.productVariantId);
  }
  const relevant = new Set([...source.keys(), ...variants.filter(row => Number(row.waca_auto_quantity ?? 0) !== 0).map(row => row.id)]);
  const issues: WacaReconciliationIssue[] = [];
  for (const id of relevant) {
    const variant = variantById.get(id);
    if (!variant) continue;
    const sourceQuantity = source.get(id) ?? 0;
    const storedQuantity = Number(variant.waca_auto_quantity ?? 0);
    const manual = Number(variant.waca_manual_adjustment ?? 0);
    const displayedQuantity = purchaseRecordsWacaQuantity(variant, true);
    const expectedDisplay = sourceQuantity + manual;
    const reason = !snapshot.cutoverAudit?.length ? 'CUTOVER_MISSING'
      : sourceQuantity !== storedQuantity ? 'AUTO_MISMATCH'
        : displayedQuantity !== expectedDisplay ? 'DISPLAY_MISMATCH'
          : badMapping.has(id) ? 'MAPPING_MISMATCH' : null;
    if (reason) issues.push({ variantId: id, sku: variant.myacg_item_code,
      productTitle: variant.product_title, variantTitle: variant.variant_name,
      sourceQuantity, storedQuantity, displayedQuantity,
      difference: sourceQuantity - storedQuantity, reason });
  }
  const failedVariants = new Set(issues.map(row => row.variantId));
  const mappedVariants = new Set(featureToVariant.values());
  const extraVariants = [...relevant].filter(id => !mappedVariants.has(id));
  const total = featureToVariant.size + extraVariants.length;
  const failed = [...featureToVariant.values()].filter(id => failedVariants.has(id)).length
    + extraVariants.filter(id => failedVariants.has(id)).length;
  return { status: issues.length ? 'FAIL' : 'PASS', passed: total - failed,
    total, effectiveQuantity, issues };
}
