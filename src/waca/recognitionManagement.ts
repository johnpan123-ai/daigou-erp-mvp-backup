import type { ProductVariant } from '../lib/db';
import type { WacaItem } from './orderCore';
import type { NextWacaSnapshot } from './nextStorage';
import { isWacaBusinessConflict } from './importErrors';

export type WacaRecognitionMode = 'COUNT' | 'INCLUDED' | 'HOLD';
export const RECOGNITION_LABELS: Record<WacaRecognitionMode, string> = {
  COUNT: '計入數量', INCLUDED: '已含原本數量', HOLD: '暫不計入',
};
export interface WacaRecognitionRequest {
  requestId: string; revision: number; restoreEpoch: number; orderKey: string; reason: string;
  choices: Array<{ itemKey: string; mode: WacaRecognitionMode }>;
}
export interface WacaRecognitionPlan {
  contract: 'waca-recognition-v1'; requestId: string; requestHash: string; revision: number; restoreEpoch: number;
  orderKey: string; reason: string;
  lines: Array<{ itemKey: string; orderKey: string; variantId: string; sku: string; sourceQuantity: number;
    sourceStatus: string; beforeMode: WacaRecognitionMode; mode: WacaRecognitionMode;
    countedBefore: number; countedAfter: number; delta: number; previousDecision: WacaItem['recognition'] | null; previousReason: string | null; previousCountedBy: string | null }>;
  quantities: Array<{ variantId: string; sku: string; version: number; autoBefore: number; manualBefore: number;
    before: number; after: number; delta: number; reversibleItemKeys: string[] }>;
}
export interface WacaRecognitionResult { status: 'COMMITTED' | 'NO_CHANGE'; revision: number; requestId: string }
export interface WacaRecognitionEvidence {
  contract: 'waca-recognition-v1'; request: WacaRecognitionRequest; plan: WacaRecognitionPlan;
  result: WacaRecognitionResult; actor: string; at: string;
  variants: Array<{ variantId: string; versionAfter: number; autoAfter: number; manualAfter: number }>;
}
export function recognitionMode(item: WacaItem, legacyCounted = 0): WacaRecognitionMode {
  return item.recognition?.mode ?? (item.countedReason === 'BASELINE_INCLUDED' ? 'INCLUDED'
    : (item.countedQuantity ?? legacyCounted) > 0 || ['NORMAL_IMPORT', 'OWNER_CONFIRMED_NEW', 'SOURCE_CHANGE_APPLIED', 'OVERWRITE', 'LEGACY_COUNTED'].includes(item.countedReason ?? '') ? 'COUNT' : 'HOLD');
}
export const recognitionErrorMessage = (cause: unknown): string => {
  const message = cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : String(cause);
  const known: Record<string, string> = {
    WACA_REVERSAL_PROOF_REQUIRED: '無法證明這筆數量仍可安全回沖。可能已有人工調整、後續變更或 Restore；請先核對，不會強制扣除。',
    WACA_INACTIVE_ORDER_NOT_COUNTABLE: '取消或付款失敗的訂單不能新增計入數量。',
    WACA_STALE_REVISION: '來源訂單已變更，請重新讀取並預覽。尚未提交此調整。',
    WACA_RESTORE_EPOCH_CHANGED: 'Restore 世代已改變，舊預覽不可提交。請重新讀取並核對。',
    WACA_RECOGNITION_PREVIEW_CHANGED: '數量或認列證據已變更，請重新預覽；不會套用舊計畫。',
    WACA_RECOGNITION_REQUIRES_COUNTED_LEDGER: '請先完成正常 WACA 匯入，建立可追溯的訂單認列紀錄。',
  };
  return known[message] ?? '認列調整未完成，請查看技術資訊並重新讀取結果；不要重複提交。';
};
export interface WacaRecognitionProvider {
  commitWacaRecognition(request: WacaRecognitionRequest, plan: WacaRecognitionPlan): Promise<WacaRecognitionResult>;
  getNextWacaSnapshot(): Promise<NextWacaSnapshot>;
  getAuthoritativeWacaVariants(): Promise<ProductVariant[]>;
  readWacaRestoreEpoch(): Promise<{ epoch: number; restoredAt: string | null }>;
}
/** Response loss is reconciled read-only by the immutable receipt. Never replay a write. */
export async function commitAndVerifyWacaRecognition(provider: WacaRecognitionProvider,
  request: WacaRecognitionRequest, plan: WacaRecognitionPlan, onStage?: (stage: 'commit' | 'readback') => void) {
  let result: WacaRecognitionResult;
  const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const receipt = (snapshot: NextWacaSnapshot) => {
    const evidence = snapshot.batches.find(b => b.id === request.requestId)?.recognition;
    if (!evidence || !evidence.actor || canonical(evidence.request) !== canonical(request) || canonical(evidence.plan) !== canonical(plan)) throw new Error('WACA_RECOGNITION_RECEIPT_MISSING');
    return evidence.result;
  };
  let saved: NextWacaSnapshot | undefined;
  onStage?.('commit');
  try { result = await provider.commitWacaRecognition(request, plan); }
  catch (cause) {
    // A definite business rejection is not a lost response and cannot be
    // upgraded to success by finding an older receipt. Require a fresh plan.
    if (isWacaBusinessConflict(cause)) throw cause;
    try { saved = await provider.getNextWacaSnapshot(); result = receipt(saved); }
    catch { throw cause; }
  }
  onStage?.('readback');
  const [snapshot, variants, epoch] = await Promise.all([saved ?? provider.getNextWacaSnapshot(), provider.getAuthoritativeWacaVariants(), provider.readWacaRestoreEpoch()]);
  if (epoch.epoch !== plan.restoreEpoch) throw new Error('WACA_RESTORE_EPOCH_CHANGED');
  if (result.status === 'COMMITTED') {
    receipt(snapshot);
    if (snapshot.revision !== result.revision) throw new Error('WACA_READBACK_REVISION_CHANGED');
    for (const line of plan.lines) {
      const item = snapshot.items.find(i => i.key === line.itemKey);
      if (item?.recognition?.requestId !== request.requestId || item.recognition.mode !== line.mode
        || item.countedQuantity !== line.countedAfter) throw new Error('WACA_RECOGNITION_READBACK_MISMATCH');
    }
    for (const quantity of plan.quantities) {
      const variant = variants.find(v => v.id === quantity.variantId);
      if (!variant || Number(variant.waca_auto_quantity) + Number(variant.waca_manual_adjustment) !== quantity.after) throw new Error('WACA_READBACK_PREVIEW_MISMATCH');
    }
  }
  return { result, snapshot, variants };
}
