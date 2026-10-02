import { CloudMutationBoundaryError, isCloudFieldMutationError } from '../providers/cloud/cloudFieldCas';

export type MyAcgImportErrorCode = 'FILE_READ_ERROR' | 'PARSER_ERROR' | 'REQUIRED_FIELD_MISSING'
  | 'VALIDATION_ERROR' | 'CLOUD_STAGING_ERROR' | 'CLOUD_COMMIT_ERROR' | 'PERMISSION_ERROR'
  | 'NETWORK_ERROR' | 'COMMIT_RESULT_UNKNOWN' | 'COMMITTED_READBACK_PENDING';
export type MyAcgImportPhase = 'file-read' | 'parse' | 'validation' | 'staging' | 'commit' | 'readback';

const messages: Record<MyAcgImportErrorCode, string> = {
  FILE_READ_ERROR: '無法讀取檔案，請確認檔案可開啟後重新選取。',
  PARSER_ERROR: '無法解析買動漫檔案，請重新從買動漫匯出。',
  REQUIRED_FIELD_MISSING: '找不到必要欄位：商品編號與商品名稱。請確認選取的是買動漫商品匯出檔。',
  VALIDATION_ERROR: '資料內容驗證失敗，本次未儲存。請查看技術資訊。',
  CLOUD_STAGING_ERROR: '雲端匯入計畫建立失敗，本次未儲存。請同步後查看技術資訊。',
  CLOUD_COMMIT_ERROR: '雲端儲存失敗，資料未變更。請稍後重試或查看技術資訊。',
  PERMISSION_ERROR: '權限不足，本次匯入已停止。請確認帳號權限。',
  NETWORK_ERROR: '網路／服務連線失敗，匯入尚未開始儲存。請確認連線。',
  COMMIT_RESULT_UNKNOWN: '雲端儲存結果尚未確認。請先同步並核對資料，勿重複匯入。',
  COMMITTED_READBACK_PENDING: '已儲存至雲端，但資料讀回尚未完成。請同步後確認，勿重複匯入。',
};

export class MyAcgImportError extends Error {
  readonly code: MyAcgImportErrorCode;
  readonly phase: MyAcgImportPhase;
  constructor(code: MyAcgImportErrorCode, phase: MyAcgImportPhase, cause?: unknown) {
    super(messages[code], { cause });
    this.name = 'MyAcgImportError';
    this.code = code;
    this.phase = phase;
  }
}

export function classifyMyAcgImportError(error: unknown, phase: MyAcgImportPhase): MyAcgImportError {
  if (error instanceof MyAcgImportError) return error;
  if (error instanceof CloudMutationBoundaryError) return new MyAcgImportError(
    error.state === 'result-unknown' ? 'COMMIT_RESULT_UNKNOWN' : 'COMMITTED_READBACK_PENDING', phase, error);
  const value = error as { code?: unknown; message?: unknown; status?: unknown } | null;
  const code = String(value?.code ?? '');
  const message = String(value?.message ?? '');
  if (['42501', 'PGRST301', 'PGRST302'].includes(code) || [401, 403].includes(Number(value?.status))
    || /permission denied|not authorized|權限不足|沒有.*權限/iu.test(message)) {
    return new MyAcgImportError('PERMISSION_ERROR', phase, error);
  }
  const network = /fetch|network|timeout|connection|socket/iu.test(message);
  // A response-lost commit may already have succeeded. Never claim rollback or
  // automatically resend; use the existing refresh/reconciliation boundary.
  if (network || (Number(value?.status) >= 500 && !/^[0-9A-Z]{5}$/u.test(code))) {
    return new MyAcgImportError(phase === 'commit' ? 'COMMIT_RESULT_UNKNOWN' : 'NETWORK_ERROR', phase, error);
  }
  const category = phase === 'file-read' ? 'FILE_READ_ERROR' : phase === 'parse' ? 'PARSER_ERROR'
    : phase === 'validation' ? 'VALIDATION_ERROR' : phase === 'staging' ? 'CLOUD_STAGING_ERROR'
      : isCloudFieldMutationError(error) || /^[0-9A-Z]{5}$/u.test(code) ? 'CLOUD_COMMIT_ERROR'
        : 'COMMIT_RESULT_UNKNOWN';
  return new MyAcgImportError(category, phase, error);
}

/** Diagnostics deliberately omit raw rows, Postgres DETAIL, request payloads and credentials. */
export function myAcgImportDiagnostic(error: MyAcgImportError, requestId: string) {
  const cause = error.cause as { code?: unknown; message?: unknown; stack?: unknown; detail?: unknown } | null;
  const inner = cause?.detail as { code?: unknown; message?: unknown } | null;
  const message = String(cause?.message ?? inner?.message ?? '');
  const code = String(cause?.code ?? inner?.code ?? '');
  return { category: error.code, phase: error.phase, requestId,
    postgresCode: /^[0-9A-Z]{5}$/u.test(code) ? code : undefined,
    reason: /^(?:CLOUD_|REQUIRED_|VALIDATION_)[A-Z_]+$/u.test(message) ? message : undefined,
    constraint: message.match(/constraint "([a-z0-9_]+)"/iu)?.[1],
    rpc: ['commit', 'readback'].includes(error.phase) ? 'erp_apply_field_mutations' : undefined,
    serverPhase: code === '23505' ? 'INSERT' : undefined,
    stack: typeof cause?.stack === 'string' ? cause.stack.split('\n').slice(1)
      .filter(line => /^\s*at /u.test(line)).slice(0, 8).join('\n') : undefined };
}
