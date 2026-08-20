import type {
  ApplyBatchAudit,
  ApplyItemAudit,
  RankedResolutionCandidate,
  ResolutionBatch,
  ResolutionResult,
  VerifiedMappingRegistryEntry,
} from './closingDateResolutionDomain';

/**
 * A separate Next-only database keeps Workbench state out of the ERP snapshot.
 * This name must never be routed to daigou-erp-db or a Supabase-backed store.
 */
export const NEXT_CLOSING_DATE_SIDECAR_DB_NAME = 'daigou-erp-closing-date-sidecar-next-v1';
export const NEXT_CLOSING_DATE_SIDECAR_DB_VERSION = 1;

export const CLOSING_DATE_SIDECAR_STORES = {
  verifiedMappings: 'closing_date_verified_mappings',
  resolutionBatches: 'closing_date_resolution_batches',
  resolutionResults: 'closing_date_resolution_results',
  resolutionCandidates: 'closing_date_resolution_candidates',
  applyBatches: 'closing_date_apply_batches',
  applyItems: 'closing_date_apply_items',
} as const;

export type ClosingDateSidecarStoreName = (
  typeof CLOSING_DATE_SIDECAR_STORES
)[keyof typeof CLOSING_DATE_SIDECAR_STORES];

export const CLOSING_DATE_SIDECAR_STORE_NAMES = Object.freeze(
  Object.values(CLOSING_DATE_SIDECAR_STORES),
) as readonly ClosingDateSidecarStoreName[];

export const CLOSING_DATE_ANALYSIS_TRANSACTION_STORES = Object.freeze([
  CLOSING_DATE_SIDECAR_STORES.verifiedMappings,
  CLOSING_DATE_SIDECAR_STORES.resolutionBatches,
  CLOSING_DATE_SIDECAR_STORES.resolutionResults,
  CLOSING_DATE_SIDECAR_STORES.resolutionCandidates,
]) as readonly ClosingDateSidecarStoreName[];

export const CLOSING_DATE_APPLY_AUDIT_TRANSACTION_STORES = Object.freeze([
  CLOSING_DATE_SIDECAR_STORES.applyBatches,
  CLOSING_DATE_SIDECAR_STORES.applyItems,
]) as readonly ClosingDateSidecarStoreName[];

export const CLOSING_DATE_SIDECAR_INDEXES = {
  mappingByProductGroup: 'by_erp_product_group_id',
  mappingBySourceIdentity: 'by_source_identity_key',
  batchByIdempotency: 'by_idempotency_key',
  resultByBatch: 'by_batch_id',
  resultByProductGroup: 'by_erp_product_group_id',
  candidateByResult: 'by_resolution_result_id',
  candidateByBatch: 'by_resolution_batch_id',
  candidateBySourceIdentity: 'by_source_identity_key',
  applyBatchByIdempotency: 'by_idempotency_key',
  applyItemByBatch: 'by_apply_batch_id',
  applyItemByResolutionResult: 'by_resolution_result_id',
} as const;

export interface StoredVerifiedMapping {
  id: string;
  erpProductGroupId: string;
  sourceIdentityKey: string;
  revokedAt?: string | null;
  mapping: VerifiedMappingRegistryEntry;
}

export interface StoredResolutionBatch {
  id: string;
  idempotencyKey: string;
  inputHash: string;
  snapshotVersion: string;
  ruleVersion: string;
  batch: ResolutionBatch;
}

export interface StoredResolutionResult {
  id: string;
  batchId: string;
  erpProductGroupId: string;
  candidateStorageIds: readonly string[];
  result: Omit<ResolutionResult, 'candidates'>;
}

export interface StoredResolutionCandidate {
  storageId: string;
  resolutionResultId: string;
  resolutionBatchId: string;
  sourceIdentityKey: string;
  candidate: RankedResolutionCandidate;
}

export interface StoredApplyBatch {
  id: string;
  idempotencyKey: string;
  resolutionBatchId: string;
  itemIds: readonly string[];
  audit: ApplyBatchAudit;
}

export interface StoredApplyItem {
  id: string;
  applyBatchId: string;
  resolutionResultId: string;
  itemOrder: number;
  audit: ApplyItemAudit;
}

export interface ClosingDateSidecarStoreRecords {
  [CLOSING_DATE_SIDECAR_STORES.verifiedMappings]: StoredVerifiedMapping;
  [CLOSING_DATE_SIDECAR_STORES.resolutionBatches]: StoredResolutionBatch;
  [CLOSING_DATE_SIDECAR_STORES.resolutionResults]: StoredResolutionResult;
  [CLOSING_DATE_SIDECAR_STORES.resolutionCandidates]: StoredResolutionCandidate;
  [CLOSING_DATE_SIDECAR_STORES.applyBatches]: StoredApplyBatch;
  [CLOSING_DATE_SIDECAR_STORES.applyItems]: StoredApplyItem;
}

const createStore = (
  database: IDBDatabase,
  name: ClosingDateSidecarStoreName,
  keyPath: string,
): IDBObjectStore => database.createObjectStore(name, { keyPath });

/** IndexedDB version 1 migration. New stores intentionally start empty. */
export function migrateClosingDateResolutionSidecar(
  database: IDBDatabase,
  oldVersion: number,
): void {
  if (oldVersion >= 1) return;

  const mappings = createStore(
    database,
    CLOSING_DATE_SIDECAR_STORES.verifiedMappings,
    'id',
  );
  mappings.createIndex(
    CLOSING_DATE_SIDECAR_INDEXES.mappingByProductGroup,
    'erpProductGroupId',
    { unique: false },
  );
  mappings.createIndex(
    CLOSING_DATE_SIDECAR_INDEXES.mappingBySourceIdentity,
    'sourceIdentityKey',
    { unique: false },
  );

  const batches = createStore(
    database,
    CLOSING_DATE_SIDECAR_STORES.resolutionBatches,
    'id',
  );
  batches.createIndex(
    CLOSING_DATE_SIDECAR_INDEXES.batchByIdempotency,
    'idempotencyKey',
    { unique: true },
  );

  const results = createStore(
    database,
    CLOSING_DATE_SIDECAR_STORES.resolutionResults,
    'id',
  );
  results.createIndex(CLOSING_DATE_SIDECAR_INDEXES.resultByBatch, 'batchId', { unique: false });
  results.createIndex(
    CLOSING_DATE_SIDECAR_INDEXES.resultByProductGroup,
    'erpProductGroupId',
    { unique: false },
  );

  const candidates = createStore(
    database,
    CLOSING_DATE_SIDECAR_STORES.resolutionCandidates,
    'storageId',
  );
  candidates.createIndex(
    CLOSING_DATE_SIDECAR_INDEXES.candidateByResult,
    'resolutionResultId',
    { unique: false },
  );
  candidates.createIndex(
    CLOSING_DATE_SIDECAR_INDEXES.candidateByBatch,
    'resolutionBatchId',
    { unique: false },
  );
  candidates.createIndex(
    CLOSING_DATE_SIDECAR_INDEXES.candidateBySourceIdentity,
    'sourceIdentityKey',
    { unique: false },
  );

  const applyBatches = createStore(
    database,
    CLOSING_DATE_SIDECAR_STORES.applyBatches,
    'id',
  );
  applyBatches.createIndex(
    CLOSING_DATE_SIDECAR_INDEXES.applyBatchByIdempotency,
    'idempotencyKey',
    { unique: true },
  );

  const applyItems = createStore(
    database,
    CLOSING_DATE_SIDECAR_STORES.applyItems,
    'id',
  );
  applyItems.createIndex(
    CLOSING_DATE_SIDECAR_INDEXES.applyItemByBatch,
    'applyBatchId',
    { unique: false },
  );
  applyItems.createIndex(
    CLOSING_DATE_SIDECAR_INDEXES.applyItemByResolutionResult,
    'resolutionResultId',
    { unique: false },
  );
}
