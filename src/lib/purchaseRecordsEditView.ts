export interface PurchaseRecordsEditViewSnapshot {
  mainGroupIds: string[];
  completedGroupIds: string[];
}

export const capturePurchaseRecordsEditView = <T extends { id: string }>(
  mainGroups: readonly T[],
  completedGroups: readonly T[],
): PurchaseRecordsEditViewSnapshot => ({
  mainGroupIds: mainGroups.map(group => group.id),
  completedGroupIds: completedGroups.map(group => group.id),
});

export const resolvePurchaseRecordsEditView = <T extends { id: string }>(
  pinnedGroupIds: readonly string[],
  latestGroups: readonly T[],
): T[] => {
  const latestById = new Map(latestGroups.map(group => [group.id, group]));
  return pinnedGroupIds
    .map(id => latestById.get(id))
    .filter((group): group is T => group !== undefined);
};
