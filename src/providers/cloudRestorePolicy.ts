import type { ProviderMode } from './providerMode';

export const CLOUD_RESTORE_DISABLED_MESSAGE =
  '為避免正式資料在還原失敗時產生部分覆蓋，Cloud Mode 暫停直接 JSON 還原。正式資料還原請使用已驗證的 Database Backup 流程。';

export class CloudRestoreDisabledError extends Error {
  constructor() {
    super(CLOUD_RESTORE_DISABLED_MESSAGE);
    this.name = 'CloudRestoreDisabledError';
  }
}

export function isCloudRestoreDisabledMode(mode: ProviderMode): boolean {
  return mode === 'cloud' || mode === 'fallback';
}
