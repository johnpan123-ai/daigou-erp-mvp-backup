export const CLOUD_STALE_WRITE_MESSAGE = '資料已被其他使用者更新，請重新載入最新資料後再編輯。';

export class CloudStaleWriteError extends Error {
  constructor(message = CLOUD_STALE_WRITE_MESSAGE) {
    super(message);
    this.name = 'CloudStaleWriteError';
  }
}

export interface VersionedSnapshot {
  id: string;
  version?: number;
  updated_at?: string;
}

export const assertSnapshotVersion = (
  expected: VersionedSnapshot,
  current: VersionedSnapshot | null,
): void => {
  if (!current) throw new CloudStaleWriteError();
  if (typeof expected.version === 'number') {
    if (current.version !== expected.version) throw new CloudStaleWriteError();
    return;
  }
  if (expected.updated_at && current.updated_at !== expected.updated_at) {
    throw new CloudStaleWriteError();
  }
  if (!expected.updated_at) {
    throw new CloudStaleWriteError('缺少資料版本，請先重新載入後再儲存。');
  }
};

export interface OptimisticUpdateAdapter<Row extends VersionedSnapshot> {
  read: (id: string) => Promise<Row | null>;
  compareAndSet: (id: string, expectedVersion: number, patch: Partial<Row>) => Promise<Row | null>;
}

export async function optimisticUpdate<Row extends VersionedSnapshot>(
  adapter: OptimisticUpdateAdapter<Row>,
  snapshot: Row,
  patch: Partial<Row>,
): Promise<Row> {
  const current = await adapter.read(snapshot.id);
  assertSnapshotVersion(snapshot, current);
  if (typeof snapshot.version !== 'number') throw new CloudStaleWriteError('缺少資料版本，請先重新載入後再儲存。');
  const updated = await adapter.compareAndSet(snapshot.id, snapshot.version, patch);
  if (!updated) throw new CloudStaleWriteError();
  return updated;
}
