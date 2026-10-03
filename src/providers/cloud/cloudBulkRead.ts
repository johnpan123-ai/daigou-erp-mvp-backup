/** Transport policy, not a business limit. Every request is a SELECT. */
export const CLOUD_BULK_READ_POLICY: Readonly<{ maxIds: number; maxUrlBytes: number; concurrency: number; retries: number; retryDelayMs: number }> = Object.freeze({
  maxIds: 150, maxUrlBytes: 7000, concurrency: 3, retries: 2, retryDelayMs: 100,
});

type IdentifiedRow = Record<string, unknown> & { id?: unknown };
export interface BulkReadOptions<T extends IdentifiedRow> {
  ids: string[];
  table: string;
  select?: string;
  baseUrl?: string;
  load: (ids: string[], signal?: AbortSignal) => Promise<T[]>;
  signal?: AbortSignal;
  // Only explicit Realtime DELETE events may have no physical row.
  allowMissing?: ReadonlySet<string>;
  expected?: ReadonlyMap<string, Record<string, unknown>>;
  policy?: Partial<typeof CLOUD_BULK_READ_POLICY>;
  onChunk?: (metric: { ids: number; urlBytes: number; attempts: number; latencyMs: number }) => void;
}

export function bulkReadUrl(table: string, ids: string[], select = '*', baseUrl = import.meta.env?.VITE_SUPABASE_URL
  ? import.meta.env.VITE_SUPABASE_URL.replace(/\/$/u, '') + '/rest/v1/' : 'https://cloud-readback.invalid/rest/v1/') {
  const url = new URL(table, baseUrl);
  url.searchParams.set('select', select);
  url.searchParams.set('id', `in.(${ids.join(',')})`);
  return url.href;
}
export const bulkReadUrlBytes = (url: string) => new TextEncoder().encode(url).length;

export class CloudBulkReadError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'CloudBulkReadError'; }
}
const fail = (code: string): never => { throw new CloudBulkReadError(code); };
const transient = (error: unknown) => {
  const e = error as { status?: number; message?: string; code?: string };
  if (e instanceof CloudBulkReadError || /abort/iu.test(e?.message || '')) return false;
  if (e?.status) return [408, 429].includes(e.status) || e.status >= 500;
  return error instanceof TypeError || /fetch|network|connection|socket|timeout/iu.test(e?.message || '');
};
const equalValue = (actual: unknown, expected: unknown) => {
  if (typeof actual === 'string' && typeof expected === 'string'
    && /^\d{4}-\d{2}-\d{2}T/u.test(actual) && /^\d{4}-\d{2}-\d{2}T/u.test(expected)) {
    return new Date(actual).getTime() === new Date(expected).getTime();
  }
  return JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null);
};
export function assertExpectedCloudFields(row: IdentifiedRow, expected: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(expected)) {
    if (!equalValue(row[field], value)) fail('CLOUD_READBACK_FIELD_MISMATCH');
  }
}
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

/** All-or-nothing read result: no partial cache merge, input order restored. */
export async function readCloudRowsByIds<T extends IdentifiedRow>(options: BulkReadOptions<T>): Promise<T[]> {
  const policy = { ...CLOUD_BULK_READ_POLICY, ...options.policy };
  for (const k of ['maxIds', 'maxUrlBytes', 'concurrency', 'retries', 'retryDelayMs'] as const) {
    if (!Number.isSafeInteger(policy[k]) || policy[k] < (k === 'retries' || k === 'retryDelayMs' ? 0 : 1))
      fail('CLOUD_BULK_READ_POLICY_INVALID');
  }
  const ids = [...new Set(options.ids)];
  if (ids.some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)))
    fail('CLOUD_READBACK_UUID_INVALID');
  const chunks: string[][] = [];
  let chunk: string[] = [];
  const size = (list: string[]) => bulkReadUrlBytes(bulkReadUrl(options.table, list, options.select, options.baseUrl));
  for (const id of ids) {
    const next = [...chunk, id];
    if (chunk.length && (next.length > policy.maxIds || size(next) > policy.maxUrlBytes)) {
      chunks.push(chunk); chunk = [];
    }
    chunk.push(id);
    if (size(chunk) > policy.maxUrlBytes) fail('CLOUD_READBACK_URL_TOO_LONG');
  }
  if (chunk.length) chunks.push(chunk);
  const results = new Map<string, T>();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  let cursor = 0;
  let failure: unknown;
  try {
    options.signal?.throwIfAborted();
    await Promise.all(Array.from({ length: Math.min(policy.concurrency, chunks.length) }, async () => {
      while (!failure && cursor < chunks.length) {
        const current = chunks[cursor++];
        const wanted = new Set(current);
        let attempt = 0;
        const started = performance.now();
        try {
          let rows: T[];
          for (;;) {
            controller.signal.throwIfAborted();
            try { rows = await options.load(current, controller.signal); break; }
            catch (error) {
              if (attempt >= policy.retries || !transient(error)) throw error;
              await pause(policy.retryDelayMs * 2 ** attempt++, controller.signal);
            }
          }
          controller.signal.throwIfAborted();
          const seen = new Set<string>();
          for (const row of rows) {
            const id = String(row.id ?? '');
            if (!wanted.has(id)) fail('CLOUD_READBACK_UNEXPECTED_ID');
            if (seen.has(id) || results.has(id)) fail('CLOUD_READBACK_DUPLICATE_ID');
            seen.add(id);
            const expected = options.expected?.get(id);
            if (expected) assertExpectedCloudFields(row, expected);
            results.set(id, row);
          }
          if (current.some(id => !seen.has(id) && !options.allowMissing?.has(id)))
            fail('CLOUD_READBACK_MISSING_ID');
          options.onChunk?.({ ids: current.length, urlBytes: size(current), attempts: attempt + 1, latencyMs: performance.now() - started });
        } catch (error) {
          if (!failure) failure = error;
          controller.abort();
        }
      }
    }));
    if (failure) throw failure;
    options.signal?.throwIfAborted();
    return ids.filter(id => results.has(id)).map(id => results.get(id)!);
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
