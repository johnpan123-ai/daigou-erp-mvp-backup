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
  snapshotVersion: string;
  signal?: AbortSignal;
}

export interface ReadonlyCatalogSearchResponse {
  products: readonly ProxyCatalogCandidate[];
  snapshotVersion: string;
}

export interface ReadonlyCatalogClient {
  openSnapshot(
    preference: 'LATEST' | string,
    signal?: AbortSignal,
  ): Promise<CatalogSnapshotDescriptor>;
  search(request: ReadonlyCatalogSearchRequest): Promise<ReadonlyCatalogSearchResponse>;
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

class LimitedConcurrencyGate {
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
  limit: number;
}

export interface CatalogSnapshotQueryCacheOptions {
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
    this.concurrency = new LimitedConcurrencyGate(options.maxConcurrency ?? 6);
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
    limit?: number;
    signal?: AbortSignal;
  }): Promise<CatalogCacheLookupResult> {
    const normalizedQuery = normalizeCatalogCacheQuery(input.query);
    if (!normalizedQuery) throw new Error('Catalog query must not be empty');
    const limit = input.limit ?? 5;
    const cacheKey = JSON.stringify([input.snapshot.version, limit, normalizedQuery]);
    const now = this.nowMs();
    let cached = this.cached.get(cacheKey) ?? null;
    if (cached && cached.expiresAtMs <= now) {
      this.cached.delete(cacheKey);
      cached = null;
    }
    cached ??= this.findCachedSuperset(input.snapshot.version, normalizedQuery, limit, now);
    if (cached && cached.expiresAtMs > now) {
      const storedKey = JSON.stringify([cached.snapshotVersion, cached.limit, cached.normalizedQuery]);
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
      ?? this.findInflightSuperset(input.snapshot.version, normalizedQuery, limit);
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
        && candidate.limit >= limit
        && (!best || candidate.limit < best.limit)
      ) best = candidate;
    }
    return best;
  }

  private findInflightSuperset(
    snapshotVersion: string,
    normalizedQuery: string,
    limit: number,
  ): InflightCatalogResponse | null {
    let best: InflightCatalogResponse | null = null;
    for (const candidate of this.inflight.values()) {
      if (
        candidate.snapshotVersion === snapshotVersion
        && candidate.normalizedQuery === normalizedQuery
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

export interface ReadonlyCatalogHttpClientOptions {
  fetcher?: typeof fetch;
  cacheWindowMs?: number;
  nowMs?: () => number;
  nowIso?: () => string;
}

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
      const url = `/api/catalog/search?q=${encodeURIComponent(request.query)}&limit=${request.limit}`;
      try {
        const payload = await fetchReadonlyCatalogJson<{ products?: ProxyCatalogCandidate[] }>(
          url,
          (input, init) => fetcher(input, { ...init, method: 'GET', signal: request.signal }),
        );
        return {
          products: Array.isArray(payload.products) ? payload.products : [],
          snapshotVersion: request.snapshotVersion,
        };
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.category === 'ABORTED') throw abortError();
          throw new ClosingDateCatalogGatewayError({
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
          });
        }
        throw error;
      }
    },
  };
}
