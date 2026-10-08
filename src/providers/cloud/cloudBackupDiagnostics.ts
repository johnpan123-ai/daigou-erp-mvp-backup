import { formatStructuredError } from '../../utils/structuredError';

export type BackupPhase = 'RPC_REQUEST' | 'MANIFEST_AND_CHECKSUMS' | 'DEADLINE_SIDECAR' | 'DOWNLOAD_PREPARATION' | 'COMPLETE';
export type BackupErrorCode = 'BACKUP_STATEMENT_TIMEOUT' | 'BACKUP_SERVER_ERROR' | 'BACKUP_PERMISSION_ERROR' | 'BACKUP_VALIDATION_ERROR' | 'BACKUP_NETWORK_ERROR' | 'BACKUP_CLIENT_PARSE_ERROR';
export interface CloudBackupDiagnostic {
  requestId: string;
  rpc: string;
  startedAt: string;
  phase: BackupPhase;
  elapsedMs: number;
  httpStatus: number | null;
  sqlstate: string | null;
  code?: BackupErrorCode;
  timingsMs: Partial<Record<BackupPhase, number>>;
  resourceCount?: number;
  totalRows?: number;
  downloadBytes?: number;
  snapshotFingerprint?: string;
  relationshipHash?: string;
}

const messages: Record<BackupErrorCode, string> = {
  BACKUP_STATEMENT_TIMEOUT: '雲端備份查詢逾時，本次沒有修改任何資料。',
  BACKUP_SERVER_ERROR: '雲端備份服務失敗，本次沒有修改任何資料。',
  BACKUP_PERMISSION_ERROR: '目前權限無法執行雲端備份，本次沒有修改任何資料。',
  BACKUP_VALIDATION_ERROR: '備份完整性驗證失敗，未產生可用備份；本次沒有修改任何資料。',
  BACKUP_NETWORK_ERROR: '備份連線中斷，本次沒有修改任何資料。',
  BACKUP_CLIENT_PARSE_ERROR: '備份回應解析失敗，本次沒有修改任何資料。',
};

// Ephemeral metadata only: no rows, credentials, server DETAIL/HINT, or durable storage.
let lastDiagnostic: CloudBackupDiagnostic | null = null;
export function getCloudBackupDiagnostic(): CloudBackupDiagnostic | null {
  return lastDiagnostic ? { ...lastDiagnostic, timingsMs: { ...lastDiagnostic.timingsMs } } : null;
}
export function recordCloudBackupDiagnostic(value: CloudBackupDiagnostic): void {
  lastDiagnostic = { ...value, timingsMs: { ...value.timingsMs } };
}
export class CloudBackupError extends Error {
  readonly code: BackupErrorCode;
  readonly diagnostic: CloudBackupDiagnostic;
  constructor(diagnostic: CloudBackupDiagnostic, code: BackupErrorCode) {
    super(messages[code]);
    this.name = 'CloudBackupError';
    this.code = code;
    this.diagnostic = diagnostic;
  }
}
export function classifyCloudBackupError(error: unknown, diagnostic: CloudBackupDiagnostic): CloudBackupError {
  if (error instanceof CloudBackupError) return error;
  const parsed = formatStructuredError(error);
  const code = parsed.code ?? '';
  const text = parsed.message ?? '';
  const sqlstate = /^[0-9A-Z]{5}$/.test(code) ? code : null;
  let category: BackupErrorCode;
  if (code === '57014' || /statement timeout/i.test(text)) category = 'BACKUP_STATEMENT_TIMEOUT';
  else if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403 || /^(42501|PGRST30[12])$/.test(code) || /permission denied|owner.required|unauthori[sz]ed/i.test(text)) category = 'BACKUP_PERMISSION_ERROR';
  else if (error instanceof SyntaxError || /invalid json|json.*pars|unexpected.*json/i.test(text)) category = 'BACKUP_CLIENT_PARSE_ERROR';
  else if (/fetch|network|abort|connection|failed to load/i.test(text)) category = 'BACKUP_NETWORK_ERROR';
  else if (diagnostic.phase !== 'RPC_REQUEST' || /SNAPSHOT_INVALID|VALIDATION|MANIFEST|CHECKSUM/.test(code + text)) category = 'BACKUP_VALIDATION_ERROR';
  else category = 'BACKUP_SERVER_ERROR';
  const safe = { ...diagnostic, sqlstate, code: category, timingsMs: { ...diagnostic.timingsMs } };
  recordCloudBackupDiagnostic(safe);
  return new CloudBackupError(safe, category);
}
