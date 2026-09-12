import {
  getCloudConnectivitySnapshot,
  isLikelyCloudConnectivityError,
  type CloudConnectivitySnapshot,
  type CloudReadFreshnessStatus,
} from './cloudConnectivity';
import type { CloudRestoreResult } from './cloudAtomicRestore';

export const CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE = '雲端資料正在更新，本次尚未送出，請待更新完成後重新確認。';
export const CLOUD_RESTORE_UNKNOWN_RESULT_MESSAGE = '還原要求已嘗試送出，但結果待查證；請勿再次還原。';

export type CloudRestoreSubmitEvent =
  | 'submit-start'
  | 'confirmation-complete'
  | 'readiness-check-pass'
  | 'readiness-check-blocked'
  | 'rpc-invocation'
  | 'rpc-response'
  | 'rpc-error'
  | 'authoritative-refresh'
  | 'submit-finish';

export type CloudRestoreSubmitPhase = 'confirmation' | 'readiness' | 'rpc' | 'authoritative-refresh' | 'submit';
export type CloudRestoreSubmitOutcome = 'not-submitted' | 'failed' | 'unknown' | 'success' | 'sync-pending' | 'cancelled';

export interface CloudRestoreSubmitDiagnostic {
  event: CloudRestoreSubmitEvent;
  timestamp: string;
  attemptCorrelationId: string;
  idempotencyKey?: string;
  readStatus?: CloudReadFreshnessStatus;
  phase?: CloudRestoreSubmitPhase;
  outcome?: CloudRestoreSubmitOutcome;
  code?: string;
  message?: string;
}

export interface CloudRestoreVisibleError {
  code: string;
  message: string;
  phase: CloudRestoreSubmitPhase;
  outcome: Extract<CloudRestoreSubmitOutcome, 'not-submitted' | 'failed' | 'unknown'>;
  details?: string;
  hint?: string;
}

export interface CloudRestoreReadiness {
  allowed: boolean;
  code: string;
  connectivity: CloudConnectivitySnapshot;
}

const MAX_DIAGNOSTICS = 100;
const MAX_MESSAGE_LENGTH = 240;
const MAX_SUPPLEMENT_LENGTH = 160;
const diagnostics: CloudRestoreSubmitDiagnostic[] = [];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ERROR_CODE_PATTERN = /^[a-z0-9_.:-]{1,80}$/iu;
const REDACTED_URL = '[REDACTED_URL]';
const REDACTED_CONNECTION_VALUE = '[REDACTED_CONNECTION_VALUE]';
const REDACTED_SENSITIVE_CONTENT = '[REDACTED_SENSITIVE_CONTENT]';
const PLAIN_CONNECTION_URL_PATTERN = /\b(?:https?|postgres(?:ql)?|jdbc:postgresql):\/\/[^\s<>"'`]+/giu;
const ENCODED_CONNECTION_URL_PATTERN = /\b(?:https?|postgres(?:ql)?)%3a(?:%2f){2}[^\s<>"'`]+/giu;
const SUPABASE_HOST_PATTERN = /\b(?:[a-z0-9-]+\.)*supabase\.(?:co|com|net)(?::\d+)?(?:\/[^\s<>"'`]+)?/giu;
const ENCODED_CONNECTION_ASSIGNMENT_PATTERN = /\b(?:host|hostaddr|port|user|username|password|dbname|database)%3d[^\s,;]+/giu;
const CONNECTION_ASSIGNMENT_PATTERN = /\b(host|hostaddr|port|user|username|password|passfile|dbname|database|sslmode|sslcert|sslkey|sslrootcert|options)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu;
const SENSITIVE_ASSIGNMENT_PATTERN = /\b(access[_-]?token|refresh[_-]?token|password|authorization|api[_-]?key|anon[_-]?key|service[_-]?role|database[_-]?url|db[_-]?url|connection[_-]?string)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu;
const JWT_PATTERN = /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/gu;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/giu;
const POSTGRES_KEY_VALUE_PATTERN = /(\bKey\s+\([^)]+\)\s*=\s*)\([^)]+\)/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const STRUCTURED_PAYLOAD_MARKER_PATTERN = /"(?:snapshot|data|manifest|resources?|customer|product|inventory|orders?)"\s*:/iu;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isSuspiciousStructuredContent = (value: string): boolean => {
  const trimmed = value.trim();
  const wrappedStructure = (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  return wrappedStructure || STRUCTURED_PAYLOAD_MARKER_PATTERN.test(trimmed);
};

const boundedText = (value: unknown, maxLength: number): string => {
  const raw = typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
  if (!raw) return '';
  if (isSuspiciousStructuredContent(raw)) return REDACTED_SENSITIVE_CONTENT;
  const redacted = raw
    .replace(PLAIN_CONNECTION_URL_PATTERN, REDACTED_URL)
    .replace(ENCODED_CONNECTION_URL_PATTERN, REDACTED_URL)
    .replace(SUPABASE_HOST_PATTERN, REDACTED_URL)
    .replace(ENCODED_CONNECTION_ASSIGNMENT_PATTERN, '[REDACTED_CONNECTION_STRING]')
    .replace(CONNECTION_ASSIGNMENT_PATTERN, (_, key: string) => `${key}=${REDACTED_CONNECTION_VALUE}`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1=[REDACTED]')
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(POSTGRES_KEY_VALUE_PATTERN, '$1([REDACTED_VALUE])')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(/[\r\n\t]+/gu, ' ')
    .trim();
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
};

const safeErrorCode = (value: unknown): string => {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return SAFE_ERROR_CODE_PATTERN.test(raw) ? raw : 'UNKNOWN_ERROR';
};

const safeSupplement = (value: unknown): string | undefined => {
  const text = boundedText(value, MAX_SUPPLEMENT_LENGTH);
  return text || undefined;
};

export const recordCloudRestoreSubmitDiagnostic = (
  entry: Omit<CloudRestoreSubmitDiagnostic, 'timestamp'>,
): void => {
  diagnostics.push(Object.freeze({
    ...entry,
    timestamp: new Date().toISOString(),
    ...(entry.code ? { code: safeErrorCode(entry.code) } : {}),
    ...(entry.message ? { message: boundedText(entry.message, MAX_MESSAGE_LENGTH) } : {}),
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
): CloudRestoreVisibleError => {
  const record = isRecord(error) ? error : null;
  const code = safeErrorCode(record?.code ?? (error instanceof Error ? error.name : ''));
  const message = boundedText(record?.message ?? (error instanceof Error ? error.message : ''), MAX_MESSAGE_LENGTH)
    || '發生未識別錯誤。';
  const details = safeSupplement(record?.details);
  const hint = safeSupplement(record?.hint);
  const outcome = code === 'CLOUD_OFFLINE_WRITE_BLOCKED'
    ? 'not-submitted'
    : isLikelyCloudConnectivityError(error)
      ? 'unknown'
      : 'failed';
  return {
    code,
    message,
    phase,
    outcome,
    ...(details ? { details } : {}),
    ...(hint ? { hint } : {}),
  };
};

export const formatCloudRestoreSubmitError = (error: CloudRestoreVisibleError): string => {
  if (error.outcome === 'not-submitted') return CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE;
  const prefix = error.outcome === 'unknown' ? `${CLOUD_RESTORE_UNKNOWN_RESULT_MESSAGE} ` : '';
  const supplements = [error.details, error.hint].filter(Boolean).join('；');
  return `${prefix}[${error.code}] ${error.message}（階段：${error.phase}）${supplements ? `；${supplements}` : ''}`;
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
    const visible = normalizeCloudRestoreSubmitError(refreshError, 'authoritative-refresh');
    recordCloudRestoreSubmitDiagnostic({
      event: 'authoritative-refresh',
      phase: 'authoritative-refresh',
      outcome: 'sync-pending',
      attemptCorrelationId: context.attemptCorrelationId,
      idempotencyKey: context.idempotencyKey,
      code: visible.code,
      message: visible.message,
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
