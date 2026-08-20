import {
  createVerifiedMapping,
  isActiveVerifiedMapping,
  revokeVerifiedMapping as markVerifiedMappingRevoked,
  sourceProductKey,
} from './closingDateResolutionDomain';
import type {
  ApplyAuditBundle,
  ResolutionBatch,
  ResolutionResult,
  VerifiedMappingRegistryEntry,
} from './closingDateResolutionDomain';
import {
  CLOSING_DATE_ANALYSIS_TRANSACTION_STORES,
  CLOSING_DATE_APPLY_AUDIT_TRANSACTION_STORES,
  CLOSING_DATE_SIDECAR_INDEXES,
  CLOSING_DATE_SIDECAR_STORE_NAMES,
  CLOSING_DATE_SIDECAR_STORES,
  NEXT_CLOSING_DATE_SIDECAR_DB_NAME,
  NEXT_CLOSING_DATE_SIDECAR_DB_VERSION,
  migrateClosingDateResolutionSidecar,
} from './closingDateResolutionSidecarSchema';
import type {
  ClosingDateSidecarStoreName,
  StoredApplyBatch,
  StoredApplyItem,
  StoredResolutionBatch,
  StoredResolutionCandidate,
  StoredResolutionResult,
  StoredVerifiedMapping,
} from './closingDateResolutionSidecarSchema';
import { getBuildSandboxMode } from './testSandboxEnvironment';

export const CLOSING_DATE_SIDECAR_FEATURE_FLAG = 'VITE_ENABLE_CLOSING_DATE_WORKBENCH_STORAGE';

export type ClosingDateSidecarFaultPoint =
  | 'BEFORE_MAPPING_WRITES'
  | 'AFTER_MAPPING_WRITE'
  | 'AFTER_BATCH_WRITE'
  | 'AFTER_RESULT_WRITE'
  | 'AFTER_CANDIDATE_WRITE'
  | 'BEFORE_ANALYSIS_COMMIT'
  | 'AFTER_APPLY_BATCH_WRITE'
  | 'AFTER_APPLY_ITEM_WRITE'
  | 'BEFORE_APPLY_AUDIT_COMMIT';

export interface ClosingDateSidecarFaultContext {
  recordId?: string;
  recordIndex?: number;
}

export type ClosingDateSidecarFaultInjector = (
  point: ClosingDateSidecarFaultPoint,
  context: ClosingDateSidecarFaultContext,
) => void;

export interface ResolutionAnalysisAggregate {
  mappings: readonly VerifiedMappingRegistryEntry[];
  batch: ResolutionBatch;
  results: readonly ResolutionResult[];
}

export interface CommitResolutionAnalysisResult {
  created: boolean;
  batch: ResolutionBatch;
}

export interface SaveApplyAuditResult {
  created: boolean;
  audit: ApplyAuditBundle;
}

export interface ClosingDateSidecarSchemaMetadata {
  databaseName: string;
  version: number;
  stores: readonly string[];
  indexes: Readonly<Record<string, readonly string[]>>;
}

export type ClosingDateSidecarStoreCounts = Readonly<Record<ClosingDateSidecarStoreName, number>>;

export interface ClosingDateResolutionSidecarRepository {
  initialize(): Promise<ClosingDateSidecarSchemaMetadata>;
  getStoreCounts(): Promise<ClosingDateSidecarStoreCounts>;
  commitResolutionAnalysis(
    aggregate: ResolutionAnalysisAggregate,
  ): Promise<CommitResolutionAnalysisResult>;
  findActiveMappings(
    erpProductGroupIds: readonly string[],
  ): Promise<readonly VerifiedMappingRegistryEntry[]>;
  getVerifiedMapping(mappingId: string): Promise<VerifiedMappingRegistryEntry | null>;
  saveVerifiedMapping(
    mapping: VerifiedMappingRegistryEntry,
  ): Promise<VerifiedMappingRegistryEntry>;
  revokeVerifiedMapping(
    mappingId: string,
    revokedAt: string,
    revokedReason: string,
  ): Promise<VerifiedMappingRegistryEntry>;
  findBatchByIdempotencyKey(idempotencyKey: string): Promise<ResolutionBatch | null>;
  getResolutionBatch(batchId: string): Promise<ResolutionBatch | null>;
  getResolutionResult(resultId: string): Promise<ResolutionResult | null>;
  saveApplyAudit(audit: ApplyAuditBundle): Promise<SaveApplyAuditResult>;
  getApplyAudit(applyBatchId: string): Promise<ApplyAuditBundle | null>;
  close(): void;
}

export interface CreateClosingDateSidecarRepositoryOptions {
  databaseName?: string;
  faultInjector?: ClosingDateSidecarFaultInjector;
}

export class ClosingDateSidecarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClosingDateSidecarUnavailableError';
  }
}

export class ClosingDateSidecarIdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`Closing Date sidecar idempotency conflict: ${key}`);
    this.name = 'ClosingDateSidecarIdempotencyConflictError';
  }
}

export class ClosingDateSidecarIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClosingDateSidecarIntegrityError';
  }
}

const defaultFeatureFlagValue = import.meta.env.VITE_ENABLE_CLOSING_DATE_WORKBENCH_STORAGE;

export function parseClosingDateSidecarFeatureFlag(
  rawValue: string | boolean | null | undefined,
): boolean {
  return rawValue === true || rawValue === 'true';
}

export function isClosingDateSidecarFeatureEnabled(): boolean {
  return parseClosingDateSidecarFeatureFlag(defaultFeatureFlagValue);
}

export function assertNextClosingDateSidecarAccess(
  buildMode: ReturnType<typeof getBuildSandboxMode>,
  featureEnabled: boolean,
): void {
  if (buildMode !== 'next') {
    throw new ClosingDateSidecarUnavailableError(
      'Closing Date Workbench sidecar storage is available only in the Next Sandbox build.',
    );
  }
  if (!featureEnabled) {
    throw new ClosingDateSidecarUnavailableError(
      'Closing Date Workbench sidecar storage feature flag is disabled.',
    );
  }
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
});

const transactionCompletion = (transaction: IDBTransaction): Promise<void> => new Promise(
  (resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error('Closing Date sidecar transaction aborted'),
    );
    transaction.onerror = () => {
      // onabort owns the final rejection so every failed write has one outcome.
    };
  },
);

const abortTransaction = (transaction: IDBTransaction): void => {
  try {
    transaction.abort();
  } catch {
    // A completed/aborted transaction needs no second abort.
  }
};

const ensureNonEmpty = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new ClosingDateSidecarIntegrityError(`${label} must not be empty`);
  return normalized;
};

const ensureSidecarDatabaseName = (databaseName: string): string => {
  const normalized = ensureNonEmpty(databaseName, 'sidecar database name');
  if (!normalized.startsWith(NEXT_CLOSING_DATE_SIDECAR_DB_NAME)) {
    throw new ClosingDateSidecarUnavailableError(
      `Refusing non-Next Closing Date sidecar database: ${normalized}`,
    );
  }
  return normalized;
};

const candidateStorageId = (resultId: string, candidateId: string): string => JSON.stringify([
  resultId,
  candidateId,
]);

const toStoredMapping = (mapping: VerifiedMappingRegistryEntry): StoredVerifiedMapping => {
  const normalized = createVerifiedMapping(mapping);
  return {
    id: normalized.id,
    erpProductGroupId: normalized.erpProductGroupId,
    sourceIdentityKey: sourceProductKey(normalized.source),
    revokedAt: normalized.revokedAt ?? null,
    mapping: normalized,
  };
};

const toStoredBatch = (batch: ResolutionBatch): StoredResolutionBatch => ({
  id: batch.id,
  idempotencyKey: batch.idempotencyKey,
  inputHash: batch.inputHash,
  snapshotVersion: batch.snapshotVersion,
  ruleVersion: batch.ruleVersion,
  batch,
});

const toStoredResult = (result: ResolutionResult): {
  result: StoredResolutionResult;
  candidates: readonly StoredResolutionCandidate[];
} => {
  const { candidates, ...resultWithoutCandidates } = result;
  const storedCandidates = candidates.map(candidate => ({
    storageId: candidateStorageId(result.id, candidate.id),
    resolutionResultId: result.id,
    resolutionBatchId: result.batchId,
    sourceIdentityKey: sourceProductKey(candidate.source),
    candidate,
  }));
  return {
    result: {
      id: result.id,
      batchId: result.batchId,
      erpProductGroupId: result.erpProductGroupId,
      candidateStorageIds: storedCandidates.map(candidate => candidate.storageId),
      result: resultWithoutCandidates,
    },
    candidates: storedCandidates,
  };
};

const validateAggregate = (aggregate: ResolutionAnalysisAggregate): {
  mappings: readonly StoredVerifiedMapping[];
  batch: StoredResolutionBatch;
  results: readonly {
    result: StoredResolutionResult;
    candidates: readonly StoredResolutionCandidate[];
  }[];
} => {
  ensureNonEmpty(aggregate.batch.id, 'resolution batch id');
  ensureNonEmpty(aggregate.batch.idempotencyKey, 'resolution batch idempotency key');
  ensureNonEmpty(aggregate.batch.inputHash, 'resolution batch input hash');
  const resultIds = new Set<string>();
  const results = aggregate.results.map(result => {
    if (resultIds.has(result.id)) {
      throw new ClosingDateSidecarIntegrityError(`Duplicate resolution result ID: ${result.id}`);
    }
    resultIds.add(result.id);
    if (result.batchId !== aggregate.batch.id) {
      throw new ClosingDateSidecarIntegrityError(
        `Resolution result ${result.id} belongs to another batch`,
      );
    }
    if (
      result.ruleVersion !== aggregate.batch.ruleVersion
      || result.snapshotVersion !== aggregate.batch.snapshotVersion
    ) {
      throw new ClosingDateSidecarIntegrityError(
        `Resolution result ${result.id} rule/snapshot version mismatch`,
      );
    }
    if (result.candidates.length > 3) {
      throw new ClosingDateSidecarIntegrityError(
        `Resolution result ${result.id} exceeds the Top 3 candidate contract`,
      );
    }
    const candidateIds = new Set<string>();
    for (const candidate of result.candidates) {
      if (candidateIds.has(candidate.id)) {
        throw new ClosingDateSidecarIntegrityError(
          `Duplicate candidate ID ${candidate.id} in result ${result.id}`,
        );
      }
      candidateIds.add(candidate.id);
      if (
        candidate.ruleVersion !== result.ruleVersion
        || candidate.snapshotVersion !== result.snapshotVersion
      ) {
        throw new ClosingDateSidecarIntegrityError(
          `Candidate ${candidate.id} rule/snapshot version mismatch`,
        );
      }
    }
    return toStoredResult(result);
  });
  return {
    mappings: aggregate.mappings.map(toStoredMapping),
    batch: toStoredBatch(aggregate.batch),
    results,
  };
};

const reconstructResult = (
  storedResult: StoredResolutionResult,
  storedCandidates: readonly StoredResolutionCandidate[],
): ResolutionResult => {
  const expectedIds = new Set(storedResult.candidateStorageIds);
  const matchingCandidates = storedCandidates.filter(candidate => expectedIds.has(candidate.storageId));
  if (
    matchingCandidates.length !== expectedIds.size
    || storedCandidates.length !== expectedIds.size
  ) {
    throw new ClosingDateSidecarIntegrityError(
      `Resolution result ${storedResult.id} has missing candidate records`,
    );
  }
  const candidates = matchingCandidates
    .map(candidate => candidate.candidate)
    .sort((left, right) => left.rank - right.rank);
  return {
    ...storedResult.result,
    candidates,
  };
};

class ClosingDateResolutionIndexedDbAdapter {
  private connectionPromise: Promise<IDBDatabase> | null = null;
  private readonly databaseName: string;
  private readonly indexedDbFactory: IDBFactory;

  constructor(
    databaseName: string,
    indexedDbFactory: IDBFactory,
  ) {
    this.databaseName = databaseName;
    this.indexedDbFactory = indexedDbFactory;
  }

  open(): Promise<IDBDatabase> {
    if (this.connectionPromise) return this.connectionPromise;
    this.connectionPromise = new Promise((resolve, reject) => {
      const request = this.indexedDbFactory.open(
        this.databaseName,
        NEXT_CLOSING_DATE_SIDECAR_DB_VERSION,
      );
      request.onupgradeneeded = event => {
        migrateClosingDateResolutionSidecar(request.result, event.oldVersion);
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          this.connectionPromise = null;
        };
        resolve(database);
      };
      request.onerror = () => {
        this.connectionPromise = null;
        reject(request.error ?? new Error('Unable to open Closing Date sidecar database'));
      };
      request.onblocked = () => {
        this.connectionPromise = null;
        reject(new Error('Closing Date sidecar database upgrade is blocked'));
      };
    });
    return this.connectionPromise;
  }

  async metadata(): Promise<ClosingDateSidecarSchemaMetadata> {
    const database = await this.open();
    const indexes: Record<string, readonly string[]> = {};
    for (const storeName of CLOSING_DATE_SIDECAR_STORE_NAMES) {
      const transaction = database.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      indexes[storeName] = [...store.indexNames];
      await transactionCompletion(transaction);
    }
    return {
      databaseName: database.name,
      version: database.version,
      stores: [...database.objectStoreNames],
      indexes,
    };
  }

  close(): void {
    if (!this.connectionPromise) return;
    void this.connectionPromise.then(database => database.close());
    this.connectionPromise = null;
  }
}

class IndexedDbClosingDateResolutionRepository
implements ClosingDateResolutionSidecarRepository {
  private readonly adapter: ClosingDateResolutionIndexedDbAdapter;
  private readonly faultInjector?: ClosingDateSidecarFaultInjector;

  constructor(
    databaseName: string,
    indexedDbFactory: IDBFactory,
    faultInjector?: ClosingDateSidecarFaultInjector,
  ) {
    this.adapter = new ClosingDateResolutionIndexedDbAdapter(databaseName, indexedDbFactory);
    this.faultInjector = faultInjector;
  }

  initialize(): Promise<ClosingDateSidecarSchemaMetadata> {
    return this.adapter.metadata();
  }

  async getStoreCounts(): Promise<ClosingDateSidecarStoreCounts> {
    const database = await this.adapter.open();
    const transaction = database.transaction([...CLOSING_DATE_SIDECAR_STORE_NAMES], 'readonly');
    const completion = transactionCompletion(transaction);
    const entries = await Promise.all(CLOSING_DATE_SIDECAR_STORE_NAMES.map(async storeName => [
      storeName,
      await requestResult(transaction.objectStore(storeName).count()),
    ] as const));
    await completion;
    return Object.fromEntries(entries) as ClosingDateSidecarStoreCounts;
  }

  async commitResolutionAnalysis(
    aggregate: ResolutionAnalysisAggregate,
  ): Promise<CommitResolutionAnalysisResult> {
    const normalized = validateAggregate(aggregate);
    const database = await this.adapter.open();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [...CLOSING_DATE_ANALYSIS_TRANSACTION_STORES],
        'readwrite',
      );
      let failure: unknown;
      let outcome: CommitResolutionAnalysisResult | null = null;
      const batchStore = transaction.objectStore(CLOSING_DATE_SIDECAR_STORES.resolutionBatches);
      const idempotencyRequest = batchStore
        .index(CLOSING_DATE_SIDECAR_INDEXES.batchByIdempotency)
        .get(normalized.batch.idempotencyKey) as IDBRequest<StoredResolutionBatch | undefined>;

      transaction.oncomplete = () => {
        if (!outcome) {
          reject(new ClosingDateSidecarIntegrityError('Analysis transaction completed without result'));
          return;
        }
        resolve(outcome);
      };
      transaction.onerror = () => {
        if (!failure && transaction.error) failure = transaction.error;
      };
      transaction.onabort = () => reject(
        failure instanceof Error
          ? failure
          : transaction.error ?? new Error('Analysis transaction aborted'),
      );

      idempotencyRequest.onerror = () => {
        failure = idempotencyRequest.error;
      };
      idempotencyRequest.onsuccess = () => {
        const existing = idempotencyRequest.result;
        if (existing) {
          if (
            existing.inputHash !== normalized.batch.inputHash
            || existing.ruleVersion !== normalized.batch.ruleVersion
            || existing.snapshotVersion !== normalized.batch.snapshotVersion
          ) {
            failure = new ClosingDateSidecarIdempotencyConflictError(
              normalized.batch.idempotencyKey,
            );
            abortTransaction(transaction);
            return;
          }
          outcome = { created: false, batch: existing.batch };
          return;
        }

        try {
          const mappingStore = transaction.objectStore(
            CLOSING_DATE_SIDECAR_STORES.verifiedMappings,
          );
          const resultStore = transaction.objectStore(
            CLOSING_DATE_SIDECAR_STORES.resolutionResults,
          );
          const candidateStore = transaction.objectStore(
            CLOSING_DATE_SIDECAR_STORES.resolutionCandidates,
          );

          this.inject('BEFORE_MAPPING_WRITES');
          normalized.mappings.forEach((mapping, index) => {
            mappingStore.put(mapping);
            this.inject('AFTER_MAPPING_WRITE', { recordId: mapping.id, recordIndex: index });
          });

          batchStore.add(normalized.batch);
          this.inject('AFTER_BATCH_WRITE', { recordId: normalized.batch.id });

          normalized.results.forEach((stored, resultIndex) => {
            resultStore.add(stored.result);
            this.inject('AFTER_RESULT_WRITE', {
              recordId: stored.result.id,
              recordIndex: resultIndex,
            });
            stored.candidates.forEach((candidate, candidateIndex) => {
              candidateStore.add(candidate);
              this.inject('AFTER_CANDIDATE_WRITE', {
                recordId: candidate.storageId,
                recordIndex: candidateIndex,
              });
            });
          });
          this.inject('BEFORE_ANALYSIS_COMMIT');
          outcome = { created: true, batch: normalized.batch.batch };
        } catch (error) {
          failure = error;
          abortTransaction(transaction);
        }
      };
    });
  }

  async findActiveMappings(
    erpProductGroupIds: readonly string[],
  ): Promise<readonly VerifiedMappingRegistryEntry[]> {
    if (erpProductGroupIds.length === 0) return [];
    const uniqueProductGroupIds = [...new Set(erpProductGroupIds)];
    const database = await this.adapter.open();
    const transaction = database.transaction(
      CLOSING_DATE_SIDECAR_STORES.verifiedMappings,
      'readonly',
    );
    const completion = transactionCompletion(transaction);
    const index = transaction
      .objectStore(CLOSING_DATE_SIDECAR_STORES.verifiedMappings)
      .index(CLOSING_DATE_SIDECAR_INDEXES.mappingByProductGroup);
    const records = await Promise.all(uniqueProductGroupIds.map(productGroupId => (
      requestResult(index.getAll(productGroupId) as IDBRequest<StoredVerifiedMapping[]>)
    )));
    await completion;
    return records
      .flat()
      .map(record => record.mapping)
      .filter(isActiveVerifiedMapping);
  }

  async getVerifiedMapping(mappingId: string): Promise<VerifiedMappingRegistryEntry | null> {
    const database = await this.adapter.open();
    const transaction = database.transaction(
      CLOSING_DATE_SIDECAR_STORES.verifiedMappings,
      'readonly',
    );
    const completion = transactionCompletion(transaction);
    const record = await requestResult(
      transaction
        .objectStore(CLOSING_DATE_SIDECAR_STORES.verifiedMappings)
        .get(mappingId) as IDBRequest<StoredVerifiedMapping | undefined>,
    );
    await completion;
    return record?.mapping ?? null;
  }

  async saveVerifiedMapping(
    mapping: VerifiedMappingRegistryEntry,
  ): Promise<VerifiedMappingRegistryEntry> {
    const stored = toStoredMapping(mapping);
    const database = await this.adapter.open();
    const transaction = database.transaction(
      CLOSING_DATE_SIDECAR_STORES.verifiedMappings,
      'readwrite',
    );
    const completion = transactionCompletion(transaction);
    await requestResult(
      transaction.objectStore(CLOSING_DATE_SIDECAR_STORES.verifiedMappings).put(stored),
    );
    await completion;
    return stored.mapping;
  }

  async revokeVerifiedMapping(
    mappingId: string,
    revokedAt: string,
    revokedReason: string,
  ): Promise<VerifiedMappingRegistryEntry> {
    const database = await this.adapter.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        CLOSING_DATE_SIDECAR_STORES.verifiedMappings,
        'readwrite',
      );
      let failure: unknown;
      let revoked: VerifiedMappingRegistryEntry | null = null;
      const store = transaction.objectStore(CLOSING_DATE_SIDECAR_STORES.verifiedMappings);
      const request = store.get(mappingId) as IDBRequest<StoredVerifiedMapping | undefined>;
      transaction.oncomplete = () => {
        if (!revoked) {
          reject(new ClosingDateSidecarIntegrityError('Mapping revocation completed without result'));
          return;
        }
        resolve(revoked);
      };
      transaction.onerror = () => {
        if (!failure && transaction.error) failure = transaction.error;
      };
      transaction.onabort = () => reject(
        failure instanceof Error
          ? failure
          : transaction.error ?? new Error('Mapping revocation transaction aborted'),
      );
      request.onerror = () => {
        failure = request.error;
      };
      request.onsuccess = () => {
        if (!request.result) {
          failure = new ClosingDateSidecarIntegrityError(
            `Verified Mapping does not exist: ${mappingId}`,
          );
          abortTransaction(transaction);
          return;
        }
        try {
          revoked = markVerifiedMappingRevoked(
            request.result.mapping,
            revokedAt,
            revokedReason,
          );
          store.put(toStoredMapping(revoked));
        } catch (error) {
          failure = error;
          abortTransaction(transaction);
        }
      };
    });
  }

  async findBatchByIdempotencyKey(idempotencyKey: string): Promise<ResolutionBatch | null> {
    const database = await this.adapter.open();
    const transaction = database.transaction(
      CLOSING_DATE_SIDECAR_STORES.resolutionBatches,
      'readonly',
    );
    const completion = transactionCompletion(transaction);
    const record = await requestResult(
      transaction
        .objectStore(CLOSING_DATE_SIDECAR_STORES.resolutionBatches)
        .index(CLOSING_DATE_SIDECAR_INDEXES.batchByIdempotency)
        .get(idempotencyKey) as IDBRequest<StoredResolutionBatch | undefined>,
    );
    await completion;
    return record?.batch ?? null;
  }

  async getResolutionBatch(batchId: string): Promise<ResolutionBatch | null> {
    const database = await this.adapter.open();
    const transaction = database.transaction(
      CLOSING_DATE_SIDECAR_STORES.resolutionBatches,
      'readonly',
    );
    const completion = transactionCompletion(transaction);
    const record = await requestResult(
      transaction
        .objectStore(CLOSING_DATE_SIDECAR_STORES.resolutionBatches)
        .get(batchId) as IDBRequest<StoredResolutionBatch | undefined>,
    );
    await completion;
    return record?.batch ?? null;
  }

  async getResolutionResult(resultId: string): Promise<ResolutionResult | null> {
    const database = await this.adapter.open();
    const transaction = database.transaction([
      CLOSING_DATE_SIDECAR_STORES.resolutionResults,
      CLOSING_DATE_SIDECAR_STORES.resolutionCandidates,
    ], 'readonly');
    const completion = transactionCompletion(transaction);
    const storedResultRequest = transaction
      .objectStore(CLOSING_DATE_SIDECAR_STORES.resolutionResults)
      .get(resultId) as IDBRequest<StoredResolutionResult | undefined>;
    const candidatesRequest = transaction
      .objectStore(CLOSING_DATE_SIDECAR_STORES.resolutionCandidates)
      .index(CLOSING_DATE_SIDECAR_INDEXES.candidateByResult)
      .getAll(resultId) as IDBRequest<StoredResolutionCandidate[]>;
    const [storedResult, candidates] = await Promise.all([
      requestResult(storedResultRequest),
      requestResult(candidatesRequest),
    ]);
    await completion;
    return storedResult ? reconstructResult(storedResult, candidates) : null;
  }

  async saveApplyAudit(audit: ApplyAuditBundle): Promise<SaveApplyAuditResult> {
    ensureNonEmpty(audit.batch.id, 'apply batch id');
    ensureNonEmpty(audit.batch.idempotencyKey, 'apply idempotency key');
    for (const item of audit.items) {
      if (item.applyBatchId !== audit.batch.id) {
        throw new ClosingDateSidecarIntegrityError(
          `Apply item ${item.id} belongs to another apply batch`,
        );
      }
    }
    const database = await this.adapter.open();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [...CLOSING_DATE_APPLY_AUDIT_TRANSACTION_STORES],
        'readwrite',
      );
      let failure: unknown;
      let outcome: SaveApplyAuditResult | null = null;
      const batchStore = transaction.objectStore(CLOSING_DATE_SIDECAR_STORES.applyBatches);
      const itemStore = transaction.objectStore(CLOSING_DATE_SIDECAR_STORES.applyItems);
      const idempotencyRequest = batchStore
        .index(CLOSING_DATE_SIDECAR_INDEXES.applyBatchByIdempotency)
        .get(audit.batch.idempotencyKey) as IDBRequest<StoredApplyBatch | undefined>;

      transaction.oncomplete = () => {
        if (!outcome) {
          reject(new ClosingDateSidecarIntegrityError('Apply audit transaction has no result'));
          return;
        }
        resolve(outcome);
      };
      transaction.onerror = () => {
        if (!failure && transaction.error) failure = transaction.error;
      };
      transaction.onabort = () => reject(
        failure instanceof Error
          ? failure
          : transaction.error ?? new Error('Apply audit transaction aborted'),
      );
      idempotencyRequest.onerror = () => {
        failure = idempotencyRequest.error;
      };
      idempotencyRequest.onsuccess = () => {
        const existing = idempotencyRequest.result;
        if (existing) {
          if (existing.id !== audit.batch.id) {
            failure = new ClosingDateSidecarIdempotencyConflictError(
              audit.batch.idempotencyKey,
            );
            abortTransaction(transaction);
            return;
          }
          const existingItemsRequest = itemStore
            .index(CLOSING_DATE_SIDECAR_INDEXES.applyItemByBatch)
            .getAll(existing.id) as IDBRequest<StoredApplyItem[]>;
          existingItemsRequest.onerror = () => {
            failure = existingItemsRequest.error;
          };
          existingItemsRequest.onsuccess = () => {
            outcome = {
              created: false,
              audit: {
                batch: existing.audit,
                items: existingItemsRequest.result
                  .sort((left, right) => left.itemOrder - right.itemOrder)
                  .map(item => item.audit),
              },
            };
          };
          return;
        }

        try {
          const storedBatch: StoredApplyBatch = {
            id: audit.batch.id,
            idempotencyKey: audit.batch.idempotencyKey,
            resolutionBatchId: audit.batch.resolutionBatchId,
            itemIds: audit.items.map(item => item.id),
            audit: audit.batch,
          };
          batchStore.add(storedBatch);
          this.inject('AFTER_APPLY_BATCH_WRITE', { recordId: storedBatch.id });

          audit.items.forEach((item, index) => {
            const storedItem: StoredApplyItem = {
              id: item.id,
              applyBatchId: item.applyBatchId,
              resolutionResultId: item.resolutionResultId,
              itemOrder: index,
              audit: item,
            };
            itemStore.add(storedItem);
            this.inject('AFTER_APPLY_ITEM_WRITE', { recordId: item.id, recordIndex: index });
          });
          this.inject('BEFORE_APPLY_AUDIT_COMMIT');
          outcome = { created: true, audit };
        } catch (error) {
          failure = error;
          abortTransaction(transaction);
        }
      };
    });
  }

  async getApplyAudit(applyBatchId: string): Promise<ApplyAuditBundle | null> {
    const database = await this.adapter.open();
    const transaction = database.transaction([
      CLOSING_DATE_SIDECAR_STORES.applyBatches,
      CLOSING_DATE_SIDECAR_STORES.applyItems,
    ], 'readonly');
    const completion = transactionCompletion(transaction);
    const batchRequest = transaction
      .objectStore(CLOSING_DATE_SIDECAR_STORES.applyBatches)
      .get(applyBatchId) as IDBRequest<StoredApplyBatch | undefined>;
    const itemsRequest = transaction
      .objectStore(CLOSING_DATE_SIDECAR_STORES.applyItems)
      .index(CLOSING_DATE_SIDECAR_INDEXES.applyItemByBatch)
      .getAll(applyBatchId) as IDBRequest<StoredApplyItem[]>;
    const [batch, items] = await Promise.all([
      requestResult(batchRequest),
      requestResult(itemsRequest),
    ]);
    await completion;
    if (!batch) return null;
    const orderedItems = items.sort((left, right) => left.itemOrder - right.itemOrder);
    if (
      orderedItems.length !== batch.itemIds.length
      || orderedItems.some((item, index) => item.id !== batch.itemIds[index])
    ) {
      throw new ClosingDateSidecarIntegrityError(
        `Apply batch ${applyBatchId} has missing or reordered item records`,
      );
    }
    return {
      batch: batch.audit,
      items: orderedItems.map(item => item.audit),
    };
  }

  close(): void {
    this.adapter.close();
  }

  private inject(
    point: ClosingDateSidecarFaultPoint,
    context: ClosingDateSidecarFaultContext = {},
  ): void {
    this.faultInjector?.(point, context);
  }
}

export function createNextClosingDateResolutionRepository(
  options: CreateClosingDateSidecarRepositoryOptions = {},
): ClosingDateResolutionSidecarRepository {
  assertNextClosingDateSidecarAccess(
    getBuildSandboxMode(),
    isClosingDateSidecarFeatureEnabled(),
  );
  if (typeof window === 'undefined' || !window.indexedDB) {
    throw new ClosingDateSidecarUnavailableError('IndexedDB is unavailable in this runtime.');
  }
  const databaseName = ensureSidecarDatabaseName(
    options.databaseName ?? NEXT_CLOSING_DATE_SIDECAR_DB_NAME,
  );
  return new IndexedDbClosingDateResolutionRepository(
    databaseName,
    window.indexedDB,
    options.faultInjector,
  );
}
