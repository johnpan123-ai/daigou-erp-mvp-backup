import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Archive, ChevronRight, Clock3, RefreshCw, ShoppingCart } from 'lucide-react';
import { calculateGroupDemandAndPurchased } from '../lib/db';
import type {
  InventoryItem,
  PrivateOrder,
  PrivateOrderItem,
  ProductCategory,
  ProductGroup,
  ProductVariant,
  PurchaseBatch,
  PurchaseBatchItem,
  SalesOrderItem,
} from '../lib/db';
import {
  buildProductDisplayCategoryMap,
  getPendingUnlistedGroupIds,
  normalizeDashboardWorkTitle,
  type ProductDisplayCategory,
  type UnlistedProcessedSnapshot,
} from '../lib/dashboardDailyWork';
import { mapPrivateOrderItemsByGroup, mapPurchaseBatchItemsByGroup } from '../lib/purchaseBatchScope';
import { dataProvider } from '../providers/dataProvider';

const UPCOMING_WINDOW_DAYS = 7;
const UNLISTED_PROCESSED_STORAGE_KEY = 'erp_unlisted_processed_local';

interface WorkQueueItem {
  group: ProductGroup;
  targetDate: string;
  diffDays: number | null;
  demand: number;
  purchased: number;
  gap: number;
}

type WorkQueueKey = 'unlisted' | 'upcoming' | 'overdue' | 'unordered';
type UnorderedCategoryFilter = 'all' | ProductDisplayCategory;

const normalizeDate = (value?: string | null): string => {
  if (!value) return '';
  const match = value.trim().replace(/\//g, '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return '';
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
};

const localToday = (): string => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const daysFromToday = (date: string, today: string): number => {
  const toLocalDate = (value: string) => {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  };
  return Math.round((toLocalDate(date).getTime() - toLocalDate(today).getTime()) / 86_400_000);
};

const readUnlistedProcessedSnapshot = (): UnlistedProcessedSnapshot | null => {
  try {
    const raw = localStorage.getItem(UNLISTED_PROCESSED_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UnlistedProcessedSnapshot;
    return Array.isArray(parsed.processed_group_ids) ? parsed : null;
  } catch {
    return null;
  }
};

function WorkQueueSection({
  id,
  title,
  description,
  tone,
  items,
  emptyText,
  onOpenItem,
  onViewAll,
}: {
  id: string;
  title: string;
  description: string;
  tone: 'indigo' | 'amber' | 'red' | 'blue';
  items: WorkQueueItem[];
  emptyText: string;
  onOpenItem: (groupId: string) => void;
  onViewAll?: () => void;
}) {
  const visibleItems = onViewAll ? items.slice(0, 10) : items;

  return (
    <section id={id} className={`work-queue work-queue-${tone}`} data-dashboard-queue={id}>
      <div className="work-queue-header">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {onViewAll && (
          <button type="button" className="view-all-button" onClick={onViewAll}>
            前往處理 <ChevronRight size={17} />
          </button>
        )}
      </div>

      {visibleItems.length === 0 ? (
        <div className="work-queue-empty">{emptyText}</div>
      ) : (
        <div className="work-queue-list">
          {visibleItems.map(item => (
            <button
              type="button"
              className="work-queue-row"
              key={item.group.id}
              onClick={() => onOpenItem(item.group.id)}
            >
              <div className="work-item-main">
                <strong>{normalizeDashboardWorkTitle(item.group.title || '') || '未命名商品'}</strong>
                <span>{item.targetDate ? `結單 ${item.targetDate}` : '未設定結單日'}</span>
              </div>
              <div className="work-item-metrics">
                {item.diffDays !== null && (
                  <span className="work-date-status">
                    {item.diffDays < 0 ? `已過期 ${Math.abs(item.diffDays)} 天` : item.diffDays === 0 ? '今天結單' : `剩 ${item.diffDays} 天`}
                  </span>
                )}
                <span>需求 {item.demand}</span>
                <span>已採購 {item.purchased}</span>
                <span className="work-gap">尚缺 {item.gap}</span>
                <ChevronRight size={18} aria-hidden="true" />
              </div>
            </button>
          ))}
        </div>
      )}

      {onViewAll && items.length > visibleItems.length && (
        <button type="button" className="work-queue-more" onClick={onViewAll}>
          還有 {items.length - visibleItems.length} 項，前往工作頁查看
        </button>
      )}
    </section>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [batches, setBatches] = useState<PurchaseBatch[]>([]);
  const [batchItems, setBatchItems] = useState<PurchaseBatchItem[]>([]);
  const [privateOrders, setPrivateOrders] = useState<PrivateOrder[]>([]);
  const [privateOrderItems, setPrivateOrderItems] = useState<PrivateOrderItem[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [salesOrderItems, setSalesOrderItems] = useState<SalesOrderItem[]>([]);
  const [refreshTime, setRefreshTime] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [hasCompletedLoad, setHasCompletedLoad] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeQueue, setActiveQueue] = useState<WorkQueueKey>('unlisted');
  const [unorderedCategory, setUnorderedCategory] = useState<UnorderedCategoryFilter>('all');

  const batchItemsByGroupId = useMemo(
    () => mapPurchaseBatchItemsByGroup(batches, batchItems),
    [batches, batchItems],
  );
  const privateOrderItemsByGroupId = useMemo(
    () => mapPrivateOrderItemsByGroup(privateOrders, privateOrderItems),
    [privateOrders, privateOrderItems],
  );

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [
        fetchedGroups,
        fetchedVariants,
        fetchedCategories,
        fetchedBatches,
        fetchedBatchItems,
        fetchedPrivateOrders,
        fetchedPrivateOrderItems,
        fetchedInventory,
        fetchedSalesOrderItems,
      ] = await Promise.all([
        dataProvider.getProductGroups(),
        dataProvider.getProductVariants(),
        dataProvider.getProductCategories(),
        dataProvider.getPurchaseBatches(),
        dataProvider.getPurchaseBatchItems(),
        dataProvider.getPrivateOrders(),
        dataProvider.getPrivateOrderItems(),
        dataProvider.getInventory(),
        dataProvider.getSalesOrderItems(),
      ]);

      setGroups(fetchedGroups || []);
      setVariants(fetchedVariants || []);
      setCategories(fetchedCategories || []);
      setBatches(fetchedBatches || []);
      setBatchItems(fetchedBatchItems || []);
      setPrivateOrders(fetchedPrivateOrders || []);
      setPrivateOrderItems(fetchedPrivateOrderItems || []);
      setInventory(fetchedInventory || []);
      setSalesOrderItems(fetchedSalesOrderItems || []);
      setLoadError(null);
      setHasCompletedLoad(true);

      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, '0');
      setRefreshTime(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`);
    } catch (error) {
      console.error('Failed to load data on Dashboard', error);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // Defer the async state transition out of the effect body. Initial render is
    // already in the loading state, and this avoids a synchronous effect cascade.
    void Promise.resolve().then(loadData);
  }, []);

  const today = localToday();
  const queues = useMemo(() => {
    const upcoming: WorkQueueItem[] = [];
    const overdue: WorkQueueItem[] = [];
    const unordered: WorkQueueItem[] = [];
    const byGroupId = new Map<string, WorkQueueItem>();

    groups.forEach(group => {
      const totals = calculateGroupDemandAndPurchased(
        group.id,
        categories,
        variants,
        privateOrderItemsByGroupId.get(group.id) || [],
        batchItemsByGroupId.get(group.id) || [],
        inventory,
        salesOrderItems,
      );
      const targetDate = normalizeDate(group.closing_date);
      const hasClosingDateValue = Boolean(group.closing_date?.trim());
      const diffDays = targetDate ? daysFromToday(targetDate, today) : null;
      const item: WorkQueueItem = {
        group,
        targetDate,
        diffDays,
        demand: totals.demand,
        purchased: totals.purchased,
        gap: totals.gap,
      };
      byGroupId.set(group.id, item);

      if (totals.gap > 0 && diffDays !== null) {
        if (diffDays < 0) overdue.push(item);
        if (diffDays >= 0 && diffDays <= UPCOMING_WINDOW_DAYS) upcoming.push(item);
      }

      // Preserve the accepted Dashboard rule: an empty closing date is active,
      // while a non-empty malformed date must not be silently reclassified as active.
      const isActive = !hasClosingDateValue || (diffDays !== null && diffDays >= 0);
      if (isActive && totals.demand > 0 && totals.purchased === 0) unordered.push(item);
    });

    upcoming.sort((a, b) => (a.diffDays ?? 0) - (b.diffDays ?? 0) || b.gap - a.gap);
    overdue.sort((a, b) => (a.targetDate || '').localeCompare(b.targetDate || '') || b.gap - a.gap);
    unordered.sort((a, b) => {
      if (a.targetDate && !b.targetDate) return -1;
      if (!a.targetDate && b.targetDate) return 1;
      return (a.targetDate || '').localeCompare(b.targetDate || '') || b.gap - a.gap || a.group.title.localeCompare(b.group.title);
    });

    return { upcoming, overdue, unordered, byGroupId };
  }, [batchItemsByGroupId, categories, groups, inventory, privateOrderItemsByGroupId, salesOrderItems, today, variants]);

  const pendingUnlistedGroupIds = useMemo(
    () => getPendingUnlistedGroupIds({
      groups,
      variants,
      inventoryItems: inventory,
      today,
      processedSnapshot: readUnlistedProcessedSnapshot(),
    }),
    [groups, inventory, today, variants],
  );
  const pendingUnlistedItems = useMemo(
    () => pendingUnlistedGroupIds
      .map(groupId => queues.byGroupId.get(groupId))
      .filter((item): item is WorkQueueItem => Boolean(item)),
    [pendingUnlistedGroupIds, queues.byGroupId],
  );
  const productDisplayCategoryMap = useMemo(
    () => buildProductDisplayCategoryMap(groups, variants, inventory),
    [groups, inventory, variants],
  );
  const unorderedCategoryCounts = useMemo(() => {
    const counts: Record<UnorderedCategoryFilter, number> = {
      all: queues.unordered.length,
      c108: 0,
      hololive: 0,
      vspo: 0,
      proxy: 0,
      other: 0,
    };
    queues.unordered.forEach(item => {
      const category = productDisplayCategoryMap.get(item.group.id) ?? 'other';
      counts[category] += 1;
    });
    return counts;
  }, [productDisplayCategoryMap, queues.unordered]);
  const filteredUnorderedItems = useMemo(
    () => unorderedCategory === 'all'
      ? queues.unordered
      : queues.unordered.filter(item => productDisplayCategoryMap.get(item.group.id) === unorderedCategory),
    [productDisplayCategoryMap, queues.unordered, unorderedCategory],
  );

  const displayCount = (count: number) => (isLoading && !hasCompletedLoad ? '…' : String(count));
  const activeQueueConfig = {
    unlisted: {
      title: '待下架',
      description: '已過結單日、但仍存在最新商品目錄中的商品',
      tone: 'indigo' as const,
      items: pendingUnlistedItems,
      emptyText: '目前沒有待下架商品。',
      route: '/unlisted-items',
      itemRoute: '/unlisted-items',
    },
    upcoming: {
      title: '快結單',
      description: `未來 ${UPCOMING_WINDOW_DAYS} 天內需要優先完成採購的商品`,
      tone: 'amber' as const,
      items: queues.upcoming,
      emptyText: `未來 ${UPCOMING_WINDOW_DAYS} 天內沒有尚缺的商品。`,
      route: null,
      itemRoute: null,
    },
    overdue: {
      title: '已過期',
      description: '已過結單日但仍有缺口，請優先確認處理狀態',
      tone: 'red' as const,
      items: queues.overdue,
      emptyText: '目前沒有已過期且尚缺的商品。',
      route: null,
      itemRoute: null,
    },
    unordered: {
      title: '尚未下單',
      description: '已有需求但採購數量仍為 0 的商品',
      tone: 'blue' as const,
      items: filteredUnorderedItems,
      emptyText: '目前沒有尚未下單的商品。',
      route: null,
      itemRoute: null,
    },
  }[activeQueue];

  const showQueue = (queue: WorkQueueKey) => {
    setActiveQueue(queue);
    document.getElementById('dashboard-work-switcher')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="daily-dashboard">
      <header className="dashboard-header">
        <div>
          <p className="dashboard-eyebrow">DAILY WORK</p>
          <h1>每日工作待辦</h1>
          <p className="dashboard-subtitle">先處理待下架，再掌握快結單、已過期與尚未下單。</p>
        </div>
        <div className="dashboard-refresh-area">
          {refreshTime && <span>更新時間 {refreshTime}</span>}
          <button type="button" className="refresh-button" onClick={() => void loadData()} disabled={isLoading}>
            <RefreshCw size={17} className={isLoading ? 'spin' : ''} />
            {isLoading ? '更新中' : '重新整理'}
          </button>
        </div>
      </header>

      {loadError && (
        <div className="dashboard-error" role="alert">
          <AlertTriangle size={19} />
          <div>
            <strong>{hasCompletedLoad ? '更新失敗，畫面保留上次資料' : '無法載入首頁資料'}</strong>
            <span>{loadError}</span>
          </div>
        </div>
      )}

      <section className="daily-task-grid" aria-label="每日工作優先順序">
        <button type="button" className="daily-task-card task-unlisted" data-dashboard-task="unlisted" onClick={() => showQueue('unlisted')}>
          <span className="task-icon"><Archive size={23} /></span>
          <span className="task-copy"><strong>待下架</strong><small>仍在賣場、需要處理</small></span>
          <span className="daily-task-count" data-task-count>{displayCount(pendingUnlistedItems.length)}</span>
          <ChevronRight size={20} className="task-chevron" />
        </button>

        <button type="button" className="daily-task-card task-upcoming" data-dashboard-task="upcoming" onClick={() => showQueue('upcoming')}>
          <span className="task-icon"><Clock3 size={23} /></span>
          <span className="task-copy"><strong>快結單</strong><small>未來 {UPCOMING_WINDOW_DAYS} 天內且尚缺</small></span>
          <span className="daily-task-count" data-task-count>{displayCount(queues.upcoming.length)}</span>
          <ChevronRight size={20} className="task-chevron" />
        </button>

        <button type="button" className="daily-task-card task-overdue" data-dashboard-task="overdue" onClick={() => showQueue('overdue')}>
          <span className="task-icon"><AlertTriangle size={23} /></span>
          <span className="task-copy"><strong>已過期</strong><small>已過結單日、工作未完成</small></span>
          <span className="daily-task-count" data-task-count>{displayCount(queues.overdue.length)}</span>
          <ChevronRight size={20} className="task-chevron" />
        </button>

        <button type="button" className="daily-task-card task-unordered" data-dashboard-task="unordered" onClick={() => showQueue('unordered')}>
          <span className="task-icon"><ShoppingCart size={23} /></span>
          <span className="task-copy"><strong>尚未下單</strong><small>有需求、尚未建立採購</small></span>
          <span className="daily-task-count" data-task-count>{displayCount(queues.unordered.length)}</span>
          <ChevronRight size={20} className="task-chevron" />
        </button>
      </section>

      <section id="dashboard-work-switcher" className="dashboard-work-switcher" aria-label="工作清單切換">
        <div className="work-queue-tabs" role="tablist" aria-label="選擇工作清單">
          <button
            type="button"
            role="tab"
            aria-selected={activeQueue === 'unlisted'}
            className={activeQueue === 'unlisted' ? 'active tab-unlisted' : ''}
            data-work-queue-tab="unlisted"
            onClick={() => setActiveQueue('unlisted')}
          >
            待下架 <span>{pendingUnlistedItems.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeQueue === 'upcoming'}
            className={activeQueue === 'upcoming' ? 'active tab-upcoming' : ''}
            data-work-queue-tab="upcoming"
            onClick={() => setActiveQueue('upcoming')}
          >
            快結單 <span>{queues.upcoming.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeQueue === 'overdue'}
            className={activeQueue === 'overdue' ? 'active tab-overdue' : ''}
            data-work-queue-tab="overdue"
            onClick={() => setActiveQueue('overdue')}
          >
            已過期 <span>{queues.overdue.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeQueue === 'unordered'}
            className={activeQueue === 'unordered' ? 'active tab-unordered' : ''}
            data-work-queue-tab="unordered"
            onClick={() => setActiveQueue('unordered')}
          >
            尚未下單 <span>{queues.unordered.length}</span>
          </button>
        </div>

        {activeQueue === 'unordered' && (
          <div className="unordered-category-tabs" role="tablist" aria-label="尚未下單商品分類">
            {([
              ['all', '全部'],
              ['c108', 'C108專區'],
              ['hololive', 'Hololive商品'],
              ['vspo', 'VSPO商品'],
              ['proxy', '代理版商品'],
              ['other', '其他商品'],
            ] as Array<[UnorderedCategoryFilter, string]>).map(([key, label]) => (
              <button
                type="button"
                role="tab"
                aria-selected={unorderedCategory === key}
                className={unorderedCategory === key ? 'active' : ''}
                data-unordered-category={key}
                key={key}
                onClick={() => setUnorderedCategory(key)}
              >
                {label} <span>{unorderedCategoryCounts[key]}</span>
              </button>
            ))}
          </div>
        )}

        <WorkQueueSection
          id={activeQueue}
          title={activeQueueConfig.title}
          description={activeQueueConfig.description}
          tone={activeQueueConfig.tone}
          items={activeQueueConfig.items}
          emptyText={activeQueueConfig.emptyText}
          onOpenItem={groupId => navigate(activeQueueConfig.itemRoute || `/purchase-records/${groupId}`)}
          onViewAll={activeQueueConfig.route ? () => navigate(activeQueueConfig.route) : undefined}
        />
      </section>

      <style>{`
        .daily-dashboard { max-width: 1420px; margin: 0 auto; padding: 26px 28px 56px; color: #172033; }
        .dashboard-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 22px; }
        .dashboard-eyebrow { margin: 0 0 5px; color: #64748b; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.16em; }
        .dashboard-header h1 { margin: 0; font-size: clamp(1.65rem, 2.4vw, 2.25rem); line-height: 1.15; letter-spacing: -0.03em; }
        .dashboard-subtitle { margin: 8px 0 0; color: #64748b; font-size: 0.95rem; }
        .dashboard-refresh-area { display: flex; align-items: center; gap: 12px; color: #94a3b8; font-size: 0.78rem; white-space: nowrap; }
        .refresh-button, .view-all-button, .work-queue-more { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
        .refresh-button { display: inline-flex; align-items: center; gap: 7px; padding: 9px 13px; border: 1px solid #dbe3ee; border-radius: 10px; background: #fff; color: #475569; font-weight: 700; }
        .refresh-button:disabled { cursor: wait; opacity: 0.65; }
        .spin { animation: dashboard-spin 0.8s linear infinite; }
        @keyframes dashboard-spin { to { transform: rotate(360deg); } }
        .dashboard-error { display: flex; gap: 10px; margin-bottom: 18px; padding: 13px 15px; border: 1px solid #fecaca; border-radius: 12px; background: #fff7f7; color: #b42318; }
        .dashboard-error div { display: flex; flex-direction: column; gap: 2px; }
        .dashboard-error span { font-size: 0.82rem; }
        .daily-task-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 26px; }
        .daily-task-card { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 112px; padding: 18px 38px 18px 18px; overflow: hidden; border: 1px solid #e2e8f0; border-radius: 17px; background: #fff; color: #172033; text-align: left; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.045); cursor: pointer; transition: transform 150ms ease, box-shadow 150ms ease, border-color 150ms ease; }
        .daily-task-card:hover { transform: translateY(-2px); border-color: #cbd5e1; box-shadow: 0 12px 28px rgba(15, 23, 42, 0.09); }
        .task-icon { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 12px; }
        .task-copy { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
        .task-copy strong { font-size: 1rem; }
        .task-copy small { overflow: hidden; color: #64748b; font-size: 0.75rem; line-height: 1.35; text-overflow: ellipsis; }
        .daily-task-count { font-size: 2rem; font-weight: 850; letter-spacing: -0.05em; font-variant-numeric: tabular-nums; }
        .task-chevron { position: absolute; right: 12px; color: #94a3b8; }
        .task-unlisted .task-icon { background: #eef2ff; color: #4f46e5; }
        .task-upcoming .task-icon { background: #fff7e6; color: #d97706; }
        .task-overdue { border-color: #fecaca; background: linear-gradient(135deg, #fff 25%, #fff7f7); }
        .task-overdue .task-icon { background: #fee2e2; color: #dc2626; }
        .task-overdue .daily-task-count { color: #c81e1e; }
        .task-unordered .task-icon { background: #e8f2ff; color: #2563eb; }
        .dashboard-work-switcher { display: grid; gap: 12px; }
        .work-queue-tabs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .work-queue-tabs button { display: inline-flex; align-items: center; gap: 7px; padding: 9px 14px; border: 1px solid #dbe3ee; border-radius: 999px; background: #fff; color: #64748b; font-size: 0.82rem; font-weight: 760; cursor: pointer; transition: border-color 140ms ease, background 140ms ease, color 140ms ease; }
        .work-queue-tabs button:hover { border-color: #aebccc; color: #334155; }
        .work-queue-tabs button span { min-width: 22px; padding: 2px 6px; border-radius: 999px; background: #f1f5f9; color: #475569; font-size: 0.72rem; text-align: center; }
        .work-queue-tabs button.active { color: #172033; box-shadow: 0 3px 10px rgba(15, 23, 42, 0.07); }
        .work-queue-tabs button.active.tab-unlisted { border-color: #a5b4fc; background: #eef2ff; color: #4338ca; }
        .work-queue-tabs button.active.tab-upcoming { border-color: #f2b94b; background: #fff8e8; color: #a65f00; }
        .work-queue-tabs button.active.tab-overdue { border-color: #fca5a5; background: #fff1f1; color: #c81e1e; }
        .work-queue-tabs button.active.tab-unordered { border-color: #93c5fd; background: #eff6ff; color: #1d4ed8; }
        .unordered-category-tabs { display: flex; align-items: center; gap: 4px; padding: 0 2px; overflow-x: auto; border-bottom: 1px solid #e2e8f0; scrollbar-width: thin; }
        .unordered-category-tabs button { flex: 0 0 auto; padding: 9px 13px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: #64748b; font-size: 0.8rem; font-weight: 700; white-space: nowrap; cursor: pointer; }
        .unordered-category-tabs button:hover { color: #334155; }
        .unordered-category-tabs button.active { border-bottom-color: #2563eb; color: #2563eb; }
        .unordered-category-tabs button span { font-size: 0.72rem; font-variant-numeric: tabular-nums; }
        .work-queue { overflow: hidden; border: 1px solid #e2e8f0; border-radius: 16px; background: #fff; box-shadow: 0 5px 18px rgba(15, 23, 42, 0.035); }
        .work-queue-header { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 17px 20px; border-bottom: 1px solid #edf1f5; }
        .work-queue-header h2 { margin: 0; font-size: 1.07rem; }
        .work-queue-header p { margin: 4px 0 0; color: #718096; font-size: 0.8rem; }
        .work-queue-indigo .work-queue-header { border-left: 4px solid #6366f1; }
        .work-queue-amber .work-queue-header { border-left: 4px solid #f59e0b; }
        .work-queue-red .work-queue-header { border-left: 4px solid #ef4444; background: #fffafa; }
        .work-queue-blue .work-queue-header { border-left: 4px solid #3b82f6; }
        .view-all-button { display: inline-flex; align-items: center; gap: 3px; flex: none; color: #475569; font-size: 0.8rem; font-weight: 750; }
        .view-all-button:hover, .work-queue-more:hover { color: #1d4ed8; }
        .work-queue-list { display: grid; }
        .work-queue-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; width: 100%; padding: 13px 20px; border: 0; border-bottom: 1px solid #f0f3f7; background: #fff; color: inherit; text-align: left; cursor: pointer; }
        .work-queue-row:last-child { border-bottom: 0; }
        .work-queue-row:hover { background: #f8fafc; }
        .work-item-main { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 4px; }
        .work-item-main strong { overflow: hidden; font-size: 0.9rem; text-overflow: ellipsis; white-space: nowrap; }
        .work-item-main span { color: #718096; font-size: 0.75rem; }
        .work-item-metrics { display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; color: #64748b; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
        .work-item-metrics > span { padding: 5px 8px; border-radius: 7px; background: #f4f6f8; }
        .work-item-metrics .work-date-status { font-weight: 750; }
        .work-queue-amber .work-date-status { background: #fff6dd; color: #a65f00; }
        .work-queue-red .work-date-status { background: #fee8e8; color: #c81e1e; }
        .work-item-metrics .work-gap { color: #b42318; font-weight: 750; }
        .work-queue-empty { padding: 24px 20px; color: #718096; font-size: 0.86rem; text-align: center; }
        .work-queue-more { width: 100%; padding: 11px 20px; border-top: 1px solid #edf1f5; color: #64748b; font-size: 0.78rem; font-weight: 700; }
        @media (max-width: 1100px) { .daily-task-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        @media (max-width: 720px) {
          .daily-dashboard { padding: 20px 14px 44px; }
          .dashboard-header { align-items: flex-start; flex-direction: column; }
          .dashboard-refresh-area { width: 100%; justify-content: space-between; }
          .daily-task-grid { grid-template-columns: 1fr; gap: 10px; }
          .daily-task-card { min-height: 90px; }
          .work-queue-header { align-items: flex-start; }
          .work-queue-row { align-items: flex-start; flex-direction: column; gap: 9px; }
          .work-item-main { width: 100%; }
          .work-item-metrics { width: 100%; justify-content: flex-start; }
        }
      `}</style>
    </div>
  );
}
