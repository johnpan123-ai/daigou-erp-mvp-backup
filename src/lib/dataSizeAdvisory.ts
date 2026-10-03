export const DATA_SIZE_THRESHOLDS: Record<string, number> = {
  product_variants: 3000,
  purchase_batch_items: 5000,
  private_order_items: 3000,
  sales_order_items: 5000,
};

export const DATA_SIZE_TABLE_LABELS: Record<string, string> = {
  product_variants: '商品規格',
  purchase_batch_items: '採購批次品項',
  private_order_items: '私下登記品項',
  sales_order_items: '銷售訂單品項',
};

type UserRole = 'owner' | 'staff' | 'viewer' | 'helper' | null;

export interface DataSizeObservation {
  table: string;
  count: number;
  threshold: number;
}

function getObservations(counts: Record<string, number>): DataSizeObservation[] {
  return Object.entries(counts).flatMap(([table, count]) => {
    const threshold = DATA_SIZE_THRESHOLDS[table];
    return threshold && count >= threshold ? [{ table, count, threshold }] : [];
  });
}

let currentObservations: DataSizeObservation[] = [];
const listeners = new Set<() => void>();
export const getDataSizeObservations = (): DataSizeObservation[] => currentObservations;
export const subscribeDataSizeObservations = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function checkDataSizeWarnings(
  counts: Record<string, number>,
  role: UserRole,
): void {
  if (role !== 'owner') return;
  const observations = getObservations(counts);
  const stable = (rows: DataSizeObservation[]) => JSON.stringify(rows);
  if (stable(observations) === stable(currentObservations)) return;
  currentObservations = observations;
  listeners.forEach(listener => listener());
}
