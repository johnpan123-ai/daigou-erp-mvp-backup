type MaintenanceRpc = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => PromiseLike<{ data: unknown; error: unknown; status?: number }>;
let running = false;

export type MaintenanceOutcome = 'idle' | 'progress' | 'busy' | 'error' | 'unknown' | 'stopped' | 'skipped';
export interface MaintenanceOptions {
  /** Hard batch cap for this run. */
  maxBatches?: number;
  /** Wall-clock work budget (ms). A batch starts only if elapsed + max(observed call, 1 s) fits. */
  deadlineMs?: number;
  /** Client-side cap per RPC; an aborted/failed transport is UNKNOWN, never inferred as done. */
  callTimeoutMs?: number;
  /** Pause between batches; resolves early when the caller stops the run. */
  wait?: (ms: number) => Promise<void>;
  interBatchMs?: number;
  /** Checked before every batch; false stops at the batch boundary. */
  shouldContinue?: () => boolean;
  clock?: () => number;
}
export interface MaintenanceSummary {
  outcome: MaintenanceOutcome;
  batches: number;
  requests: number;
  chunks: number;
  typedRows: number;
  elapsedMs: number;
  maxCallMs: number;
  budgetExhausted: boolean;
  errorCode?: string;
}

const TRANSPORT = /fetch|network|abort|timeout|load failed|connection|offline/iu;
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
/** A server response with an error is definite (nothing committed by that call);
 * no HTTP status plus a transport-shaped message is UNKNOWN. */
function classifyRpcError(error: unknown, status: unknown): { outcome: 'error' | 'unknown'; code: string } {
  const e = asRecord(error);
  const code = String(e.code || e.name || 'RPC_ERROR').slice(0, 64);
  const transport = (typeof status !== 'number' || status === 0)
    && TRANSPORT.test(`${String(e.name || '')} ${String(e.message || '')} ${String(e.details || '')}`);
  return { outcome: transport ? 'unknown' : 'error', code };
}

/** Best-effort OPS-only maintenance. Never awaited by Begin/Prepare/Execute or
 * Global Sync; no retries, payload logging, or business RPCs. Callers outside the
 * Restore/Provider paths decide when to run it (see cloudRestoreOpsScheduler). */
export async function cleanupExpiredRestoreOps(
  rpc: MaintenanceRpc,
  currentRequestId: string | null,
  options?: MaintenanceOptions,
): Promise<MaintenanceSummary> {
  const summary: MaintenanceSummary = { outcome: 'skipped', batches: 0, requests: 0, chunks: 0, typedRows: 0,
    elapsedMs: 0, maxCallMs: 0, budgetExhausted: false };
  if (running) return summary;
  running = true;
  const clock = options?.clock ?? (() => performance.now());
  const maxBatches = options?.maxBatches ?? 32;
  const deadlineMs = options?.deadlineMs ?? 15000;
  const predictive = options !== undefined;
  const started = clock();
  const pauseMs = options?.wait && options.interBatchMs ? options.interBatchMs : 0;
  // Wall-clock rule: start a batch only if it is predicted to finish inside the budget.
  const fits = (extra: number) => {
    const elapsed = clock() - started;
    return summary.batches < maxBatches
      && (predictive ? elapsed + extra + Math.max(summary.maxCallMs, 1000) <= deadlineMs : elapsed < deadlineMs);
  };
  const stopRequested = () => Boolean(options?.shouldContinue && !options.shouldContinue());
  try {
    for (;;) {
      const pause = summary.batches > 0 ? pauseMs : 0;
      if (!fits(pause)) { summary.budgetExhausted = summary.outcome === 'progress'; break; }
      if (stopRequested()) { summary.outcome = 'stopped'; break; }
      if (pause) {
        await options!.wait!(pause);
        // A throttled/delayed timer or a stop event during the pause is re-evaluated here.
        if (!fits(0)) { summary.budgetExhausted = summary.outcome === 'progress'; break; }
        if (stopRequested()) { summary.outcome = 'stopped'; break; }
      }
      const callStarted = clock();
      let result: { data: unknown; error: unknown; status?: number };
      const controller = options?.callTimeoutMs ? new AbortController() : undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const call = Promise.resolve(rpc('erp_cleanup_expired_restore_ops', { p_exclude_request_id: currentRequestId },
          controller?.signal));
        result = controller ? await Promise.race([call, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('CLIENT_CALL_TIMEOUT')); }, options!.callTimeoutMs);
        })]) : await call;
      } catch (error) {
        // Transport failure or client timeout: the server call may still commit.
        summary.outcome = 'unknown';
        summary.errorCode = error instanceof Error && error.message === 'CLIENT_CALL_TIMEOUT' ? 'CLIENT_CALL_TIMEOUT' : 'TRANSPORT';
        break;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      summary.maxCallMs = Math.max(summary.maxCallMs, clock() - callStarted);
      summary.batches++;
      if (result.error) {
        const classified = classifyRpcError(result.error, result.status);
        summary.outcome = classified.outcome;
        summary.errorCode = classified.code;
        break;
      }
      const data = asRecord(result.data);
      const status = data.status;
      if (status !== 'progress') {
        summary.outcome = status === 'idle' ? 'idle' : status === 'busy' ? 'busy' : 'error';
        if (summary.outcome === 'error') summary.errorCode = 'UNEXPECTED_RESPONSE';
        break;
      }
      summary.outcome = 'progress';
      summary.requests += count(data.requests);
      summary.chunks += count(data.chunks);
      summary.typedRows += count(data.typedRows);
    }
  } catch {
    /* Independent failure domain: an OPS cleanup cannot fail any caller. */
    if (summary.outcome === 'progress' || summary.outcome === 'skipped') { summary.outcome = 'unknown'; summary.errorCode = 'INTERNAL'; }
  } finally {
    summary.elapsedMs = Math.round(clock() - started);
    running = false;
  }
  return summary;
}
