import type { ProductGroup } from './db';

export interface ClosingDateClearPlan {
  nextGroups: ProductGroup[];
  selectedCount: number;
  modifiedCount: number;
  alreadyEmptyCount: number;
}

export const canUseNextFieldTestClosingDateClear = (providerMode: string): boolean => providerMode === 'next';

const hasClosingDate = (group: ProductGroup): boolean => (
  typeof group.closing_date === 'string' && group.closing_date.trim().length > 0
);

export function createNextFieldTestClosingDateClearPlan(
  groups: ProductGroup[],
  selectedGroupIds: ReadonlySet<string>,
): ClosingDateClearPlan {
  const matchedIds = new Set(groups.filter(group => selectedGroupIds.has(group.id)).map(group => group.id));
  if (matchedIds.size !== selectedGroupIds.size) {
    throw new Error('選取商品已變更，請重新載入後再試。');
  }

  let modifiedCount = 0;
  let alreadyEmptyCount = 0;
  const nextGroups = groups.map(group => {
    if (!selectedGroupIds.has(group.id)) return group;
    if (!hasClosingDate(group)) {
      alreadyEmptyCount += 1;
      return group;
    }
    modifiedCount += 1;
    return { ...group, closing_date: '' };
  });

  return {
    nextGroups,
    selectedCount: matchedIds.size,
    modifiedCount,
    alreadyEmptyCount,
  };
}

export function assertNextFieldTestProductGroupsReadback(
  expectedGroups: ProductGroup[],
  actualGroups: ProductGroup[],
): void {
  if (expectedGroups.length !== actualGroups.length) {
    throw new Error('Next DB 寫入後筆數不一致。');
  }

  const actualById = new Map(actualGroups.map(group => [group.id, group]));
  for (const expected of expectedGroups) {
    const actual = actualById.get(expected.id);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Next DB 寫入後資料驗證失敗：${expected.id}`);
    }
  }
}
