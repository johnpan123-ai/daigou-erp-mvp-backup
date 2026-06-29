import { useState, useEffect, useMemo, Fragment } from 'react';
import { Archive, Copy, Check, Search, AlertTriangle, Loader2, RotateCcw, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useViewport } from '../contexts/ViewportContext';
import { dataProvider } from '../providers/dataProvider';
import { calculateGroupDemandAndPurchased, normalizeProductTitle } from '../lib/db';
import { useResizableColumns } from '../hooks/useResizableColumns';

interface UnlistedItemSku {
  sku: string;
  variantName: string;
}

interface UnlistedItem {
  id: string; // ProductGroup ID
  name: string; // ProductGroup Title
  closingDate: string;
  daysOverdue: number;
  source: '買動漫' | 'WACA' | '其他';
  category: string;
  status: '已結單' | '進行中';
  hitSkus: UnlistedItemSku[];
  totalDemand: number;
  purchased: number;
  gap: number;
}

const DEFAULT_COL_WIDTHS = {
  name: 450,
  closingDate: 130,
  daysOverdue: 110,
  source: 100,
  hitSkuCount: 160,
  category: 120
};

export default function UnlistedItems() {
  const { isMobile } = useViewport();
  
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<UnlistedItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [copied, setCopied] = useState(false);
  const [catalogImportTime, setCatalogImportTime] = useState<string | null>(null);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());

  const { colWidths, handleMouseDown, resetWidths } = useResizableColumns(
    'erp_unlisted_col_widths',
    DEFAULT_COL_WIDTHS
  );

  // Load and process data
  const loadData = async () => {
    setLoading(true);
    try {
      const [inventory, groups, variants, categories, privateOrderItems, batchItems, salesOrderItems] = await Promise.all([
        dataProvider.getInventory(),
        dataProvider.getProductGroups(),
        dataProvider.getProductVariants(),
        dataProvider.getProductCategories(),
        dataProvider.getPrivateOrderItems(),
        dataProvider.getPurchaseBatchItems(),
        dataProvider.getSalesOrderItems()
      ]);

      const todayStr = getTodayStr();

      // Find the latest import ID and timestamp
      let latestImportId: string | null = null;
      let latestImportTime: string | null = null;

      for (const item of inventory) {
        if (item.catalog_last_seen_at) {
          if (!latestImportTime || item.catalog_last_seen_at > latestImportTime) {
            latestImportTime = item.catalog_last_seen_at;
            latestImportId = item.latest_catalog_import_id || null;
          }
        }
      }

      setCatalogImportTime(latestImportTime);

      // Filter inventory to only items from the latest import batch (fallback to all if none have timestamps)
      const latestInventory = latestImportId
        ? inventory.filter(item => item.latest_catalog_import_id === latestImportId)
        : inventory;

      // Filter groups that have passed closing date
      const overdueGroups = groups.filter(g => {
        const normalized = normalizeDate(g.closing_date);
        return normalized && normalized < todayStr;
      });

      // Group variants by group ID
      const groupVariantsMap = new Map<string, typeof variants>();
      for (const v of variants) {
        if (!v.product_group_id) continue;
        const list = groupVariantsMap.get(v.product_group_id) || [];
        list.push(v);
        groupVariantsMap.set(v.product_group_id, list);
      }

      // Create a set of SKUs currently present in latest Catalog/Inventory
      const catalogSkus = new Set(latestInventory.map(item => item.myacg_item_code.trim().toUpperCase()));

      // Find variants of overdue groups that are still present in catalog
      const unlistedList: UnlistedItem[] = [];

      for (const group of overdueGroups) {
        const groupVars = groupVariantsMap.get(group.id) || [];
        const hitSkus: UnlistedItemSku[] = [];

        for (const v of groupVars) {
          if (!v.myacg_item_code) continue;
          const skuUpper = v.myacg_item_code.trim().toUpperCase();
          if (catalogSkus.has(skuUpper)) {
            hitSkus.push({
              sku: v.myacg_item_code,
              variantName: v.variant_name || ''
            });
          }
        }

        if (hitSkus.length > 0) {
          // Calculate Overdue Days
          const daysOverdue = (() => {
            const close = normalizeDate(group.closing_date);
            if (!close) return 0;
            const diffTime = new Date(todayStr).getTime() - new Date(close).getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            return diffDays > 0 ? diffDays : 0;
          })();

          // Determine Source (買動漫 / WACA / 其他)
          const source = (() => {
            const url = (group.product_url || '').toLowerCase();
            if (url.includes('waca')) return 'WACA';
            if (url.includes('myacg')) return '買動漫';
            for (const h of hitSkus) {
              const code = h.sku.toUpperCase();
              if (code.includes('WACA') || code.startsWith('W_') || code.startsWith('WA')) return 'WACA';
            }
            return '買動漫';
          })();

          // Category
          const category = group.listing_type || '一般預購';

          // Status
          const status = '已結單';

          const demandResult = calculateGroupDemandAndPurchased(
            group.id,
            categories,
            variants,
            privateOrderItems,
            batchItems,
            inventory,
            salesOrderItems
          );

          unlistedList.push({
            id: group.id,
            name: group.normalized_title || group.title,
            closingDate: group.closing_date,
            daysOverdue,
            source,
            category,
            status,
            hitSkus,
            totalDemand: demandResult.demand,
            purchased: demandResult.purchased,
            gap: demandResult.gap
          });
        }
      }

      // Sort by days overdue descending
      unlistedList.sort((a, b) => b.daysOverdue - a.daysOverdue);
      setItems(unlistedList);
      setSelectedIds(new Set()); // Reset selections
      setExpandedGroupIds(new Set()); // Reset expand states
    } catch (err) {
      console.error('[UnlistedItems Load Error]:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Helper date parsing
  const getTodayStr = (): string => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const normalizeDate = (dateStr: string | undefined | null): string | null => {
    if (!dateStr) return null;
    const clean = dateStr.trim().replace(/\//g, '-');
    const match = clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!match) return null;
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const toggleExpandGroup = (groupId: string) => {
    setExpandedGroupIds(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  // Filter items by search
  const filteredItems = useMemo(() => {
    if (!searchTerm.trim()) return items;
    const lower = searchTerm.toLowerCase();
    return items.filter(item => 
      item.name.toLowerCase().includes(lower) || 
      item.category.toLowerCase().includes(lower) ||
      item.source.toLowerCase().includes(lower) ||
      item.hitSkus.some(sku => sku.sku.toLowerCase().includes(lower) || sku.variantName.toLowerCase().includes(lower))
    );
  }, [items, searchTerm]);

  // Checkbox functions
  const handleToggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(filteredItems.map(item => item.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const isAllSelected = filteredItems.length > 0 && selectedIds.size === filteredItems.length;
  const isSomeSelected = selectedIds.size > 0 && selectedIds.size < filteredItems.length;

  const [copiedItemId, setCopiedItemId] = useState<string | null>(null);

  const handleCopyItemName = async (itemId: string, name: string) => {
    try {
      const cleanName = normalizeProductTitle(name);
      await navigator.clipboard.writeText(cleanName);
      setCopiedItemId(itemId);
      setTimeout(() => setCopiedItemId(current => current === itemId ? null : current), 1000);
    } catch (err) {
      console.error('[Copy Item Error]:', err);
    }
  };

  // Copy selected to clipboard
  const handleCopySelected = async () => {
    if (selectedIds.size === 0) return;
    const selectedItems = items.filter(item => selectedIds.has(item.id));
    
    // Format: Product Name (Group Title)
    const textToCopy = selectedItems.map(item => normalizeProductTitle(item.name)).join('\n');

    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('[Copy Error]:', err);
      alert('複製失敗，請手動複製');
    }
  };

  // Stats
  const stats = useMemo(() => {
    const total = items.length;
    const myacg = items.filter(item => item.source === '買動漫').length;
    const waca = items.filter(item => item.source === 'WACA').length;
    return { total, myacg, waca };
  }, [items]);

  return (
    <div className="unlisted-container">
      <style>{`
        .unlisted-container {
          width: 100%;
          max-width: none;
          margin: 0;
          padding: 0;
          box-sizing: border-box;
          font-family: 'Outfit', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          color: #1e293b;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .unlisted-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding-bottom: 8px;
          flex-wrap: wrap;
          gap: 16px;
        }

        .unlisted-title-area h1 {
          font-size: 26px;
          font-weight: 700;
          color: #0f172a;
          margin: 0 0 6px 0;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .unlisted-title-area p {
          font-size: 14px;
          color: #64748b;
          margin: 0;
        }

        .unlisted-actions {
          display: flex;
          gap: 12px;
        }

        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 12px;
          margin-bottom: 4px;
        }

        .stat-card {
          background-color: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }

        .stat-label {
          font-size: 13px;
          color: #64748b;
          font-weight: 500;
        }

        .stat-value {
          font-size: 22px;
          font-weight: 700;
          color: #0f172a;
        }

        .filter-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          background-color: #ffffff;
          padding: 12px 16px;
          border-radius: 8px;
          border: 1px solid #e2e8f0;
          flex-wrap: wrap;
        }

        .search-box {
          position: relative;
          width: 320px;
          max-width: 100%;
        }

        .search-input {
          width: 100%;
          padding: 8px 12px 8px 36px;
          font-size: 13px;
          border: 1px solid #cbd5e1;
          border-radius: 6px;
          outline: none;
          box-sizing: border-box;
          font-family: inherit;
        }

        .search-input:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
        }

        .table-card {
          background-color: #ffffff;
          border-radius: 8px;
          border: 1px solid #e2e8f0;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
          overflow: hidden;
        }

        .unlisted-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
          font-size: 13px;
        }

        .unlisted-table th {
          background-color: #f8fafc;
          padding: 12px 16px;
          font-weight: 600;
          color: #475569;
          border-bottom: 1px solid #e2e8f0;
          white-space: nowrap;
        }

        .unlisted-table td {
          padding: 14px 16px;
          border-bottom: 1px solid #f1f5f9;
          color: #334155;
        }

        .unlisted-table tr:last-child td {
          border-bottom: none;
        }

        .unlisted-table tr:hover td {
          background-color: #f8fafc;
        }

        .badge-source {
          display: inline-flex;
          align-items: center;
          padding: 2px 8px;
          font-size: 11px;
          font-weight: 600;
          border-radius: 4px;
        }

        .badge-myacg {
          background-color: #eff6ff;
          color: #2563eb;
          border: 1px solid #bfdbfe;
        }

        .badge-waca {
          background-color: #f5f3ff;
          color: #7c3aed;
          border: 1px solid #ddd6fe;
        }

        .badge-other {
          background-color: #f1f5f9;
          color: #475569;
          border: 1px solid #e2e8f0;
        }

        .badge-overdue {
          background-color: #fef2f2;
          color: #dc2626;
          border: 1px solid #fecaca;
          font-weight: 600;
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 4px;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }

        .mobile-card-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .mobile-card {
          background-color: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }

        .mobile-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 8px;
        }

        .mobile-card-title {
          font-size: 14px;
          font-weight: 600;
          color: #0f172a;
          line-height: 1.4;
        }

        .mobile-card-details {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 8px;
          font-size: 12px;
          color: #64748b;
          border-top: 1px solid #f1f5f9;
          padding-top: 8px;
        }

        .mobile-card-detail-item {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .mobile-card-detail-label {
          font-weight: 500;
          color: #94a3b8;
        }

        .mobile-card-detail-value {
          color: #334155;
          font-weight: 600;
        }
      `}</style>

      <div className="unlisted-header">
        <div className="unlisted-title-area">
          <h1>
            <Archive size={26} style={{ color: '#2563eb' }} />
            待下架商品
          </h1>
          <p style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 12px', marginTop: '6px' }}>
            <span>檢查已過官方結單日但仍存在於最新 Catalog (商品主檔) 的品項，這代表商店可能尚未下架。</span>
            <span style={{ padding: '2px 8px', borderRadius: '4px', backgroundColor: '#f1f5f9', color: '#475569', fontSize: '12px', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              📅 目前比對 Catalog 匯入時間：
              {catalogImportTime 
                ? new Date(catalogImportTime).toLocaleString('zh-TW', { hour12: false })
                : '無暫存匯入記錄 (比對全部快取)'
              }
            </span>
          </p>
        </div>
        
        <div className="unlisted-actions" style={{ display: 'flex', gap: '8px' }}>
          {!isMobile && (
            <button
              className="btn btn-ghost flex items-center gap-xs"
              onClick={resetWidths}
              style={{
                height: '38px',
                fontSize: '13px',
                padding: '0 12px',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                color: '#64748b',
                backgroundColor: '#fff',
                cursor: 'pointer'
              }}
            >
              <RotateCcw size={16} />
              重設欄寬
            </button>
          )}
          <button 
            className="btn btn-primary flex items-center gap-xs"
            onClick={handleCopySelected}
            disabled={selectedIds.size === 0}
            style={{ 
              height: '38px', 
              fontSize: '13px', 
              padding: '0 16px',
              backgroundColor: selectedIds.size === 0 ? '#cbd5e1' : undefined,
              borderColor: selectedIds.size === 0 ? '#cbd5e1' : undefined,
              cursor: selectedIds.size === 0 ? 'not-allowed' : 'pointer'
            }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? '已複製！' : `複製下架清單 (${selectedIds.size})`}
          </button>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">待下架規格總數</span>
          <span className="stat-value">{stats.total} 筆</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">買動漫 管道</span>
          <span className="stat-value" style={{ color: '#2563eb' }}>{stats.myacg} 筆</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">WACA 管道</span>
          <span className="stat-value" style={{ color: '#7c3aed' }}>{stats.waca} 筆</span>
        </div>
      </div>

      <div className="filter-bar">
        <div className="search-box">
          <Search size={16} style={{ position: 'absolute', left: '10px', top: '10px', color: '#94a3b8' }} />
          <input 
            type="text"
            className="search-input"
            placeholder="搜尋商品名稱 / SKU / 分類 / 來源..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center items-center" style={{ height: '200px', gap: '8px' }}>
          <Loader2 className="animate-spin" size={24} style={{ color: '#2563eb' }} />
          <span className="text-sm text-secondary font-medium">資料整理中...</span>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="table-card flex flex-col items-center justify-center" style={{ height: '200px', backgroundColor: '#fff' }}>
          <Archive size={40} style={{ color: '#cbd5e1', marginBottom: '8px' }} />
          <span className="text-sm text-secondary font-medium">沒有符合條件的待下架商品</span>
        </div>
      ) : isMobile ? (
        <div className="mobile-card-list">
          {filteredItems.map(item => (
            <div className="mobile-card" key={item.id}>
              <div className="mobile-card-header">
                <input 
                  type="checkbox" 
                  checked={selectedIds.has(item.id)}
                  onChange={() => handleToggleSelect(item.id)}
                  style={{ width: '18px', height: '18px', marginTop: '2px' }}
                />
                <div style={{ flex: 1, marginLeft: '10px' }}>
                  <div className="mobile-card-title" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <span>{normalizeProductTitle(item.name)}</span>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      <button
                        onClick={() => handleCopyItemName(item.id, item.name)}
                        title="複製商品名稱"
                        style={{
                          border: 'none',
                          background: 'none',
                          cursor: 'pointer',
                          padding: '2px',
                          color: copiedItemId === item.id ? '#10b981' : '#94a3b8',
                          display: 'inline-flex',
                          alignItems: 'center'
                        }}
                      >
                        {copiedItemId === item.id ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                      <Link
                        to={`/purchase-records/${item.id}`}
                        title="前往訂購紀錄表詳細資訊"
                        style={{
                          color: '#3b82f6',
                          display: 'inline-flex',
                          alignItems: 'center',
                          padding: '2px'
                        }}
                      >
                        <ExternalLink size={12} />
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="mobile-card-details">
                <div className="mobile-card-detail-item">
                  <span className="mobile-card-detail-label">結單日</span>
                  <span className="mobile-card-detail-value">{item.closingDate}</span>
                </div>
                <div className="mobile-card-detail-item">
                  <span className="mobile-card-detail-label">逾期天數</span>
                  <div className="mobile-card-detail-value">
                    <span className="badge-overdue">
                      <AlertTriangle size={10} />
                      逾期 {item.daysOverdue} 天
                    </span>
                  </div>
                </div>

                <div className="mobile-card-detail-item">
                  <span className="mobile-card-detail-label">來源</span>
                  <div className="mobile-card-detail-value">
                    <span className={`badge-source ${item.source === 'WACA' ? 'badge-waca' : item.source === '買動漫' ? 'badge-myacg' : 'badge-other'}`}>
                      {item.source}
                    </span>
                  </div>
                </div>
                <div className="mobile-card-detail-item">
                  <span className="mobile-card-detail-label">分類</span>
                  <span className="mobile-card-detail-value">{item.category}</span>
                </div>
                
                <div className="mobile-card-detail-item" style={{ gridColumn: 'span 2' }}>
                  <span className="mobile-card-detail-label">採購狀態與資訊</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                    <span style={{ 
                      fontSize: '11px', 
                      fontWeight: 600, 
                      color: item.gap === 0 ? '#15803d' : item.purchased > 0 ? '#b45309' : '#b91c1c', 
                      backgroundColor: item.gap === 0 ? '#f0fdf4' : item.purchased > 0 ? '#fef3c7' : '#fef2f2', 
                      padding: '2px 8px', 
                      borderRadius: '4px',
                      border: `1px solid ${item.gap === 0 ? '#bbf7d0' : item.purchased > 0 ? '#fde68a' : '#fecaca'}`
                    }}>
                      {item.gap === 0 ? '已採購完成' : item.purchased > 0 ? '部分採購' : '尚未採購'}
                    </span>
                    <span style={{ fontSize: '12px', color: '#475569' }}>
                      需求{item.totalDemand} │ 已採購{item.purchased} │ 缺<strong style={{ color: item.gap > 0 ? '#ef4444' : '#166534' }}>{item.gap}</strong>
                    </span>
                  </div>
                </div>

                <div className="mobile-card-detail-item" style={{ gridColumn: 'span 2' }}>
                  <button 
                    onClick={() => toggleExpandGroup(item.id)}
                    style={{ 
                      width: '100%', 
                      padding: '6px 12px', 
                      backgroundColor: '#f1f5f9', 
                      border: '1px solid #cbd5e1', 
                      borderRadius: '6px', 
                      fontSize: '12px', 
                      fontWeight: 600, 
                      color: '#475569', 
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'center',
                      gap: '4px',
                      marginTop: '4px'
                    }}
                  >
                    {expandedGroupIds.has(item.id) ? '收合規格明細 ▲' : `查看命中規格 (${item.hitSkus.length}) ▼`}
                  </button>
                  {expandedGroupIds.has(item.id) && (
                    <div style={{ 
                      marginTop: '8px', 
                      padding: '8px 12px', 
                      backgroundColor: '#fff', 
                      border: '1px solid #e2e8f0', 
                      borderRadius: '6px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px'
                    }}>
                      {item.hitSkus.map(sku => (
                        <div key={sku.sku} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontFamily: 'monospace' }}>
                          <span style={{ color: '#2563eb', fontWeight: 600 }}>{sku.sku}</span>
                          <span style={{ color: '#64748b' }}>{sku.variantName}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="table-card">
          <table className="unlisted-table">
            <thead>
              <tr>
                <th style={{ width: '40px', textAlign: 'center' }}>
                  <input 
                    type="checkbox"
                    checked={isAllSelected}
                    ref={el => {
                      if (el) {
                        el.indeterminate = isSomeSelected;
                      }
                    }}
                    onChange={e => handleSelectAll(e.target.checked)}
                  />
                </th>
                <th style={{ width: `${colWidths.name}px` }}>
                  <div className="th-inner">
                    <span>商品名稱</span>
                    <div className="resizer-handle" onMouseDown={e => handleMouseDown('name', e)} />
                  </div>
                </th>
                <th style={{ width: `${colWidths.closingDate}px` }}>
                  <div className="th-inner">
                    <span>官方結單日</span>
                    <div className="resizer-handle" onMouseDown={e => handleMouseDown('closingDate', e)} />
                  </div>
                </th>
                <th style={{ width: `${colWidths.daysOverdue}px` }}>
                  <div className="th-inner">
                    <span>已逾期天數</span>
                    <div className="resizer-handle" onMouseDown={e => handleMouseDown('daysOverdue', e)} />
                  </div>
                </th>
                <th style={{ width: `${colWidths.source}px` }}>
                  <div className="th-inner">
                    <span>商品來源</span>
                    <div className="resizer-handle" onMouseDown={e => handleMouseDown('source', e)} />
                  </div>
                </th>
                <th style={{ width: `${colWidths.hitSkuCount}px` }}>
                  <div className="th-inner">
                    <span>最新 Catalog 命中 SKU 數</span>
                    <div className="resizer-handle" onMouseDown={e => handleMouseDown('hitSkuCount', e)} />
                  </div>
                </th>
                <th style={{ width: `${colWidths.category}px` }}>
                  <div className="th-inner">
                    <span>分類</span>
                    <div className="resizer-handle" onMouseDown={e => handleMouseDown('category', e)} />
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map(item => (
                <Fragment key={item.id}>
                  <tr>
                    <td style={{ textAlign: 'center', verticalAlign: 'middle' }}>
                      <input 
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        onChange={() => handleToggleSelect(item.id)}
                      />
                    </td>
                    <td style={{ fontWeight: 600, color: '#0f172a', verticalAlign: 'middle' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <button 
                            onClick={() => toggleExpandGroup(item.id)}
                            style={{ 
                              border: 'none', 
                              background: 'none', 
                              cursor: 'pointer', 
                              padding: '4px',
                              color: '#64748b', 
                              fontSize: '11px',
                              display: 'flex',
                              alignItems: 'center'
                            }}
                          >
                            {expandedGroupIds.has(item.id) ? '▼' : '▶'}
                          </button>
                          <span>{normalizeProductTitle(item.name)}</span>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: '8px' }}>
                            <button
                              onClick={() => handleCopyItemName(item.id, item.name)}
                              title="複製商品名稱"
                              style={{
                                border: 'none',
                                background: 'none',
                                cursor: 'pointer',
                                padding: '2px',
                                color: copiedItemId === item.id ? '#10b981' : '#94a3b8',
                                display: 'inline-flex',
                                alignItems: 'center'
                              }}
                            >
                              {copiedItemId === item.id ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                            <Link
                              to={`/purchase-records/${item.id}`}
                              title="前往訂購紀錄表詳細資訊"
                              style={{
                                color: '#3b82f6',
                                display: 'inline-flex',
                                alignItems: 'center',
                                padding: '2px'
                              }}
                            >
                              <ExternalLink size={14} />
                            </Link>
                          </div>
                        </div>
                        
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', fontSize: '12px', fontWeight: 500 }}>
                          <span style={{ 
                            fontSize: '11px', 
                            fontWeight: 600, 
                            color: item.gap === 0 ? '#15803d' : item.purchased > 0 ? '#b45309' : '#b91c1c', 
                            backgroundColor: item.gap === 0 ? '#f0fdf4' : item.purchased > 0 ? '#fef3c7' : '#fef2f2', 
                            padding: '2px 8px', 
                            borderRadius: '4px',
                            border: `1px solid ${item.gap === 0 ? '#bbf7d0' : item.purchased > 0 ? '#fde68a' : '#fecaca'}`,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}>
                            {item.gap === 0 ? '已採購完成' : item.purchased > 0 ? '部分採購' : '尚未採購'}
                          </span>
                          <span style={{ color: '#64748b' }}>
                            需求{item.totalDemand} │ 已採購{item.purchased} │ 缺<strong style={{ color: item.gap > 0 ? '#ef4444' : '#166534' }}>{item.gap}</strong>
                          </span>
                        </div>
                      </div>
                    </td>
                    <td style={{ verticalAlign: 'middle' }}>{item.closingDate}</td>
                    <td style={{ verticalAlign: 'middle' }}>
                      <span className="badge-overdue">
                        <AlertTriangle size={12} />
                        逾期 {item.daysOverdue} 天
                      </span>
                    </td>
                    <td style={{ textAlign: 'center', verticalAlign: 'middle' }}>
                      <span className={`badge-source ${item.source === 'WACA' ? 'badge-waca' : item.source === '買動漫' ? 'badge-myacg' : 'badge-other'}`} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                        {item.source}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center', verticalAlign: 'middle', fontWeight: 600, color: '#1e293b' }}>
                      {item.hitSkus.length} 筆
                    </td>
                    <td style={{ verticalAlign: 'middle' }}>{item.category}</td>
                  </tr>
                  {expandedGroupIds.has(item.id) && (
                    <tr style={{ backgroundColor: '#f8fafc' }}>
                      <td></td>
                      <td colSpan={6} style={{ padding: '8px 16px' }}>
                        <div style={{ padding: '12px 16px', borderLeft: '3px solid #2563eb', backgroundColor: '#fff', borderRadius: '0 4px 4px 0', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.05)' }}>
                          <div style={{ fontWeight: 600, fontSize: '12px', color: '#475569', marginBottom: '6px' }}>
                            🔍 命中最新 Catalog 規格清單：
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {item.hitSkus.map(sku => (
                              <div key={sku.sku} style={{ display: 'flex', gap: '16px', fontSize: '12px', fontFamily: 'monospace' }}>
                                <span style={{ color: '#2563eb', fontWeight: 600, width: '150px' }}>{sku.sku}</span>
                                <span style={{ color: '#334155' }}>{sku.variantName}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
