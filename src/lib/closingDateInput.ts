// Official closing date input rule shared by Purchase Records level 1 / level 2 (typing, paste, batch apply).
// No hard-coded year; dates that do not exist are rejected (never converted).
/** Calendar check: rejects dates that do not exist (e.g. 2/31, 2027/02/29). */
export const isExistingCalendarDate = (year: number, month: number, day: number): boolean => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
};

/** Calendar day in Asia/Taipei, independent of the browser/host timezone. */
export const currentTaipeiDate = (now: Date = new Date()): { year: number; month: number; day: number } => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  return { year: number('year'), month: number('month'), day: number('day') };
};
export const currentTaipeiYear = (now: Date = new Date()): number => currentTaipeiDate(now).year;

export type DateInputParse =
  | { kind: 'valid'; value: string; usedDefaultYear: boolean }
  | { kind: 'nonexistent' }
  | { kind: 'unrecognized' };

/**
 * Parses an official closing date as typed (YYYYMMDD, MMDD, YYYY/M/D, YYYY-M-D, M/D, M-D).
 * Shorthand without a year selects the next valid date on or after today (Asia/Taipei), so the UI
 * can show the full date before it is saved. Dates that do not exist are never converted or saved.
 */
export const parseDateInput = (value: string | null | undefined, now: Date = new Date()): DateInputParse => {
  const clean = (value ?? '').trim();
  if (clean === '') return { kind: 'unrecognized' };
  const build = (y: number, m: number, d: number, usedDefaultYear: boolean): DateInputParse => (
    isExistingCalendarDate(y, m, d)
      ? { kind: 'valid', value: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, usedDefaultYear }
      : { kind: 'nonexistent' }
  );
  const nextDate = (month: number, day: number): DateInputParse => {
    // A leap year admits every possible month/day. Reject impossible input before searching.
    if (!isExistingCalendarDate(2000, month, day)) return { kind: 'nonexistent' };
    const today = currentTaipeiDate(now);
    for (let year = today.year; year <= Math.min(today.year + 8, 9999); year++) {
      if (year === today.year && (month < today.month || (month === today.month && day < today.day))) continue;
      if (isExistingCalendarDate(year, month, day)) return build(year, month, day, true);
    }
    return { kind: 'nonexistent' };
  };
  const yyyymmdd = clean.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (yyyymmdd) return build(Number(yyyymmdd[1]), Number(yyyymmdd[2]), Number(yyyymmdd[3]), false);
  const mmdd = clean.match(/^(\d{2})(\d{2})$/);
  if (mmdd) return nextDate(Number(mmdd[1]), Number(mmdd[2]));
  const full = clean.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (full) return build(Number(full[1]), Number(full[2]), Number(full[3]), false);
  const partial = clean.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (partial) return nextDate(Number(partial[1]), Number(partial[2]));
  return { kind: 'unrecognized' };
};

export const normalizeDateInput = (value: string | null | undefined, now: Date = new Date()): string | null => {
  const parsed = parseDateInput(value, now);
  return parsed.kind === 'valid' ? parsed.value : null;
};

/** Purchase-date paste keeps its existing current-year meaning; only closing dates roll forward. */
export const normalizePurchaseDateInput = (value: string | null | undefined, now: Date = new Date()): string | null => {
  const clean = (value ?? '').trim();
  const shorthand = clean.match(/^(\d{1,2})[/-](\d{1,2})$/) ?? clean.match(/^(\d{2})(\d{2})$/);
  return normalizeDateInput(shorthand ? `${currentTaipeiYear(now)}/${shorthand[1]}/${shorthand[2]}` : clean, now);
};
