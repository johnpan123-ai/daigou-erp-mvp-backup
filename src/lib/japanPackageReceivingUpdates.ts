// Shared by the Cloud request builder and the Local provider (one rule for both data layers).
export const JAPAN_PACKAGE_RECEIVING_NO_CHANGE = 'JAPAN_PACKAGE_RECEIVING_NO_CHANGE';

type ReceivingUpdate = { itemId: string; checked: boolean; checkedAt?: string };
/** Receiving updates that actually change an item's checked state (unknown items are kept so the base check fails closed). */
export const changedReceivingUpdates = <T extends ReceivingUpdate>(
  items: ReadonlyArray<{ id: string; checked?: boolean | null }>,
  updates: readonly T[],
): T[] => {
  const byId = new Map(items.map(item => [item.id, item]));
  return updates.filter(update => {
    const item = byId.get(update.itemId);
    return !item || Boolean(item.checked) !== update.checked;
  });
};
