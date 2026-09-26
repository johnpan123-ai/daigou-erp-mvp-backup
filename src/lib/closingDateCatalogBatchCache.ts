import type { ProxyCatalogCandidate } from './proxyProductIdentity';
import {
  CatalogServiceError,
  fetchReadonlyCatalogJson,
} from './readonlyCatalogApi';

export interface CatalogSnapshotDescriptor {
  version: string;
  capturedAt: string;
  expiresAt: string;
}

export interface ReadonlyCatalogSearchRequest {
  query: string;
  limit: number;
  catalogId?: string | null;
  snapshotVersion: string;
  signal?: AbortSignal;
}

export interface ReadonlyCatalogSearchResponse {
  products: readonly ProxyCatalogCandidate[];
  snapshotVersion: string;
}

export const CATALOG_DEADLINE_LOOKUP_SCHEMA_VERSION = 'deadline-v1';
export const CATALOG_DEADLINE_BATCH_MAX = 50;

export type CatalogDeadlineLookupStatus =
  | 'MATCHED'
  | 'NO_DEADLINE'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'TEMPORARY_ERROR';

export interface CatalogDeadlineLookupRecord {
  catalogProductId: string;
  status: CatalogDeadlineLookupStatus;
  reason: string | null;
  productName: string | null;
  catalogId: string | null;
  supplierCode: string | null;
  supplierProductId: string | null;
  deadlineAt: string | null;
  deadlinePrecision: 'DATETIME' | null;
  deadlineTimezone: 'UTC' | 'Asia/Taipei' | null;
  catalogProductUrl: string | null;
  sourceUpdatedAt: string | null;
  sourceUpdatedAtKind: 'PROVIDER_EXPLICIT' | 'DERIVED_SOURCE_TIME' | null;
  catalogStatus: 'AVAILABLE' | 'UNAVAILABLE' | null;
}

export interface ReadonlyCatalogDeadlineBatchRequest {
  catalogProductIds: readonly string[];
  snapshotVersion: string;
  signal?: AbortSignal;
}

export interface ReadonlyCatalogDeadlineBatchResponse {
  schemaVersion: typeof CATALOG_DEADLINE_LOOKUP_SCHEMA_VERSION;
  results: readonly CatalogDeadlineLookupRecord[];
  snapshotVersion: string;
}

export interface ReadonlyCatalogClient {
  openSnapshot(
    preference: 'LATEST' | string,
    signal?: AbortSignal,
  ): Promise<CatalogSnapshotDescriptor>;
  search(request: ReadonlyCatalogSearchRequest): Promise<ReadonlyCatalogSearchResponse>;
  lookupDeadlines?(
    request: ReadonlyCatalogDeadlineBatchRequest,
  ): Promise<ReadonlyCatalogDeadlineBatchResponse>;
}

export class ClosingDateCatalogGatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(input: {
    code: string;
    message: string;
    retryable: boolean;
    status?: number | null;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'ClosingDateCatalogGatewayError';
    this.code = input.code;
    this.retryable = input.retryable;
    this.status = input.status ?? null;
  }
}

export const normalizeCatalogCacheQuery = (query: string): string => query
  .normalize('NFKC')
  .replace(/\s+/gu, ' ')
  .trim()
  .toLocaleLowerCase();

const abortError = (): DOMException => new DOMException('Catalog lookup cancelled', 'AbortError');

const raceWithAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

export class LimitedConcurrencyGate {
  private active = 0;
  private readonly maximum: number;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: DOMException) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  peak = 0;

  constructor(maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16) {
      throw new Error('Catalog concurrency must be an integer between 1 and 16');
    }
    this.maximum = maximum;
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    if (this.active < this.maximum) {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = {
        resolve,
        reject,
        signal,
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      // Transfer the occupied slot directly to the next waiter.
      waiter.resolve();
      return;
    }
    this.active -= 1;
  }

  async run<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<{ value: T; observedConcurrency: number }> {
    await this.acquire(signal);
    this.peak = Math.max(this.peak, this.active);
    const observedConcurrency = this.active;
    try {
      return { value: await operation(), observedConcurrency };
    } finally {
      this.release();
    }
  }
}

export type CatalogCacheLookupSource = 'UPSTREAM' | 'CACHE' | 'SINGLE_FLIGHT';

export interface CatalogCacheLookupResult {
  response: ReadonlyCatalogSearchResponse;
  source: CatalogCacheLookupSource;
  cacheKey: string;
  observedUpstreamConcurrency: number;
}

interface CachedCatalogResponse {
  response: ReadonlyCatalogSearchResponse;
  expiresAtMs: number;
  snapshotVersion: string;
  normalizedQuery: string;
  catalogId: string | null;
  limit: number;
}

interface InflightCatalogResponse {
  promise: Promise<{ response: ReadonlyCatalogSearchResponse; observedConcurrency: number }>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
  cacheKey: string;
  snapshotVersion: string;
  normalizedQuery: string;
  catalogId: string | null;
  limit: number;
}

export interface CatalogSnapshotQueryCacheOptions {
  concurrencyGate?: LimitedConcurrencyGate;
  ttlMs?: number;
  maxEntries?: number;
  maxConcurrency?: number;
  nowMs?: () => number;
}

export class CatalogSnapshotQueryCache {
  private readonly client: ReadonlyCatalogClient;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly nowMs: () => number;
  private readonly concurrency: LimitedConcurrencyGate;
  private readonly cached = new Map<string, CachedCatalogResponse>();
  private readonly inflight = new Map<string, InflightCatalogResponse>();

  constructor(client: ReadonlyCatalogClient, options: CatalogSnapshotQueryCacheOptions = {}) {
    this.client = client;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxEntries = options.maxEntries ?? 2_000;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.concurrency = options.concurrencyGate ?? new LimitedConcurrencyGate(options.maxConcurrency ?? 6);
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Catalog cache TTL must be positive');
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error('Catalog cache maxEntries must be a positive integer');
    }
  }

  openSnapshot(
    preference: 'LATEST' | string,
    signal?: AbortSignal,
  ): Promise<CatalogSnapshotDescriptor> {
    return this.client.openSnapshot(preference, signal);
  }

  async lookup(input: {
    snapshot: CatalogSnapshotDescriptor;
    query: string;
    catalogId?: string | null;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<CatalogCacheLookupResult> {
    const normalizedQuery = normalizeCatalogCacheQuery(input.query);
    if (!normalizedQuery) throw new Error('Catalog query must not be empty');
    const catalogId = input.catalogId?.trim() || null;
    const limit = input.limit ?? 5;
    const cacheKey = JSON.stringify([
      CATALOG_DEADLINE_LOOKUP_SCHEMA_VERSION,
      'deadline-candidate',
      input.snapshot.version,
      catalogId,
      limit,
      normalizedQuery,
    ]);
    const now = this.nowMs();
    let cached = this.cached.get(cacheKey) ?? null;
    if (cached && cached.expiresAtMs <= now) {
      this.cached.delete(cacheKey);
      cached = null;
    }
    cached ??= this.findCachedSuperset(
      input.snapshot.version,
      normalizedQuery,
      catalogId,
      limit,
      now,
    );
    if (cached && cached.expiresAtMs > now) {
      const storedKey = JSON.stringify([
        CATALOG_DEADLINE_LOOKUP_SCHEMA_VERSION,
        'deadline-candidate',
        cached.snapshotVersion,
        cached.catalogId,
        cached.limit,
        cached.normalizedQuery,
      ]);
      this.cached.delete(storedKey);
      this.cached.set(storedKey, cached);
      return {
        response: this.limitResponse(cached.response, limit),
        source: 'CACHE',
        cacheKey,
        observedUpstreamConcurrency: 0,
      };
    }

    const active = this.inflight.get(cacheKey)
      ?? this.findInflightSuperset(input.snapshot.version, normalizedQuery, catalogId, limit);
    if (active) {
      const shared = await this.consumeInflight(active, input.signal);
      return {
        response: this.limitResponse(shared.response, limit),
        source: 'SINGLE_FLIGHT',
        cacheKey,
        observedUpstreamConcurrency: shared.observedConcurrency,
      };
    }

    const controller = new AbortController();
    const request: InflightCatalogResponse['promise'] = this.concurrency.run(async () => {
      const response = await this.client.search({
        query: normalizedQuery,
        limit,
        catalogId,
        snapshotVersion: input.snapshot.version,
        signal: controller.signal,
      });
      if (response.snapshotVersion !== input.snapshot.version) {
        throw new ClosingDateCatalogGatewayError({
          code: 'SNAPSHOT_VERSION_MISMATCH',
          message: `Catalog snapshot changed during batch: ${input.snapshot.version} -> ${response.snapshotVersion}`,
          retryable: true,
        });
      }
      return response;
    }, controller.signal).then(({ value, observedConcurrency }) => {
      const shared = { response: value, observedConcurrency };
      // A retired request may still resolve when an upstream ignores abort.
      // It must not repopulate the cache or overwrite a replacement request.
      if (controller.signal.aborted || this.inflight.get(cacheKey)?.controller !== controller) return shared;
      const completedAt = this.nowMs();
      const snapshotExpiry = Date.parse(input.snapshot.expiresAt);
      const expiresAtMs = Math.min(
        completedAt + this.ttlMs,
        Number.isFinite(snapshotExpiry) ? snapshotExpiry : completedAt + this.ttlMs,
      );
      this.cached.set(cacheKey, {
        response: value,
        expiresAtMs,
        snapshotVersion: input.snapshot.version,
        normalizedQuery,
        catalogId,
        limit,
      });
      this.trim();
      return shared;
    });
    const created: InflightCatalogResponse = {
      promise: request,
      controller,
      consumers: 0,
      settled: false,
      cacheKey,
      snapshotVersion: input.snapshot.version,
      normalizedQuery,
      catalogId,
      limit,
    };
    this.inflight.set(cacheKey, created);
    void request.then(
      () => this.settleInflight(cacheKey, created),
      () => this.settleInflight(cacheKey, created),
    );

    const shared = await this.consumeInflight(created, input.signal);
    return {
      response: shared.response,
      source: 'UPSTREAM',
      cacheKey,
      observedUpstreamConcurrency: shared.observedConcurrency,
    };
  }

  clear(): void {
    this.cached.clear();
  }

  get peakUpstreamConcurrency(): number {
    return this.concurrency.peak;
  }

  private async consumeInflight(
    active: InflightCatalogResponse,
    signal?: AbortSignal,
  ): Promise<{ response: ReadonlyCatalogSearchResponse; observedConcurrency: number }> {
    active.consumers += 1;
    try {
      return await raceWithAbort(active.promise, signal);
    } finally {
      active.consumers -= 1;
      if (active.consumers === 0 && !active.settled) {
        // Detach immediately so a dependency that ignores AbortSignal cannot
        // permanently occupy the single-flight entry. The concurrency gate is
        // still released by its own finally block when the operation settles.
        if (this.inflight.get(active.cacheKey) === active) this.inflight.delete(active.cacheKey);
        active.controller.abort(abortError());
      }
    }
  }

  private settleInflight(cacheKey: string, active: InflightCatalogResponse): void {
    active.settled = true;
    if (this.inflight.get(cacheKey) === active) this.inflight.delete(cacheKey);
  }

  private limitResponse(
    response: ReadonlyCatalogSearchResponse,
    limit: number,
  ): ReadonlyCatalogSearchResponse {
    if (response.products.length <= limit) return response;
    return { ...response, products: response.products.slice(0, limit) };
  }

  private findCachedSuperset(
    snapshotVersion: string,
    normalizedQuery: string,
    catalogId: string | null,
    limit: number,
    now: number,
  ): CachedCatalogResponse | null {
    let best: CachedCatalogResponse | null = null;
    for (const [key, candidate] of this.cached) {
      if (candidate.expiresAtMs <= now) {
        this.cached.delete(key);
        continue;
      }
      if (
        candidate.snapshotVersion === snapshotVersion
        && candidate.normalizedQuery === normalizedQuery
        && candidate.catalogId === catalogId
        && candidate.limit >= limit
        && (!best || candidate.limit < best.limit)
      ) best = candidate;
    }
    return best;
  }

  private findInflightSuperset(
    snapshotVersion: string,
    normalizedQuery: string,
    catalogId: string | null,
    limit: number,
  ): InflightCatalogResponse | null {
    let best: InflightCatalogResponse | null = null;
    for (const candidate of this.inflight.values()) {
      if (
        candidate.snapshotVersion === snapshotVersion
        && candidate.normalizedQuery === normalizedQuery
        && candidate.catalogId === catalogId
        && candidate.limit >= limit
        && (!best || candidate.limit < best.limit)
      ) best = candidate;
    }
    return best;
  }

  private trim(): void {
    while (this.cached.size > this.maxEntries) {
      const oldest = this.cached.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cached.delete(oldest);
    }
  }
}

interface CachedDeadlineResult {
  result: CatalogDeadlineLookupRecord;
  expiresAtMs: number;
}

interface InflightDeadlineBatch {
  promise: Promise<{
    response: ReadonlyCatalogDeadlineBatchResponse;
    observedConcurrency: number;
  }>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
  cacheKeys: readonly string[];
  catalogProductIds: readonly string[];
  snapshotVersion: string;
}

export interface CatalogDeadlineDirectEntry {
  catalogProductId: string;
  result: CatalogDeadlineLookupRecord;
  source: CatalogCacheLookupSource;
  cacheKey: string;
}

export interface CatalogDeadlineDirectLookupResult {
  entries: readonly CatalogDeadlineDirectEntry[];
  upstreamRequestCount: number;
  cacheHitCount: number;
  singleFlightHitCount: number;
  observedUpstreamConcurrency: number;
}

export interface CatalogDeadlineDirectCacheOptions {
  concurrencyGate?: LimitedConcurrencyGate;
  ttlMs?: number;
  maxEntries?: number;
  maxConcurrency?: number;
  nowMs?: () => number;
}

const directCacheKey = (snapshotVersion: string, catalogProductId: string): string => JSON.stringify([
  CATALOG_DEADLINE_LOOKUP_SCHEMA_VERSION,
  'deadline-direct',
  snapshotVersion,
  catalogProductId,
]);

export class CatalogDeadlineDirectCache {
  private readonly client: ReadonlyCatalogClient;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly nowMs: () => number;
  private readonly concurrency: LimitedConcurrencyGate;
  private readonly cached = new Map<string, CachedDeadlineResult>();
  private readonly inflight = new Map<string, InflightDeadlineBatch>();

  constructor(client: ReadonlyCatalogClient, options: CatalogDeadlineDirectCacheOptions = {}) {
    this.client = client;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxEntries = options.maxEntries ?? 2_000;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.concurrency = options.concurrencyGate ?? new LimitedConcurrencyGate(options.maxConcurrency ?? 6);
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Catalog direct cache TTL must be positive');
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error('Catalog direct cache maxEntries must be a positive integer');
    }
  }

  async lookup(input: {
    snapshot: CatalogSnapshotDescriptor;
    catalogProductIds: readonly string[];
    signal?: AbortSignal;
  }): Promise<CatalogDeadlineDirectLookupResult> {
    const catalogProductIds = [...new Set(input.catalogProductIds.map(id => id.trim()).filter(Boolean))];
    if (catalogProductIds.length === 0) {
      return {
        entries: [],
        upstreamRequestCount: 0,
        cacheHitCount: 0,
        singleFlightHitCount: 0,
        observedUpstreamConcurrency: 0,
      };
    }
    if (catalogProductIds.length > CATALOG_DEADLINE_BATCH_MAX) {
      throw new Error(`Catalog direct lookup exceeds ${CATALOG_DEADLINE_BATCH_MAX} IDs`);
    }
    if (input.signal?.aborted) throw abortError();

    const now = this.nowMs();
    const resolved = new Map<string, CatalogDeadlineDirectEntry>();
    const existingBatches = new Map<InflightDeadlineBatch, string[]>();
    const missing: string[] = [];

    for (const catalogProductId of catalogProductIds) {
      const cacheKey = directCacheKey(input.snapshot.version, catalogProductId);
      const cached = this.cached.get(cacheKey);
      if (cached && cached.expiresAtMs <= now) this.cached.delete(cacheKey);
      else if (cached) {
        this.cached.delete(cacheKey);
        this.cached.set(cacheKey, cached);
        resolved.set(catalogProductId, {
          catalogProductId,
          result: cached.result,
          source: 'CACHE',
          cacheKey,
        });
        continue;
      }
      const active = this.inflight.get(cacheKey);
      if (active) {
        const ids = existingBatches.get(active) ?? [];
        ids.push(catalogProductId);
        existingBatches.set(active, ids);
      } else {
        missing.push(catalogProductId);
      }
    }

    const created = missing.length > 0
      ? this.createInflight(input.snapshot, missing)
      : null;
    const batches = new Map(existingBatches);
    if (created) batches.set(created, missing);
    let observedUpstreamConcurrency = 0;

    await Promise.all([...batches.entries()].map(async ([active, ids]) => {
      const shared = await this.consumeInflight(active, input.signal);
      observedUpstreamConcurrency = Math.max(
        observedUpstreamConcurrency,
        shared.observedConcurrency,
      );
      const resultsById = new Map(
        shared.response.results.map(result => [result.catalogProductId, result]),
      );
      for (const catalogProductId of ids) {
        const result = resultsById.get(catalogProductId);
        if (!result) {
          throw new ClosingDateCatalogGatewayError({
            code: 'CATALOG_DIRECT_CONTRACT_ERROR',
            message: `Catalog direct response omitted ${catalogProductId}`,
            retryable: false,
          });
        }
        resolved.set(catalogProductId, {
          catalogProductId,
          result,
          source: active === created ? 'UPSTREAM' : 'SINGLE_FLIGHT',
          cacheKey: directCacheKey(input.snapshot.version, catalogProductId),
        });
      }
    }));

    return {
      entries: catalogProductIds.map(catalogProductId => {
        const entry = resolved.get(catalogProductId);
        if (!entry) throw new Error(`Catalog direct lookup did not resolve ${catalogProductId}`);
        return entry;
      }),
      upstreamRequestCount: created ? 1 : 0,
      cacheHitCount: [...resolved.values()].filter(entry => entry.source === 'CACHE').length,
      singleFlightHitCount: [...resolved.values()]
        .filter(entry => entry.source === 'SINGLE_FLIGHT').length,
      observedUpstreamConcurrency,
    };
  }

  clear(): void {
    this.cached.clear();
  }

  get peakUpstreamConcurrency(): number {
    return this.concurrency.peak;
  }

  private createInflight(
    snapshot: CatalogSnapshotDescriptor,
    catalogProductIds: readonly string[],
  ): InflightDeadlineBatch {
    const lookupDeadlines = this.client.lookupDeadlines;
    if (!lookupDeadlines) {
      throw new ClosingDateCatalogGatewayError({
        code: 'CATALOG_DIRECT_UNAVAILABLE',
        message: 'Catalog direct deadline lookup is unavailable',
        retryable: false,
      });
    }
    const controller = new AbortController();
    const cacheKeys = catalogProductIds.map(id => directCacheKey(snapshot.version, id));
    const active = {} as InflightDeadlineBatch;
    const promise = this.concurrency.run(async () => {
      const response = await lookupDeadlines.call(this.client, {
        catalogProductIds,
        snapshotVersion: snapshot.version,
        signal: controller.signal,
      });
      if (response.schemaVersion !== CATALOG_DEADLINE_LOOKUP_SCHEMA_VERSION) {
        throw new ClosingDateCatalogGatewayError({
          code: 'CATALOG_DEADLINE_SCHEMA_MISMATCH',
          message: `Unsupported Catalog deadline schema: ${response.schemaVersion}`,
          retryable: false,
        });
      }
      if (response.snapshotVersion !== snapshot.version) {
        throw new ClosingDateCatalogGatewayError({
          code: 'SNAPSHOT_VERSION_MISMATCH',
          message: `Catalog snapshot changed during direct lookup: ${snapshot.version} -> ${response.snapshotVersion}`,
          retryable: true,
        });
      }
      return response;
    }, controller.signal).then(({ value, observedConcurrency }) => {
      if (controller.signal.aborted) return { response: value, observedConcurrency };
      const completedAt = this.nowMs();
      const snapshotExpiry = Date.parse(snapshot.expiresAt);
      const expiresAtMs = Math.min(
        completedAt + this.ttlMs,
        Number.isFinite(snapshotExpiry) ? snapshotExpiry : completedAt + this.ttlMs,
      );
      for (const result of value.results) {
        const key = directCacheKey(snapshot.version, result.catalogProductId);
        if (
          result.status !== 'TEMPORARY_ERROR'
          && this.inflight.get(key) === active
        ) {
          this.cached.set(key, { result, expiresAtMs });
        }
      }
      this.trim();
      return { response: value, observedConcurrency };
    });
    Object.assign(active, {
      promise,
      controller,
      consumers: 0,
      settled: false,
      cacheKeys,
      catalogProductIds,
      snapshotVersion: snapshot.version,
    });
    for (const cacheKey of cacheKeys) this.inflight.set(cacheKey, active);
    void promise.then(
      () => this.settleInflight(active),
      () => this.settleInflight(active),
    );
    return active;
  }

  private async consumeInflight(
    active: InflightDeadlineBatch,
    signal?: AbortSignal,
  ): Promise<{
      response: ReadonlyCatalogDeadlineBatchResponse;
      observedConcurrency: number;
    }> {
    active.consumers += 1;
    try {
      return await raceWithAbort(active.promise, signal);
    } finally {
      active.consumers -= 1;
      if (active.consumers === 0 && !active.settled) {
        for (const cacheKey of active.cacheKeys) {
          if (this.inflight.get(cacheKey) === active) this.inflight.delete(cacheKey);
        }
        active.controller.abort(abortError());
      }
    }
  }

  private settleInflight(active: InflightDeadlineBatch): void {
    active.settled = true;
    for (const cacheKey of active.cacheKeys) {
      if (this.inflight.get(cacheKey) === active) this.inflight.delete(cacheKey);
    }
  }

  private trim(): void {
    while (this.cached.size > this.maxEntries) {
      const oldest = this.cached.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cached.delete(oldest);
    }
  }
}

export interface ReadonlyCatalogHttpClientOptions {
  fetcher?: typeof fetch;
  cacheWindowMs?: number;
  nowMs?: () => number;
  nowIso?: () => string;
}

interface CatalogDeadlineCandidateDto {
  catalogProductId: string;
  productName: string;
  catalogId: string;
  supplierCode: string;
  supplierProductId: string;
  deadlineAt: string | null;
  sourceUpdatedAt: string | null;
  matchEvidence: {
    originalName: string;
    brandName: string | null;
    catalogName: string;
  };
}

interface CatalogDeadlineCandidatePayload {
  schemaVersion: string;
  status: 'AMBIGUOUS' | 'NOT_FOUND' | 'TEMPORARY_ERROR';
  reason: string;
  query: string;
  candidates: readonly CatalogDeadlineCandidateDto[];
}

const CATALOG_PUBLIC_ORIGIN = 'https://hippotoycatalog.com';

const publicCatalogProductUrl = (catalogProductId: string): string => (
  `${CATALOG_PUBLIC_ORIGIN}/product/${encodeURIComponent(catalogProductId)}`
);

const candidateDtoToProxyCandidate = (
  candidate: CatalogDeadlineCandidateDto,
): ProxyCatalogCandidate => ({
  id: candidate.catalogProductId,
  name: candidate.productName,
  url: publicCatalogProductUrl(candidate.catalogProductId),
  supplierProductId: candidate.supplierProductId,
  brand: candidate.matchEvidence.brandName
    ? { name: candidate.matchEvidence.brandName }
    : null,
  catalog: {
    id: candidate.catalogId,
    name: candidate.matchEvidence.catalogName,
    deadlineAt: candidate.deadlineAt,
    sourceUpdatedAt: candidate.sourceUpdatedAt,
    supplier: { code: candidate.supplierCode },
  },
});

const mapCatalogServiceError = (error: CatalogServiceError): ClosingDateCatalogGatewayError => (
  new ClosingDateCatalogGatewayError({
    code: error.category === 'TIMEOUT'
      ? 'CATALOG_TIMEOUT'
      : 'CATALOG_SERVICE_ERROR',
    message: error.message,
    retryable: error.category === 'TIMEOUT'
      || error.status === null
      || error.status >= 500
      || error.status === 429,
    status: error.status,
    cause: error,
  })
);

export function createReadonlyCatalogHttpClient(
  options: ReadonlyCatalogHttpClientOptions = {},
): ReadonlyCatalogClient {
  const fetcher = options.fetcher ?? fetch;
  const cacheWindowMs = options.cacheWindowMs ?? 5 * 60_000;
  const nowMs = options.nowMs ?? (() => Date.now());
  const nowIso = options.nowIso ?? (() => new Date(nowMs()).toISOString());
  return {
    async openSnapshot(preference, signal) {
      if (signal?.aborted) throw abortError();
      const capturedAtMs = nowMs();
      const version = preference === 'LATEST'
        ? `next-catalog-cache-v1:${Math.floor(capturedAtMs / cacheWindowMs)}`
        : preference.trim();
      if (!version) throw new Error('Catalog snapshot preference must not be empty');
      return {
        version,
        capturedAt: nowIso(),
        expiresAt: new Date(capturedAtMs + cacheWindowMs).toISOString(),
      };
    },
    async search(request) {
      const catalogScope = request.catalogId
        ? `&catalogId=${encodeURIComponent(request.catalogId)}`
        : '';
      const url = `/api/catalog/deadline-candidates?q=${encodeURIComponent(request.query)}&limit=${request.limit}${catalogScope}`;
      try {
        const payload = await fetchReadonlyCatalogJson<CatalogDeadlineCandidatePayload>(
          url,
          (input, init) => fetcher(input, { ...init, method: 'GET', signal: request.signal }),
        );
        if (payload.schemaVersion !== CATALOG_DEADLINE_LOOKUP_SCHEMA_VERSION) {
          throw new ClosingDateCatalogGatewayError({
            code: 'CATALOG_DEADLINE_SCHEMA_MISMATCH',
            message: `Unsupported Catalog deadline schema: ${payload.schemaVersion}`,
            retryable: false,
          });
        }
        if (payload.status === 'TEMPORARY_ERROR') {
          throw new ClosingDateCatalogGatewayError({
            code: 'CATALOG_SERVICE_ERROR',
            message: 'Catalog deadline candidate lookup is temporarily unavailable',
            retryable: true,
          });
        }
        return {
          products: Array.isArray(payload.candidates)
            ? payload.candidates.map(candidateDtoToProxyCandidate)
            : [],
          snapshotVersion: request.snapshotVersion,
        };
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.category === 'ABORTED') throw abortError();
          throw mapCatalogServiceError(error);
        }
        throw error;
      }
    },
    async lookupDeadlines(request) {
      if (request.catalogProductIds.length === 0) {
        return {
          schemaVersion: CATALOG_DEADLINE_LOOKUP_SCHEMA_VERSION,
          results: [],
          snapshotVersion: request.snapshotVersion,
        };
      }
      if (request.catalogProductIds.length > CATALOG_DEADLINE_BATCH_MAX) {
        throw new ClosingDateCatalogGatewayError({
          code: 'CATALOG_DIRECT_BATCH_LIMIT',
          message: `Catalog deadline batch exceeds ${CATALOG_DEADLINE_BATCH_MAX} IDs`,
          retryable: false,
        });
      }
      const params = new URLSearchParams();
      request.catalogProductIds.forEach(id => params.append('catalogProductId', id));
      const url = `/api/catalog/deadlines?${params.toString()}`;
      try {
        const payload = await fetchReadonlyCatalogJson<{
          schemaVersion: string;
          results?: CatalogDeadlineLookupRecord[];
        }>(
          url,
          (input, init) => fetcher(input, { ...init, method: 'GET', signal: request.signal }),
        );
        if (payload.schemaVersion !== CATALOG_DEADLINE_LOOKUP_SCHEMA_VERSION) {
          throw new ClosingDateCatalogGatewayError({
            code: 'CATALOG_DEADLINE_SCHEMA_MISMATCH',
            message: `Unsupported Catalog deadline schema: ${payload.schemaVersion}`,
            retryable: false,
          });
        }
        if (!Array.isArray(payload.results)) {
          throw new ClosingDateCatalogGatewayError({
            code: 'CATALOG_DIRECT_CONTRACT_ERROR',
            message: 'Catalog direct deadline response omitted results',
            retryable: false,
          });
        }
        return {
          schemaVersion: CATALOG_DEADLINE_LOOKUP_SCHEMA_VERSION,
          results: payload.results,
          snapshotVersion: request.snapshotVersion,
        };
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.category === 'ABORTED') throw abortError();
          throw mapCatalogServiceError(error);
        }
        throw error;
      }
    },
  };
}
