/**
 * Partitioned keyset read for one table.
 *
 * Same rows and the same global key order as a sequential keyset scan, but a
 * table larger than one page is read as independent key ranges in parallel:
 *   1. first page (key order) with an exact row count;
 *   2. small single-key probes at fixed offsets after the first page give
 *      range boundaries (value-based, so concurrent inserts/deletes cannot make
 *      a range skip rows the way OFFSET pagination can);
 *   3. each range [b_j, b_j+1) is read with its own keyset loop.
 * Rows are concatenated in range order and de-duplicated by key. If a bounded
 * range unexpectedly returns nothing (boundaries not monotonic under heavy
 * concurrent deletes) the remainder is re-read sequentially. Cross-page
 * atomicity is unchanged from the sequential scan: rows changed after the read
 * started are still converged by Realtime / authoritative catch-up.
 */
export interface KeysetPageRequest {
  /** Exclusive lower bound (keyset cursor). */
  gt?: string | null;
  /** Inclusive lower bound (range start). */
  gte?: string;
  /** Exclusive upper bound (range end). */
  lt?: string;
  limit: number;
  /** Ask for the exact total row count (first page only). */
  count?: boolean;
}
export interface KeysetPageResult<T> { rows: T[]; count?: number | null }

export interface PartitionedKeysetOptions<T> {
  keyColumn: string;
  page: (request: KeysetPageRequest) => Promise<KeysetPageResult<T>>;
  /** Key of the row at `offset` (0-based) after `afterKey` in key order, or null. */
  probe: (afterKey: string, offset: number) => Promise<string | null>;
  pageSize?: number;
  maxPartitions?: number;
}

const keyOf = (row: unknown, column: string): string | null => {
  const value = (row as Record<string, unknown> | null)?.[column];
  return typeof value === 'string' && value ? value : null;
};

async function readRange<T>(options: PartitionedKeysetOptions<T>, lower: { gt?: string; gte?: string }, lt: string | undefined, limit: number): Promise<T[]> {
  const rows: T[] = [];
  let request: KeysetPageRequest = { ...lower, lt, limit };
  for (;;) {
    const { rows: page } = await options.page(request);
    rows.push(...page);
    if (page.length < limit) return rows;
    const last = keyOf(page[page.length - 1], options.keyColumn);
    const previous = request.gt ?? request.gte ?? null;
    if (!last || last === previous) throw new Error(`CLOUD_KEYSET_CURSOR_NOT_ADVANCING:${options.keyColumn}`);
    request = { gt: last, lt, limit };
  }
}

export async function fetchPartitionedKeyset<T>(options: PartitionedKeysetOptions<T>): Promise<T[]> {
  const limit = options.pageSize ?? 1000;
  const maxPartitions = Math.max(1, options.maxPartitions ?? 8);
  const first = await options.page({ gt: null, limit, count: true });
  const dedupe = (pages: T[][]): T[] => {
    const seen = new Set<string>(); const out: T[] = [];
    for (const page of pages) for (const row of page) {
      const key = keyOf(row, options.keyColumn);
      if (key) { if (seen.has(key)) continue; seen.add(key); }
      out.push(row);
    }
    return out;
  };
  if (first.rows.length < limit) return dedupe([first.rows]);
  const lastKey = keyOf(first.rows[first.rows.length - 1], options.keyColumn);
  if (!lastKey) throw new Error(`CLOUD_KEYSET_CURSOR_NOT_ADVANCING:${options.keyColumn}`);
  const stride = limit - 1; // a bounded range then normally fits in ONE page (< limit)
  const remaining = typeof first.count === 'number' ? Math.max(0, first.count - first.rows.length) : null;
  const probes = remaining === null ? 0 : Math.min(maxPartitions - 1, Math.max(0, Math.ceil(remaining / stride) - 1));
  const sequentialRest = () => readRange(options, { gt: lastKey }, undefined, limit);
  // Partitioning costs one probe round trip; it only pays off when at least
  // three more sequential pages would follow. Otherwise keep the plain scan.
  if (probes < 2) return dedupe([first.rows, await sequentialRest()]);
  const found = await Promise.all(Array.from({ length: probes }, (_, index) => options.probe(lastKey, (index + 1) * stride)));
  const bounds: string[] = [];
  for (const key of found) if (key && key !== bounds[bounds.length - 1] && key !== lastKey) bounds.push(key);
  const ranges = [{ lower: { gt: lastKey } as { gt?: string; gte?: string }, lt: bounds[0] as string | undefined },
    ...bounds.map((bound, index) => ({ lower: { gte: bound }, lt: bounds[index + 1] }))];
  const pages = await Promise.all(ranges.map(range => readRange(options, range.lower, range.lt, limit)));
  // A bounded range with distinct boundaries cannot legitimately be empty
  // (its lower bound row existed when probed); treat it as a non-monotonic
  // boundary set and fall back to the plain sequential scan for the rest.
  if (pages.some((page, index) => index < pages.length - 1 && page.length === 0)) {
    return dedupe([first.rows, await sequentialRest()]);
  }
  return dedupe([first.rows, ...pages]);
}
