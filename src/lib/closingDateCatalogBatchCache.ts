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
  private readonly waiters: Array<() => void> = [];

  peak = 0;

  constructor(maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16) {
      throw new Error('Catalog concurrency must be an integer between 1 and 16');
    }
    this.maximum = maximum;
  }

  async run<T>(operation: () => Promise<T>): Promise<{ value: T; observedConcurrency: number }> {
    if (this.active >= this.maximum) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    const observedConcurrency = this.active;
    try {
      return { value: await operation(), observedConcurrency };
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
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
}

interface InflightCatalogResponse {
  promise: Promise<{ response: ReadonlyCatalogSearchResponse; observedConcurrency: number }>;
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
    const cached = this.cached.get(cacheKey);
    if (cached && cached.expiresAtMs > now) {
      this.cached.delete(cacheKey);
      this.cached.set(cacheKey, cached);
      return {
        response: cached.response,
        source: 'CACHE',
        cacheKey,
        observedUpstreamConcurrency: 0,
      };
    }
    if (cached) this.cached.delete(cacheKey);

    const active = this.inflight.get(cacheKey);
    if (active) {
      const shared = await raceWithAbort(active.promise, input.signal);
      return {
        response: shared.response,
        source: 'SINGLE_FLIGHT',
        cacheKey,
        observedUpstreamConcurrency: shared.observedConcurrency,
      };
    }

    const request = this.concurrency.run(async () => {
      const response = await this.client.search({
        query: normalizedQuery,
        limit,
        snapshotVersion: input.snapshot.version,
      });
      if (response.snapshotVersion !== input.snapshot.version) {
        throw new ClosingDateCatalogGatewayError({
          code: 'SNAPSHOT_VERSION_MISMATCH',
          message: `Catalog snapshot changed during batch: ${input.snapshot.version} -> ${response.snapshotVersion}`,
          retryable: true,
        });
      }
      return response;
    }).then(({ value, observedConcurrency }) => {
      const completedAt = this.nowMs();
      const snapshotExpiry = Date.parse(input.snapshot.expiresAt);
      const expiresAtMs = Math.min(
        completedAt + this.ttlMs,
        Number.isFinite(snapshotExpiry) ? snapshotExpiry : completedAt + this.ttlMs,
      );
      const shared = { response: value, observedConcurrency };
      this.cached.set(cacheKey, { response: value, expiresAtMs });
      this.trim();
      return shared;
    });
    this.inflight.set(cacheKey, { promise: request });
    void request.then(() => {
      if (this.inflight.get(cacheKey)?.promise === request) this.inflight.delete(cacheKey);
    }, () => {
      if (this.inflight.get(cacheKey)?.promise === request) this.inflight.delete(cacheKey);
    });

    const shared = await raceWithAbort(request, input.signal);
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
          throw new ClosingDateCatalogGatewayError({
            code: 'CATALOG_SERVICE_ERROR',
            message: error.message,
            retryable: error.status === null || error.status >= 500 || error.status === 429,
            status: error.status,
            cause: error,
          });
        }
        throw error;
      }
    },
  };
}
