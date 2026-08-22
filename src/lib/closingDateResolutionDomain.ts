/**
 * Closing Date Resolution Workbench domain contracts.
 *
 * This module is deliberately pure: it owns no Provider, storage, network, UI,
 * clock, or ID-generation dependency. Runtime integrations must supply every
 * identifier and timestamp explicitly.
 */

export type ResolutionClassification = 'GREEN' | 'YELLOW' | 'RED';
export type ResolutionJobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED';

export type VerifiedMappingMethod =
  | 'IMPORT_DIRECT_ID'
  | 'MANUAL_TOP3_SELECTION'
  | 'EXACT_JAN'
  | 'EXACT_SOURCE_PRODUCT_ID'
  | 'EXACT_MODEL_CODE';

export type CandidateMatchMethod =
  | 'ACTIVE_VERIFIED_MAPPING'
  | 'IMPORT_DIRECT_ID_BINDING'
  | 'EXACT_JAN'
  | 'EXACT_SOURCE_PRODUCT_ID'
  | 'EXACT_MODEL_CODE'
  | 'PARSER_INFERRED'
  | 'FUZZY_INFERRED'
  | 'UNVERIFIED';

export type ResolutionFailureCode =
  | 'SERVICE_ERROR'
  | 'NO_CANDIDATE'
  | 'RETRIEVED_BUT_REJECTED'
  | 'MISSING_DEADLINE'
  | 'IDENTITY_CONFLICT';

export type ApplyConflictCode =
  | 'BATCH_MISMATCH'
  | 'MISSING_PRODUCT'
  | 'STALE_PRODUCT'
  | 'CLOSING_DATE_CHANGED'
  | 'RESULT_NOT_APPLICABLE'
  | 'MISSING_SELECTED_CANDIDATE'
  | 'MISSING_SUGGESTED_CLOSING_DATE';

export type ApplyAuditStatus = 'PENDING' | 'APPLIED' | 'CONFLICT' | 'ROLLED_BACK' | 'FAILED';
export type ApplyItemResult = 'PENDING' | 'APPLIED' | 'CONFLICT' | 'ROLLED_BACK' | 'FAILED';
export type ApplyApproval = 'GREEN_AUTO' | 'MANUAL_CONFIRMED';

export interface SourceProductReference {
  sourceSupplier: string;
  sourceProductId: string;
  sourceCatalogId?: string | null;
}

export interface VerifiedMappingRegistryEntry {
  id: string;
  erpProductGroupId: string;
  source: SourceProductReference;
  resolutionIdentityId?: string | null;
  verificationMethod: VerifiedMappingMethod;
  verificationEvidence?: Readonly<Record<string, string>>;
  sourceTitleAtVerification?: string | null;
  erpTitleFingerprint?: string | null;
  verifiedAt: string;
  verifiedBy: string;
  revokedAt?: string | null;
  revokedReason?: string | null;
}

export interface ResolutionCandidateIdentifiers {
  jan?: string | null;
  modelCode?: string | null;
}

export type ResolutionCandidateQueryKind =
  | 'PRODUCT_LINE_SUBJECT'
  | 'SERIES_SUBJECT'
  | 'UNRESOLVED_CONTEXT_SUBJECT'
  | 'SUBJECT_VERSION_FORM'
  | 'SUBJECT'
  | 'COMPOUND_MEMBER'
  | 'FAMILY_STEM_FALLBACK';

export interface ResolutionCandidateRetrievalEvidence {
  queryText: string;
  queryPriority: number;
  queryKind: ResolutionCandidateQueryKind;
  nativeRank: number;
  sourceSupplier: string;
  sourceProductId: string;
}

export interface ResolutionCandidateRetrievalMetadata {
  strategy: 'CATALOG_NATIVE_SEARCH_V2';
  firstSeenOrder: number;
  /** Explicit type/line/scale/model/manufacturer agreement used only for retrieval ranking. */
  metadataCompatibilityCount?: number;
  queryHits: readonly ResolutionCandidateRetrievalEvidence[];
}

export interface ResolutionCandidate {
  id: string;
  source: SourceProductReference;
  resolutionIdentityId?: string | null;
  catalogTitle: string;
  catalogUrl?: string | null;
  /** Raw Catalog brand/manufacturer metadata; never inferred from the title. */
  brandName?: string | null;
  manufacturerName?: string | null;
  identifiers?: ResolutionCandidateIdentifiers;
  rawDeadline?: string | null;
  suggestedClosingDate?: string | null;
  ruleVersion: string;
  snapshotVersion: string;
  confidence: number;
  matchMethod: CandidateMatchMethod;
  retrieval?: ResolutionCandidateRetrievalMetadata;
}

export interface RankedResolutionCandidate extends ResolutionCandidate {
  rank: 1 | 2 | 3;
}

export interface ResolutionServiceError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ResolutionResult {
  id: string;
  batchId: string;
  erpProductGroupId: string;
  erpTitleAtAnalysis: string;
  productUpdatedAtAtAnalysis?: string | null;
  closingDateAtAnalysis?: string | null;
  classification: ResolutionClassification;
  classificationReason: CandidateMatchMethod | ResolutionFailureCode;
  confidence: number;
  candidates: readonly RankedResolutionCandidate[];
  recommendedCandidateId?: string | null;
  selectedCandidateId?: string | null;
  selectedMappingId?: string | null;
  rawDeadline?: string | null;
  suggestedClosingDate?: string | null;
  ruleVersion: string;
  snapshotVersion: string;
  serviceError?: ResolutionServiceError | null;
  analyzedAt: string;
}

export interface ResolutionBatchProgress {
  totalCount: number;
  completedCount: number;
  greenCount: number;
  yellowCount: number;
  redCount: number;
  serviceErrorCount: number;
  retryableServiceErrorCount: number;
}

export interface ResolutionBatchFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ResolutionBatch {
  id: string;
  idempotencyKey: string;
  inputHash: string;
  snapshotVersion: string;
  ruleVersion: string;
  status: ResolutionJobStatus;
  productGroupIds: readonly string[];
  progress: ResolutionBatchProgress;
  attempt: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  cancelRequestedAt?: string | null;
  failure?: ResolutionBatchFailure | null;
}

export interface CreateResolutionBatchInput {
  id: string;
  idempotencyKey: string;
  inputHash: string;
  snapshotVersion: string;
  ruleVersion: string;
  productGroupIds: readonly string[];
  createdAt: string;
}

export interface CreateResolutionResultInput {
  id: string;
  batchId: string;
  erpProductGroupId: string;
  erpTitleAtAnalysis: string;
  productUpdatedAtAtAnalysis?: string | null;
  closingDateAtAnalysis?: string | null;
  candidates?: readonly ResolutionCandidate[];
  recommendedCandidateId?: string | null;
  selectedCandidateId?: string | null;
  activeVerifiedMapping?: VerifiedMappingRegistryEntry | null;
  serviceError?: ResolutionServiceError | null;
  identityConflict?: boolean;
  retrievedButRejected?: boolean;
  ruleVersion: string;
  snapshotVersion: string;
  analyzedAt: string;
}

export interface CurrentProductClosingDateState {
  erpProductGroupId: string;
  updatedAt?: string | null;
  closingDate?: string | null;
}

export interface ResolutionApplySelection {
  result: ResolutionResult;
  approval: ApplyApproval;
  mappingId?: string | null;
}

export interface ApplyConflict {
  erpProductGroupId: string;
  resolutionResultId: string;
  code: ApplyConflictCode;
  expected?: string | null;
  actual?: string | null;
}

export interface ApplyWriteIntent {
  erpProductGroupId: string;
  resolutionResultId: string;
  candidateId: string;
  mappingId?: string | null;
  beforeClosingDate?: string | null;
  afterClosingDate: string;
  source: SourceProductReference;
  rawDeadline: string;
  ruleVersion: string;
}

export interface ApplyAttemptItem {
  erpProductGroupId: string;
  resolutionResultId: string;
  candidateId?: string | null;
  mappingId?: string | null;
  source?: SourceProductReference | null;
  rawDeadline?: string | null;
  ruleVersion: string;
  beforeClosingDate?: string | null;
  afterClosingDate?: string | null;
  conflicts: readonly ApplyConflict[];
}

export type AtomicTransactionResult =
  | {
    outcome: 'NOT_STARTED';
    atomic: true;
    committed: false;
    rolledBack: false;
    writeCount: 0;
  }
  | {
    outcome: 'NOT_STARTED_CONFLICT';
    atomic: true;
    committed: false;
    rolledBack: false;
    writeCount: 0;
  }
  | {
    outcome: 'COMMITTED';
    atomic: true;
    committed: true;
    rolledBack: false;
    writeCount: number;
    transactionId?: string | null;
  }
  | {
    outcome: 'ROLLED_BACK';
    atomic: true;
    committed: false;
    rolledBack: true;
    writeCount: 0;
    reason: string;
    transactionId?: string | null;
  };

export interface AtomicApplyPlan {
  status: 'READY' | 'CONFLICT';
  resolutionBatchId: string;
  attemptedItems: readonly ApplyAttemptItem[];
  writeIntents: readonly ApplyWriteIntent[];
  conflicts: readonly ApplyConflict[];
  transactionResult: AtomicTransactionResult;
}

export interface ApplyBatchAudit {
  id: string;
  resolutionBatchId: string;
  idempotencyKey: string;
  status: ApplyAuditStatus;
  requestedCount: number;
  appliedCount: number;
  atomicTransactionResult: AtomicTransactionResult;
  conflictCount: number;
  rollbackInformation?: string | null;
  createdAt: string;
  appliedAt?: string | null;
}

export interface ApplyItemAudit {
  id: string;
  applyBatchId: string;
  resolutionResultId: string;
  erpProductGroupId: string;
  mappingId?: string | null;
  candidateId?: string | null;
  source?: SourceProductReference | null;
  rawDeadline?: string | null;
  ruleVersion: string;
  beforeClosingDate?: string | null;
  afterClosingDate?: string | null;
  result: ApplyItemResult;
  conflictInformation?: readonly ApplyConflict[];
  appliedAt?: string | null;
}

export interface ApplyAuditBundle {
  batch: ApplyBatchAudit;
  items: readonly ApplyItemAudit[];
}

export interface CreateResolutionJobRequest {
  clientBatchId: string;
  idempotencyKey: string;
  inputHash: string;
  snapshotVersionPreference: 'LATEST' | string;
  ruleVersion: string;
  items: readonly {
    clientItemId: string;
    erpProductGroupId: string;
    title: string;
    updatedAt?: string | null;
    currentClosingDate?: string | null;
    sourceType?: string | null;
    proxyAgent?: string | null;
    jan?: string | null;
    modelCode?: string | null;
    verifiedMappings: readonly VerifiedMappingRegistryEntry[];
  }[];
}

export interface CreateResolutionJobResponse {
  jobId: string;
  status: ResolutionJobStatus;
  snapshotVersion: string;
  statusUrl: string;
}

export interface ResolutionJobResponse {
  batch: ResolutionBatch;
  results: readonly ResolutionResult[];
  nextCursor?: string | null;
}

export interface CancelResolutionJobResponse {
  jobId: string;
  status: 'CANCELLING' | 'CANCELLED';
}

export interface RetryResolutionJobResponse {
  jobId: string;
  logicalBatchId: string;
  attempt: number;
  status: 'QUEUED';
}

export interface ApplyResolutionBatchRequest {
  clientApplyBatchId: string;
  idempotencyKey: string;
  resolutionBatchId: string;
  expectedSnapshotVersion: string;
  expectedRuleVersion: string;
  selections: readonly {
    resolutionResultId: string;
    approval: ApplyApproval;
    selectedCandidateId: string;
    mappingId?: string | null;
    expectedProductUpdatedAt?: string | null;
    expectedClosingDate?: string | null;
  }[];
}

export interface ApplyResolutionBatchResponse {
  applyBatchId: string;
  resolutionBatchId: string;
  status: ApplyAuditStatus;
  atomicTransactionResult: AtomicTransactionResult;
  audit: ApplyAuditBundle;
}

/** Contract only. No storage implementation belongs in the Domain Foundation. */
export interface ClosingDateResolutionStoreContract {
  findActiveMappings(erpProductGroupIds: readonly string[]): Promise<readonly VerifiedMappingRegistryEntry[]>;
  findBatchByIdempotencyKey(idempotencyKey: string): Promise<ResolutionBatch | null>;
  saveResolutionBatch(batch: ResolutionBatch): Promise<void>;
  saveResolutionResults(results: readonly ResolutionResult[]): Promise<void>;
  saveVerifiedMapping(mapping: VerifiedMappingRegistryEntry): Promise<void>;
  saveApplyAudit(audit: ApplyAuditBundle): Promise<void>;
}

const VERIFIED_MAPPING_METHODS = new Set<string>([
  'IMPORT_DIRECT_ID',
  'MANUAL_TOP3_SELECTION',
  'EXACT_JAN',
  'EXACT_SOURCE_PRODUCT_ID',
  'EXACT_MODEL_CODE',
]);

const GREEN_MATCH_METHODS = new Set<CandidateMatchMethod>([
  'IMPORT_DIRECT_ID_BINDING',
  'EXACT_JAN',
  'EXACT_SOURCE_PRODUCT_ID',
  'EXACT_MODEL_CODE',
]);

const CANDIDATE_PRIORITY: Record<CandidateMatchMethod, number> = {
  ACTIVE_VERIFIED_MAPPING: 500,
  IMPORT_DIRECT_ID_BINDING: 400,
  EXACT_JAN: 300,
  EXACT_SOURCE_PRODUCT_ID: 200,
  EXACT_MODEL_CODE: 100,
  PARSER_INFERRED: 30,
  FUZZY_INFERRED: 20,
  UNVERIFIED: 10,
};

const JOB_TRANSITIONS: Readonly<Record<ResolutionJobStatus, readonly ResolutionJobStatus[]>> = {
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED', 'EXPIRED'],
  RUNNING: ['CANCELLING', 'COMPLETED', 'FAILED'],
  CANCELLING: ['CANCELLED', 'FAILED'],
  CANCELLED: [],
  COMPLETED: [],
  FAILED: [],
  EXPIRED: [],
};

const nonEmpty = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
};

const normalizeSupplier = (supplier: string): string => nonEmpty(supplier, 'sourceSupplier').toLowerCase();

const normalizeClosingDate = (value: string | null | undefined): string => value?.trim() ?? '';

const candidateCatalogKey = (candidate: ResolutionCandidate): string => sourceProductKey(candidate.source);

const isTrustedCandidateMethod = (method: CandidateMatchMethod): boolean => (
  GREEN_MATCH_METHODS.has(method) || method === 'ACTIVE_VERIFIED_MAPPING'
);

const bestNativeEvidence = (
  candidate: ResolutionCandidate,
): ResolutionCandidateRetrievalEvidence | null => {
  const hits = candidate.retrieval?.queryHits ?? [];
  return [...hits].sort((left, right) => (
    left.queryPriority - right.queryPriority
    || left.nativeRank - right.nativeRank
  ))[0] ?? null;
};

const nativeQuerySupportCount = (candidate: ResolutionCandidate): number => new Set(
  (candidate.retrieval?.queryHits ?? []).map(hit => `${hit.queryPriority}:${hit.queryText}`),
).size;

const compareCandidates = (left: ResolutionCandidate, right: ResolutionCandidate): number => {
  const leftNative = bestNativeEvidence(left);
  const rightNative = bestNativeEvidence(right);
  if (leftNative && rightNative) {
    const trustedDifference = Number(isTrustedCandidateMethod(right.matchMethod))
      - Number(isTrustedCandidateMethod(left.matchMethod));
    if (trustedDifference !== 0) return trustedDifference;
    const compatibilityDifference = (right.retrieval?.metadataCompatibilityCount ?? 0)
      - (left.retrieval?.metadataCompatibilityCount ?? 0);
    if (compatibilityDifference !== 0) return compatibilityDifference;
    const queryPriorityDifference = leftNative.queryPriority - rightNative.queryPriority;
    if (queryPriorityDifference !== 0) return queryPriorityDifference;
    const nativeRankDifference = leftNative.nativeRank - rightNative.nativeRank;
    if (nativeRankDifference !== 0) return nativeRankDifference;
    const querySupportDifference = nativeQuerySupportCount(right) - nativeQuerySupportCount(left);
    if (querySupportDifference !== 0) return querySupportDifference;
    const firstSeenDifference = (left.retrieval?.firstSeenOrder ?? Number.MAX_SAFE_INTEGER)
      - (right.retrieval?.firstSeenOrder ?? Number.MAX_SAFE_INTEGER);
    if (firstSeenDifference !== 0) return firstSeenDifference;
    return right.confidence - left.confidence;
  }
  if (leftNative || rightNative) return leftNative ? -1 : 1;
  const priorityDifference = CANDIDATE_PRIORITY[right.matchMethod] - CANDIDATE_PRIORITY[left.matchMethod];
  if (priorityDifference !== 0) return priorityDifference;
  const confidenceDifference = right.confidence - left.confidence;
  if (confidenceDifference !== 0) return confidenceDifference;
  return candidateCatalogKey(left).localeCompare(candidateCatalogKey(right));
};

export function sourceProductKey(source: SourceProductReference): string {
  return JSON.stringify([
    normalizeSupplier(source.sourceSupplier),
    nonEmpty(source.sourceProductId, 'sourceProductId'),
  ]);
}

export function sameSourceProduct(
  left: SourceProductReference,
  right: SourceProductReference,
): boolean {
  return sourceProductKey(left) === sourceProductKey(right);
}

export function createVerifiedMapping(
  input: VerifiedMappingRegistryEntry,
): VerifiedMappingRegistryEntry {
  if (!VERIFIED_MAPPING_METHODS.has(input.verificationMethod)) {
    throw new Error(`Unsupported verified mapping method: ${String(input.verificationMethod)}`);
  }
  sourceProductKey(input.source);
  nonEmpty(input.id, 'mapping id');
  nonEmpty(input.erpProductGroupId, 'erpProductGroupId');
  nonEmpty(input.verifiedAt, 'verifiedAt');
  nonEmpty(input.verifiedBy, 'verifiedBy');
  return {
    ...input,
    source: {
      ...input.source,
      sourceSupplier: normalizeSupplier(input.source.sourceSupplier),
      sourceProductId: input.source.sourceProductId.trim(),
      sourceCatalogId: input.source.sourceCatalogId?.trim() || null,
    },
    revokedAt: input.revokedAt ?? null,
    revokedReason: input.revokedReason ?? null,
  };
}

export function revokeVerifiedMapping(
  mapping: VerifiedMappingRegistryEntry,
  revokedAt: string,
  revokedReason: string,
): VerifiedMappingRegistryEntry {
  return {
    ...mapping,
    revokedAt: nonEmpty(revokedAt, 'revokedAt'),
    revokedReason: nonEmpty(revokedReason, 'revokedReason'),
  };
}

export function isActiveVerifiedMapping(mapping: VerifiedMappingRegistryEntry): boolean {
  return !mapping.revokedAt;
}

export function mappingVerifiesCandidate(
  mapping: VerifiedMappingRegistryEntry | null | undefined,
  candidate: ResolutionCandidate,
  erpProductGroupId: string,
): boolean {
  return Boolean(
    mapping
    && isActiveVerifiedMapping(mapping)
    && mapping.erpProductGroupId === erpProductGroupId
    && sameSourceProduct(mapping.source, candidate.source),
  );
}

export function rankTopThreeCandidates(
  candidates: readonly ResolutionCandidate[],
): readonly RankedResolutionCandidate[] {
  const deduplicated = new Map<string, ResolutionCandidate>();
  for (const candidate of candidates) {
    if (candidate.confidence < 0 || candidate.confidence > 1 || !Number.isFinite(candidate.confidence)) {
      throw new Error(`Candidate confidence must be between 0 and 1: ${candidate.id}`);
    }
    sourceProductKey(candidate.source);
    const key = candidateCatalogKey(candidate);
    const existing = deduplicated.get(key);
    if (!existing || compareCandidates(candidate, existing) < 0) deduplicated.set(key, candidate);
  }

  return [...deduplicated.values()]
    .sort(compareCandidates)
    .slice(0, 3)
    .map((candidate, index) => ({
      ...candidate,
      rank: (index + 1) as 1 | 2 | 3,
    }));
}

export function classifyResolutionCandidate(input: {
  erpProductGroupId: string;
  candidate?: ResolutionCandidate | null;
  activeVerifiedMapping?: VerifiedMappingRegistryEntry | null;
  serviceError?: ResolutionServiceError | null;
  identityConflict?: boolean;
  retrievedButRejected?: boolean;
}): { classification: ResolutionClassification; reason: CandidateMatchMethod | ResolutionFailureCode } {
  if (input.serviceError) return { classification: 'RED', reason: 'SERVICE_ERROR' };
  if (input.identityConflict) return { classification: 'RED', reason: 'IDENTITY_CONFLICT' };
  if (!input.candidate && input.retrievedButRejected) {
    return { classification: 'RED', reason: 'RETRIEVED_BUT_REJECTED' };
  }
  if (!input.candidate) return { classification: 'RED', reason: 'NO_CANDIDATE' };
  if (!input.candidate.rawDeadline || !input.candidate.suggestedClosingDate) {
    return { classification: 'RED', reason: 'MISSING_DEADLINE' };
  }
  if (mappingVerifiesCandidate(input.activeVerifiedMapping, input.candidate, input.erpProductGroupId)) {
    return { classification: 'GREEN', reason: 'ACTIVE_VERIFIED_MAPPING' };
  }
  if (GREEN_MATCH_METHODS.has(input.candidate.matchMethod)) {
    return { classification: 'GREEN', reason: input.candidate.matchMethod };
  }
  return { classification: 'YELLOW', reason: input.candidate.matchMethod };
}

export function createResolutionResult(input: CreateResolutionResultInput): ResolutionResult {
  const candidates = rankTopThreeCandidates(input.candidates ?? []);
  for (const candidate of candidates) {
    if (candidate.ruleVersion !== input.ruleVersion) {
      throw new Error(`Candidate rule version mismatch: ${candidate.id}`);
    }
    if (candidate.snapshotVersion !== input.snapshotVersion) {
      throw new Error(`Candidate snapshot version mismatch: ${candidate.id}`);
    }
  }
  const explicitlySelected = input.selectedCandidateId
    ? candidates.find(candidate => candidate.id === input.selectedCandidateId)
    : undefined;
  if (input.selectedCandidateId && !explicitlySelected) {
    throw new Error(`Selected candidate is not present in Top 3: ${input.selectedCandidateId}`);
  }
  const explicitlyRecommended = input.recommendedCandidateId
    ? candidates.find(candidate => candidate.id === input.recommendedCandidateId)
    : undefined;
  if (input.recommendedCandidateId && !explicitlyRecommended) {
    throw new Error(`Recommended candidate is not present in Top 3: ${input.recommendedCandidateId}`);
  }
  const recommended = explicitlySelected ?? explicitlyRecommended ?? candidates[0];
  const decision = classifyResolutionCandidate({
    erpProductGroupId: input.erpProductGroupId,
    candidate: recommended,
    activeVerifiedMapping: input.activeVerifiedMapping,
    serviceError: input.serviceError,
    identityConflict: input.identityConflict,
    retrievedButRejected: input.retrievedButRejected,
  });
  const selectedCandidateId = explicitlySelected?.id
    ?? (decision.classification === 'GREEN' ? recommended?.id : null);

  return {
    id: nonEmpty(input.id, 'result id'),
    batchId: nonEmpty(input.batchId, 'batchId'),
    erpProductGroupId: nonEmpty(input.erpProductGroupId, 'erpProductGroupId'),
    erpTitleAtAnalysis: input.erpTitleAtAnalysis,
    productUpdatedAtAtAnalysis: input.productUpdatedAtAtAnalysis ?? null,
    closingDateAtAnalysis: input.closingDateAtAnalysis ?? null,
    classification: decision.classification,
    classificationReason: decision.reason,
    confidence: recommended?.confidence ?? 0,
    candidates,
    recommendedCandidateId: recommended?.id ?? null,
    selectedCandidateId,
    selectedMappingId: recommended
      && mappingVerifiesCandidate(input.activeVerifiedMapping, recommended, input.erpProductGroupId)
      ? input.activeVerifiedMapping?.id ?? null
      : null,
    rawDeadline: recommended?.rawDeadline ?? null,
    suggestedClosingDate: recommended?.suggestedClosingDate ?? null,
    ruleVersion: nonEmpty(input.ruleVersion, 'ruleVersion'),
    snapshotVersion: nonEmpty(input.snapshotVersion, 'snapshotVersion'),
    serviceError: input.serviceError ?? null,
    analyzedAt: nonEmpty(input.analyzedAt, 'analyzedAt'),
  };
}

export function createResolutionBatch(input: CreateResolutionBatchInput): ResolutionBatch {
  if (new Set(input.productGroupIds).size !== input.productGroupIds.length) {
    throw new Error('Resolution batch contains duplicate ProductGroup IDs');
  }
  input.productGroupIds.forEach(id => nonEmpty(id, 'productGroupId'));
  return {
    id: nonEmpty(input.id, 'batch id'),
    idempotencyKey: nonEmpty(input.idempotencyKey, 'idempotencyKey'),
    inputHash: nonEmpty(input.inputHash, 'inputHash'),
    snapshotVersion: nonEmpty(input.snapshotVersion, 'snapshotVersion'),
    ruleVersion: nonEmpty(input.ruleVersion, 'ruleVersion'),
    status: 'QUEUED',
    productGroupIds: [...input.productGroupIds],
    progress: {
      totalCount: input.productGroupIds.length,
      completedCount: 0,
      greenCount: 0,
      yellowCount: 0,
      redCount: 0,
      serviceErrorCount: 0,
      retryableServiceErrorCount: 0,
    },
    attempt: 1,
    createdAt: nonEmpty(input.createdAt, 'createdAt'),
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    failure: null,
  };
}

export function canTransitionResolutionJob(
  from: ResolutionJobStatus,
  to: ResolutionJobStatus,
): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function transitionResolutionBatch(
  batch: ResolutionBatch,
  nextStatus: ResolutionJobStatus,
  at: string,
): ResolutionBatch {
  if (!canTransitionResolutionJob(batch.status, nextStatus)) {
    throw new Error(`Invalid resolution job transition: ${batch.status} -> ${nextStatus}`);
  }
  const timestamp = nonEmpty(at, 'transition timestamp');
  return {
    ...batch,
    status: nextStatus,
    startedAt: nextStatus === 'RUNNING' ? timestamp : batch.startedAt,
    cancelRequestedAt: nextStatus === 'CANCELLING' ? timestamp : batch.cancelRequestedAt,
    finishedAt: ['CANCELLED', 'COMPLETED', 'FAILED', 'EXPIRED'].includes(nextStatus)
      ? timestamp
      : batch.finishedAt,
  };
}

export function canCancelResolutionBatch(batch: ResolutionBatch): boolean {
  return batch.status === 'QUEUED' || batch.status === 'RUNNING';
}

export function canRetryResolutionBatch(batch: ResolutionBatch): boolean {
  return (batch.status === 'FAILED' && Boolean(batch.failure?.retryable))
    || (batch.status === 'COMPLETED' && batch.progress.retryableServiceErrorCount > 0);
}

export function resolveIdempotentResolutionBatch(
  existingBatches: readonly ResolutionBatch[],
  request: CreateResolutionBatchInput,
): { batch: ResolutionBatch; logicalBatches: readonly ResolutionBatch[]; created: boolean } {
  const existing = existingBatches.find(batch => batch.idempotencyKey === request.idempotencyKey);
  if (!existing) {
    const batch = createResolutionBatch(request);
    return { batch, logicalBatches: [...existingBatches, batch], created: true };
  }
  if (
    existing.inputHash !== request.inputHash
    || existing.ruleVersion !== request.ruleVersion
    || existing.snapshotVersion !== request.snapshotVersion
  ) {
    throw new Error(`Idempotency conflict for key: ${request.idempotencyKey}`);
  }
  return { batch: existing, logicalBatches: existingBatches, created: false };
}

const conflict = (
  selection: ResolutionApplySelection,
  code: ApplyConflictCode,
  expected?: string | null,
  actual?: string | null,
): ApplyConflict => ({
  erpProductGroupId: selection.result.erpProductGroupId,
  resolutionResultId: selection.result.id,
  code,
  expected,
  actual,
});

export function planAtomicClosingDateApply(input: {
  resolutionBatchId: string;
  selections: readonly ResolutionApplySelection[];
  currentProducts: readonly CurrentProductClosingDateState[];
}): AtomicApplyPlan {
  const currentById = new Map(input.currentProducts.map(product => [product.erpProductGroupId, product]));
  const conflicts: ApplyConflict[] = [];
  const attemptedItems: ApplyAttemptItem[] = [];
  const proposedWriteIntents: ApplyWriteIntent[] = [];

  for (const selection of input.selections) {
    const result = selection.result;
    const itemConflicts: ApplyConflict[] = [];
    const addConflict = (
      code: ApplyConflictCode,
      expected?: string | null,
      actual?: string | null,
    ): void => {
      const item = conflict(selection, code, expected, actual);
      itemConflicts.push(item);
      conflicts.push(item);
    };
    if (result.batchId !== input.resolutionBatchId) {
      addConflict('BATCH_MISMATCH', input.resolutionBatchId, result.batchId);
    }
    if (result.classification !== 'GREEN') {
      addConflict('RESULT_NOT_APPLICABLE', result.classification, selection.approval);
    }
    const selectedCandidate = result.candidates.find(candidate => candidate.id === result.selectedCandidateId);
    if (!selectedCandidate) {
      addConflict('MISSING_SELECTED_CANDIDATE');
    } else if (!selectedCandidate.suggestedClosingDate || !selectedCandidate.rawDeadline) {
      addConflict('MISSING_SUGGESTED_CLOSING_DATE');
    }
    const current = currentById.get(result.erpProductGroupId);
    if (!current) {
      addConflict('MISSING_PRODUCT');
    } else {
      if ((result.productUpdatedAtAtAnalysis ?? null) !== (current.updatedAt ?? null)) {
        addConflict(
        'STALE_PRODUCT',
        result.productUpdatedAtAtAnalysis ?? null,
        current.updatedAt ?? null,
        );
      }
      if (normalizeClosingDate(result.closingDateAtAnalysis) !== normalizeClosingDate(current.closingDate)) {
        addConflict(
        'CLOSING_DATE_CHANGED',
        result.closingDateAtAnalysis ?? null,
        current.closingDate ?? null,
        );
      }
    }

    attemptedItems.push({
      erpProductGroupId: result.erpProductGroupId,
      resolutionResultId: result.id,
      candidateId: selectedCandidate?.id ?? null,
      mappingId: selection.mappingId ?? result.selectedMappingId ?? null,
      beforeClosingDate: current?.closingDate ?? null,
      afterClosingDate: selectedCandidate?.suggestedClosingDate ?? null,
      source: selectedCandidate?.source ?? null,
      rawDeadline: selectedCandidate?.rawDeadline ?? null,
      ruleVersion: result.ruleVersion,
      conflicts: itemConflicts,
    });

    if (
      itemConflicts.length === 0
      && selectedCandidate?.suggestedClosingDate
      && selectedCandidate.rawDeadline
      && current
    ) {
      proposedWriteIntents.push({
        erpProductGroupId: result.erpProductGroupId,
        resolutionResultId: result.id,
        candidateId: selectedCandidate.id,
        mappingId: selection.mappingId ?? result.selectedMappingId ?? null,
        beforeClosingDate: current.closingDate ?? null,
        afterClosingDate: selectedCandidate.suggestedClosingDate,
        source: selectedCandidate.source,
        rawDeadline: selectedCandidate.rawDeadline,
        ruleVersion: result.ruleVersion,
      });
    }
  }

  if (conflicts.length > 0) {
    return {
      status: 'CONFLICT',
      resolutionBatchId: input.resolutionBatchId,
      attemptedItems,
      writeIntents: [],
      conflicts,
      transactionResult: {
        outcome: 'NOT_STARTED_CONFLICT',
        atomic: true,
        committed: false,
        rolledBack: false,
        writeCount: 0,
      },
    };
  }

  return {
    status: 'READY',
    resolutionBatchId: input.resolutionBatchId,
    attemptedItems,
    writeIntents: proposedWriteIntents,
    conflicts: [],
    transactionResult: {
      outcome: 'NOT_STARTED',
      atomic: true,
      committed: false,
      rolledBack: false,
      writeCount: 0,
    },
  };
}

/**
 * The persisted ResolutionResult is the single source of truth for Apply.
 * A transient radio selection must never promote a YELLOW result to an
 * applyable result. Manual verification first persists an active mapping and
 * recomputes the result as GREEN/ACTIVE_VERIFIED_MAPPING.
 */
export function createApplySelectionFromResolutionResult(
  result: ResolutionResult,
): ResolutionApplySelection | null {
  if (result.classification !== 'GREEN' || !result.selectedCandidateId) return null;
  const candidate = result.candidates.find(item => item.id === result.selectedCandidateId);
  if (!candidate?.rawDeadline || !candidate.suggestedClosingDate) return null;
  if (result.classificationReason === 'ACTIVE_VERIFIED_MAPPING' && !result.selectedMappingId) {
    return null;
  }
  return {
    result,
    approval: 'GREEN_AUTO',
    mappingId: result.selectedMappingId ?? null,
  };
}

export function createAtomicRollbackResult(
  reason: string,
  transactionId?: string | null,
): AtomicTransactionResult {
  return {
    outcome: 'ROLLED_BACK',
    atomic: true,
    committed: false,
    rolledBack: true,
    writeCount: 0,
    reason: nonEmpty(reason, 'rollback reason'),
    transactionId: transactionId ?? null,
  };
}

export function createApplyAuditBundle(input: {
  applyBatchId: string;
  applyItemIds: readonly string[];
  idempotencyKey: string;
  plan: AtomicApplyPlan;
  createdAt: string;
}): ApplyAuditBundle {
  if (input.applyItemIds.length !== input.plan.attemptedItems.length) {
    throw new Error('Every attempted apply item requires one audit ID');
  }
  const conflictsByResult = new Map<string, ApplyConflict[]>();
  for (const item of input.plan.conflicts) {
    const items = conflictsByResult.get(item.resolutionResultId) ?? [];
    items.push(item);
    conflictsByResult.set(item.resolutionResultId, items);
  }
  const status: ApplyAuditStatus = input.plan.status === 'CONFLICT' ? 'CONFLICT' : 'PENDING';
  return {
    batch: {
      id: nonEmpty(input.applyBatchId, 'applyBatchId'),
      resolutionBatchId: input.plan.resolutionBatchId,
      idempotencyKey: nonEmpty(input.idempotencyKey, 'idempotencyKey'),
      status,
      requestedCount: input.plan.attemptedItems.length,
      appliedCount: 0,
      atomicTransactionResult: input.plan.transactionResult,
      conflictCount: input.plan.conflicts.length,
      createdAt: nonEmpty(input.createdAt, 'createdAt'),
      appliedAt: null,
    },
    items: input.plan.attemptedItems.map((item, index) => ({
      id: nonEmpty(input.applyItemIds[index], 'apply item audit id'),
      applyBatchId: input.applyBatchId,
      resolutionResultId: item.resolutionResultId,
      erpProductGroupId: item.erpProductGroupId,
      mappingId: item.mappingId ?? null,
      candidateId: item.candidateId,
      source: item.source,
      rawDeadline: item.rawDeadline,
      ruleVersion: item.ruleVersion,
      beforeClosingDate: item.beforeClosingDate ?? null,
      afterClosingDate: item.afterClosingDate,
      result: input.plan.status === 'CONFLICT' ? 'CONFLICT' : 'PENDING',
      conflictInformation: conflictsByResult.get(item.resolutionResultId) ?? [],
      appliedAt: null,
    })),
  };
}
