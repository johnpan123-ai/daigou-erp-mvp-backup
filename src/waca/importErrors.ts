import { formatStructuredError } from '../utils/structuredError';

export type WacaStage = 'read' | 'parse' | 'validation' | 'backup' | 'commit' | 'readback';
export type WacaErrorCategory = 'BACKUP_TIMEOUT' | 'BACKUP_FAILED' | 'FILE_PARSE_ERROR' | 'VALIDATION_ERROR'
  | 'WACA_COMMIT_REJECTED' | 'WACA_COMMIT_UNKNOWN' | 'READBACK_FAILED' | 'PERMISSION_ERROR'
  | 'NETWORK_ERROR' | 'PENDING' | 'CONFLICT' | 'STALE_CONFLICT';
export type WacaUiError = { category: WacaErrorCategory; label: string; message: string;
  diagnostic?: { stage: WacaStage; code?: string; reason: string; requestId?: string; rpc?: string } };

const messages: Record<WacaErrorCategory, string> = {
  STALE_CONFLICT: 'WACA 資料已由其他操作更新，本次未提交。請重新讀取並預覽檔案。',
  BACKUP_TIMEOUT: '匯入前備份逾時，本次 WACA 尚未寫入。請稍後再試。',
  BACKUP_FAILED: '匯入前備份失敗，本次 WACA 尚未寫入。請查看技術資訊。',
  FILE_PARSE_ERROR: 'WACA Excel 解析失敗，本次尚未寫入。請確認必要欄位與檔案內容。',
  VALIDATION_ERROR: 'WACA 資料驗證未通過，本次尚未寫入。請重新預覽並確認資料。',
  WACA_COMMIT_REJECTED: 'WACA 更新被拒絕，交易已取消。請重新讀取後核對資料。',
  WACA_COMMIT_UNKNOWN: 'WACA 更新結果尚未確認。請先重新讀取並核對匯入紀錄，勿重複確認更新。',
  READBACK_FAILED: 'WACA 已保存，但雲端讀回或對帳未完成。請重新讀取並核對紀錄，勿重複確認更新。',
  PERMISSION_ERROR: 'WACA 讀取權限不足，請確認目前帳號的存取權限。',
  NETWORK_ERROR: 'WACA 雲端讀取失敗，請確認連線後重新讀取。',
  PENDING: '部分商品／規格尚待配對。',
  CONFLICT: '訂單狀態或商品對照有衝突，需要確認。',
};
const labels: Record<WacaErrorCategory, string> = {
  STALE_CONFLICT: '資料版本衝突',
  BACKUP_TIMEOUT: '備份逾時', BACKUP_FAILED: '備份失敗', FILE_PARSE_ERROR: '檔案解析失敗',
  VALIDATION_ERROR: '驗證失敗', WACA_COMMIT_REJECTED: '更新被拒絕', WACA_COMMIT_UNKNOWN: '更新結果待確認',
  READBACK_FAILED: '已保存／讀回失敗', PERMISSION_ERROR: '權限不足', NETWORK_ERROR: '連線失敗',
  PENDING: '待處理', CONFLICT: '需核對衝突',
};
export function wacaNotice(category: WacaErrorCategory, message = messages[category]): WacaUiError {
  return { category, label: labels[category], message };
}
export function classifyWacaError(cause: unknown, stage: WacaStage, requestId?: string): WacaUiError {
  const error = formatStructuredError(cause);
  const timeout = error.code === '57014' || /statement timeout|timed?\s*out|timeout|逾時/iu.test(error.message);
  const permission = ['42501', 'PGRST301', 'PGRST302'].includes(error.code ?? '')
    || /permission denied|authentication_required|owner_required/iu.test(error.message);
  const network = /fetch|network|connection|socket|offline/iu.test(error.message);
  // Phase always wins: a lost commit response is not proof of rollback, and
  // failure AFTER acknowledgment must not tell the user to resend the import.
  const category: WacaErrorCategory = (stage === 'validation' || stage === 'commit')
    && (error.code === '40001' || error.message === 'WACA_STALE_REVISION') ? 'STALE_CONFLICT'
    : stage === 'backup' ? timeout ? 'BACKUP_TIMEOUT' : 'BACKUP_FAILED'
    : stage === 'readback' ? 'READBACK_FAILED'
    : stage === 'commit' ? /^[0-9A-Z]{5}$/u.test(error.code ?? '') ? 'WACA_COMMIT_REJECTED' : 'WACA_COMMIT_UNKNOWN'
    : permission ? 'PERMISSION_ERROR' : network || timeout ? 'NETWORK_ERROR'
    : stage === 'parse' ? 'FILE_PARSE_ERROR' : 'VALIDATION_ERROR';
  // Never show raw SQL DETAIL/HINT/rows/tokens. Retain known technical reasons;
  // unknown server messages stay in the underlying provider diagnostics.
  const reason = error.code === '57014' ? 'canceling statement due to statement timeout'
    : /^[A-Z][A-Z0-9_]+(?::[A-Z0-9_-]+)?$/u.test(error.message) ? error.message : 'STRUCTURED_ERROR';
  const safeCode = /^[A-Z0-9_]{2,80}$/u.test(error.code ?? '') ? error.code : undefined;
  return { ...wacaNotice(category), diagnostic: { stage, code: safeCode, reason, requestId,
    rpc: stage === 'backup' ? 'erp_export_cloud_restore_snapshot_json'
      : stage === 'commit' ? 'erp_commit_waca_snapshot' : undefined } };
}
