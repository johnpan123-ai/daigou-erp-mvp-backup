import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, ExternalLink, History, RefreshCcw, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ProductGroup, PurchaseBatch, PurchaseBatchItem } from '../lib/db';
import { dataProvider } from '../providers/dataProvider';

type DateFilter = 'today' | 'yesterday' | '7d' | '30d';

interface RecentPurchaseRow {
  dateKey: string;
  group: ProductGroup;
  totalQuantity: number;
  batchCount: number;
  lastPurchaseAt: number;
}

interface RecentPurchaseSection {
  dateKey: string;
  rows: RecentPurchaseRow[];
}

const TAIPEI_TIME_ZONE = 'Asia/Taipei';

const getPurchaseBatchTimestamp = (batch: PurchaseBatch): number => {
  const createdAt = Date.parse(batch.created_at || '');
  if (Number.isFinite(createdAt)) return createdAt;

  const normalizedDate = (batch.date || '').trim().replace(/\//g, '-');
  const purchaseDate = Date.parse(`${normalizedDate}T00:00:00+08:00`);
  return Number.isFinite(purchaseDate) ? purchaseDate : 0;
};

const getTaipeiDateKey = (timestamp: number): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TAIPEI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const shiftDateKey = (dateKey: string, days: number): string => {
  const timestamp = Date.parse(`${dateKey}T00:00:00+08:00`) + days * 86_400_000;
  return getTaipeiDateKey(timestamp);
};

const formatDateHeading = (dateKey: string, todayKey: string): string => {
  const dateText = dateKey.replace(/-/g, '/');
  if (dateKey === todayKey) return `${dateText}｜今天`;
  if (dateKey === shiftDateKey(todayKey, -1)) return `${dateText}｜昨天`;
  return dateText;
};

const formatPurchaseTime = (timestamp: number): string => {
  if (timestamp <= 0) return '-';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TAIPEI_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
};

const dateFilterOptions: Array<{ value: DateFilter; label: string }> = [
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨天' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
];

export default function RecentPurchases() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [batches, setBatches] = useState<PurchaseBatch[]>([]);
  const [batchItems, setBatchItems] = useState<PurchaseBatchItem[]>([]);
  const [dateFilter, setDateFilter] = useState<DateFilter>('7d');
  const [expandedDateKeys, setExpandedDateKeys] = useState<Set<string>>(() => new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [onlyWithOfficialSite, setOnlyWithOfficialSite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const loadData = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [nextGroups, nextBatches, nextBatchItems] = await Promise.all([
        dataProvider.getProductGroups(),
        dataProvider.getPurchaseBatches(),
        dataProvider.getPurchaseBatchItems(),
      ]);
      setGroups(nextGroups);
      setBatches(nextBatches);
      setBatchItems(nextBatchItems);
    } catch (error) {
      console.error('[RecentPurchases] Failed to load recent purchase data:', error);
      setLoadError('近期採購資料載入失敗，請重新整理或重試。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    setExpandedDateKeys(new Set());
  }, [dateFilter]);

  const toggleDateSection = (dateKey: string) => {
    setExpandedDateKeys(current => {
      const next = new Set(current);
      if (next.has(dateKey)) {
        next.delete(dateKey);
      } else {
        next.add(dateKey);
      }
      return next;
    });
  };

  const todayKey = getTaipeiDateKey(Date.now());

  const allRows = useMemo(() => {
    const groupById = new Map(groups.map(group => [group.id, group]));
    const itemsByBatchId = new Map<string, PurchaseBatchItem[]>();

    for (const item of batchItems) {
      const existing = itemsByBatchId.get(item.purchase_batch_id);
      if (existing) existing.push(item);
      else itemsByBatchId.set(item.purchase_batch_id, [item]);
    }

    const rowsByDateAndGroup = new Map<string, RecentPurchaseRow & { batchIds: Set<string> }>();

    for (const batch of batches) {
      const group = groupById.get(batch.product_group_id);
      const items = itemsByBatchId.get(batch.id) ?? [];
      const timestamp = getPurchaseBatchTimestamp(batch);
      if (!group || items.length === 0 || timestamp <= 0) continue;

      const dateKey = getTaipeiDateKey(timestamp);
      const aggregateKey = `${dateKey}::${group.id}`;
      const quantity = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      const existing = rowsByDateAndGroup.get(aggregateKey);

      if (existing) {
        existing.totalQuantity += quantity;
        existing.batchIds.add(batch.id);
        existing.batchCount = existing.batchIds.size;
        existing.lastPurchaseAt = Math.max(existing.lastPurchaseAt, timestamp);
      } else {
        rowsByDateAndGroup.set(aggregateKey, {
          dateKey,
          group,
          totalQuantity: quantity,
          batchCount: 1,
          batchIds: new Set([batch.id]),
          lastPurchaseAt: timestamp,
        });
      }
    }

    return Array.from(rowsByDateAndGroup.values()).map(({ batchIds: _batchIds, ...row }) => row);
  }, [groups, batches, batchItems]);

  const sections = useMemo<RecentPurchaseSection[]>(() => {
    const search = searchTerm.trim().toLocaleLowerCase('zh-TW');
    const yesterdayKey = shiftDateKey(todayKey, -1);
    const start7Key = shiftDateKey(todayKey, -6);
    const start30Key = shiftDateKey(todayKey, -29);

    const filteredRows = allRows.filter(row => {
      const inDateRange = dateFilter === 'today'
        ? row.dateKey === todayKey
        : dateFilter === 'yesterday'
          ? row.dateKey === yesterdayKey
          : dateFilter === '7d'
            ? row.dateKey >= start7Key && row.dateKey <= todayKey
            : row.dateKey >= start30Key && row.dateKey <= todayKey;

      if (!inDateRange) return false;
      if (onlyWithOfficialSite && !row.group.product_url) return false;
      if (!search) return true;

      const title = `${row.group.normalized_title || ''} ${row.group.title || ''}`.toLocaleLowerCase('zh-TW');
      return title.includes(search);
    });

    const rowsByDate = new Map<string, RecentPurchaseRow[]>();
    for (const row of filteredRows) {
      const rows = rowsByDate.get(row.dateKey);
      if (rows) rows.push(row);
      else rowsByDate.set(row.dateKey, [row]);
    }

    return Array.from(rowsByDate.entries())
      .sort(([dateA], [dateB]) => dateB.localeCompare(dateA))
      .map(([dateKey, rows]) => ({
        dateKey,
        rows: rows.sort((a, b) => {
          if (b.lastPurchaseAt !== a.lastPurchaseAt) return b.lastPurchaseAt - a.lastPurchaseAt;
          return (a.group.normalized_title || a.group.title).localeCompare(b.group.normalized_title || b.group.title, 'zh-TW');
        }),
      }));
  }, [allRows, dateFilter, onlyWithOfficialSite, searchTerm, todayKey]);

  const visibleProductCount = sections.reduce((sum, section) => sum + section.rows.length, 0);
  const visibleQuantity = sections.reduce(
    (sum, section) => sum + section.rows.reduce((sectionSum, row) => sectionSum + row.totalQuantity, 0),
    0,
  );

  const openProductDetail = (groupId: string) => {
    navigate(`/purchase-records/${groupId}`, { state: { from: '/recent-purchases' } });
  };

  return (
    <div data-testid="recent-purchases-page" style={{ width: '100%', maxWidth: '1500px', margin: '0 auto', paddingBottom: '40px' }}>
      <style>{`
        .recent-purchases-filter-button {
          height: 36px;
          padding: 0 14px;
          border-radius: 8px;
          border: 1px solid #cbd5e1;
          background: #fff;
          color: #475569;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }
        .recent-purchases-filter-button.active {
          border-color: #2563eb;
          background: #2563eb;
          color: #fff;
        }
        .recent-purchases-table {
          width: 100%;
          min-width: 760px;
          border-collapse: collapse;
          table-layout: fixed;
        }
        .recent-purchases-table th {
          padding: 9px 14px;
          background: #f8fafc;
          color: #64748b;
          font-size: 12px;
          font-weight: 700;
          text-align: left;
          border-bottom: 1px solid #e2e8f0;
          white-space: nowrap;
        }
        .recent-purchases-table td {
          padding: 10px 14px;
          border-bottom: 1px solid #edf2f7;
          color: #334155;
          font-size: 13px;
          vertical-align: middle;
        }
        .recent-purchases-table tbody tr:last-child td { border-bottom: 0; }
        .recent-purchases-table tbody tr:hover { background: #f8fbff; }
        .recent-purchase-product-button {
          min-width: 0;
          flex: 1 1 auto;
          padding: 0;
          border: 0;
          background: transparent;
          color: #0f172a;
          font-size: 14px;
          font-weight: 700;
          line-height: 1.45;
          text-align: left;
          cursor: pointer;
        }
        .recent-purchase-agent-badge {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          min-height: 22px;
          padding: 2px 8px;
          border: 1px solid #fed7aa;
          border-radius: 999px;
          background: #fff7ed;
          color: #9a3412;
          font-size: 12px;
          font-weight: 700;
          white-space: nowrap;
        }
        @media (max-width: 720px) {
          .recent-purchases-page-header { align-items: flex-start !important; flex-direction: column; }
          .recent-purchases-toolbar { align-items: stretch !important; }
          .recent-purchases-search { flex-basis: 100%; max-width: none !important; }
        }
      `}</style>

      <header className="recent-purchases-page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', marginBottom: '18px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#0f172a', fontSize: '26px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <History size={26} color="#2563eb" />
            近期採購
          </h1>
          <p style={{ margin: '7px 0 0', color: '#64748b', fontSize: '13px' }}>
            唯讀彙總近期採購紀錄；原始採購批次與明細不會被合併或修改。
          </p>
        </div>
        <div style={{ color: '#475569', fontSize: '13px', fontWeight: 600 }}>
          {visibleProductCount} 項商品・採購 {visibleQuantity} 件
        </div>
      </header>

      <div className="recent-purchases-toolbar" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px', padding: '14px', marginBottom: '16px', border: '1px solid #e2e8f0', borderRadius: '12px', background: '#fff' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px' }}>
          {dateFilterOptions.map(option => (
            <button
              key={option.value}
              type="button"
              data-testid={`recent-purchases-filter-${option.value}`}
              className={`recent-purchases-filter-button ${dateFilter === option.value ? 'active' : ''}`}
              aria-pressed={dateFilter === option.value}
              onClick={() => setDateFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="recent-purchases-search" style={{ height: '36px', minWidth: '220px', maxWidth: '420px', flex: '1 1 260px', display: 'flex', alignItems: 'center', gap: '8px', padding: '0 11px', border: '1px solid #cbd5e1', borderRadius: '8px', background: '#f8fafc' }}>
          <Search size={16} color="#64748b" />
          <input
            data-testid="recent-purchases-search"
            aria-label="搜尋近期採購商品"
            value={searchTerm}
            onChange={event => setSearchTerm(event.target.value)}
            placeholder="搜尋商品名稱"
            style={{ width: '100%', border: 0, outline: 0, background: 'transparent', color: '#334155', fontSize: '13px' }}
          />
        </label>

        <label style={{ minHeight: '36px', display: 'flex', alignItems: 'center', gap: '8px', color: '#334155', fontSize: '13px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input
            data-testid="recent-purchases-only-official"
            type="checkbox"
            checked={onlyWithOfficialSite}
            onChange={event => setOnlyWithOfficialSite(event.target.checked)}
            style={{ width: '16px', height: '16px', margin: 0, accentColor: '#2563eb' }}
          />
          只看有官網
        </label>
      </div>

      {loading ? (
        <div style={{ padding: '80px 20px', textAlign: 'center', color: '#64748b' }}>載入近期採購資料中…</div>
      ) : loadError ? (
        <div style={{ padding: '28px', border: '1px solid #fecaca', borderRadius: '12px', background: '#fff7f7', color: '#991b1b', textAlign: 'center' }}>
          <div>{loadError}</div>
          <button type="button" onClick={() => void loadData()} style={{ marginTop: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }} className="btn">
            <RefreshCcw size={15} /> 重新載入
          </button>
        </div>
      ) : sections.length === 0 ? (
        <div style={{ padding: '80px 20px', border: '1px solid #e2e8f0', borderRadius: '12px', background: '#fff', textAlign: 'center', color: '#64748b' }}>
          目前篩選條件下沒有採購紀錄。
        </div>
      ) : (
        <div data-testid="recent-purchases-sections" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {sections.map(section => {
            const sectionQuantity = section.rows.reduce((sum, row) => sum + row.totalQuantity, 0);
            const isExpanded = expandedDateKeys.has(section.dateKey);
            const contentId = `recent-purchases-date-content-${section.dateKey}`;
            return (
              <section key={section.dateKey} data-testid="recent-purchases-date-section" data-date={section.dateKey} style={{ border: '1px solid #e2e8f0', borderRadius: '12px', background: '#fff', overflow: 'hidden' }}>
                <button
                  type="button"
                  data-testid="recent-purchases-date-toggle"
                  aria-expanded={isExpanded}
                  aria-controls={contentId}
                  onClick={() => toggleDateSection(section.dateKey)}
                  style={{ width: '100%', minHeight: '44px', padding: '9px 14px', border: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: '#eff6ff', cursor: 'pointer', textAlign: 'left' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
                    {isExpanded ? <ChevronDown size={16} color="#1e3a8a" /> : <ChevronRight size={16} color="#1e3a8a" />}
                    <strong style={{ color: '#1e3a8a', fontSize: '15px' }}>{formatDateHeading(section.dateKey, todayKey)}</strong>
                  </span>
                  <span style={{ color: '#64748b', fontSize: '12px', fontWeight: 600 }}>{section.rows.length} 項・{sectionQuantity} 件</span>
                </button>
                {isExpanded && <div id={contentId} data-testid="recent-purchases-date-content" style={{ width: '100%', overflowX: 'auto', borderTop: '1px solid #dbeafe' }}>
                  <table className="recent-purchases-table">
                    <colgroup>
                      <col />
                      <col style={{ width: '130px' }} />
                      <col style={{ width: '110px' }} />
                      <col style={{ width: '130px' }} />
                      <col style={{ width: '80px' }} />
                      <col style={{ width: '80px' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>商品名稱</th>
                        <th>當日採購數量</th>
                        <th>採購批次數</th>
                        <th>最後採購時間</th>
                        <th>官網</th>
                        <th>查看</th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.rows.map(row => (
                        <tr
                          key={`${section.dateKey}::${row.group.id}`}
                          data-testid="recent-purchase-row"
                          data-date={section.dateKey}
                          data-group-id={row.group.id}
                          data-quantity={row.totalQuantity}
                          data-batch-count={row.batchCount}
                          data-last-purchase-at={row.lastPurchaseAt}
                        >
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                              <button
                                type="button"
                                data-testid="recent-purchase-product"
                                className="recent-purchase-product-button"
                                onClick={() => openProductDetail(row.group.id)}
                              >
                                {row.group.normalized_title || row.group.title}
                              </button>
                              {row.group.proxy_agent?.trim() && (
                                <span data-testid="recent-purchase-agent" className="recent-purchase-agent-badge">
                                  {row.group.proxy_agent.trim()}
                                </span>
                              )}
                            </div>
                          </td>
                          <td><strong style={{ color: '#1d4ed8', fontSize: '15px' }}>×{row.totalQuantity}</strong></td>
                          <td>{row.batchCount} 批</td>
                          <td>{formatPurchaseTime(row.lastPurchaseAt)}</td>
                          <td>
                            {row.group.product_url && (
                              <a
                                data-testid="recent-purchase-official-link"
                                href={row.group.product_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="開啟商品官網"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#2563eb', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}
                              >
                                官網 <ExternalLink size={13} />
                              </a>
                            )}
                          </td>
                          <td>
                            <button
                              type="button"
                              data-testid="recent-purchase-view"
                              onClick={() => openProductDetail(row.group.id)}
                              style={{ padding: 0, border: 0, background: 'transparent', color: '#2563eb', fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                            >
                              查看 <ArrowRight size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
