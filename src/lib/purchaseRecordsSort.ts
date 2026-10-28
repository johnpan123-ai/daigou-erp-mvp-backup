// 訂購紀錄表排序：唯一來源，主清單與「已過結單日」區共用。
//
// 主排序鍵（結單日、發售月份、建立時間、名稱）與既有規則完全相同；只在其後
// 補上 deterministic tie-breaker（正規化名稱 → 商品群組 id）。原本相同結單日的
// 商品只靠 Array.sort 的「穩定性」維持輸入順序，而雲端 targeted cache 合併會把
// 剛被修改（例如代理商）的群組移到快取陣列尾端，造成畫面跳動。完整的鍵讓
// 同一組排序條件在儲存後、Realtime 後、重新整理後都得到相同順序。

export interface PurchaseRecordSortable {
  id: string;
  title?: string | null;
  normalized_title?: string | null;
  closing_date?: string | null;
  release_month?: string | null;
  created_at?: string | null;
}

export interface PurchaseRecordSortContext<T extends PurchaseRecordSortable> {
  sortMode: string;
  isClosed: (group: T) => boolean;
  normalizeTitle: (title: string) => string;
  parseReleaseYm: (raw: string | undefined | null) => { tier: 0 | 1 | 2; ym: number };
}

const closingKey = (group: PurchaseRecordSortable): string =>
  group.closing_date ? group.closing_date.replace(/\//g, '-') : '9999-12-31';

const codeUnitCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function comparePurchaseRecordGroups<T extends PurchaseRecordSortable>(
  a: T, b: T, context: PurchaseRecordSortContext<T>,
): number {
  const { sortMode } = context;
  let primary: number;
  if (sortMode === 'release_asc') {
    const ra = context.parseReleaseYm(a.release_month);
    const rb = context.parseReleaseYm(b.release_month);
    if (ra.tier !== rb.tier) primary = ra.tier - rb.tier;
    else if (ra.tier === 1 && ra.ym !== rb.ym) primary = ra.ym - rb.ym;
    else primary = closingKey(a).localeCompare(closingKey(b));
  } else if (sortMode === 'closing_urgent') {
    const activeA = !context.isClosed(a);
    const activeB = !context.isClosed(b);
    primary = activeA !== activeB ? (activeA ? -1 : 1) : closingKey(a).localeCompare(closingKey(b));
  } else if (sortMode === 'closing_name' || sortMode === 'closing_asc') {
    primary = closingKey(a).localeCompare(closingKey(b));
  } else {
    primary = new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  }
  if (primary !== 0 && !Number.isNaN(primary)) return primary;
  const titleA = context.normalizeTitle(a.normalized_title || a.title || '');
  const titleB = context.normalizeTitle(b.normalized_title || b.title || '');
  const title = titleA.localeCompare(titleB);
  if (title !== 0) return title;
  return codeUnitCompare(String(a.id), String(b.id));
}

/** Returns a new array; never sorts the caller's (shared) array in place. */
export function sortPurchaseRecordGroups<T extends PurchaseRecordSortable>(
  groups: readonly T[], context: PurchaseRecordSortContext<T>,
): T[] {
  return [...groups].sort((a, b) => comparePurchaseRecordGroups(a, b, context));
}
