/**
 * Restore pre-check for WACA: what the current ERP2 WACA work would lose if the candidate
 * backup replaced it (Restore replaces all 24 resources atomically; nothing is re-applied later).
 * Pure; reads only the current WACA snapshot and the candidate's WACA resources.
 */
import type { NextWacaSnapshot } from './nextStorage';

export interface WacaRestoreLossItem {
  orderNumber: string;
  itemKey: string;
  variantId: string | null;
  countedQuantity: number;
  reason: 'ORDER_NOT_IN_BACKUP' | 'COUNTED_DIFFERENT_IN_BACKUP';
}

export interface WacaRestoreLossReport {
  /** True when the current WACA work holds anything the backup does not. */
  atRisk: boolean;
  ordersNotInBackup: number;
  itemsAtRisk: WacaRestoreLossItem[];
  countedQuantityAtRisk: number;
  batchesNotInBackup: string[];
  currentMode: string;
  backupMode: string;
  /** ERP1 v1 backups reset WACA to a new historical baseline (no ledger). */
  backupHasNoLedger: boolean;
}

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));
const payloadOf = (row: Row): Row => (row.payload && typeof row.payload === 'object' ? row.payload as Row : {});

export function assessWacaRestoreLoss(current: NextWacaSnapshot, candidate: {
  waca_orders: readonly Row[]; waca_order_items: readonly Row[]; waca_import_batches: readonly Row[]; waca_state: readonly Row[];
}): WacaRestoreLossReport {
  const backupOrders = new Set(candidate.waca_orders.map(row => text(row.order_key)));
  const backupItems = new Map(candidate.waca_order_items.map(row => [text(row.item_key), row]));
  const backupBatches = new Set(candidate.waca_import_batches.map(row => text(row.batch_key)));
  const orderNumber = new Map(current.orders.map(row => [row.key, row.orderNumber]));
  const itemsAtRisk: WacaRestoreLossItem[] = [];
  for (const item of current.items) {
    const counted = Number(item.countedQuantity ?? 0);
    const backup = backupItems.get(item.key);
    if (!backup) {
      itemsAtRisk.push({ orderNumber: orderNumber.get(item.orderKey) ?? item.orderKey, itemKey: item.key,
        variantId: item.productVariantId || null, countedQuantity: counted, reason: 'ORDER_NOT_IN_BACKUP' });
      continue;
    }
    const backupCounted = payloadOf(backup).countedQuantity;
    if (item.countedQuantity !== undefined && Number(backupCounted ?? -1) !== counted) {
      itemsAtRisk.push({ orderNumber: orderNumber.get(item.orderKey) ?? item.orderKey, itemKey: item.key,
        variantId: item.productVariantId || null, countedQuantity: counted, reason: 'COUNTED_DIFFERENT_IN_BACKUP' });
    }
  }
  const ordersNotInBackup = current.orders.filter(row => !backupOrders.has(row.key)).length;
  const batchesNotInBackup = current.batches.map(row => row.id).filter(idValue => !backupBatches.has(idValue));
  return {
    atRisk: ordersNotInBackup > 0 || itemsAtRisk.length > 0 || batchesNotInBackup.length > 0,
    ordersNotInBackup, itemsAtRisk,
    countedQuantityAtRisk: itemsAtRisk.reduce((sum, row) => sum + row.countedQuantity, 0),
    batchesNotInBackup,
    currentMode: current.cutoverState?.mode ?? 'UNKNOWN',
    backupMode: text(candidate.waca_state[0]?.mode) || 'UNKNOWN',
    backupHasNoLedger: candidate.waca_orders.length === 0,
  };
}
