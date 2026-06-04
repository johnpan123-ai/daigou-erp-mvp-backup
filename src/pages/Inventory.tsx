import React, { useState, useEffect, useRef, useMemo } from 'react';
import { dataProvider } from '../providers/dataProvider';
import type { InventoryItem, ProductGroup } from '../lib/db';
import { parseMyAcgFile } from '../utils/myacgParser';
import { Upload, RefreshCw, PackageX, ChevronDown, ChevronRight, Search, ShoppingBag, CheckCircle, Clock, Building2, Play, Heart, SlidersHorizontal, Plus } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';

interface InventoryGroup {
  title: string;
  skus: InventoryItem[];
  totalSold: number;
  minPrice: number;
  maxPrice: number;
  latest_listed_at: string;
  max_item_code: string;
  inPurchaseRecord: boolean;
}

const HighlightText = ({ text, highlight }: { text: string; highlight: string }) => {
  if (!highlight.trim()) {
    return <span>{text}</span>;
  }
  const regex = new RegExp(`(${highlight})`, 'gi');
  const parts = text.split(regex);
  return (
    <span>
      {parts.map((part, i) => 
        regex.test(part) ? <mark key={i} style={{ backgroundColor: '#fef08a', color: 'inherit' }}>{part}</mark> : <span key={i}>{part}</span>
      )}
    </span>
  );
};

const DEFAULT_COL_WIDTHS = {
  title: 450,
  category: 180,
  status: 200,
  listedAt: 120,
  sales: 100
};

export default function Inventory() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [productGroups, setProductGroups] = useState<ProductGroup[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all'); // 'all', 'hololive', 'vspo', 'other'
  const [proxyFilter, setProxyFilter] = useState('all'); // 'all', 'proxy', 'japan', 'instock'
  const [statusFilter, setStatusFilter] = useState('all'); // 'all', 'added', 'not_added'
  const [refreshTime, setRefreshTime] = useState<string>('');
  
  // selectedSkus contains myacg_item_code
  const [selectedSkus, setSelectedSkus] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const saved = localStorage.getItem('erp_inventory_col_widths');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        // ignore
      }
    }
    return DEFAULT_COL_WIDTHS;
  });

  const handleMouseDown = (colKey: string, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = colWidths[colKey] || DEFAULT_COL_WIDTHS[colKey as keyof typeof DEFAULT_COL_WIDTHS];

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const newWidth = Math.max(80, startWidth + dx);
      setColWidths(prev => ({
        ...prev,
        [colKey]: newWidth
      }));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      
      setColWidths(current => {
        localStorage.setItem('erp_inventory_col_widths', JSON.stringify(current));
        return current;
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    loadItems();
  }, []);

  const loadItems = async () => {
    const data = await dataProvider.getInventory();
    setItems(data);
    const groups = await dataProvider.getProductGroups();
    setProductGroups(groups);
    
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    setRefreshTime(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`);
  };

  const existingGroupTitles = useMemo(() => {
    return new Set(productGroups.map(g => g.normalized_title || g.title));
  }, [productGroups]);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    try {
      const parsedItems = await parseMyAcgFile(file);
      const stats = await dataProvider.upsertInventory(parsedItems);
      
      // Sync ProductGroups with new inventory
      const syncStats = await dataProvider.syncProductGroupsWithInventory();
      await loadItems();
      
      const report = `本次匯入結果：\n- SKU 總筆數：${stats.total}\n- 新增 SKU：${stats.newCount}\n- 更新 SKU：${stats.updatedCount}\n- 補齊既有訂購紀錄 SKU：${syncStats.filledVariantsCount}\n- 受影響 ProductGroup：${syncStats.affectedGroupsCount}`;

      alert(report);
    } catch (err) {
      console.error(err);
      alert('匯入失敗，請確認檔案格式是否正確。');
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCreatePurchaseRecords = async () => {
    if (selectedSkus.size === 0) return;
    const confirmImport = window.confirm(`你即將匯入 ${selectedSkus.size} 個商品至訂購紀錄表，是否確認？`);
    if (!confirmImport) return;
    try {
      await dataProvider.createPurchaseRecordFromInventory(Array.from(selectedSkus));
      alert(`已將 ${selectedSkus.size} 筆 SKU 建立/匯入訂購紀錄。`);
      setSelectedSkus(new Set());
      await loadItems(); // Refresh the "Added" status
    } catch (e) {
      alert('建立失敗');
      console.error(e);
    }
  };

  const handleImportSingleGroup = async (g: InventoryGroup) => {
    const skusToImport = g.skus.map(s => s.myacg_item_code);
    if (skusToImport.length === 0) return;

    const confirmImport = window.confirm(`你即將匯入該群組共 ${skusToImport.length} 個商品至訂購紀錄表，是否確認？`);
    if (!confirmImport) return;

    try {
      await dataProvider.createPurchaseRecordFromInventory(skusToImport);
      alert(`已將 ${skusToImport.length} 筆 SKU 建立/匯入訂購紀錄。`);
      
      // 同時把這些 sku 從 selectedSkus 中移除（若有的話）
      const nextSelected = new Set(selectedSkus);
      skusToImport.forEach(sku => nextSelected.delete(sku));
      setSelectedSkus(nextSelected);

      await loadItems(); // 重新整理狀態
    } catch (e) {
      alert('建立失敗');
      console.error(e);
    }
  };

  // Grouping logic
  const groups = useMemo(() => {
    const map = new Map<string, InventoryGroup>();
    for (const item of items) {
      const groupKey = item.normalized_product_title || item.product_title;
      if (!map.has(groupKey)) {
        map.set(groupKey, {
          title: groupKey,
          skus: [],
          totalSold: 0,
          minPrice: Infinity,
          maxPrice: -Infinity,
          latest_listed_at: '',
          max_item_code: '',
          inPurchaseRecord: existingGroupTitles.has(groupKey)
        });
      }
      const g = map.get(groupKey)!;
      g.skus.push(item);
      g.totalSold += item.myacg_sold_quantity;
      if (item.final_price < g.minPrice) g.minPrice = item.final_price;
      if (item.final_price > g.maxPrice) g.maxPrice = item.final_price;
      
      const listedAt = item.myacg_listed_at || '';
      if (listedAt > g.latest_listed_at) g.latest_listed_at = listedAt;
      if (item.myacg_item_code > g.max_item_code) g.max_item_code = item.myacg_item_code;
    }
    
    // Sort groups
    const sortedGroups = Array.from(map.values()).sort((a, b) => {
      if (a.latest_listed_at !== b.latest_listed_at) {
        return b.latest_listed_at.localeCompare(a.latest_listed_at);
      }
      return b.max_item_code.localeCompare(a.max_item_code);
    });

    sortedGroups.forEach(g => {
      g.skus.sort((a, b) => a.myacg_item_code.localeCompare(b.myacg_item_code));
    });

    // Apply Filters
    let filteredGroups = sortedGroups;

    // 1. Category Filter
    if (categoryFilter === 'hololive') {
      filteredGroups = filteredGroups.filter(g => {
        const titleNorm = g.title.toLowerCase().replace(/[\s!\uff01\?\uff1f\-_\(\)\uff08\uff09\.\*,]/g, '');
        return titleNorm.includes('hololive');
      });
    } else if (categoryFilter === 'vspo') {
      filteredGroups = filteredGroups.filter(g => {
        const titleNorm = g.title.toLowerCase().replace(/[\s!\uff01\?\uff1f\-_\(\)\uff08\uff09\.\*,]/g, '');
        return titleNorm.includes('vspo') || titleNorm.includes('ぶいすぽ');
      });
    } else if (categoryFilter === 'other') {
      filteredGroups = filteredGroups.filter(g => {
        const titleNorm = g.title.toLowerCase().replace(/[\s!\uff01\?\uff1f\-_\(\)\uff08\uff09\.\*,]/g, '');
        return !titleNorm.includes('hololive') && !titleNorm.includes('vspo') && !titleNorm.includes('ぶいすぽ');
      });
    }

    // 2. Proxy/Type Filter (listing_type)
    if (proxyFilter === 'proxy') {
      filteredGroups = filteredGroups.filter(g => g.skus[0]?.listing_type === '代理版');
    } else if (proxyFilter === 'japan') {
      filteredGroups = filteredGroups.filter(g => g.skus[0]?.listing_type === '日本代購');
    } else if (proxyFilter === 'instock') {
      filteredGroups = filteredGroups.filter(g => g.skus[0]?.listing_type === '現貨');
    }

    // 3. Purchase Status Filter (added/not_added)
    if (statusFilter === 'added') {
      filteredGroups = filteredGroups.filter(g => g.inPurchaseRecord);
    } else if (statusFilter === 'not_added') {
      filteredGroups = filteredGroups.filter(g => !g.inPurchaseRecord);
    }

    if (!searchTerm) {
      return filteredGroups;
    }

    const lowerSearch = searchTerm.toLowerCase();
    return filteredGroups.filter(g => {
      const groupMatches = g.title.toLowerCase().includes(lowerSearch);
      const matchingSkus = g.skus.filter(s => 
        (s.product_title && s.product_title.toLowerCase().includes(lowerSearch)) ||
        (s.myacg_item_code && s.myacg_item_code.toLowerCase().includes(lowerSearch)) ||
        (s.raw_variant_name && s.raw_variant_name.toLowerCase().includes(lowerSearch)) ||
        (s.listing_type && s.listing_type.toLowerCase().includes(lowerSearch)) ||
        (s.normalized_product_title && s.normalized_product_title.toLowerCase().includes(lowerSearch))
      );
      return groupMatches || matchingSkus.length > 0;
    });

  }, [items, searchTerm, categoryFilter, proxyFilter, statusFilter, existingGroupTitles]);

  // Effect to auto-expand groups when search term changes
  useEffect(() => {
    if (!searchTerm) return;
    const lowerSearch = searchTerm.toLowerCase();
    const newExpanded = new Set(expandedGroups);
    let changed = false;

    groups.forEach(g => {
      if (g.skus.length <= 1) return; // Single SKU items are never explicitly expanded

      const matchingSkus = g.skus.filter(s => 
        (s.product_title && s.product_title.toLowerCase().includes(lowerSearch)) ||
        (s.myacg_item_code && s.myacg_item_code.toLowerCase().includes(lowerSearch)) ||
        (s.raw_variant_name && s.raw_variant_name.toLowerCase().includes(lowerSearch)) ||
        (s.listing_type && s.listing_type.toLowerCase().includes(lowerSearch)) ||
        (s.normalized_product_title && s.normalized_product_title.toLowerCase().includes(lowerSearch))
      );
      if (matchingSkus.length > 0) {
        if (!newExpanded.has(g.title)) {
          newExpanded.add(g.title);
          changed = true;
        }
      }
    });

    if (changed) {
      setExpandedGroups(newExpanded);
    }
  }, [searchTerm, groups]);

  // Pagination on Groups
  const PAGE_SIZE = 50;
  const totalPages = Math.ceil(groups.length / PAGE_SIZE);
  const paginatedGroups = groups.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Reset pagination if search or filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, categoryFilter, proxyFilter, statusFilter]);

  const toggleGroupExpand = (title: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(expandedGroups);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    setExpandedGroups(next);
  };

  const handleGroupCheck = (g: InventoryGroup) => {
    const next = new Set(selectedSkus);
    const allSelected = g.skus.every(sku => next.has(sku.myacg_item_code));

    if (allSelected) {
      g.skus.forEach(sku => next.delete(sku.myacg_item_code));
    } else {
      g.skus.forEach(sku => next.add(sku.myacg_item_code));
    }
    setSelectedSkus(next);
  };

  const handleSkuCheck = (skuCode: string) => {
    const next = new Set(selectedSkus);
    if (next.has(skuCode)) next.delete(skuCode);
    else next.add(skuCode);
    setSelectedSkus(next);
  };

  // Unfiltered groups for KPI stats calculation
  const unfilteredGroups = useMemo(() => {
    const map = new Map<string, InventoryGroup>();
    for (const item of items) {
      const groupKey = item.normalized_product_title || item.product_title;
      if (!map.has(groupKey)) {
        map.set(groupKey, {
          title: groupKey,
          skus: [],
          totalSold: 0,
          minPrice: Infinity,
          maxPrice: -Infinity,
          latest_listed_at: '',
          max_item_code: '',
          inPurchaseRecord: existingGroupTitles.has(groupKey)
        });
      }
      const g = map.get(groupKey)!;
      g.skus.push(item);
      g.totalSold += item.myacg_sold_quantity;
      if (item.final_price < g.minPrice) g.minPrice = item.final_price;
      if (item.final_price > g.maxPrice) g.maxPrice = item.final_price;
      
      const listedAt = item.myacg_listed_at || '';
      if (listedAt > g.latest_listed_at) g.latest_listed_at = listedAt;
      if (item.myacg_item_code > g.max_item_code) g.max_item_code = item.myacg_item_code;
    }
    return Array.from(map.values());
  }, [items, existingGroupTitles]);

  const renderPageNumbers = () => {
    const pages = [];
    for (let i = 1; i <= totalPages; i++) {
      pages.push(
        <button 
          key={i} 
          onClick={() => setCurrentPage(i)}
          className={`pagination-btn-inv ${currentPage === i ? 'active' : ''}`}
        >
          {i}
        </button>
      );
    }
    return pages;
  };

  return (
    <div className="inventory-container">
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileChange} 
        accept=".xls,.xlsx,.html" 
        style={{ display: 'none' }} 
      />
      <style>{`
        .inventory-container {
          width: 100%;
          max-width: none;
          margin: 0;
          padding: 0;
          box-sizing: border-box;
          font-family: 'Outfit', 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #1e293b;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .inventory-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding-bottom: 8px;
          flex-wrap: wrap;
          gap: 16px;
        }

        .inventory-title-area h1 {
          font-size: 26px;
          font-weight: 700;
          color: #0f172a;
          margin: 0 0 6px 0;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .inventory-title-area p {
          font-size: 14px;
          color: #64748b;
          margin: 0;
        }

        .inventory-header-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .btn-refresh-inv {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 16px;
          font-size: 14px;
          font-weight: 600;
          color: #475569;
          background: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
        }

        .btn-refresh-inv:hover {
          background-color: #f8fafc;
          border-color: #94a3b8;
          color: #1e293b;
        }

        .btn-refresh-inv:active {
          transform: scale(0.98);
        }

        .btn-import-xls {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 16px;
          font-size: 14px;
          font-weight: 600;
          color: #475569;
          background: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        }

        .btn-import-xls:hover {
          background-color: #f8fafc;
          border-color: #94a3b8;
        }

        .btn-import-xls:active {
          transform: scale(0.98);
        }

        .btn-add-product {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 16px;
          font-size: 14px;
          font-weight: 600;
          color: #ffffff;
          background-color: #2563eb;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
          box-shadow: 0 2px 4px rgba(37, 99, 235, 0.1);
        }

        .btn-add-product:hover {
          background-color: #1d4ed8;
        }

        .btn-add-product:active {
          transform: scale(0.98);
        }

        /* KPI Row & Cards */
        .kpi-row {
          display: grid;
          grid-template-columns: repeat(6, 1fr);
          gap: 16px;
          width: 100%;
        }

        @media (max-width: 1200px) {
          .kpi-row {
            grid-template-columns: repeat(3, 1fr);
          }
        }

        @media (max-width: 768px) {
          .kpi-row {
            grid-template-columns: repeat(2, 1fr);
          }
        }

        .kpi-card {
          background-color: #ffffff;
          border-radius: 12px;
          padding: 16px 20px;
          border: 1px solid #e2e8f0;
          box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03);
          display: flex;
          align-items: center;
          gap: 16px;
          box-sizing: border-box;
        }

        .kpi-card-icon-wrapper {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .kpi-icon-blue {
          background-color: #eff6ff;
          color: #2563eb;
        }
        .kpi-icon-green {
          background-color: #ecfdf5;
          color: #059669;
        }
        .kpi-icon-orange {
          background-color: #fff7ed;
          color: #ea580c;
        }
        .kpi-icon-purple {
          background-color: #f5f3ff;
          color: #7c3aed;
        }
        .kpi-icon-skyblue {
          background-color: #e0f2fe;
          color: #0284c7;
        }
        .kpi-icon-pink {
          background-color: #fdf2f8;
          color: #db2777;
        }

        .kpi-card-content {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }

        .kpi-card-label {
          font-size: 13px;
          color: #64748b;
          font-weight: 500;
        }

        .kpi-card-value {
          font-size: 24px;
          font-weight: 700;
          color: #0f172a;
          line-height: 1.2;
        }

        /* Filter bar */
        .filter-bar-card {
          background-color: #ffffff;
          border-radius: 12px;
          border: 1px solid #e2e8f0;
          box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03);
          padding: 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
          width: 100%;
          box-sizing: border-box;
        }

        .filter-left-group {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          flex: 1;
          min-width: 0;
        }

        .search-input-wrapper {
          position: relative;
          min-width: 280px;
          max-width: 400px;
          flex: 1;
        }

        .search-input-wrapper svg {
          position: absolute;
          left: 12px;
          top: 50%;
          transform: translateY(-50%);
          color: #94a3b8;
          pointer-events: none;
        }

        .search-input-wrapper input {
          width: 100%;
          padding: 8px 12px 8px 36px;
          font-size: 14px;
          border-radius: 8px;
          border: 1px solid #cbd5e1;
          background-color: #ffffff;
          color: #1e293b;
          outline: none;
          transition: all 0.15s ease;
          box-sizing: border-box;
        }

        .search-input-wrapper input:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
        }

        .flex-wrap {
          flex-wrap: wrap;
        }

        .filter-select {
          padding: 8px 12px;
          font-size: 14px;
          font-weight: 500;
          color: #475569;
          background-color: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          cursor: pointer;
          outline: none;
          min-width: 120px;
          transition: all 0.15s ease;
        }

        .filter-select:hover {
          border-color: #94a3b8;
        }

        .filter-select.active {
          border-color: #3b82f6;
          background-color: #f0f7ff;
          color: #1d4ed8;
        }

        .quick-tag {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 12px;
          font-size: 13px;
          font-weight: 500;
          color: #475569;
          background-color: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .quick-tag:hover {
          background-color: #f8fafc;
        }

        .quick-tag.active {
          background-color: #eff6ff;
          border-color: #3b82f6;
          color: #1d4ed8;
        }

        .dot-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
        }

        .dot-green {
          background-color: #16a34a;
        }

        .dot-red {
          background-color: #dc2626;
        }

        .btn-more-filters {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 16px;
          font-size: 14px;
          font-weight: 500;
          color: #475569;
          background-color: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .btn-more-filters:hover {
          background-color: #f8fafc;
        }

        /* Table Card & General Layout */
        .inventory-list-card {
          background-color: #ffffff;
          border-radius: 12px;
          border: 1px solid #e2e8f0;
          box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03);
          overflow: hidden;
          width: 100%;
          box-sizing: border-box;
        }

        .inventory-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
          font-size: 13px;
          table-layout: fixed;
        }

        .inventory-table th {
          padding: 0;
          font-weight: 600;
          color: #475569;
          font-size: 12px;
          background-color: #f8fafc;
          border-bottom: 1px solid #e2e8f0;
          white-space: nowrap;
        }

        .th-inner {
          position: relative;
          padding: 8px 12px;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          width: 100%;
          height: 100%;
        }

        .th-inner.justify-center {
          justify-content: center;
        }

        .th-inner.justify-end {
          justify-content: flex-end;
        }

        .resizer-handle {
          position: absolute;
          right: 0;
          top: 4px;
          bottom: 4px;
          width: 4px;
          border-right: 2px solid #000000;
          cursor: col-resize;
          user-select: none;
          z-index: 10;
          opacity: 0.6;
          transition: opacity 0.15s;
        }

        .resizer-handle:hover,
        .resizer-handle:active {
          opacity: 1;
          border-right: 2px solid #2563eb;
        }

        .inventory-table tr {
          border-bottom: 1px solid #f1f5f9;
          transition: background-color 0.2s ease;
        }

        .inventory-table tbody tr.group-row {
          cursor: pointer;
        }

        .inventory-table tbody tr.group-row:hover {
          background-color: #f8fafc;
        }

        .inventory-table td {
          padding: 6px 12px;
          vertical-align: middle;
          box-sizing: border-box;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* Soft Badge Tags */
        .tag-pill {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
        }

        .tag-hololive {
          background-color: #eff6ff;
          color: #2563eb;
          border: 1px solid #dbeafe;
        }

        .tag-vspo {
          background-color: #fdf2f8;
          color: #db2777;
          border: 1px solid #fbcfe8;
        }

        .tag-proxy {
          background-color: #f5f3ff;
          color: #7c3aed;
          border: 1px solid #ddd6fe;
        }

        .tag-japan {
          background-color: #ecfdf5;
          color: #059669;
          border: 1px solid #a7f3d0;
        }

        .tag-instock {
          background-color: #fffbeb;
          color: #d97706;
          border: 1px solid #fde68a;
        }

        .tag-other {
          background-color: #f1f5f9;
          color: #475569;
          border: 1px solid #e2e8f0;
        }

        .badge-status-added {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 8px;
          font-size: 11px;
          font-weight: 600;
          border-radius: 9999px;
          background-color: #ecfdf5;
          color: #047857;
          border: 1px solid #a7f3d0;
        }

        .badge-status-not-added {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 8px;
          font-size: 11px;
          font-weight: 600;
          border-radius: 9999px;
          background-color: #fef2f2;
          color: #b91c1c;
          border: 1px solid #fecaca;
        }

        /* Pagination style */
        .table-pagination-inv {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px;
          border-top: 1px solid #f1f5f9;
          font-size: 13px;
          color: #64748b;
          background-color: #ffffff;
        }
        
        .pagination-info {
          font-weight: 500;
        }
        
        .pagination-btn-group {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        
        .pagination-btn-inv {
          width: 32px;
          height: 32px;
          border-radius: 6px;
          border: 1px solid #cbd5e1;
          background-color: #ffffff;
          color: #475569;
          font-size: 12px;
          font-weight: 600;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        
        .pagination-btn-inv:hover:not(:disabled) {
          background-color: #f8fafc;
          border-color: #94a3b8;
        }
        
        .pagination-btn-inv.active {
          background-color: #eff6ff;
          border-color: #3b82f6;
          color: #2563eb;
        }
        
        .pagination-btn-inv:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .pagination-text-btn {
          height: 32px;
          padding: 0 12px;
          border-radius: 6px;
          border: 1px solid #cbd5e1;
          background-color: #ffffff;
          color: #475569;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }

        .pagination-text-btn:hover:not(:disabled) {
          background-color: #f8fafc;
          border-color: #94a3b8;
        }

        .pagination-text-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .inventory-header-buttons {
          margin-top: 12px;
          display: flex;
          gap: 12px;
          align-items: center;
        }
      `}</style>

      {/* Header Area */}
      <div className="inventory-header">
        <div className="inventory-title-left">
          <div className="inventory-title-area">
            <h1>商品主檔</h1>
            <p>管理全部商品庫存，以 SKU 為基礎。</p>
          </div>
          <div className="inventory-header-buttons">
            <button className="btn-add-product" onClick={() => alert('手動新增商品功能開發中，目前請使用 [匯入主檔 XLS] 進行商品新增。')}>
              <Plus size={14} />
              <span>新增商品</span>
            </button>
            <button className="btn-import-xls" onClick={handleImportClick} disabled={isImporting}>
              <Upload size={14} />
              <span>{isImporting ? '匯入中...' : '匯入主檔 XLS'}</span>
            </button>
            {selectedSkus.size > 0 && (
              <button className="btn btn-primary" onClick={handleCreatePurchaseRecords} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <span>建立訂購紀錄 ({selectedSkus.size} 筆)</span>
              </button>
            )}
          </div>
        </div>
        <div className="inventory-header-right" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
          {refreshTime && (
            <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 500 }}>
              更新時間：{refreshTime}
            </div>
          )}
          <button className="btn-refresh-inv" onClick={loadItems} disabled={isImporting}>
            <RefreshCw size={14} />
            <span>重新整理</span>
          </button>
        </div>
      </div>

      {/* KPI Cards Row */}
      <div className="kpi-row">
        {/* 商品總數 */}
        <div className="kpi-card">
          <div className="kpi-card-icon-wrapper kpi-icon-blue">
            <ShoppingBag size={20} />
          </div>
          <div className="kpi-card-content">
            <div className="kpi-card-label">商品總數</div>
            <div className="kpi-card-value">{unfilteredGroups.length}</div>
          </div>
        </div>

        {/* 已加入訂購 */}
        <div className="kpi-card">
          <div className="kpi-card-icon-wrapper kpi-icon-green">
            <CheckCircle size={20} />
          </div>
          <div className="kpi-card-content">
            <div className="kpi-card-label">已加入訂購</div>
            <div className="kpi-card-value">{unfilteredGroups.filter(g => g.inPurchaseRecord).length}</div>
          </div>
        </div>

        {/* 未加入訂購 */}
        <div className="kpi-card">
          <div className="kpi-card-icon-wrapper kpi-icon-orange">
            <Clock size={20} />
          </div>
          <div className="kpi-card-content">
            <div className="kpi-card-label">未加入訂購</div>
            <div className="kpi-card-value">{unfilteredGroups.filter(g => !g.inPurchaseRecord).length}</div>
          </div>
        </div>

        {/* 代理版商品 */}
        <div className="kpi-card">
          <div className="kpi-card-icon-wrapper kpi-icon-purple">
            <Building2 size={20} />
          </div>
          <div className="kpi-card-content">
            <div className="kpi-card-label">代理版商品</div>
            <div className="kpi-card-value">{unfilteredGroups.filter(g => g.skus[0]?.listing_type === '代理版').length}</div>
          </div>
        </div>

        {/* Hololive 商品 */}
        <div className="kpi-card">
          <div className="kpi-card-icon-wrapper kpi-icon-skyblue">
            <Play size={20} />
          </div>
          <div className="kpi-card-content">
            <div className="kpi-card-label">Hololive 商品</div>
            <div className="kpi-card-value">
              {unfilteredGroups.filter(g => {
                const titleNorm = g.title.toLowerCase().replace(/[\s!\uff01\?\uff1f\-_\(\)\uff08\uff09\.\*,]/g, '');
                return titleNorm.includes('hololive');
              }).length}
            </div>
          </div>
        </div>

        {/* VSPO 商品 */}
        <div className="kpi-card">
          <div className="kpi-card-icon-wrapper kpi-icon-pink">
            <Heart size={20} />
          </div>
          <div className="kpi-card-content">
            <div className="kpi-card-label">VSPO 商品</div>
            <div className="kpi-card-value">
              {unfilteredGroups.filter(g => {
                const titleNorm = g.title.toLowerCase().replace(/[\s!\uff01\?\uff1f\-_\(\)\uff08\uff09\.\*,]/g, '');
                return titleNorm.includes('vspo') || titleNorm.includes('ぶいすぽ');
              }).length}
            </div>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar Card */}
      <div className="filter-bar-card">
        <div className="filter-left-group">
          {/* Search Input */}
          <div className="search-input-wrapper">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted" size={16} />
            <input 
              type="text" 
              placeholder="搜尋商品名稱、SKU、綠碼、品牌..." 
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>

          {/* Classification Dropdown */}
          <select 
            className={`filter-select ${categoryFilter !== 'all' ? 'active' : ''}`}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="all">全部分類</option>
            <option value="hololive">Hololive</option>
            <option value="vspo">VSPO</option>
            <option value="other">其他分類</option>
          </select>

          {/* Proxy/Type Dropdown */}
          <select 
            className={`filter-select ${proxyFilter !== 'all' ? 'active' : ''}`}
            value={proxyFilter}
            onChange={(e) => setProxyFilter(e.target.value)}
          >
            <option value="all">全部代理/類型</option>
            <option value="proxy">代理版</option>
            <option value="japan">日本代購</option>
            <option value="instock">現貨</option>
          </select>

          {/* Quick status Tags */}
          <button 
            className={`quick-tag ${statusFilter === 'added' ? 'active' : ''}`}
            onClick={() => {
              if (statusFilter === 'added') setStatusFilter('all');
              else setStatusFilter('added');
            }}
          >
            <span className="dot-indicator dot-green"></span>
            <span>已加入訂購紀錄</span>
          </button>

          <button 
            className={`quick-tag ${statusFilter === 'not_added' ? 'active' : ''}`}
            onClick={() => {
              if (statusFilter === 'not_added') setStatusFilter('all');
              else setStatusFilter('not_added');
            }}
          >
            <span className="dot-indicator dot-red"></span>
            <span>未加入訂購紀錄</span>
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button 
            className="btn-more-filters"
            onClick={() => {
              setColWidths({
                title: 450,
                category: 180,
                status: 200,
                listedAt: 120,
                sales: 100
              });
              localStorage.removeItem('erp_inventory_col_widths');
              alert('欄位寬度已重設為預設值！');
            }}
          >
            <span>重設欄寬</span>
          </button>
          <button className="btn-more-filters">
            <SlidersHorizontal size={14} />
            <span>更多篩選</span>
            <ChevronDown size={14} />
          </button>
        </div>
      </div>

      {/* Main List Section */}
      <div className="inventory-list-card">
        {groups.length === 0 ? (
          <EmptyState
            icon={PackageX}
            title={searchTerm || categoryFilter !== 'all' || proxyFilter !== 'all' || statusFilter !== 'all' ? "找不到符合條件的商品" : "尚未匯入商品主檔"}
            description={searchTerm || categoryFilter !== 'all' || proxyFilter !== 'all' || statusFilter !== 'all' ? "請嘗試更換搜尋關鍵字或篩選條件。" : "請點擊匯入買動漫匯出檔案，建立系統內 SKU 與庫存數據。"}
            actionLabel={searchTerm || categoryFilter !== 'all' || proxyFilter !== 'all' || statusFilter !== 'all' ? undefined : "匯入 XLS"}
            onAction={searchTerm || categoryFilter !== 'all' || proxyFilter !== 'all' || statusFilter !== 'all' ? undefined : handleImportClick}
          />
        ) : (
          <>
            <table className="inventory-table">
              <thead>
                <tr>
                  <th style={{ width: '48px', textAlign: 'center' }}>
                    {/* 移除全選 Checkbox */}
                  </th>
                  <th style={{ width: `${colWidths.title}px` }}>
                    <div className="th-inner">
                      <span>商品名稱 / SKU</span>
                      <div 
                        className="resizer-handle"
                        onMouseDown={(e) => handleMouseDown('title', e)}
                      />
                    </div>
                  </th>
                  <th style={{ width: `${colWidths.category}px` }}>
                    <div className="th-inner">
                      <span>分類 / 代理</span>
                      <div 
                        className="resizer-handle"
                        onMouseDown={(e) => handleMouseDown('category', e)}
                      />
                    </div>
                  </th>
                  <th style={{ width: `${colWidths.status}px` }}>
                    <div className="th-inner justify-center">
                      <span>狀態</span>
                      <div 
                        className="resizer-handle"
                        onMouseDown={(e) => handleMouseDown('status', e)}
                      />
                    </div>
                  </th>
                  <th style={{ width: `${colWidths.listedAt}px` }}>
                    <div className="th-inner justify-center">
                      <span>上架時間</span>
                      <div 
                        className="resizer-handle"
                        onMouseDown={(e) => handleMouseDown('listedAt', e)}
                      />
                    </div>
                  </th>
                  <th style={{ width: `${colWidths.sales}px` }}>
                    <div className="th-inner justify-end">
                      <span>總銷量</span>
                      <div 
                        className="resizer-handle"
                        onMouseDown={(e) => handleMouseDown('sales', e)}
                      />
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {paginatedGroups.map(g => {
                  const isSingle = g.skus.length === 1;
                  const isExpanded = expandedGroups.has(g.title);
                  const selectedCount = g.skus.filter(s => selectedSkus.has(s.myacg_item_code)).length;
                  const allSelected = selectedCount === g.skus.length && g.skus.length > 0;
                  const someSelected = selectedCount > 0 && !allSelected;

                  // Soft Tagpill badge rendering
                  const renderGroupTags = () => {
                    const tags = [];
                    const titleNorm = g.title.toLowerCase().replace(/[\s!\uff01\?\uff1f\-_\(\)\uff08\uff09\.\*,]/g, '');
                    
                    if (titleNorm.includes('hololive')) {
                      tags.push(<span key="hololive" className="tag-pill tag-hololive">Hololive</span>);
                    }
                    if (titleNorm.includes('vspo') || titleNorm.includes('ぶいすぽ')) {
                      tags.push(<span key="vspo" className="tag-pill tag-vspo">VSPO</span>);
                    }
                    
                    const type = g.skus[0]?.listing_type;
                    if (type === '代理版') {
                      tags.push(<span key="proxy" className="tag-pill tag-proxy">代理版</span>);
                    } else if (type === '日本代購') {
                      tags.push(<span key="japan" className="tag-pill tag-japan">日本代購</span>);
                    } else if (type === '現貨') {
                      tags.push(<span key="instock" className="tag-pill tag-instock">現貨</span>);
                    } else if (type) {
                      tags.push(<span key="other" className="tag-pill tag-other">{type}</span>);
                    }
                    
                    return <div className="flex gap-xs flex-wrap">{tags}</div>;
                  };

                  return (
                    <React.Fragment key={g.title}>
                      <tr 
                        className="group-row"
                        onClick={(e) => {
                          if (!isSingle) toggleGroupExpand(g.title, e);
                        }}
                        style={{ 
                          backgroundColor: selectedCount > 0 ? '#eff6ff' : '#ffffff'
                        }}
                      >
                        <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                          <input 
                            type="checkbox" 
                            checked={allSelected} 
                            ref={input => { if (input) input.indeterminate = someSelected }}
                            onChange={() => handleGroupCheck(g)} 
                          />
                        </td>
                        <td>
                          <div className="flex-col" style={{ gap: '2px' }}>
                            <div style={{ 
                              fontWeight: 600, 
                              fontSize: '13px', 
                              color: '#0f172a', 
                              lineHeight: '1.3',
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              wordBreak: 'break-word'
                            }}>
                              <HighlightText text={g.title} highlight={searchTerm} />
                              {!isSingle && (
                                <span style={{ marginLeft: '6px', fontSize: '11px', padding: '1px 5px', borderRadius: '12px', backgroundColor: '#f1f5f9', color: '#64748b', fontWeight: 500 }}>
                                  {g.skus.length} 款
                                </span>
                              )}
                              {!isSingle && (
                                isExpanded ? <ChevronDown size={12} style={{ display: 'inline-block', marginLeft: '4px', verticalAlign: 'middle', color: '#94a3b8' }} /> : <ChevronRight size={12} style={{ display: 'inline-block', marginLeft: '4px', verticalAlign: 'middle', color: '#94a3b8' }} />
                              )}
                            </div>
                            
                            {isSingle && (
                              <div style={{ color: '#64748b', fontSize: '11px', display: 'flex', gap: '10px', marginTop: '1px', flexWrap: 'wrap' }}>
                                <span>SKU: <HighlightText text={g.skus[0].myacg_item_code} highlight={searchTerm} /></span>
                                {g.skus[0].raw_variant_name && (
                                  <span>規格: <HighlightText text={g.skus[0].raw_variant_name} highlight={searchTerm} /></span>
                                )}
                                <span style={{ fontWeight: 600, color: '#475569' }}>NT${g.minPrice}</span>
                              </div>
                            )}
                            {!isSingle && (
                              <div style={{ color: '#64748b', fontSize: '11px', display: 'flex', gap: '10px', marginTop: '1px' }}>
                                <span>價格區間: <span style={{ fontWeight: 600 }}>NT${g.minPrice === g.maxPrice ? g.minPrice : `${g.minPrice}~${g.maxPrice}`}</span></span>
                              </div>
                            )}
                          </div>
                        </td>
                        <td>
                          {renderGroupTags()}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: '8px', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                            {g.inPurchaseRecord ? (
                              <>
                                <span className="badge-status-added">
                                  <span className="dot-indicator dot-green"></span>
                                  <span>已加入</span>
                                </span>
                                <button 
                                  style={{ 
                                    fontSize: '11px', 
                                    color: '#475569', 
                                    backgroundColor: '#ffffff', 
                                    border: '1px solid #cbd5e1', 
                                    borderRadius: '6px', 
                                    padding: '3px 8px', 
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                    whiteSpace: 'nowrap',
                                    transition: 'all 0.15s'
                                  }}
                                  onClick={() => handleImportSingleGroup(g)}
                                  onMouseEnter={e => {
                                    e.currentTarget.style.backgroundColor = '#f8fafc';
                                    e.currentTarget.style.borderColor = '#94a3b8';
                                  }}
                                  onMouseLeave={e => {
                                    e.currentTarget.style.backgroundColor = '#ffffff';
                                    e.currentTarget.style.borderColor = '#cbd5e1';
                                  }}
                                >
                                  再次匯入
                                </button>
                              </>
                            ) : (
                              <>
                                <span className="badge-status-not-added">
                                  <span className="dot-indicator dot-red"></span>
                                  <span>未加入</span>
                                </span>
                                <button 
                                  style={{ 
                                    fontSize: '11px', 
                                    color: '#ffffff', 
                                    backgroundColor: '#2563eb', 
                                    border: 'none', 
                                    borderRadius: '6px', 
                                    padding: '3px 8px', 
                                    fontWeight: 600, 
                                    cursor: 'pointer',
                                    whiteSpace: 'nowrap',
                                    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
                                    transition: 'all 0.15s'
                                  }}
                                  onClick={() => handleImportSingleGroup(g)}
                                  onMouseEnter={e => {
                                    e.currentTarget.style.backgroundColor = '#1d4ed8';
                                  }}
                                  onMouseLeave={e => {
                                    e.currentTarget.style.backgroundColor = '#2563eb';
                                  }}
                                >
                                  匯入訂購紀錄
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                        <td style={{ textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
                          {g.latest_listed_at ? g.latest_listed_at.split(' ')[0] : '-'}
                        </td>
                        <td style={{ textAlign: 'right', color: '#475569', fontSize: '13px', fontWeight: 500 }}>
                          {g.totalSold}
                        </td>
                      </tr>

                      {/* Nested SKU details */}
                      {!isSingle && isExpanded && g.skus.map(sku => (
                        <tr key={sku.myacg_item_code} style={{ backgroundColor: '#f8fafc' }}>
                          <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                            <input 
                              type="checkbox" 
                              checked={selectedSkus.has(sku.myacg_item_code)} 
                              onChange={() => handleSkuCheck(sku.myacg_item_code)} 
                            />
                          </td>
                          <td colSpan={2}>
                            <div className="flex-col justify-center" style={{ paddingLeft: '8px', gap: '2px' }}>
                              <div style={{ fontSize: '13px', color: '#475569', fontWeight: 600 }}>
                                <HighlightText text={sku.raw_variant_name || '無規格'} highlight={searchTerm} />
                              </div>
                              <div style={{ fontSize: '11px', color: '#94a3b8', display: 'flex', gap: '12px' }}>
                                <span>SKU: <HighlightText text={sku.myacg_item_code} highlight={searchTerm} /></span>
                                <span>價格: NT${sku.final_price}</span>
                              </div>
                            </div>
                          </td>
                          <td></td>
                          <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '12px' }}>
                            {sku.myacg_listed_at ? sku.myacg_listed_at.split(' ')[0] : '-'}
                          </td>
                          <td style={{ textAlign: 'right', color: '#64748b', fontSize: '13px' }}>
                            {sku.myacg_sold_quantity}
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="table-pagination-inv">
                <span className="pagination-info">
                  顯示 {(currentPage - 1) * PAGE_SIZE + 1} 到 {Math.min(currentPage * PAGE_SIZE, groups.length)} 項母體，共 {groups.length} 項
                </span>
                
                <div className="pagination-btn-group">
                  <button 
                    className="pagination-text-btn" 
                    disabled={currentPage === 1} 
                    onClick={() => setCurrentPage(1)}
                  >
                    首頁
                  </button>
                  <button 
                    className="pagination-text-btn" 
                    disabled={currentPage === 1} 
                    onClick={() => setCurrentPage(p => p - 1)}
                  >
                    上一頁
                  </button>
                  
                  {renderPageNumbers()}
                  
                  <button 
                    className="pagination-text-btn" 
                    disabled={currentPage === totalPages} 
                    onClick={() => setCurrentPage(p => p + 1)}
                  >
                    下一頁
                  </button>
                  <button 
                    className="pagination-text-btn" 
                    disabled={currentPage === totalPages} 
                    onClick={() => setCurrentPage(totalPages)}
                  >
                    末頁
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
