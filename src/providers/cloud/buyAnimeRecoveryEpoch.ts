import { MyAcgImportError } from '../../utils/myacgImportErrors';

export interface BuyAnimeRestoreGeneration { epoch: number; restoredAt: string | null }
export interface BuyAnimeRecoveryEvidence { observedAt: string; restoreEpoch?: number }
export type BuyAnimeRecoveryValidity = 'CURRENT' | 'STALE_AFTER_RESTORE';
const invalid = (reason: string): never => {
  throw new MyAcgImportError('RECOVERY_STATE_ERROR', 'recovery', new Error(reason));
};

/** Reuse the existing server generation. Never infer authority from browser storage. */
export async function readBuyAnimeRestoreGeneration(): Promise<BuyAnimeRestoreGeneration> {
  const { supabase } = await import('./supabaseClient');
  const result = await supabase.from('erp_cloud_restore_epoch').select('epoch,restored_at').eq('singleton', true).single();
  if (result.error) throw new MyAcgImportError('RECOVERY_STATE_ERROR', 'recovery', result.error);
  const value = result.data;
  if (!value || !Number.isSafeInteger(value.epoch) || value.epoch < 0
    || (value.epoch > 0 && !Number.isFinite(Date.parse(value.restored_at))))
    return invalid('BUYANIME_RESTORE_EPOCH_INVALID');
  return { epoch: value.epoch, restoredAt: value.restored_at ?? null };
}

export function classifyBuyAnimeRecoveryGeneration(
  evidence: BuyAnimeRecoveryEvidence, current: BuyAnimeRestoreGeneration,
): BuyAnimeRecoveryValidity {
  if (!Number.isSafeInteger(current.epoch) || current.epoch < 0
    || (current.epoch > 0 && (!current.restoredAt || !Number.isFinite(Date.parse(current.restoredAt)))))
    return invalid('BUYANIME_RESTORE_EPOCH_INVALID');
  if (evidence.restoreEpoch !== undefined) {
    if (!Number.isSafeInteger(evidence.restoreEpoch) || evidence.restoreEpoch < 0 || evidence.restoreEpoch > current.epoch)
      return invalid('BUYANIME_RECOVERY_EPOCH_INVALID');
    return evidence.restoreEpoch < current.epoch ? 'STALE_AFTER_RESTORE' : 'CURRENT';
  }
  // Pre-epoch records can be retired only when their timestamp PROVES that
  // Restore superseded them. Equal/invalid timestamps must not be guessed stale.
  if (!Number.isFinite(Date.parse(evidence.observedAt))) return invalid('BUYANIME_RECOVERY_TIMESTAMP_INVALID');
  return current.restoredAt && Date.parse(evidence.observedAt) < Date.parse(current.restoredAt)
    ? 'STALE_AFTER_RESTORE' : 'CURRENT';
}

export function assertBuyAnimeGenerationUnchanged(before: BuyAnimeRestoreGeneration, after: BuyAnimeRestoreGeneration): void {
  if (before.epoch !== after.epoch || before.restoredAt !== after.restoredAt)
    invalid('BUYANIME_RESTORE_GENERATION_CHANGED');
}
export function assertBuyAnimeRecoveryCurrent(evidence: BuyAnimeRecoveryEvidence, current: BuyAnimeRestoreGeneration): void {
  if (classifyBuyAnimeRecoveryGeneration(evidence, current) !== 'CURRENT') invalid('BUYANIME_STALE_AFTER_RESTORE');
}
