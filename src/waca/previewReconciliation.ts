import type { ProductVariant } from '../lib/db';
import { isEffectiveWacaStatus, type WacaItem, type WacaRepository, type WacaStatus } from './orderCore';
import { purchaseRecordsWacaQuantity } from './reconciliation';
import type { WacaCutoverState } from './backupFormat';

export interface WacaPreviewOrderTrace {
  key: string;
  orderNumber: string;
  status: WacaStatus;
  quantity: number;
  resolutionCode: WacaItem['resolution'];
  matchReason: string;
  included: boolean;
  excludedReason: string | null;
}

export interface WacaVariantPreviewComparison {
  variantId: string;
  baselineLabel: 'ERP1 原 WACA' | '目前 WACA';
  baselineQuantity: number;
  recomputedQuantity: number;
  difference: number;
  ledgerBeforeQuantity: number;
  ledgerAfterQuantity: number;
  includedOrderCount: number;
  includedQuantity: number;
  included: WacaPreviewOrderTrace[];
  excluded: WacaPreviewOrderTrace[];
}

export const wacaMatchReasonLabel = (item: Pick<WacaItem, 'match' | 'resolution'>): string => {
  if (item.resolution === 'SPEC_CODE_EXACT') return '規格編號精確配對';
  if (item.match === 'MANUAL_MATCH' || item.resolution === 'MANUAL_CONFIRMED_MAPPING') return '人工確認對照';
  if (item.resolution === 'SPEC_NAME_EXACT_UNIQUE') return '規格名稱唯一配對';
  if (item.resolution === 'UNIQUE_PARENT_VARIANT') return '無規格商品／唯一規格自動配對';
  return '已配對';
};

const excludedReason = (status: WacaStatus): string => status === '取消'
  ? '訂單已取消，不計入 WACA 數量'
  : status === '失敗' ? '訂單失敗，不計入 WACA 數量' : '此訂單狀態不計入 WACA 數量';

/**
 * Produces the user-facing rebaseline comparison from the same quantities shown
 * by Purchase Records and the same in-memory candidate that would be committed.
 * Any trace/quantity disagreement fails before the preview can be confirmed.
 */
export function buildWacaPreviewComparisons(
  variants: readonly ProductVariant[],
  currentLedger: WacaRepository,
  candidate: WacaRepository,
  cutoverMode?: WacaCutoverState['mode'],
): Map<string, WacaVariantPreviewComparison> {
  const firstCutover = cutoverMode !== 'ORDER_DRIVEN_ACTIVE';
  const rebaseline = cutoverMode === 'ORDER_REBASELINE_REQUIRED' || cutoverMode === 'LEGACY_QUANTITY_ACTIVE';
  const traces = new Map<string, WacaPreviewOrderTrace[]>();
  for (const item of candidate.items.values()) {
    if (!item.productVariantId) continue;
    const order = candidate.orders.get(item.orderKey);
    if (!order) throw new Error(`WACA_PREVIEW_ORPHAN_ORDER:${item.key}`);
    const included = isEffectiveWacaStatus(order.status);
    const rows = traces.get(item.productVariantId) ?? [];
    rows.push({
      key: item.key,
      orderNumber: order.orderNumber,
      status: order.status,
      quantity: item.quantity,
      resolutionCode: item.resolution,
      matchReason: wacaMatchReasonLabel(item),
      included,
      excludedReason: included ? null : excludedReason(order.status),
    });
    traces.set(item.productVariantId, rows);
  }

  const result = new Map<string, WacaVariantPreviewComparison>();
  for (const variant of variants) {
    const all = (traces.get(variant.id) ?? []).sort((left, right) =>
      left.orderNumber.localeCompare(right.orderNumber) || left.key.localeCompare(right.key));
    const included = all.filter(row => row.included);
    const excluded = all.filter(row => !row.included);
    const includedQuantity = included.reduce((sum, row) => sum + row.quantity, 0);
    const ledgerAfterQuantity = candidate.autoQuantities.get(variant.id) ?? 0;
    if (includedQuantity !== ledgerAfterQuantity) {
      throw new Error(`WACA_PREVIEW_TRACE_SUM_MISMATCH:${variant.id}:${includedQuantity}:${ledgerAfterQuantity}`);
    }
    const baselineQuantity = purchaseRecordsWacaQuantity(variant, true);
    // A first cutover replaces the complete legacy aggregate. It never carries
    // the legacy/manual quantity forward and then adds the order ledger to it.
    const postImportManual = firstCutover ? 0 : Number(variant.waca_manual_adjustment ?? 0);
    const recomputedQuantity = Math.max(0, ledgerAfterQuantity + postImportManual);
    result.set(variant.id, {
      variantId: variant.id,
      baselineLabel: rebaseline ? 'ERP1 原 WACA' : '目前 WACA',
      baselineQuantity,
      recomputedQuantity,
      difference: recomputedQuantity - baselineQuantity,
      ledgerBeforeQuantity: currentLedger.autoQuantities.get(variant.id) ?? 0,
      ledgerAfterQuantity,
      includedOrderCount: new Set(included.map(row => row.orderNumber)).size,
      includedQuantity,
      included,
      excluded,
    });
  }
  return result;
}

export function isWacaPreviewVariantVisible(
  comparison: WacaVariantPreviewComparison,
  showLedgerUnchanged: boolean,
  onlyBaselineDifferences: boolean,
): boolean {
  if (onlyBaselineDifferences) return comparison.difference !== 0;
  if (!showLedgerUnchanged && comparison.ledgerBeforeQuantity === comparison.ledgerAfterQuantity) return false;
  return true;
}
