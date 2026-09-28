/** One registry owns the compatibility boundary for local ERP JSON backups. */
import { DASHBOARD_IMAGE_CATEGORY_KEYS } from '../lib/dashboardImageCategories';

export const WORKBENCH_BACKUP_FORMAT_VERSION = 2 as const;

export const WACA_BACKUP_COLLECTIONS = [
  'wacaOrders', 'wacaItems', 'wacaMappings', 'wacaImportBatches',
  'myacgMasterLinks', 'wacaCutoverAudit',
] as const;

export type WacaCutoverMode =
  | 'LEGACY_QUANTITY_ACTIVE'
  | 'ORDER_REBASELINE_REQUIRED'
  | 'ORDER_DRIVEN_ACTIVE';

export interface WacaCutoverState {
  mode: WacaCutoverMode;
  updatedAt: string;
  sourceBackupFormatVersion: number | null;
}

export type WorkbenchBackupKind = 'legacy-pre-waca' | 'waca-unversioned' | 'waca-v2';

export interface DashboardImageBackupRow { categoryKey: string; dataUrl: string }

export function validateDashboardImageBackup(value: unknown): DashboardImageBackupRow[] {
  if (!Array.isArray(value) || value.length !== DASHBOARD_IMAGE_CATEGORY_KEYS.length) {
    throw new Error('新版備份的首頁圖片資料不完整，已取消還原。');
  }
  const rows = value as DashboardImageBackupRow[];
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !DASHBOARD_IMAGE_CATEGORY_KEYS.includes(row.categoryKey as typeof DASHBOARD_IMAGE_CATEGORY_KEYS[number])
      || typeof row.dataUrl !== 'string' || keys.has(row.categoryKey)) {
      throw new Error('新版備份的首頁圖片資料無效，已取消還原。');
    }
    keys.add(row.categoryKey);
  }
  return rows;
}

export function classifyWorkbenchBackup(data: Record<string, unknown>): WorkbenchBackupKind {
  const present = WACA_BACKUP_COLLECTIONS.filter(name => Object.hasOwn(data, name));
  if (data.backupFormatVersion === WORKBENCH_BACKUP_FORMAT_VERSION) {
    if (present.length !== WACA_BACKUP_COLLECTIONS.length) {
      throw new Error('新版備份缺少 WACA 訂單資料，已取消還原。');
    }
    if (!Array.isArray(data.wacaCutoverState) || data.wacaCutoverState.length !== 1) {
      throw new Error('新版備份缺少 WACA 數量來源狀態，已取消還原。');
    }
    for (const key of ['deadlineVerifiedMappings', 'deadlineApplyBatches', 'deadlineApplyItems']) {
      if (!Array.isArray(data[key])) throw new Error(`新版備份缺少期限對照資料 ${key}，已取消還原。`);
    }
    validateDashboardImageBackup(data.dashboardCategoryImages);
    if (!['LEGACY_QUANTITY_ACTIVE', 'ORDER_REBASELINE_REQUIRED', 'ORDER_DRIVEN_ACTIVE']
      .includes(String((data.wacaCutoverState[0] as Record<string, unknown>)?.mode))) {
      throw new Error('新版備份的 WACA 數量來源狀態無效。');
    }
    return 'waca-v2';
  }
  if (data.backupFormatVersion !== undefined) throw new Error('不支援此版本的 JSON 備份。');
  if (present.length === 0) return 'legacy-pre-waca';
  if (present.length === WACA_BACKUP_COLLECTIONS.length) return 'waca-unversioned';
  throw new Error('備份中的 WACA 訂單資料不完整，已取消還原。');
}

export function legacyCutoverState(kind: Exclude<WorkbenchBackupKind, 'waca-v2'>,
  data: Record<string, unknown>): WacaCutoverState {
  const audited = kind === 'waca-unversioned'
    && Array.isArray(data.wacaCutoverAudit) && data.wacaCutoverAudit.length > 0;
  return {
    mode: audited ? 'ORDER_DRIVEN_ACTIVE' : 'ORDER_REBASELINE_REQUIRED',
    updatedAt: new Date().toISOString(),
    sourceBackupFormatVersion: null,
  };
}
