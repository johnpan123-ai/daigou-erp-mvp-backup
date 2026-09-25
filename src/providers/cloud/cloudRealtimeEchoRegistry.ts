const localEchoes = new Map<string, number>();
const DEFAULT_TTL_MS = 10_000;

const keyOf = (table: string, id: string) => `${table}:${id}`;

export const markLocalCloudWrite = (table: string, ids: string[], ttlMs = DEFAULT_TTL_MS): void => {
  const expiresAt = Date.now() + ttlMs;
  ids.filter(Boolean).forEach(id => localEchoes.set(keyOf(table, id), expiresAt));
};

export const consumeLocalCloudEcho = (table: string, id: string): boolean => {
  const key = keyOf(table, id);
  const expiresAt = localEchoes.get(key);
  localEchoes.delete(key);
  return typeof expiresAt === 'number' && expiresAt >= Date.now();
};

export const consumeLocalCloudEchoAliases = (table: string, ids: string[]): boolean => {
  for (const id of [...new Set(ids.filter(Boolean))]) {
    if (consumeLocalCloudEcho(table, id)) return true;
  }
  return false;
};

export const clearLocalCloudWrites = (table: string, ids: string[]): void => {
  ids.filter(Boolean).forEach(id => localEchoes.delete(keyOf(table, id)));
};

export const clearExpiredLocalCloudEchoes = (): void => {
  const now = Date.now();
  for (const [key, expiresAt] of localEchoes) {
    if (expiresAt < now) localEchoes.delete(key);
  }
};
