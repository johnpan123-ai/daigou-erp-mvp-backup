export type BuyAnimeTracePoint =
  | 'T00_FILE_SELECTED'
  | 'T01_FILE_READ_START'
  | 'T02_FILE_READ_DONE'
  | 'T03_PARSE_START'
  | 'T04_PARSE_DONE'
  | 'T05_NORMALIZE_DONE'
  | 'T06_PREIMPORT_BACKUP_START'
  | 'T07_PREIMPORT_BACKUP_DONE'
  | 'T08_INDEX_BUILD_START'
  | 'T09_INDEX_BUILD_DONE'
  | 'T10_INVENTORY_PLAN_START'
  | 'T11_INVENTORY_PLAN_DONE'
  | 'T12_INVENTORY_COMMIT_START'
  | 'T13_INVENTORY_COMMIT_RESPONSE'
  | 'T14_INVENTORY_ACK_READ_START'
  | 'T15_INVENTORY_ACK_READ_DONE'
  | 'T16_CATALOG_PLAN_START'
  | 'T17_CATALOG_PLAN_DONE'
  | 'T18_CATALOG_COMMIT_START'
  | 'T19_CATALOG_COMMIT_RESPONSE'
  | 'T20_CATALOG_READBACK_DONE'
  | 'T21_BUYANIME_JOURNAL_FINALIZE_START'
  | 'T22_BUYANIME_JOURNAL_FINALIZE_DONE'
  | 'T23_TARGETED_REFRESH_START'
  | 'T24_TARGETED_REFRESH_DONE'
  | 'T25_IMPORT_STATE_UPDATE'
  | 'T26_GLOBAL_SYNC_WAIT_START'
  | 'T27_GLOBAL_SYNC_AUTHORITATIVE_READ_START'
  | 'T28_GLOBAL_SYNC_AUTHORITATIVE_READ_DONE'
  | 'T29_GLOBAL_SYNC_SYNCED'
  | 'T30_REACT_FINAL_COMMIT'
  | 'T31_SUCCESS_MODAL_VISIBLE';

type SafeMeta = Record<string, string | number | boolean | null>;

export interface BuyAnimeTraceEvent {
  point: BuyAnimeTracePoint;
  offsetMs: number;
  at: string;
  meta?: SafeMeta;
}

export interface BuyAnimeTraceNetworkEntry {
  category: string;
  method: string;
  url: string;
  startMs: number;
  durationMs: number;
  status: number | null;
  transferBytes: number;
  responseBytes: number;
  blockingSuccess: boolean;
}

export interface BuyAnimeTraceSpan {
  from: BuyAnimeTracePoint;
  to: BuyAnimeTracePoint;
  label: string;
  durationMs: number;
}

export interface BuyAnimeProductionTrace {
  format: 'ERP2_BUYANIME_PRODUCTION_TRACE_V1';
  traceId: string;
  startedAt: string;
  completedAt: string | null;
  outcome: 'RUNNING' | 'SUCCESS' | 'ERROR';
  fileBytes: number;
  fileExtension: string;
  events: BuyAnimeTraceEvent[];
  spans: BuyAnimeTraceSpan[];
  network: BuyAnimeTraceNetworkEntry[];
  totalMs: number | null;
  unattributedMs: number | null;
  longTasksMs: number[];
  reactCommitCount: number;
  reactCommitMaxMs: number;
  missingRequiredPoints: BuyAnimeTracePoint[];
  errorCode?: string;
  catalogEvidence?: Array<{ offsetMs:number; event:string; details:SafeMeta }>;
}

const STORAGE_KEY = '__hippo_erp2_buyanime_production_trace_v1__';
const REQUIRED_POINTS: BuyAnimeTracePoint[] = [
  'T00_FILE_SELECTED','T01_FILE_READ_START','T02_FILE_READ_DONE','T03_PARSE_START','T04_PARSE_DONE',
  'T05_NORMALIZE_DONE','T06_PREIMPORT_BACKUP_START','T07_PREIMPORT_BACKUP_DONE','T08_INDEX_BUILD_START',
  'T09_INDEX_BUILD_DONE','T10_INVENTORY_PLAN_START','T11_INVENTORY_PLAN_DONE','T12_INVENTORY_COMMIT_START',
  'T13_INVENTORY_COMMIT_RESPONSE','T14_INVENTORY_ACK_READ_START','T15_INVENTORY_ACK_READ_DONE',
  'T16_CATALOG_PLAN_START','T17_CATALOG_PLAN_DONE','T18_CATALOG_COMMIT_START','T19_CATALOG_COMMIT_RESPONSE',
  'T20_CATALOG_READBACK_DONE','T21_BUYANIME_JOURNAL_FINALIZE_START','T22_BUYANIME_JOURNAL_FINALIZE_DONE',
  'T23_TARGETED_REFRESH_START','T24_TARGETED_REFRESH_DONE','T25_IMPORT_STATE_UPDATE',
  'T26_GLOBAL_SYNC_WAIT_START','T27_GLOBAL_SYNC_AUTHORITATIVE_READ_START',
  'T28_GLOBAL_SYNC_AUTHORITATIVE_READ_DONE','T29_GLOBAL_SYNC_SYNCED','T30_REACT_FINAL_COMMIT',
  'T31_SUCCESS_MODAL_VISIBLE',
];

let active: (BuyAnimeProductionTrace & { startedAtPerformance: number; observer?: PerformanceObserver }) | null = null;

const now = (): number => typeof performance === 'undefined' ? Date.now() : performance.now();
const rounded = (value: number): number => Math.round(value * 10) / 10;
const safeExtension = (name: string): string => name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase().slice(0, 12) : '';
const publicTrace = (trace: BuyAnimeProductionTrace & { startedAtPerformance?: number; observer?: PerformanceObserver }): BuyAnimeProductionTrace => {
  const safe = { ...trace };
  delete safe.startedAtPerformance;
  delete safe.observer;
  return safe;
};

const publish = (trace: BuyAnimeProductionTrace): void => {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trace)); } catch { /* Diagnostics must never affect import. */ }
  try { Object.defineProperty(window, '__ERP2_BUYANIME_PRODUCTION_TRACE__', { configurable: true, value: trace }); } catch { /* Best effort only. */ }
  window.dispatchEvent(new CustomEvent('erp2-buyanime-production-trace', { detail: trace }));
};

const safeMeta = (meta?: SafeMeta): SafeMeta | undefined => meta && Object.fromEntries(
  Object.entries(meta).filter(([, value]) => ['string','number','boolean'].includes(typeof value) || value === null),
);

/** Counts, phase timings and static caller labels only; never request payloads. */
export function recordBuyAnimeCatalogEvidence(event:string, details:SafeMeta):void {
  if(!active || active.outcome!=='RUNNING') return;
  (active.catalogEvidence ??= []).push({offsetMs:rounded(now()-active.startedAtPerformance),event,details:safeMeta(details)!});
}

export function beginBuyAnimeProductionTrace(file: Pick<File, 'name' | 'size'>): BuyAnimeProductionTrace {
  const startedAtPerformance = now();
  active = {
    format: 'ERP2_BUYANIME_PRODUCTION_TRACE_V1',
    traceId: crypto.randomUUID(),
    startedAt: new Date().toISOString(), completedAt: null, outcome: 'RUNNING',
    fileBytes: file.size, fileExtension: safeExtension(file.name), events: [], spans: [], network: [],
    totalMs: null, unattributedMs: null, longTasksMs: [], reactCommitCount: 0, reactCommitMaxMs: 0,
    missingRequiredPoints: [...REQUIRED_POINTS], startedAtPerformance,
  };
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      active.observer = new PerformanceObserver(list => {
        if (!active) return;
        active.longTasksMs.push(...list.getEntries().map(entry => rounded(entry.duration)));
      });
      active.observer.observe({ type: 'longtask', buffered: false });
    } catch { /* Long-task entries are not supported by every browser. */ }
  }
  markBuyAnimeTrace('T00_FILE_SELECTED');
  publish(publicTrace(active));
  return publicTrace(active);
}

export function recordBuyAnimeReactCommit(durationMs: number): void {
  if (!active || active.outcome !== 'RUNNING') return;
  active.reactCommitCount += 1;
  active.reactCommitMaxMs = Math.max(active.reactCommitMaxMs, rounded(Math.max(0, durationMs)));
}

export function markBuyAnimeTrace(point: BuyAnimeTracePoint, meta?: SafeMeta): void {
  if (!active || active.outcome !== 'RUNNING') return;
  const existing = active.events.find(event => event.point === point);
  if (existing) return;
  active.events.push({ point, offsetMs: rounded(now() - active.startedAtPerformance), at: new Date().toISOString(), meta: safeMeta(meta) });
}

const requestCategory = (url: URL): string => {
  if (url.pathname.includes('/rpc/erp_apply_cloud_field_mutation')) return 'INVENTORY_COMMIT_RPC';
  if (url.pathname.includes('/rpc/erp_apply_catalog_transaction')) return 'CATALOG_COMMIT_RPC';
  if (url.pathname.includes('/rpc/erp_commit_waca_snapshot')) return 'WACA_EVIDENCE_RPC';
  if (url.pathname.includes('/inventory_items')) return 'INVENTORY_READ';
  if (url.pathname.includes('/product_groups')) return 'PRODUCT_GROUP_READ';
  if (url.pathname.includes('/product_variants')) return 'PRODUCT_VARIANT_READ';
  if (url.pathname.includes('/waca_')) return 'WACA_READ';
  if (url.pathname.includes('/rest/v1/')) return 'SUPABASE_REST_OTHER';
  return url.hostname.endsWith('.supabase.co') ? 'SUPABASE_OTHER' : 'APP_RESOURCE';
};

const captureNetwork = (start: number, end: number): BuyAnimeTraceNetworkEntry[] => {
  if (typeof performance === 'undefined') return [];
  return performance.getEntriesByType('resource')
    .filter((entry): entry is PerformanceResourceTiming => entry.entryType === 'resource')
    .filter(entry => entry.startTime >= start && entry.startTime <= end)
    .map(entry => {
      const url = new URL(entry.name, typeof location === 'undefined' ? 'https://invalid.local' : location.href);
      const category = requestCategory(url);
      const responseStatus = Number((entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus || 0) || null;
      return {
        category,
        method: url.pathname.includes('/rpc/') ? 'POST' : category.endsWith('_READ') ? 'GET' : 'UNKNOWN',
        url: `${url.origin}${url.pathname}`,
        startMs: rounded(entry.startTime - start), durationMs: rounded(entry.duration), status: responseStatus,
        transferBytes: entry.transferSize || 0, responseBytes: entry.decodedBodySize || entry.encodedBodySize || 0,
        blockingSuccess: category !== 'APP_RESOURCE' && category !== 'SUPABASE_OTHER',
      };
    });
};

export function finishBuyAnimeProductionTrace(outcome: 'SUCCESS' | 'ERROR', errorCode?: string): BuyAnimeProductionTrace | null {
  if (!active || active.outcome !== 'RUNNING') return active;
  const end = now();
  active.outcome = outcome;
  active.completedAt = new Date().toISOString();
  active.totalMs = rounded(end - active.startedAtPerformance);
  active.observer?.disconnect();
  delete active.observer;
  active.network = captureNetwork(active.startedAtPerformance, end);
  const ordered = [...active.events].sort((a, b) => a.offsetMs - b.offsetMs);
  active.spans = ordered.slice(1).map((event, index) => ({
    from: ordered[index].point, to: event.point,
    label: `${ordered[index].point} → ${event.point}`,
    durationMs: rounded(Math.max(0, event.offsetMs - ordered[index].offsetMs)),
  }));
  const covered = active.spans.reduce((sum, span) => sum + span.durationMs, 0);
  active.unattributedMs = rounded(Math.max(0, active.totalMs - covered));
  const seen = new Set(active.events.map(event => event.point));
  active.missingRequiredPoints = REQUIRED_POINTS.filter(point => !seen.has(point));
  if (errorCode && /^(?:BUYANIME_|CLOUD_|FILE_|PARSER_|VALIDATION_)[A-Z0-9_]+$/u.test(errorCode)) active.errorCode = errorCode;
  const completed = publicTrace(active);
  publish(completed);
  active = null;
  return completed;
}

export function getLatestBuyAnimeProductionTrace(): BuyAnimeProductionTrace | null {
  if (typeof window === 'undefined') return null;
  const exposed = (window as unknown as Record<string, unknown>).__ERP2_BUYANIME_PRODUCTION_TRACE__;
  if (exposed && (exposed as BuyAnimeProductionTrace).format === 'ERP2_BUYANIME_PRODUCTION_TRACE_V1') return exposed as BuyAnimeProductionTrace;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null') as BuyAnimeProductionTrace | null;
    return parsed?.format === 'ERP2_BUYANIME_PRODUCTION_TRACE_V1' ? parsed : null;
  } catch { return null; }
}
