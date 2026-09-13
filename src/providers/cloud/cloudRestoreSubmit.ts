import {
  getCloudConnectivitySnapshot,
  type CloudConnectivitySnapshot,
  type CloudReadFreshnessStatus,
} from './cloudConnectivity';
import type { CloudRestoreResult } from './cloudAtomicRestore';

export const CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE = '雲端資料正在更新，本次尚未送出。';
export const CLOUD_RESTORE_UNKNOWN_RESULT_MESSAGE = '還原結果待查證，請勿重複操作。';

export type CloudRestoreSubmitEvent =
  | 'submit-start'
  | 'confirmation-complete'
  | 'readiness-check-pass'
  | 'readiness-check-blocked'
  | 'target-compatibility'
  | 'rpc-invocation'
  | 'rpc-response'
  | 'rpc-error'
  | 'authoritative-refresh'
  | 'submit-finish';

export type CloudRestoreSubmitPhase = 'confirmation' | 'readiness' | 'rpc' | 'authoritative-refresh' | 'submit';
export type CloudRestoreSubmitOutcome = 'not-submitted' | 'failed' | 'unknown' | 'success' | 'sync-pending' | 'cancelled';
export type CloudRestoreErrorClassification = 'readiness' | 'validation' | 'server' | 'transport' | 'unknown';
export type CloudRestoreErrorSource = 'local' | 'pre-dispatch' | 'server-response' | 'transport' | 'post-dispatch';

export interface CloudRestoreSubmitDiagnostic {
  event: CloudRestoreSubmitEvent;
  timestamp: string;
  attemptCorrelationId: string;
  idempotencyKey?: string;
  readStatus?: CloudReadFreshnessStatus;
  phase?: CloudRestoreSubmitPhase;
  outcome?: CloudRestoreSubmitOutcome;
  classification?: CloudRestoreErrorClassification;
  code?: string;
  message?: string;
}

export interface CloudRestoreVisibleError {
  classification: CloudRestoreErrorClassification;
  code: string;
  message: string;
  phase: CloudRestoreSubmitPhase;
  outcome: Extract<CloudRestoreSubmitOutcome, 'not-submitted' | 'failed' | 'unknown'>;
  attemptCorrelationId?: string;
}

export interface CloudRestoreReadiness {
  allowed: boolean;
  code: string;
  connectivity: CloudConnectivitySnapshot;
}

const MAX_DIAGNOSTICS = 100;
const diagnostics: CloudRestoreSubmitDiagnostic[] = [];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_PHASES = new Set<CloudRestoreSubmitPhase>(['confirmation', 'readiness', 'rpc', 'authoritative-refresh', 'submit']);

interface SafeErrorDefinition {
  classification: CloudRestoreErrorClassification;
  code: string;
  message: string;
  outcome: Extract<CloudRestoreSubmitOutcome, 'not-submitted' | 'failed' | 'unknown'>;
}

const READINESS_MESSAGE = CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE;
const VALIDATION_MESSAGE = '備份內容未通過安全檢查，本次尚未送出。';
const TARGET_COMPATIBILITY_MESSAGE = '目標環境不符合跨環境還原政策，本次尚未送出。';
const SERVER_MESSAGE = '伺服器已回覆還原錯誤，請使用追蹤編號查證。';
const UNKNOWN_MESSAGE = '還原發生未分類錯誤；原始錯誤內容已隱藏。';

const definition = (
  code: string,
  classification: CloudRestoreErrorClassification,
  message: string,
  outcome: SafeErrorDefinition['outcome'],
): SafeErrorDefinition => Object.freeze({ code, classification, message, outcome });

const safeDefinitions = new Map<string, SafeErrorDefinition>();
const addDefinitions = (
  codes: readonly string[],
  classification: CloudRestoreErrorClassification,
  message: string,
  outcome: SafeErrorDefinition['outcome'],
): void => {
  codes.forEach(code => safeDefinitions.set(code, definition(code, classification, message, outcome)));
};

addDefinitions([
  'CLOUD_MODE_REQUIRED',
  'AUTHENTICATION_REQUIRED',
  'OWNER_REQUIRED',
  'CLOUD_RESTORE_OWNER_REQUIRED',
  'BROWSER_OFFLINE',
  'CLOUD_NOT_ONLINE',
  'CLOUD_NOT_AUTHORITATIVE_FRESH',
  'CLOUD_OFFLINE_WRITE_BLOCKED',
  'CLOUD_RESTORE_EXPLICIT_CONFIRMATION_REQUIRED',
], 'readiness', READINESS_MESSAGE, 'not-submitted');

addDefinitions([
  'MALFORMED_JSON',
  'RESTORE_DOCUMENT_INVALID',
  'UNSUPPORTED_SCHEMA_VERSION',
  'RESTORE_DATA_REQUIRED',
  'UNEXPECTED_RESOURCE',
  'RESTORE_MANIFEST_REQUIRED',
  'RESTORE_MANIFEST_MISMATCH',
  'UNSUPPORTED_IDENTITY_CONTRACT_VERSION',
  'RESTORE_COLLECTION_REQUIRED',
  'RESTORE_ROW_INVALID',
  'CANONICAL_ID_REQUIRED',
  'CANONICAL_UUID_REQUIRED',
  'INVENTORY_KEY_REQUIRED',
  'DUPLICATE_CANONICAL_ID',
  'DUPLICATE_INVENTORY_KEY',
  'DUPLICATE_VARIANT_LOCAL_ID',
  'ORPHAN_RELATION',
  'CLOUD_RESTORE_CLOSURE_UNSTABLE',
  'RESTORE_PORTABLE_CANDIDATE_NOT_IMPORTABLE',
  'RESTORE_SOURCE_SHA256_INVALID',
  'RESTORE_PORTABILITY_ALREADY_APPLIED',
  'RESTORE_PORTABILITY_TARGET_BLOCKED',
  'RESTORE_PORTABILITY_ROW_COUNT_CHANGED',
  'RESTORE_PORTABILITY_BUSINESS_DATA_CHANGED',
  'RESTORE_PORTABILITY_AUDIT_FIELD_NOT_NULL',
  'RESTORE_PORTABILITY_AUDIT_IDENTITY_INVALID',
  'RESTORE_PORTABILITY_SOURCE_CHANGED',
  'RESTORE_TARGET_COMPATIBILITY_INVALID',
  'RESTORE_TARGET_COMPATIBILITY_MISMATCH',
  'CLOUD_RESTORE_PORTABILITY_POLICY_INVALID',
  'CLOUD_RESTORE_PORTABILITY_TARGET_MISMATCH',
  'CLOUD_RESTORE_PORTABILITY_SCHEMA_MISMATCH',
  'CLOUD_RESTORE_PORTABILITY_EXTERNAL_REFERENCE_BLOCKED',
  'CLOUD_RESTORE_PORTABILITY_AUDIT_VALUE_NOT_NULL',
], 'validation', VALIDATION_MESSAGE, 'failed');

safeDefinitions.set(
  'CLOUD_RESTORE_TARGET_COMPATIBILITY_BLOCKED',
  definition('CLOUD_RESTORE_TARGET_COMPATIBILITY_BLOCKED', 'validation', TARGET_COMPATIBILITY_MESSAGE, 'not-submitted'),
);

addDefinitions([
  'CLOUD_RESTORE_FAILED',
  'CLOUD_RESTORE_LOCK_CONFLICT',
  'CLOUD_RESTORE_MAINTENANCE_LOCKED',
  'RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH',
  'CLOUD_RESTORE_REQUEST_INVALID',
  'CLOUD_RESTORE_SNAPSHOT_INVALID',
  'CLOUD_RESTORE_MANIFEST_INVALID',
  'CLOUD_RESTORE_RESOURCE_REQUIRED',
  'CLOUD_RESTORE_MANIFEST_COUNT_MISMATCH',
  'CLOUD_RESTORE_MANIFEST_TOTAL_MISMATCH',
  'CLOUD_RESTORE_IDENTITY_REQUIRED',
  'CLOUD_RESTORE_POST_INTEGRITY_COUNT_MISMATCH',
  'CLOUD_RESTORE_POST_INTEGRITY_IDENTITY_HASH_MISMATCH',
  'CLOUD_RESTORE_POST_INTEGRITY_ORPHAN',
  'CLOUD_RESTORE_POST_INTEGRITY_RELATIONSHIP_HASH_MISMATCH',
  '22023',
  '23000',
  '23503',
  '23505',
  '42501',
  '55000',
  '55006',
  '57014',
  'PGRST202',
  'PGRST301',
], 'server', SERVER_MESSAGE, 'failed');

addDefinitions([
  'NETWORK_ERROR',
  'ETIMEDOUT',
  'ECONNRESET',
  'ABORT_ERR',
], 'transport', CLOUD_RESTORE_UNKNOWN_RESULT_MESSAGE, 'unknown');

const UNKNOWN_LOCAL_DEFINITION = definition('UNKNOWN', 'unknown', UNKNOWN_MESSAGE, 'failed');
const UNKNOWN_SERVER_DEFINITION = definition('UNKNOWN', 'server', SERVER_MESSAGE, 'failed');
const UNKNOWN_TRANSPORT_DEFINITION = definition('UNKNOWN', 'transport', CLOUD_RESTORE_UNKNOWN_RESULT_MESSAGE, 'unknown');

const contextualizeKnownDefinition = (
  resolved: SafeErrorDefinition,
  source: CloudRestoreErrorSource,
): SafeErrorDefinition => {
  if (source === 'server-response') {
    if (resolved.classification === 'server' || resolved.classification === 'transport') return resolved;
    return definition(resolved.code, 'server', SERVER_MESSAGE, 'failed');
  }
  if (source === 'transport') {
    if (resolved.classification === 'readiness') return resolved;
    return definition(resolved.code, 'transport', CLOUD_RESTORE_UNKNOWN_RESULT_MESSAGE, 'unknown');
  }
  if (source === 'post-dispatch') {
    if (resolved.classification === 'readiness' || resolved.classification === 'server' || resolved.classification === 'transport') {
      return resolved;
    }
    return definition(resolved.code, 'server', SERVER_MESSAGE, 'failed');
  }
  return resolved;
};

const safeOwnScalar = (value: unknown, property: string): string | undefined => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (!descriptor || !('value' in descriptor)) return undefined;
    const scalar = descriptor.value;
    if (typeof scalar !== 'string' && typeof scalar !== 'number') return undefined;
    return String(scalar).trim();
  } catch {
    return undefined;
  }
};

const safeInstanceOf = (value: unknown, constructor: { readonly prototype: object }): boolean => {
  try {
    return value instanceof (constructor as { new (...args: never[]): object });
  } catch {
    return false;
  }
};

const validCorrelationId = (value: unknown): string | undefined => (
  typeof value === 'string' && UUID_PATTERN.test(value) ? value : undefined
);

const definitionFor = (error: unknown, source: CloudRestoreErrorSource): SafeErrorDefinition => {
  if (safeInstanceOf(error, CloudRestoreSafeSubmitError)) {
    const safeCode = safeOwnScalar(error, 'safeCode');
    const safeClassification = safeOwnScalar(error, 'safeClassification');
    if (safeCode === 'UNKNOWN') {
      if (safeClassification === 'server') return UNKNOWN_SERVER_DEFINITION;
      if (safeClassification === 'transport') return UNKNOWN_TRANSPORT_DEFINITION;
      return UNKNOWN_LOCAL_DEFINITION;
    }
    const approved = safeCode ? safeDefinitions.get(safeCode) : undefined;
    if (!approved) return UNKNOWN_LOCAL_DEFINITION;
    if (safeClassification === 'server') return definition(approved.code, 'server', SERVER_MESSAGE, 'failed');
    if (safeClassification === 'transport') return definition(approved.code, 'transport', CLOUD_RESTORE_UNKNOWN_RESULT_MESSAGE, 'unknown');
    return approved.classification === safeClassification ? approved : UNKNOWN_LOCAL_DEFINITION;
  }
  const rawCode = safeOwnScalar(error, 'code');
  const exactKnown = rawCode ? safeDefinitions.get(rawCode) : undefined;
  if (exactKnown) return contextualizeKnownDefinition(exactKnown, source);
  if (source === 'transport' || source === 'post-dispatch' || safeInstanceOf(error, TypeError)) {
    return UNKNOWN_TRANSPORT_DEFINITION;
  }
  if (source === 'server-response') return UNKNOWN_SERVER_DEFINITION;
  return UNKNOWN_LOCAL_DEFINITION;
};

const visibleFromDefinition = (
  resolved: SafeErrorDefinition,
  phase: CloudRestoreSubmitPhase,
  attemptCorrelationId?: string,
): CloudRestoreVisibleError => Object.freeze({
  classification: resolved.classification,
  code: resolved.code,
  message: resolved.message,
  phase: SAFE_PHASES.has(phase) ? phase : 'submit',
  outcome: resolved.outcome,
  ...(validCorrelationId(attemptCorrelationId) ? { attemptCorrelationId } : {}),
});

class CloudRestoreSafeSubmitError extends Error {
  readonly safeCode: string;
  readonly safeClassification: CloudRestoreErrorClassification;

  constructor(resolved: SafeErrorDefinition) {
    super(resolved.message);
    this.name = 'CloudRestoreSafeSubmitError';
    this.safeCode = resolved.code;
    this.safeClassification = resolved.classification;
  }
}

const definitionForVisible = (error: CloudRestoreVisibleError): SafeErrorDefinition => {
  const code = safeOwnScalar(error, 'code');
  const classification = safeOwnScalar(error, 'classification');
  if (code === 'UNKNOWN') {
    if (classification === 'server') return UNKNOWN_SERVER_DEFINITION;
    if (classification === 'transport') return UNKNOWN_TRANSPORT_DEFINITION;
    return UNKNOWN_LOCAL_DEFINITION;
  }
  const exactKnown = code ? safeDefinitions.get(code) : undefined;
  if (!exactKnown) return UNKNOWN_LOCAL_DEFINITION;
  if (classification === 'server') return definition(exactKnown.code, 'server', SERVER_MESSAGE, 'failed');
  if (classification === 'transport') return definition(exactKnown.code, 'transport', CLOUD_RESTORE_UNKNOWN_RESULT_MESSAGE, 'unknown');
  return exactKnown.classification === classification ? exactKnown : UNKNOWN_LOCAL_DEFINITION;
};

export const createCloudRestoreSafeSubmitError = (
  error: unknown,
  source: CloudRestoreErrorSource,
): CloudRestoreSafeSubmitError => {
  const resolved = definitionFor(error, source);
  return new CloudRestoreSafeSubmitError(resolved);
};

export const recordCloudRestoreSubmitDiagnostic = (
  entry: Omit<CloudRestoreSubmitDiagnostic, 'timestamp' | 'classification' | 'code' | 'message'> & {
    error?: CloudRestoreVisibleError;
  },
): void => {
  const resolved = entry.error ? definitionForVisible(entry.error) : null;
  diagnostics.push(Object.freeze({
    event: entry.event,
    timestamp: new Date().toISOString(),
    attemptCorrelationId: validCorrelationId(entry.attemptCorrelationId) ?? 'unavailable',
    ...(validCorrelationId(entry.idempotencyKey) ? { idempotencyKey: entry.idempotencyKey } : {}),
    ...(entry.readStatus ? { readStatus: entry.readStatus } : {}),
    ...(entry.phase ? { phase: entry.phase } : {}),
    ...(entry.outcome ? { outcome: entry.outcome } : {}),
    ...(resolved ? {
      classification: resolved.classification,
      code: resolved.code,
      message: resolved.message,
    } : {}),
  }));
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
};

export const getCloudRestoreSubmitDiagnostics = (): readonly CloudRestoreSubmitDiagnostic[] => (
  diagnostics.map(entry => ({ ...entry }))
);

export const resetCloudRestoreSubmitDiagnosticsForTests = (): void => {
  diagnostics.splice(0);
};

export const inspectCurrentCloudRestoreReadiness = (input: {
  cloudMode: boolean;
  authenticated: boolean;
  owner: boolean;
}): CloudRestoreReadiness => {
  const connectivity = getCloudConnectivitySnapshot();
  if (!input.cloudMode) return { allowed: false, code: 'CLOUD_MODE_REQUIRED', connectivity };
  if (!input.authenticated) return { allowed: false, code: 'AUTHENTICATION_REQUIRED', connectivity };
  if (!input.owner) return { allowed: false, code: 'OWNER_REQUIRED', connectivity };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { allowed: false, code: 'BROWSER_OFFLINE', connectivity };
  }
  if (connectivity.status !== 'online') return { allowed: false, code: 'CLOUD_NOT_ONLINE', connectivity };
  if (connectivity.readStatus !== 'fresh-online' && connectivity.readStatus !== 'fresh-empty') {
    return { allowed: false, code: 'CLOUD_NOT_AUTHORITATIVE_FRESH', connectivity };
  }
  return { allowed: true, code: 'READY', connectivity };
};

export const normalizeCloudRestoreSubmitError = (
  error: unknown,
  phase: CloudRestoreSubmitPhase,
  context: { source?: CloudRestoreErrorSource; attemptCorrelationId?: string } = {},
): CloudRestoreVisibleError => {
  return visibleFromDefinition(
    definitionFor(error, context.source ?? 'local'),
    phase,
    context.attemptCorrelationId,
  );
};

export const formatCloudRestoreSubmitError = (error: CloudRestoreVisibleError): string => {
  const resolved = definitionForVisible(error);
  const phase = SAFE_PHASES.has(error.phase) ? error.phase : 'submit';
  const correlation = validCorrelationId(error.attemptCorrelationId);
  const trace = correlation ? `（階段：${phase}；追蹤：${correlation}）` : `（階段：${phase}）`;
  if (resolved.outcome === 'not-submitted') return `${resolved.message}${correlation ? ` 追蹤：${correlation}` : ''}`;
  return `[${resolved.code}] ${resolved.message}${trace}`;
};

export const readOrCreateCloudRestoreIdempotencyKey = (
  fingerprint: string,
  memory: Map<string, string>,
): string => {
  const existing = memory.get(fingerprint);
  if (existing) return existing;
  const storageKey = `erp_cloud_restore_idempotency:${fingerprint}`;
  try {
    const persisted = sessionStorage.getItem(storageKey);
    if (persisted && UUID_PATTERN.test(persisted)) {
      memory.set(fingerprint, persisted);
      return persisted;
    }
  } catch {
    // In-memory idempotency still protects the mounted panel when storage is unavailable.
  }
  const created = crypto.randomUUID();
  memory.set(fingerprint, created);
  try {
    sessionStorage.setItem(storageKey, created);
  } catch {
    // Storage failure must not replace the key during the current mounted attempt.
  }
  return created;
};

export const preserveCloudRestoreSuccessThroughRefresh = async (
  result: CloudRestoreResult,
  refresh: () => Promise<void>,
  context: { attemptCorrelationId: string; idempotencyKey: string },
): Promise<CloudRestoreResult> => {
  try {
    await refresh();
    recordCloudRestoreSubmitDiagnostic({
      event: 'authoritative-refresh',
      phase: 'authoritative-refresh',
      outcome: 'success',
      attemptCorrelationId: context.attemptCorrelationId,
      idempotencyKey: context.idempotencyKey,
    });
    return { ...result, authoritativeRefresh: { status: 'complete' } };
  } catch (refreshError) {
    const visible = normalizeCloudRestoreSubmitError(refreshError, 'authoritative-refresh', {
      source: 'post-dispatch',
      attemptCorrelationId: context.attemptCorrelationId,
    });
    recordCloudRestoreSubmitDiagnostic({
      event: 'authoritative-refresh',
      phase: 'authoritative-refresh',
      outcome: 'sync-pending',
      attemptCorrelationId: context.attemptCorrelationId,
      idempotencyKey: context.idempotencyKey,
      error: visible,
    });
    return {
      ...result,
      authoritativeRefresh: {
        status: 'pending',
        errorCode: visible.code,
        errorMessage: visible.message,
      },
    };
  }
};
