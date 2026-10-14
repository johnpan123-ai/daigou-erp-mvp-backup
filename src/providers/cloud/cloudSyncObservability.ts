/**
 * P0-2 Phase 1a: local, in-memory sync diagnostics (requests, rows, decoded bytes,
 * elapsed time per sync run). Never sent anywhere; no row content is retained.
 * Readable from the browser console as window.__ERP_SYNC_DIAG__() (alias ERP_SYNC_DIAG()) for support.
 */
export type CloudSyncTrigger = 'core-bootstrap' | 'authoritative-refresh' | 'targeted' | 'incremental';

interface SyncRun {
  trigger: CloudSyncTrigger;
  startedAt: number;
  finishedAt: number | null;
  outcome: 'running' | 'committed' | 'failed' | 'deferred' | 'superseded';
  requests: number;
  rows: number;
  decodedBytes: number;
  realtimeReadiness?: string;
}

const MAX_RUNS = 30;
const runs: SyncRun[] = [];
const totals = { requests: 0, rows: 0, decodedBytes: 0, softTimeouts: 0, hardFailures: 0, catchUpsSkippedAfterReadiness: 0, catchUpsRetained: 0, catchUpsAfterLateReadiness: 0 };

const estimateBytes = (rows: unknown[]): number => {
  try {
    return JSON.stringify(rows).length;
  } catch {
    return 0;
  }
};

export const startCloudSyncRun = (trigger: CloudSyncTrigger): SyncRun => {
  const run: SyncRun = { trigger, startedAt: Date.now(), finishedAt: null, outcome: 'running', requests: 0, rows: 0, decodedBytes: 0 };
  runs.push(run);
  if (runs.length > MAX_RUNS) runs.shift();
  return run;
};

export const recordCloudSyncPage = (run: SyncRun | null, rows: unknown[]): void => {
  const bytes = estimateBytes(rows);
  totals.requests += 1;
  totals.rows += rows.length;
  totals.decodedBytes += bytes;
  if (!run) return;
  run.requests += 1;
  run.rows += rows.length;
  run.decodedBytes += bytes;
};

export const finishCloudSyncRun = (run: SyncRun | null, outcome: SyncRun['outcome']): void => {
  if (!run || run.finishedAt !== null) return;
  run.finishedAt = Date.now();
  run.outcome = outcome;
};

export const noteCloudSyncEvent = (event: 'soft-timeout' | 'hard-failure' | 'catch-up-skipped-after-readiness' | 'catch-up-retained' | 'catch-up-after-late-readiness'): void => {
  if (event === 'soft-timeout') totals.softTimeouts += 1;
  else if (event === 'hard-failure') totals.hardFailures += 1;
  else if (event === 'catch-up-skipped-after-readiness') totals.catchUpsSkippedAfterReadiness += 1;
  else if (event === 'catch-up-after-late-readiness') totals.catchUpsAfterLateReadiness += 1;
  else totals.catchUpsRetained += 1;
};

/**
 * C1d: structure-only record of Realtime `system` messages the readiness gate could not
 * recognise. Only the time, top-level field NAMES, `extension` and `status` are kept; field
 * values (message text, channel, tokens, keys, cookies) are never stored or printed.
 */
export type RealtimeSystemAnomalyKind = 'unrecognized-shape' | 'unrecognized-status' | 'error-status' | 'ok-before-subscribed';
export interface RealtimeSystemAnomaly {
  at: string;
  kind: RealtimeSystemAnomalyKind;
  generation: number;
  fields: string[];
  extension: string | null;
  status: string | null;
}
const MAX_SYSTEM_ANOMALIES = 5;
const MAX_FIELDS = 12;
const WARN_INTERVAL_MS = 60_000;
const systemAnomalies: RealtimeSystemAnomaly[] = [];
const realtimeTotals = { systemOk: 0, okBeforeSubscribedIgnored: 0, errorStatus: 0, unrecognized: 0, warningsSuppressed: 0 };
let lastWarnAt = 0;

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,40}$/;
const TOKEN_LIKE = /eyJ|[A-Za-z0-9_-]{32,}|bearer|apikey|token|secret|cookie|password|key$/i;
const safeLabel = (value: unknown): string | null => {
  if (typeof value !== 'string') return value === undefined || value === null ? null : `<${typeof value}>`;
  return SAFE_TOKEN.test(value) && !TOKEN_LIKE.test(value) ? value : '<redacted>';
};
const fieldNames = (payload: unknown): string[] => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [`<${Array.isArray(payload) ? 'array' : payload === null ? 'null' : typeof payload}>`];
  const names = Object.keys(payload as Record<string, unknown>).sort();
  const shown = names.slice(0, MAX_FIELDS).map(name => (SAFE_TOKEN.test(name) ? name : '<redacted>'));
  return names.length > MAX_FIELDS ? [...shown, `<+${names.length - MAX_FIELDS}>`] : shown;
};

export const noteRealtimeSystemOk = (): void => { realtimeTotals.systemOk += 1; };

export const recordRealtimeSystemAnomaly = (kind: RealtimeSystemAnomalyKind, generation: number, payload: unknown): void => {
  const record = payload && typeof payload === 'object' ? payload as { extension?: unknown; status?: unknown } : null;
  const entry: RealtimeSystemAnomaly = {
    at: new Date().toISOString(),
    kind,
    generation,
    fields: fieldNames(payload),
    extension: safeLabel(record?.extension),
    status: safeLabel(record?.status),
  };
  if (kind === 'ok-before-subscribed') realtimeTotals.okBeforeSubscribedIgnored += 1;
  else if (kind === 'error-status') realtimeTotals.errorStatus += 1;
  else realtimeTotals.unrecognized += 1;
  if (kind === 'ok-before-subscribed') return; // expected race (C1c); counted only
  systemAnomalies.push(entry);
  if (systemAnomalies.length > MAX_SYSTEM_ANOMALIES) systemAnomalies.shift();
  if (kind === 'error-status') return;
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) {
    realtimeTotals.warningsSuppressed += 1;
    return;
  }
  lastWarnAt = now;
  try {
    console.warn('[ERP sync] Realtime system message not recognised; listening readiness stays unproven (writes paused). Structure recorded in __ERP_SYNC_DIAG__().', entry);
  } catch {
    // Console is optional.
  }
};

export const getCloudSyncDiagnostics = () => ({
  totals: { ...totals },
  runs: runs.map(run => ({ ...run, elapsedMs: run.finishedAt === null ? null : run.finishedAt - run.startedAt })),
  realtime: {
    systemMessages: { ...realtimeTotals },
    unrecognizedSystemMessages: systemAnomalies.map(entry => ({ ...entry, fields: [...entry.fields] })),
  },
});

/** Test-only reset of the C1d Realtime diagnostics (never called by application code). */
export const __resetRealtimeDiagnosticsForTests = (): void => {
  systemAnomalies.length = 0;
  Object.keys(realtimeTotals).forEach(key => { realtimeTotals[key as keyof typeof realtimeTotals] = 0; });
  lastWarnAt = 0;
};

if (typeof window !== 'undefined') {
  try {
    Object.defineProperty(window, '__ERP_SYNC_DIAG__', { value: getCloudSyncDiagnostics, configurable: true });
    Object.defineProperty(window, 'ERP_SYNC_DIAG', { value: getCloudSyncDiagnostics, configurable: true });
  } catch {
    // Diagnostics are optional.
  }
}
