/**
 * Bumped whenever the cloud cache is invalidated or atomically replaced (authoritative reread,
 * Restore epoch change, server-committed ledger writes). Page-level return previews and saved
 * scroll positions taken under an older generation are discarded instead of being shown.
 */
let generation = 0;
export const bumpViewSnapshotGeneration = (): void => { generation += 1; };
export const getViewSnapshotGeneration = (): number => generation;
