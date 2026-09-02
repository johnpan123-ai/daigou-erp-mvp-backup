export const DATA_SIZE_THRESHOLDS: Record<string, number> = {
  product_variants: 3000,
  purchase_batch_items: 5000,
  private_order_items: 3000,
  sales_order_items: 5000,
};

const DATA_SIZE_ADVISORY_SESSION_KEY = 'erp:data-size-advisory-shown:v1';
const DATA_SIZE_ADVISORY_ID = 'erp-data-size-advisory';

const TABLE_LABELS: Record<string, string> = {
  product_variants: '商品規格',
  purchase_batch_items: '採購批次品項',
  private_order_items: '私下登記品項',
  sales_order_items: '銷售訂單品項',
};

let dataSizeAdvisoryShown = false;

type UserRole = 'owner' | 'staff' | 'viewer' | 'helper' | null;

interface DataSizeObservation {
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

function wasShownInThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(DATA_SIZE_ADVISORY_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markShownInThisSession(): void {
  try {
    window.sessionStorage.setItem(DATA_SIZE_ADVISORY_SESSION_KEY, '1');
  } catch {
    // A restricted browser context may disable sessionStorage. The in-memory guard
    // still prevents repeated notices during the current runtime.
  }
}

function showNonBlockingAdvisory(message: string): void {
  if (typeof document === 'undefined' || document.getElementById(DATA_SIZE_ADVISORY_ID)) return;

  const notice = document.createElement('div');
  notice.id = DATA_SIZE_ADVISORY_ID;
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.textContent = message;
  Object.assign(notice.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '10000',
    maxWidth: 'min(440px, calc(100vw - 32px))',
    padding: '12px 14px',
    border: '1px solid #bfdbfe',
    borderLeft: '4px solid #3b82f6',
    borderRadius: '10px',
    background: '#eff6ff',
    color: '#1e3a5f',
    boxShadow: '0 10px 28px rgba(15, 23, 42, 0.16)',
    fontSize: '14px',
    lineHeight: '1.5',
    whiteSpace: 'pre-line',
    pointerEvents: 'none',
  });
  document.body.appendChild(notice);

  window.setTimeout(() => notice.remove(), 12_000);
}

export function checkDataSizeWarnings(
  counts: Record<string, number>,
  role: UserRole,
): void {
  const observations = getObservations(counts);
  if (observations.length === 0) return;

  const diagnostic = observations
    .map(({ table, count, threshold }) => `${table}: ${count} / ${threshold}`)
    .join('\n');
  console.warn(`[Data Size Advisory] 資料量已達效能觀察值，系統仍可正常使用:\n${diagnostic}`);

  // This operational notice is intended for the owner, not regular ERP users.
  if (role !== 'owner' || dataSizeAdvisoryShown || wasShownInThisSession()) return;

  dataSizeAdvisoryShown = true;
  markShownInThisSession();
  const message = observations
    .map(({ table, count, threshold }) =>
      `${TABLE_LABELS[table] || table}資料量已超過目前效能觀察值（${count} / ${threshold}），系統仍可正常使用。`,
    )
    .join('\n');
  showNonBlockingAdvisory(`${message}\n建議管理員後續檢查載入效能。`);
}
