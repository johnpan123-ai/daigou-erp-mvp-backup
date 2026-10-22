// Japan package status: presentation / operation options only. The stored status values and the receiving
// transaction's automatic transitions are unchanged (Owner decision 2026-10-21, option A).
export type JapanPackageStatusValue = 'registered' | 'arrived' | 'confirmed' | 'problem';

/** Statuses the Owner / helpers choose in daily work. */
export const DAILY_JAPAN_PACKAGE_STATUSES: readonly JapanPackageStatusValue[] = ['registered', 'confirmed'];
/** Historical statuses: still stored, displayed and filterable, but no longer offered as a daily choice. */
export const LEGACY_JAPAN_PACKAGE_STATUSES: readonly JapanPackageStatusValue[] = ['arrived', 'problem'];

export const JAPAN_PACKAGE_STATUS_LABEL: Record<JapanPackageStatusValue, string> = {
  registered: '已登記', arrived: '已到小幫手家', confirmed: '已點收', problem: '有問題',
};

export const isLegacyJapanPackageStatus = (status: string | undefined | null): boolean =>
  !!status && !DAILY_JAPAN_PACKAGE_STATUSES.includes(status as JapanPackageStatusValue);

/**
 * Options for a status selector: the daily statuses, plus the package's current status when it is a historical
 * (or unknown) value, so an existing package is never shown with a wrong / empty selection and is never converted
 * silently. Moving it forward is always an explicit choice of a daily status.
 */
export const japanPackageStatusChoices = (current: string | undefined | null): Array<{ value: string; label: string; legacy: boolean }> => {
  const daily = DAILY_JAPAN_PACKAGE_STATUSES.map(value => ({ value, label: JAPAN_PACKAGE_STATUS_LABEL[value], legacy: false }));
  if (!current || !isLegacyJapanPackageStatus(current)) return daily;
  const label = JAPAN_PACKAGE_STATUS_LABEL[current as JapanPackageStatusValue] ?? current;
  return [{ value: current, label: `${label}（舊狀態）`, legacy: true }, ...daily];
};

/** Leaving 有問題 must be a deliberate decision (it is never treated as 已點收 automatically). */
export const japanPackageStatusChangeNeedsConfirm = (from: string | undefined | null, to: string): boolean =>
  from === 'problem' && to !== 'problem';

export const japanPackageLegacyStatusChangeMessage = (from: string, to: string): string =>
  `此包裹目前為「${JAPAN_PACKAGE_STATUS_LABEL[from as JapanPackageStatusValue] ?? from}」（舊狀態，可能有待處理的問題）。\n確定改為「${JAPAN_PACKAGE_STATUS_LABEL[to as JapanPackageStatusValue] ?? to}」嗎？`;
