import { BuyAnimeResumeError, type BuyAnimeImportRecord, type BuyAnimeStage } from './buyAnimeImportResume';
import type { CloudChange } from './cloudSyncDomain';

export interface BuyAnimeAuthoritativeEvidence {
  changes: CloudChange[];
  rowsByTable: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
}

export interface BuyAnimeFlowOptions {
  beforeStart?: () => Promise<unknown>;
  onStage?: (stage: BuyAnimeStage) => void;
}

let tail: Promise<unknown> = Promise.resolve();
let presentation = { label: '', error: '', active: false };
const listeners = new Set<() => void>();
export const getBuyAnimeFlowPresentation = () => presentation;
export function subscribeBuyAnimeFlow(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function publishBuyAnimeFlow(label: string, error = ''): void {
  presentation = { ...presentation, label, error }; listeners.forEach(listener => listener());
}
let targetedRefresh: ((evidence: BuyAnimeAuthoritativeEvidence) => Promise<void>) | undefined;
export function registerBuyAnimeTargetedRefresh(refresh: NonNullable<typeof targetedRefresh>): () => void {
  targetedRefresh = refresh;
  return () => { if (targetedRefresh === refresh) targetedRefresh = undefined; };
}
export function refreshBuyAnimeReadback(evidence: BuyAnimeAuthoritativeEvidence, fallback: () => Promise<void>): Promise<void> {
  return targetedRefresh ? targetedRefresh(evidence) : fallback();
}
/** One queue per client, plus an origin-wide lock across tabs. Journal CAS is
 * still the authority across devices; this lock never replaces it. */
export function coordinateBuyAnimeImport<T>(run: () => Promise<T>): Promise<T> {
  const guarded = async () => {
    presentation = { label: '正在匯入並同步資料…', error: '', active: true };
    listeners.forEach(listener => listener());
    try { const result = await run(); publishBuyAnimeFlow(result ? '匯入完成' : ''); return result; }
    catch (error) {
      // Pre-dispatch/backup/permission failures have no committed batch to resume.
      // Let the caller show their specific error, not a misleading resume action.
      publishBuyAnimeFlow('', error instanceof BuyAnimeResumeError && error.record
        ? '同步暫時未完成，請稍後重試。已儲存的主檔不會重送。' : '');
      throw error;
    } finally {
      presentation = { ...presentation, active: false };
      listeners.forEach(listener => listener());
    }
  };
  const operation = tail.catch(() => undefined).then(() =>
    typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('erp-buyanime-import', guarded) : guarded());
  tail = operation;
  return operation;
}

const retryable = (error: unknown): boolean => {
  let cause = error;
  for (let depth = 0; depth < 6; depth++) {
    const e = cause as { code?: string; cause?: unknown; name?: string; message?: string; status?: number } | null;
    if (/MISMATCH|INVALID|DELETED|CONFLICT|FORBIDDEN|NOT_COMMITTED|INTENT_CONFLICT/iu.test(e?.code || '')) return false;
    if (e?.cause) { cause = e.cause; continue; }
    return e?.name === 'TypeError' || [408,429,500,502,503,504].includes(e?.status || 0)
      || /fetch|network|timeout|connection|CLOUD_OFFLINE/iu.test((e?.code || '') + ' ' + (e?.message || ''));
  }
  return false;
};

/** Retries downstream reconciliation ONLY. Inventory dispatch is never inside
 * the retry loop, including unknown commit outcomes and close/reopen recovery. */
export async function finishBuyAnimeImport(
  input: BuyAnimeImportRecord,
  resume: (record: BuyAnimeImportRecord) => Promise<BuyAnimeImportRecord>,
  prepare: () => Promise<void>,
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
): Promise<BuyAnimeImportRecord> {
  let record = input;
  for (let attempt = 0; ; attempt++) {
    try { await prepare(); return await resume(record); }
    catch (error) {
      if (error instanceof BuyAnimeResumeError && error.record) record = error.record;
      if (attempt >= 2 || !retryable(error)) throw error;
      await pause(250 * 2 ** attempt);
    }
  }
}

export function buyAnimeFlowLabel(stage: BuyAnimeStage): string {
  if (stage === 'COMPLETE') return '匯入完成';
  if (stage === 'WACA_EVIDENCE_PENDING') return '正在更新來源對照…';
  if (stage.startsWith('CATALOG')) return '正在同步商品資料…';
  return '匯入中…';
}
