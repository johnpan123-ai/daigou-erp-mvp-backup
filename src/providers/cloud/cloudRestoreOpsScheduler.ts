import { cleanupExpiredRestoreOps, type MaintenanceOptions, type MaintenanceSummary } from './cloudRestoreOpsMaintenance';

/**
 * P0-1 Phase 2 (G-1): independent, owner-only, idle-time trigger for the
 * existing bounded RPC erp_cleanup_expired_restore_ops. It is deliberately NOT
 * wired into Prepare/Execute/Provider code (restore-expired-ops-cleanup.mjs:38).
 *
 * Safety model: correctness is guaranteed server-side (expired-only selection,
 * in-flight attempt exclusion, FOR UPDATE NOWAIT + advisory xact lock, bounded
 * batches, statement_timeout). This module only limits WHEN and HOW MUCH runs:
 * one tab per origin (Web Locks, fail-closed without them), small wall-clock
 * budget, cooldown/backoff, and stop at batch boundaries when the tab hides,
 * goes offline, unloads, or Restore/BuyAnime activity is observed.
 *
 * Diagnostics are per browser + origin (localStorage) and are NOT an
 * authoritative system-wide execution record.
 */

export const OPS_SCHEDULER = Object.freeze({
  maxBatches: 12,
  budgetMs: 8000,
  callTimeoutMs: 12000,
  interBatchMs: 250,
  startupDelayMs: 120_000,
  tickMs: 10 * 60_000,
  cooldown: { idle: 12 * 3600_000, progress: 10 * 60_000, busy: 30 * 60_000, unknown: 30 * 60_000 },
  errorBackoff: [3600_000, 6 * 3600_000, 24 * 3600_000],
  noWebLocksRecheckMs: 12 * 3600_000,
  settingsActiveWindowMs: 180_000,
  settingsHeartbeatMs: 30_000,
  settingsFollowupMs: 35 * 60_000,
  healthSuccessWindowMs: 13 * 3600_000,
  logLimit: 20,
});
export const OPS_LOCK_NAME = 'erp-restore-ops-maintenance';
const KEY_STATE = 'erp_restore_ops_maint:v1:state';
const KEY_LOG = 'erp_restore_ops_maint:v1:log';
const KEY_OPPORTUNITY = 'erp_restore_ops_maint:v1:opportunity';
const KEY_SETTINGS = 'erp_restore_ops_maint:v1:settings_seen_at';

export type OpsRunOutcome = MaintenanceSummary['outcome'] | 'skipped-no-web-locks';
export interface OpsRunRecord {
  at: number; trigger: string; outcome: OpsRunOutcome; batches: number; requests: number;
  chunks: number; typedRows: number; elapsedMs: number; errorCode?: string;
}
export interface OpsSchedulerState {
  nextDueAt: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastOutcome: OpsRunOutcome | null;
  consecutiveFailures: number;
  consecutiveErrors: number;
  progressSince: number | null;
  progressDays: string[];
  lastServerObservation: { at: number; status: 'idle' | 'progress' | 'busy' } | null;
}
interface OpportunityState { lastAt: number | null; daysSinceAttempt: string[] }

export interface OpsGates {
  cloud: boolean; owner: boolean; syncReady: boolean; buyAnimeActive: boolean;
  onSettingsRoute: boolean; unresolvedRestore: boolean;
}
type LockGrant = unknown;
export interface OpsLocks {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: LockGrant | null) => Promise<T>): Promise<T>;
}
export interface OpsSchedulerEnv {
  now: () => number;
  clock: () => number;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  locks: OpsLocks | null;
  rpc: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => PromiseLike<{ data: unknown; error: unknown; status?: number }>;
  isVisible: () => boolean;
  isOnline: () => boolean;
  /** Abortable pause: must resolve early when `signal` aborts (hidden/pagehide/offline). */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Subscribes to stop events (visibility hidden, pagehide, offline). */
  onStop: (listener: () => void) => () => void;
  dayKey?: (at: number) => string;
}

const DEFAULT_STATE: OpsSchedulerState = { nextDueAt: 0, lastAttemptAt: null, lastSuccessAt: null, lastOutcome: null,
  consecutiveFailures: 0, consecutiveErrors: 0, progressSince: null, progressDays: [], lastServerObservation: null };

function read<T>(storage: OpsSchedulerEnv['storage'], key: string, fallback: T): T {
  try { const raw = storage?.getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) } as T : fallback; }
  catch { return fallback; }
}
function readArray<T>(storage: OpsSchedulerEnv['storage'], key: string): T[] {
  try { const value = JSON.parse(storage?.getItem(key) || '[]'); return Array.isArray(value) ? value as T[] : []; }
  catch { return []; }
}
function write(storage: OpsSchedulerEnv['storage'], key: string, value: unknown): void {
  try { storage?.setItem(key, JSON.stringify(value)); } catch { /* storage full/blocked: diagnostics only */ }
}
const localDay = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDay = (days: string[], day: string) => (days.includes(day) ? days : [...days, day].slice(-14));

export type OpsHealthLevel = 'NO_OPPORTUNITY' | 'WAITING' | 'OK' | 'ATTENTION';
export interface OpsHealth { level: OpsHealthLevel; reason: string; scope: string }
export const OPS_HEALTH_SCOPE = '僅代表此瀏覽器與此網址的紀錄，不是全系統權威紀錄';

/** Distinguishes "the owner had no chance to run it" from "the scheduler is failing". */
export function classifyOpsHealth(state: OpsSchedulerState, opportunity: OpportunityState, now: number): OpsHealth {
  const scope = OPS_HEALTH_SCOPE;
  if (state.consecutiveFailures >= 3) return { level: 'ATTENTION', reason: `連續 ${state.consecutiveFailures} 次清理失敗或結果未知`, scope };
  if (state.progressSince !== null && state.progressDays.length >= 3) return { level: 'ATTENTION', reason: '待清理資料已連續 3 個使用日未清完', scope };
  if (opportunity.lastAt === null) return { level: 'NO_OPPORTUNITY', reason: '尚無執行機會（此瀏覽器尚未以 Owner 身分開啟可見的 ERP 頁面）', scope };
  if (now >= state.nextDueAt && opportunity.daysSinceAttempt.length >= 2) return { level: 'ATTENTION', reason: '已有多個使用日的執行機會，但排程器沒有嘗試清理', scope };
  if (state.lastSuccessAt !== null && state.lastSuccessAt >= opportunity.lastAt - OPS_SCHEDULER.healthSuccessWindowMs) return { level: 'OK', reason: '正常', scope };
  return { level: 'WAITING', reason: '等待下一次閒置時段執行', scope };
}

export interface OpsSchedulerSnapshot {
  mounted: boolean; running: boolean; state: OpsSchedulerState; opportunity: OpportunityState;
  log: OpsRunRecord[]; health: OpsHealth;
}

export function createRestoreOpsScheduler(env: OpsSchedulerEnv, getGates: () => OpsGates) {
  const listeners = new Set<() => void>();
  const dayKey = env.dayKey ?? localDay;
  let running = false;
  let mounted = false;
  let snapshot: OpsSchedulerSnapshot;
  const compute = (): OpsSchedulerSnapshot => {
    const state = read(env.storage, KEY_STATE, DEFAULT_STATE);
    const opportunity = read<OpportunityState>(env.storage, KEY_OPPORTUNITY, { lastAt: null, daysSinceAttempt: [] });
    return { mounted, running, state, opportunity, log: readArray<OpsRunRecord>(env.storage, KEY_LOG),
      health: classifyOpsHealth(state, opportunity, env.now()) };
  };
  snapshot = compute();
  const publish = () => { snapshot = compute(); listeners.forEach(listener => listener()); };

  const settingsActive = () => {
    const seen = Number(env.storage?.getItem(KEY_SETTINGS) || 0);
    return seen > 0 && env.now() - seen < OPS_SCHEDULER.settingsActiveWindowMs;
  };
  const followupDue = (state: OpsSchedulerState) => {
    const seen = Number(env.storage?.getItem(KEY_SETTINGS) || 0);
    return seen > 0 && env.now() >= seen + OPS_SCHEDULER.settingsFollowupMs && seen > (state.lastAttemptAt ?? 0);
  };
  const gatesOpen = () => {
    const g = getGates();
    return g.cloud && g.owner && g.syncReady && !g.buyAnimeActive && !g.onSettingsRoute && !g.unresolvedRestore
      && env.isVisible() && env.isOnline() && !settingsActive();
  };

  function record(state: OpsSchedulerState, run: OpsRunRecord): void {
    write(env.storage, KEY_STATE, state);
    write(env.storage, KEY_LOG, [...readArray<OpsRunRecord>(env.storage, KEY_LOG), run].slice(-OPS_SCHEDULER.logLimit));
    if (run.outcome !== 'skipped-no-web-locks') {
      const opp = read<OpportunityState>(env.storage, KEY_OPPORTUNITY, { lastAt: null, daysSinceAttempt: [] });
      write(env.storage, KEY_OPPORTUNITY, { ...opp, daysSinceAttempt: [] });
    }
  }

  function nextState(prev: OpsSchedulerState, s: MaintenanceSummary, now: number): OpsSchedulerState {
    const c = OPS_SCHEDULER.cooldown;
    const base = { ...prev, lastAttemptAt: now, lastOutcome: s.outcome };
    switch (s.outcome) {
      case 'idle':
        return { ...base, nextDueAt: now + c.idle, lastSuccessAt: now, consecutiveFailures: 0, consecutiveErrors: 0,
          progressSince: null, progressDays: [], lastServerObservation: { at: now, status: 'idle' } };
      case 'progress':
        return { ...base, nextDueAt: now + c.progress, lastSuccessAt: now, consecutiveFailures: 0, consecutiveErrors: 0,
          progressSince: prev.progressSince ?? now, progressDays: addDay(prev.progressDays, dayKey(now)),
          lastServerObservation: { at: now, status: 'progress' } };
      case 'busy':
        return { ...base, nextDueAt: now + c.busy, lastServerObservation: { at: now, status: 'busy' } };
      case 'unknown':
        // Never retried immediately; not escalated. The next run re-reads true DB state.
        return { ...base, nextDueAt: now + c.unknown, consecutiveFailures: prev.consecutiveFailures + 1 };
      case 'error': {
        const errors = prev.consecutiveErrors + 1;
        const backoff = OPS_SCHEDULER.errorBackoff[Math.min(errors, OPS_SCHEDULER.errorBackoff.length) - 1];
        return { ...base, nextDueAt: now + backoff, consecutiveErrors: errors, consecutiveFailures: prev.consecutiveFailures + 1 };
      }
      case 'stopped':
        // Interrupted by a gate (hidden/offline/unload/Restore/BuyAnime): not a failure; due again at next trigger.
        return { ...base, nextDueAt: now, ...(s.batches > 0 ? { lastSuccessAt: now } : {}) };
      default:
        return base;
    }
  }

  /** One evaluation. Never throws; never blocks callers' flows. */
  async function trigger(reason: string): Promise<OpsRunRecord | null> {
    try {
      const g = getGates();
      if (!g.cloud || !g.owner || !env.isVisible() || !env.isOnline()) return null;
      // Opportunity = an owner had a visible, online cloud session (independent of other gates).
      const now = env.now();
      const opp = read<OpportunityState>(env.storage, KEY_OPPORTUNITY, { lastAt: null, daysSinceAttempt: [] });
      write(env.storage, KEY_OPPORTUNITY, { lastAt: now, daysSinceAttempt: addDay(opp.daysSinceAttempt, dayKey(now)) });
      const state = read(env.storage, KEY_STATE, DEFAULT_STATE);
      if (!(now >= state.nextDueAt || followupDue(state))) { publish(); return null; }
      if (running || !gatesOpen()) { publish(); return null; }
      if (!env.locks) {
        // Fail-closed: no strict cross-tab mutual exclusion available.
        const run: OpsRunRecord = { at: now, trigger: reason, outcome: 'skipped-no-web-locks', batches: 0, requests: 0, chunks: 0, typedRows: 0, elapsedMs: 0 };
        record({ ...state, nextDueAt: now + OPS_SCHEDULER.noWebLocksRecheckMs, lastOutcome: run.outcome }, run);
        publish();
        return run;
      }
      return await env.locks.request(OPS_LOCK_NAME, { ifAvailable: true }, async lock => {
        if (!lock) return null; // another tab of this origin is running it
        const fresh = read(env.storage, KEY_STATE, DEFAULT_STATE);
        if (!(env.now() >= fresh.nextDueAt || followupDue(fresh)) || !gatesOpen()) return null;
        running = true; publish();
        const stop = new AbortController();
        const off = env.onStop(() => stop.abort());
        try {
          const options: MaintenanceOptions = {
            maxBatches: OPS_SCHEDULER.maxBatches, deadlineMs: OPS_SCHEDULER.budgetMs, callTimeoutMs: OPS_SCHEDULER.callTimeoutMs,
            interBatchMs: OPS_SCHEDULER.interBatchMs, clock: env.clock,
            wait: ms => env.wait(ms, stop.signal),
            shouldContinue: () => !stop.signal.aborted && gatesOpen(),
          };
          const summary = await cleanupExpiredRestoreOps(env.rpc, null, options);
          if (summary.outcome === 'skipped') return null;
          const at = env.now();
          const run: OpsRunRecord = { at, trigger: reason, outcome: summary.outcome, batches: summary.batches, requests: summary.requests,
            chunks: summary.chunks, typedRows: summary.typedRows, elapsedMs: summary.elapsedMs,
            ...(summary.errorCode ? { errorCode: summary.errorCode } : {}) };
          record(nextState(fresh, summary, at), run);
          return run;
        } finally {
          off(); running = false; publish();
        }
      });
    } catch {
      running = false;
      return null;
    }
  }

  return {
    trigger,
    /** Restore panel lives on /settings: heartbeat lets every tab of this origin stay away. */
    noteSettingsActivity(): void { write(env.storage, KEY_SETTINGS, env.now()); },
    setMounted(value: boolean): void { mounted = value; publish(); },
    getSnapshot: (): OpsSchedulerSnapshot => snapshot,
    refresh: publish,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
export type RestoreOpsScheduler = ReturnType<typeof createRestoreOpsScheduler>;
