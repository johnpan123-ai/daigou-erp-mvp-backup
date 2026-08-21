import {
  canCancelResolutionBatch,
  canRetryResolutionBatch,
  createResolutionBatch,
  createResolutionResult,
  isActiveVerifiedMapping,
  sameSourceProduct,
  transitionResolutionBatch,
} from './closingDateResolutionDomain';
import type {
  CancelResolutionJobResponse,
  CandidateMatchMethod,
  CreateResolutionJobRequest,
  CreateResolutionJobResponse,
  ResolutionBatch,
  ResolutionJobResponse,
  ResolutionResult,
  RetryResolutionJobResponse,
  SourceProductReference,
  VerifiedMappingRegistryEntry,
} from './closingDateResolutionDomain';
import type { ClosingDateResolutionSidecarRepository } from './closingDateResolutionSidecarRepository';
import {
  CatalogSnapshotQueryCache,
  ClosingDateCatalogGatewayError,
  createReadonlyCatalogHttpClient,
} from './closingDateCatalogBatchCache';
import type {
  CatalogCacheLookupResult,
  CatalogSnapshotDescriptor,
  ReadonlyCatalogClient,
} from './closingDateCatalogBatchCache';
import {
  buildProxyCatalogQueries,
  normalizeProxyProductIdentity,
  scoreProxyCatalogCandidate,
  selectProxyCatalogCandidate,
} from './proxyProductIdentity';
import type { ProxyCatalogCandidate } from './proxyProductIdentity';
import {
  resolveProxyCatalogDecision,
  scoreProxyCatalogCandidateV2Pilot,
} from './proxyProductIdentityPilot';
import { buildProxyCatalogQueriesV2 } from './proxyProductIdentityQueryV2';
import { getBuildSandboxMode } from './testSandboxEnvironment';

export const CLOSING_DATE_BATCH_GATEWAY_FEATURE_FLAG = 'VITE_ENABLE_CLOSING_DATE_BATCH_GATEWAY';

const defaultFeatureFlagValue = import.meta.env.VITE_ENABLE_CLOSING_DATE_BATCH_GATEWAY;

export const parseClosingDateBatchGatewayFeatureFlag = (
  value: string | boolean | null | undefined,
): boolean => value === true || value === 'true';

export const isClosingDateBatchGatewayFeatureEnabled = (): boolean => (
  parseClosingDateBatchGatewayFeatureFlag(defaultFeatureFlagValue)
);

export class ClosingDateBatchGatewayUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClosingDateBatchGatewayUnavailableError';
  }
}

export function assertNextClosingDateBatchGatewayAccess(
  buildMode: ReturnType<typeof getBuildSandboxMode>,
  featureEnabled: boolean,
): void {
  if (buildMode !== 'next') {
    throw new ClosingDateBatchGatewayUnavailableError(
      'Closing Date Batch Gateway is available only in the Next Sandbox build.',
    );
  }
  if (!featureEnabled) {
    throw new ClosingDateBatchGatewayUnavailableError(
      'Closing Date Batch Gateway feature flag is disabled.',
    );
  }
}

export interface ClosingDateBatchGatewayMetrics {
  totalTimeMs: number;
  itemLatencyP50Ms: number;
  itemLatencyP95Ms: number;
  logicalQueryCount: number;
  uniqueQueryCount: number;
  upstreamRequestCount: number;
  dedupedRequestCount: number;
  dedupeRatio: number;
  cacheHitCount: number;
  cacheHitRatio: number;
  singleFlightHitCount: number;
  maxUpstreamConcurrency: number;
  cancellationCount: number;
  serviceErrorCount: number;
}

export interface ClosingDateBatchPollResponse extends ResolutionJobResponse {
  metrics: ClosingDateBatchGatewayMetrics;
  catalogSnapshot: CatalogSnapshotDescriptor;
  logicalBatchId: string;
}

export interface RetryClosingDateBatchOptions {
  clientBatchId?: string;
  idempotencyKey?: string;
  createdAt?: string;
}

export interface ClosingDateBatchSearch {
  (query: string): Promise<readonly ProxyCatalogCandidate[]>;
}

export interface ClosingDateBatchAnalysisContext {
  item: CreateResolutionJobRequest['items'][number];
  batchId: string;
  ruleVersion: string;
  snapshot: CatalogSnapshotDescriptor;
  activeMappings: readonly VerifiedMappingRegistryEntry[];
  search: ClosingDateBatchSearch;
  signal: AbortSignal;
  analyzedAt: string;
}

export type ClosingDateBatchItemAnalyzer = (
  context: ClosingDateBatchAnalysisContext,
) => Promise<ResolutionResult>;

interface MutableMetrics {
  startedAtMs: number;
  finishedAtMs: number | null;
  itemLatenciesMs: number[];
  logicalQueryCount: number;
  uniqueQueryKeys: Set<string>;
  upstreamRequestCount: number;
  cacheHitCount: number;
  singleFlightHitCount: number;
  maxUpstreamConcurrency: number;
  cancellationCount: number;
}

interface InternalResolutionJob {
  request: CreateResolutionJobRequest;
  batch: ResolutionBatch;
  results: ResolutionResult[];
  snapshot: CatalogSnapshotDescriptor;
  activeMappingsByProduct: ReadonlyMap<string, readonly VerifiedMappingRegistryEntry[]>;
  controller: AbortController;
  completion: Promise<void>;
  persistence: Promise<void>;
  metrics: MutableMetrics;
  logicalBatchId: string;
}

const createMutableMetrics = (startedAtMs: number): MutableMetrics => ({
  startedAtMs,
  finishedAtMs: null,
  itemLatenciesMs: [],
  logicalQueryCount: 0,
  uniqueQueryKeys: new Set<string>(),
  upstreamRequestCount: 0,
  cacheHitCount: 0,
  singleFlightHitCount: 0,
  maxUpstreamConcurrency: 0,
  cancellationCount: 0,
});

const percentile = (values: readonly number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)];
};

const roundMetric = (value: number): number => Math.round(value * 100) / 100;

const toMetrics = (
  mutable: MutableMetrics,
  nowMs: number,
  results: readonly ResolutionResult[],
): ClosingDateBatchGatewayMetrics => {
  const totalTimeMs = (mutable.finishedAtMs ?? nowMs) - mutable.startedAtMs;
  const dedupedRequestCount = mutable.cacheHitCount + mutable.singleFlightHitCount;
  return {
    totalTimeMs: roundMetric(Math.max(0, totalTimeMs)),
    itemLatencyP50Ms: roundMetric(percentile(mutable.itemLatenciesMs, 0.5)),
    itemLatencyP95Ms: roundMetric(percentile(mutable.itemLatenciesMs, 0.95)),
    logicalQueryCount: mutable.logicalQueryCount,
    uniqueQueryCount: mutable.uniqueQueryKeys.size,
    upstreamRequestCount: mutable.upstreamRequestCount,
    dedupedRequestCount,
    dedupeRatio: mutable.logicalQueryCount === 0
      ? 0
      : roundMetric(dedupedRequestCount / mutable.logicalQueryCount),
    cacheHitCount: mutable.cacheHitCount,
    cacheHitRatio: mutable.logicalQueryCount === 0
      ? 0
      : roundMetric(mutable.cacheHitCount / mutable.logicalQueryCount),
    singleFlightHitCount: mutable.singleFlightHitCount,
    maxUpstreamConcurrency: mutable.maxUpstreamConcurrency,
    cancellationCount: mutable.cancellationCount,
    serviceErrorCount: results.filter(result => Boolean(result.serviceError)).length,
  };
};

const isAbortError = (error: unknown): boolean => (
  error instanceof DOMException && error.name === 'AbortError'
);

const uniqueQueries = (queries: readonly string[]): string[] => Array.from(new Set(
  queries.map(query => query.trim()).filter(Boolean),
));

const candidateSupplier = (candidate: ProxyCatalogCandidate): string => (
  candidate.catalog?.supplier?.code?.trim().toLocaleLowerCase() || 'unknown'
);

const candidateSourceProductId = (candidate: ProxyCatalogCandidate): string | null => {
  const value = candidate.id ?? candidate.sku ?? candidate.slug ?? candidate.url;
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const sourceReferenceForCandidate = (
  candidate: ProxyCatalogCandidate,
  snapshotVersion: string,
): SourceProductReference | null => {
  const sourceProductId = candidateSourceProductId(candidate);
  if (!sourceProductId) return null;
  return {
    sourceSupplier: candidateSupplier(candidate),
    sourceProductId,
    sourceCatalogId: snapshotVersion,
  };
};

const suggestedClosingDate = (rawDeadline: string | null | undefined): string | null => {
  if (!rawDeadline) return null;
  const deadline = new Date(rawDeadline);
  if (!Number.isFinite(deadline.getTime())) return null;
  deadline.setUTCDate(deadline.getUTCDate() - 2);
  return deadline.toISOString().slice(0, 10);
};

const compactIdentifier = (value: string | null | undefined): string => (
  value?.normalize('NFKC').replace(/[^\p{Letter}\p{Number}]/gu, '').toLocaleLowerCase() ?? ''
);

const candidateMethod = (input: {
  item: CreateResolutionJobRequest['items'][number];
  candidate: ProxyCatalogCandidate;
  source: SourceProductReference;
  activeMappings: readonly VerifiedMappingRegistryEntry[];
  selected: boolean;
}): CandidateMatchMethod => {
  if (input.activeMappings.some(mapping => (
    isActiveVerifiedMapping(mapping)
    && mapping.erpProductGroupId === input.item.erpProductGroupId
    && sameSourceProduct(mapping.source, input.source)
  ))) return 'ACTIVE_VERIFIED_MAPPING';
  const jan = compactIdentifier(input.item.jan);
  if (jan && jan === compactIdentifier(input.candidate.janCode)) return 'EXACT_JAN';
  const modelCode = compactIdentifier(input.item.modelCode);
  if (modelCode && modelCode === compactIdentifier(input.candidate.sku)) {
    return 'EXACT_MODEL_CODE';
  }
  return input.selected ? 'PARSER_INFERRED' : 'UNVERIFIED';
};

const catalogCandidateKey = (candidate: ProxyCatalogCandidate): string => JSON.stringify([
  candidateSupplier(candidate),
  candidateSourceProductId(candidate),
]);

export const createProxyClosingDateBatchAnalyzer = (): ClosingDateBatchItemAnalyzer => (
  async context => {
    const title = context.item.title;
    const v1Queries = buildProxyCatalogQueries(normalizeProxyProductIdentity(title));
    const queries = uniqueQueries([
      ...v1Queries,
      ...buildProxyCatalogQueriesV2(title),
    ]);
    const candidateMap = new Map<string, ProxyCatalogCandidate>();
    let lastServiceError: ClosingDateCatalogGatewayError | null = null;
    let selectedCandidate: ProxyCatalogCandidate | null = null;
    let selectedConfidence = 0;

    for (const query of queries) {
      if (context.signal.aborted) throw new DOMException('Batch cancelled', 'AbortError');
      try {
        const products = await context.search(query);
        for (const product of products) {
          const key = catalogCandidateKey(product);
          if (!candidateMap.has(key)) candidateMap.set(key, product);
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (error instanceof ClosingDateCatalogGatewayError) {
          lastServiceError = error;
          continue;
        }
        throw error;
      }
      const candidates = [...candidateMap.values()];
      const v1Selection = selectProxyCatalogCandidate(title, candidates);
      const decision = resolveProxyCatalogDecision('next', title, candidates, v1Selection);
      if (decision.match?.candidate) {
        selectedCandidate = decision.match.candidate;
        selectedConfidence = decision.match.confidence;
        const supplier = candidateSupplier(selectedCandidate);
        if (supplier === 'wanrong' && selectedCandidate.catalog?.deadlineAt) break;
      }
    }

    const domainCandidates = [...candidateMap.values()].flatMap(candidate => {
      const source = sourceReferenceForCandidate(candidate, context.snapshot.version);
      if (!source) return [];
      const isSelected = candidate === selectedCandidate;
      const v1 = scoreProxyCatalogCandidate(title, candidate);
      const v2 = scoreProxyCatalogCandidateV2Pilot(title, candidate);
      const confidence = isSelected
        ? selectedConfidence
        : Math.max(v1.rejected ? 0 : v1.confidence, v2.rejected ? 0 : v2.confidence);
      const rawDeadline = candidate.catalog?.deadlineAt ?? null;
      return [{
        id: `${context.batchId}:${context.item.clientItemId}:${source.sourceSupplier}:${source.sourceProductId}`,
        source,
        catalogTitle: candidate.name?.trim() || '(untitled catalog product)',
        catalogUrl: candidate.url ?? null,
        identifiers: {
          jan: candidate.janCode ?? null,
          modelCode: candidate.sku ?? null,
        },
        rawDeadline,
        suggestedClosingDate: suggestedClosingDate(rawDeadline),
        ruleVersion: context.ruleVersion,
        snapshotVersion: context.snapshot.version,
        confidence: Math.max(0, Math.min(1, confidence)),
        matchMethod: candidateMethod({
          item: context.item,
          candidate,
          source,
          activeMappings: context.activeMappings,
          selected: isSelected,
        }),
      }];
    });
    const selectedDomainCandidate = selectedCandidate
      ? domainCandidates.find(candidate => (
        candidate.source.sourceSupplier === candidateSupplier(selectedCandidate)
        && candidate.source.sourceProductId === candidateSourceProductId(selectedCandidate)
      ))
      : undefined;
    const activeVerifiedMapping = selectedDomainCandidate
      ? context.activeMappings.find(mapping => sameSourceProduct(
        mapping.source,
        selectedDomainCandidate.source,
      )) ?? null
      : null;

    return createResolutionResult({
      id: `${context.batchId}:${context.item.clientItemId}`,
      batchId: context.batchId,
      erpProductGroupId: context.item.erpProductGroupId,
      erpTitleAtAnalysis: title,
      productUpdatedAtAtAnalysis: context.item.updatedAt,
      closingDateAtAnalysis: context.item.currentClosingDate,
      candidates: domainCandidates,
      activeVerifiedMapping,
      serviceError: lastServiceError ? {
        code: lastServiceError.code,
        message: lastServiceError.message,
        retryable: lastServiceError.retryable,
      } : null,
      ruleVersion: context.ruleVersion,
      snapshotVersion: context.snapshot.version,
      analyzedAt: context.analyzedAt,
    });
  }
);

export interface CreateClosingDateBatchGatewayOptions {
  repository: ClosingDateResolutionSidecarRepository;
  catalogClient?: ReadonlyCatalogClient;
  queryCache?: CatalogSnapshotQueryCache;
  analyzer?: ClosingDateBatchItemAnalyzer;
  maxItemConcurrency?: number;
  maxUpstreamConcurrency?: number;
  cacheTtlMs?: number;
  clock?: () => string;
  monotonicNow?: () => number;
}

export interface ClosingDateBatchGateway {
  createJob(request: CreateResolutionJobRequest): Promise<CreateResolutionJobResponse>;
  pollJob(jobId: string): Promise<ClosingDateBatchPollResponse>;
  cancelJob(jobId: string): Promise<CancelResolutionJobResponse>;
  retryJob(
    jobId: string,
    options?: RetryClosingDateBatchOptions,
  ): Promise<RetryResolutionJobResponse>;
  waitForJob(jobId: string): Promise<ClosingDateBatchPollResponse>;
  hasInMemoryRunner(jobId: string): boolean;
  clearCatalogCache(): void;
}

class NextClosingDateBatchGateway implements ClosingDateBatchGateway {
  private readonly repository: ClosingDateResolutionSidecarRepository;
  private readonly queryCache: CatalogSnapshotQueryCache;
  private readonly analyzer: ClosingDateBatchItemAnalyzer;
  private readonly maxItemConcurrency: number;
  private readonly clock: () => string;
  private readonly monotonicNow: () => number;
  private readonly jobs = new Map<string, InternalResolutionJob>();

  constructor(options: CreateClosingDateBatchGatewayOptions) {
    this.repository = options.repository;
    const catalogClient = options.catalogClient ?? createReadonlyCatalogHttpClient();
    this.queryCache = options.queryCache ?? new CatalogSnapshotQueryCache(catalogClient, {
      ttlMs: options.cacheTtlMs,
      maxConcurrency: options.maxUpstreamConcurrency ?? 6,
      nowMs: options.monotonicNow,
    });
    this.analyzer = options.analyzer ?? createProxyClosingDateBatchAnalyzer();
    this.maxItemConcurrency = options.maxItemConcurrency ?? 6;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    if (
      !Number.isInteger(this.maxItemConcurrency)
      || this.maxItemConcurrency < 1
      || this.maxItemConcurrency > 16
    ) {
      throw new Error('Item concurrency must be an integer between 1 and 16');
    }
  }

  async createJob(request: CreateResolutionJobRequest): Promise<CreateResolutionJobResponse> {
    return this.createJobAttempt(request, 1, request.clientBatchId);
  }

  async pollJob(jobId: string): Promise<ClosingDateBatchPollResponse> {
    const batch = await this.repository.getResolutionBatch(jobId);
    if (!batch) throw new Error(`Closing Date resolution job not found: ${jobId}`);
    const results = await this.repository.listResolutionResults(jobId);
    const internal = this.jobs.get(jobId);
    const fallbackSnapshot: CatalogSnapshotDescriptor = {
      version: batch.snapshotVersion,
      capturedAt: batch.createdAt,
      expiresAt: batch.finishedAt ?? batch.createdAt,
    };
    return {
      batch,
      results,
      nextCursor: null,
      metrics: internal
        ? toMetrics(internal.metrics, this.monotonicNow(), results)
        : toMetrics(createMutableMetrics(this.monotonicNow()), this.monotonicNow(), results),
      catalogSnapshot: internal?.snapshot ?? fallbackSnapshot,
      logicalBatchId: internal?.logicalBatchId ?? batch.id,
    };
  }

  async cancelJob(jobId: string): Promise<CancelResolutionJobResponse> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Running Closing Date resolution job not found: ${jobId}`);
    if (!canCancelResolutionBatch(job.batch)) {
      throw new Error(`Closing Date resolution job cannot be cancelled: ${job.batch.status}`);
    }
    if (job.batch.status === 'QUEUED') {
      job.batch = transitionResolutionBatch(job.batch, 'CANCELLED', this.clock());
      job.metrics.cancellationCount += 1;
      job.metrics.finishedAtMs = this.monotonicNow();
      await this.enqueuePersistence(job, () => this.repository.updateResolutionJob(job.batch));
      job.controller.abort();
      return { jobId, status: 'CANCELLED' };
    }
    job.batch = transitionResolutionBatch(job.batch, 'CANCELLING', this.clock());
    job.metrics.cancellationCount += 1;
    await this.enqueuePersistence(job, () => this.repository.updateResolutionJob(job.batch));
    job.controller.abort();
    return { jobId, status: 'CANCELLING' };
  }

  async retryJob(
    jobId: string,
    options: RetryClosingDateBatchOptions = {},
  ): Promise<RetryResolutionJobResponse> {
    const source = this.jobs.get(jobId);
    if (!source) {
      throw new Error('Retry requires the original Next-only in-memory job request');
    }
    const current = await this.repository.getResolutionBatch(jobId);
    if (!current || !canRetryResolutionBatch(current)) {
      throw new Error(`Closing Date resolution job is not retryable: ${current?.status ?? 'missing'}`);
    }
    const retryableProductIds = new Set(
      source.results
        .filter(result => result.serviceError?.retryable)
        .map(result => result.erpProductGroupId),
    );
    const retryItems = source.request.items.filter(item => (
      current.status === 'FAILED' || retryableProductIds.has(item.erpProductGroupId)
    ));
    if (retryItems.length === 0) throw new Error('Resolution job has no retryable items');
    const attempt = current.attempt + 1;
    const clientBatchId = options.clientBatchId ?? `${source.logicalBatchId}:retry:${attempt}`;
    const request: CreateResolutionJobRequest = {
      ...source.request,
      clientBatchId,
      idempotencyKey: options.idempotencyKey ?? `${source.request.idempotencyKey}:retry:${attempt}`,
      inputHash: `${source.request.inputHash}:retry:${attempt}`,
      snapshotVersionPreference: 'LATEST',
      items: retryItems,
    };
    const response = await this.createJobAttempt(
      { ...request },
      attempt,
      source.logicalBatchId,
      options.createdAt,
    );
    return {
      jobId: response.jobId,
      logicalBatchId: source.logicalBatchId,
      attempt,
      status: 'QUEUED',
    };
  }

  async waitForJob(jobId: string): Promise<ClosingDateBatchPollResponse> {
    const job = this.jobs.get(jobId);
    if (job) await job.completion;
    return this.pollJob(jobId);
  }

  hasInMemoryRunner(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  clearCatalogCache(): void {
    this.queryCache.clear();
  }

  private async createJobAttempt(
    request: CreateResolutionJobRequest,
    attempt: number,
    logicalBatchId: string,
    createdAtOverride?: string,
  ): Promise<CreateResolutionJobResponse> {
    if (new Set(request.items.map(item => item.erpProductGroupId)).size !== request.items.length) {
      throw new Error('Closing Date resolution request contains duplicate ProductGroup IDs');
    }
    const existing = await this.repository.findBatchByIdempotencyKey(request.idempotencyKey);
    if (existing) {
      const requestedProductIds = request.items.map(item => item.erpProductGroupId);
      if (
        existing.inputHash !== request.inputHash
        || existing.ruleVersion !== request.ruleVersion
        || JSON.stringify(existing.productGroupIds) !== JSON.stringify(requestedProductIds)
      ) {
        throw new Error(`Idempotency conflict for key: ${request.idempotencyKey}`);
      }
      return {
        jobId: existing.id,
        status: existing.status,
        snapshotVersion: existing.snapshotVersion,
        statusUrl: `/next/closing-date-resolution/jobs/${encodeURIComponent(existing.id)}`,
      };
    }
    const snapshot = await this.queryCache.openSnapshot(request.snapshotVersionPreference);
    const createdAt = createdAtOverride ?? this.clock();
    const batch: ResolutionBatch = {
      ...createResolutionBatch({
        id: request.clientBatchId,
        idempotencyKey: request.idempotencyKey,
        inputHash: request.inputHash,
        snapshotVersion: snapshot.version,
        ruleVersion: request.ruleVersion,
        productGroupIds: request.items.map(item => item.erpProductGroupId),
        createdAt,
      }),
      attempt,
    };
    // Resolve every read dependency before creating the persisted job. A read
    // failure must not leave a QUEUED sidecar batch that can never start.
    const mappings = await this.repository.findActiveMappings(batch.productGroupIds);
    const stored = await this.repository.createResolutionJob(batch);
    if (!stored.created) {
      return {
        jobId: stored.batch.id,
        status: stored.batch.status,
        snapshotVersion: stored.batch.snapshotVersion,
        statusUrl: `/next/closing-date-resolution/jobs/${encodeURIComponent(stored.batch.id)}`,
      };
    }
    const activeMappingsByProduct = new Map<string, VerifiedMappingRegistryEntry[]>();
    for (const mapping of mappings) {
      const entries = activeMappingsByProduct.get(mapping.erpProductGroupId) ?? [];
      entries.push(mapping);
      activeMappingsByProduct.set(mapping.erpProductGroupId, entries);
    }
    const internal: InternalResolutionJob = {
      request,
      batch,
      results: [],
      snapshot,
      activeMappingsByProduct,
      controller: new AbortController(),
      completion: Promise.resolve(),
      persistence: Promise.resolve(),
      metrics: createMutableMetrics(this.monotonicNow()),
      logicalBatchId,
    };
    this.jobs.set(batch.id, internal);
    internal.completion = Promise.resolve().then(() => this.runJob(internal));
    return {
      jobId: batch.id,
      status: 'QUEUED',
      snapshotVersion: snapshot.version,
      statusUrl: `/next/closing-date-resolution/jobs/${encodeURIComponent(batch.id)}`,
    };
  }

  private async runJob(job: InternalResolutionJob): Promise<void> {
    if (job.batch.status === 'CANCELLED') return;
    try {
      job.batch = transitionResolutionBatch(job.batch, 'RUNNING', this.clock());
      await this.enqueuePersistence(job, () => this.repository.updateResolutionJob(job.batch));
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        while (!job.controller.signal.aborted) {
          const itemIndex = nextIndex;
          nextIndex += 1;
          const item = job.request.items[itemIndex];
          if (!item) return;
          const startedAt = this.monotonicNow();
          let result: ResolutionResult;
          try {
            result = await this.analyzeItem(job, item);
          } catch (error) {
            if (isAbortError(error)) return;
            const gatewayError = error instanceof ClosingDateCatalogGatewayError
              ? error
              : new ClosingDateCatalogGatewayError({
                code: 'ANALYSIS_ERROR',
                message: error instanceof Error ? error.message : String(error),
                retryable: false,
                cause: error,
              });
            result = createResolutionResult({
              id: `${job.batch.id}:${item.clientItemId}`,
              batchId: job.batch.id,
              erpProductGroupId: item.erpProductGroupId,
              erpTitleAtAnalysis: item.title,
              productUpdatedAtAtAnalysis: item.updatedAt,
              closingDateAtAnalysis: item.currentClosingDate,
              serviceError: {
                code: gatewayError.code,
                message: gatewayError.message,
                retryable: gatewayError.retryable,
              },
              ruleVersion: job.batch.ruleVersion,
              snapshotVersion: job.batch.snapshotVersion,
              analyzedAt: this.clock(),
            });
          }
          job.metrics.itemLatenciesMs.push(this.monotonicNow() - startedAt);
          await this.enqueuePersistence(job, async () => {
            const nextResults = [...job.results, result];
            const nextBatch: ResolutionBatch = {
              ...job.batch,
              progress: this.progressFor(job.batch.progress.totalCount, nextResults),
            };
            await this.repository.appendResolutionResult(nextBatch, result);
            job.results.push(result);
            job.batch = nextBatch;
          });
        }
      };
      const workerCount = Math.min(this.maxItemConcurrency, job.request.items.length || 1);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      await job.persistence;
      if (job.controller.signal.aborted) {
        if (job.batch.status === 'RUNNING') {
          job.batch = transitionResolutionBatch(job.batch, 'CANCELLING', this.clock());
        }
        if (job.batch.status === 'CANCELLING') {
          job.batch = transitionResolutionBatch(job.batch, 'CANCELLED', this.clock());
        }
      } else if (job.batch.status === 'RUNNING') {
        job.batch = transitionResolutionBatch(job.batch, 'COMPLETED', this.clock());
      }
      job.metrics.finishedAtMs = this.monotonicNow();
      await this.enqueuePersistence(job, () => this.repository.updateResolutionJob(job.batch));
    } catch (error) {
      if (job.batch.status === 'CANCELLED') return;
      const failedAt = this.clock();
      if (job.batch.status === 'RUNNING' || job.batch.status === 'CANCELLING' || job.batch.status === 'QUEUED') {
        job.batch = {
          ...transitionResolutionBatch(job.batch, 'FAILED', failedAt),
          failure: {
            code: 'BATCH_GATEWAY_FAILURE',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        };
        job.metrics.finishedAtMs = this.monotonicNow();
        await this.enqueuePersistence(job, () => this.repository.updateResolutionJob(job.batch));
      }
    }
  }

  private async analyzeItem(
    job: InternalResolutionJob,
    item: CreateResolutionJobRequest['items'][number],
  ): Promise<ResolutionResult> {
    const search: ClosingDateBatchSearch = async query => {
      job.metrics.logicalQueryCount += 1;
      const lookup: CatalogCacheLookupResult = await this.queryCache.lookup({
        snapshot: job.snapshot,
        query,
        pageSize: 8,
        signal: job.controller.signal,
      });
      job.metrics.uniqueQueryKeys.add(lookup.cacheKey);
      if (lookup.source === 'UPSTREAM') job.metrics.upstreamRequestCount += 1;
      if (lookup.source === 'CACHE') job.metrics.cacheHitCount += 1;
      if (lookup.source === 'SINGLE_FLIGHT') job.metrics.singleFlightHitCount += 1;
      job.metrics.maxUpstreamConcurrency = Math.max(
        job.metrics.maxUpstreamConcurrency,
        lookup.observedUpstreamConcurrency,
      );
      return lookup.response.products;
    };
    return this.analyzer({
      item,
      batchId: job.batch.id,
      ruleVersion: job.batch.ruleVersion,
      snapshot: job.snapshot,
      activeMappings: job.activeMappingsByProduct.get(item.erpProductGroupId) ?? [],
      search,
      signal: job.controller.signal,
      analyzedAt: this.clock(),
    });
  }

  private progressFor(
    totalCount: number,
    results: readonly ResolutionResult[],
  ): ResolutionBatch['progress'] {
    return {
      totalCount,
      completedCount: results.length,
      greenCount: results.filter(result => result.classification === 'GREEN').length,
      yellowCount: results.filter(result => result.classification === 'YELLOW').length,
      redCount: results.filter(result => result.classification === 'RED').length,
      serviceErrorCount: results.filter(result => Boolean(result.serviceError)).length,
      retryableServiceErrorCount: results.filter(result => result.serviceError?.retryable).length,
    };
  }

  private async enqueuePersistence(
    job: InternalResolutionJob,
    operation: () => Promise<void>,
  ): Promise<void> {
    const pending = job.persistence.then(operation);
    job.persistence = pending.catch(() => undefined);
    await pending;
  }
}

export function createNextClosingDateBatchGateway(
  options: CreateClosingDateBatchGatewayOptions,
): ClosingDateBatchGateway {
  assertNextClosingDateBatchGatewayAccess(
    getBuildSandboxMode(),
    isClosingDateBatchGatewayFeatureEnabled(),
  );
  return new NextClosingDateBatchGateway(options);
}
