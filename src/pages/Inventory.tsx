import React, { useState, useEffect, useRef, useMemo } from 'react';
import { db } from '../lib/db';
import type { InventoryItem, ProductGroup } from '../lib/db';
import { parseMyAcgFile } from '../utils/myacgParser';
import { Upload, RefreshCw, PackageX, ChevronDown, ChevronRight, Search } from 'lucide-react';
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

const ListingBadge = ({ type }: { type: string }) => {
  if (type === '代理版') {
    return <span style={{ backgroundColor: '#e0f2fe', color: '#0369a1', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>🟦 代理版</span>;
  }
  if (type === '日本代購') {
    return <span style={{ backgroundColor: '#dcfce7', color: '#15803d', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>🟩 日本代購</span>;
  }
  if (type === '現貨') {
    return <span style={{ backgroundColor: '#fef9c3', color: '#a16207', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>🟨 現貨</span>;
  }
  return <span style={{ backgroundColor: '#f1f5f9', color: '#475569', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>{type}</span>;
};

export default function Inventory() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [productGroups, setProductGroups] = useState<ProductGroup[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('all'); // 'all', 'proxy', 'japan', 'instock', 'added', 'not_added'
  
  // selectedSkus contains myacg_item_code
  const [selectedSkus, setSelectedSkus] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadItems();
  }, []);

  const loadItems = async () => {
    const data = await db.getInventory();
    setItems(data);
    const groups = await db.getProductGroups();
    setProductGroups(groups);
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
      const stats = await db.upsertInventory(parsedItems);
      
      // Sync ProductGroups with new inventory
      const syncStats = await db.syncProductGroupsWithInventory();
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
    try {
      await db.createPurchaseRecordFromInventory(Array.from(selectedSkus));
      alert(`已將 ${selectedSkus.size} 筆 SKU 建立/匯入訂購紀錄。`);
      setSelectedSkus(new Set());
      await loadItems(); // Refresh the "Added" status
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

    if (filterType === 'proxy') {
      filteredGroups = filteredGroups.filter(g => g.skus[0]?.listing_type === '代理版');
    } else if (filterType === 'japan') {
      filteredGroups = filteredGroups.filter(g => g.skus[0]?.listing_type === '日本代購');
    } else if (filterType === 'instock') {
      filteredGroups = filteredGroups.filter(g => g.skus[0]?.listing_type === '現貨');
    } else if (filterType === 'added') {
      filteredGroups = filteredGroups.filter(g => g.inPurchaseRecord);
    } else if (filterType === 'not_added') {
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

  }, [items, searchTerm, filterType, existingGroupTitles]);

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
  }, [searchTerm, filterType]);

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

  const getStatusBadge = (inPurchaseRecord: boolean) => {
    if (inPurchaseRecord) {
      return <span style={{ color: '#059669', fontSize: '12px', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '4px' }}>🟢 已加入</span>;
    }
    return <span style={{ color: '#dc2626', fontSize: '12px', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '4px' }}>🔴 未加入</span>;
  };

  const filters = [
    { id: 'all', label: '全部' },
    { id: 'proxy', label: '代理版' },
    { id: 'japan', label: '日本代購' },
    { id: 'instock', label: '現貨' },
    { id: 'added', label: '🟢 已加入訂購紀錄' },
    { id: 'not_added', label: '🔴 未加入訂購紀錄' },
  ];

  return (
    <div className="flex-col gap-lg" style={{ padding: '0 24px', maxWidth: '1600px', margin: '0 auto' }}>
      <div className="flex justify-between items-center" style={{ padding: '16px 0', borderBottom: '1px solid var(--color-border)' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>商品主檔</h1>
          <p className="text-muted text-sm" style={{ margin: 0, marginTop: '4px' }}>管理全部庫存，以 SKU 為基礎。</p>
        </div>
        <div className="flex gap-sm items-center">
          {selectedSkus.size > 0 && (
            <button className="btn btn-primary" onClick={handleCreatePurchaseRecords}>
              建立訂購紀錄 ({selectedSkus.size} 筆)
            </button>
          )}
          <button className="btn btn-outline" onClick={loadItems}>
            <RefreshCw size={16} /> 重新讀取
          </button>
          <button className="btn btn-primary" onClick={handleImportClick} disabled={isImporting}>
            <Upload size={16} /> {isImporting ? '匯入中...' : '匯入主檔 XLS'}
          </button>
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            accept=".xls,.xlsx,.html" 
            style={{ display: 'none' }} 
          />
        </div>
      </div>

      <div className="flex gap-md items-center" style={{ paddingBottom: '8px' }}>
        <div className="relative" style={{ marginRight: '8px' }}>
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted" size={16} />
          <input 
            type="text" 
            className="form-input" 
            placeholder="🔍 搜尋商品名稱、SKU、規格..." 
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ paddingLeft: '36px', width: '450px' }}
          />
        </div>
        
        <div className="flex gap-xs" style={{ flexWrap: 'wrap' }}>
          {filters.map(f => (
            <button
              key={f.id}
              onClick={() => setFilterType(f.id)}
              style={{
                padding: '4px 12px',
                borderRadius: '16px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
                border: filterType === f.id ? '1px solid #3b82f6' : '1px solid #e2e8f0',
                backgroundColor: filterType === f.id ? '#eff6ff' : '#fff',
                color: filterType === f.id ? '#1d4ed8' : '#475569',
                transition: 'all 0.1s'
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-col gap-md">
        {groups.length === 0 ? (
          <EmptyState
            icon={PackageX}
            title={searchTerm || filterType !== 'all' ? "找不到符合條件的商品" : "尚未匯入商品主檔"}
            description={searchTerm || filterType !== 'all' ? "請嘗試更換搜尋關鍵字或篩選條件。" : "請點擊匯入買動漫匯出檔案，建立系統內 SKU 與庫存數據。"}
            actionLabel={searchTerm || filterType !== 'all' ? undefined : "匯入 XLS"}
            onAction={searchTerm || filterType !== 'all' ? undefined : handleImportClick}
          />
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden', border: '1px solid #e2e8f0', borderRadius: '8px' }}>
            <table className="erp-table" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                  <th style={{ width: '48px', textAlign: 'center', padding: '12px 0' }}>
                    <input type="checkbox" 
                      checked={selectedSkus.size === items.length && items.length > 0} 
                      onChange={() => {
                        if (selectedSkus.size === items.length) {
                          setSelectedSkus(new Set());
                        } else {
                          setSelectedSkus(new Set(items.map(i => i.myacg_item_code)));
                        }
                      }} 
                    />
                  </th>
                  <th style={{ width: '40px', padding: '12px 0' }}></th>
                  <th style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 500, color: '#475569' }}>商品資訊</th>
                  <th style={{ width: '120px', textAlign: 'center', padding: '12px 8px', fontWeight: 500, color: '#475569' }}>狀態</th>
                  <th style={{ width: '100px', textAlign: 'center', padding: '12px 8px', fontWeight: 500, color: '#475569' }}>上架時間</th>
                  <th style={{ width: '80px', textAlign: 'right', padding: '12px 8px', fontWeight: 500, color: '#475569' }}>總銷量</th>
                  <th style={{ width: '120px', textAlign: 'right', padding: '12px 16px', fontWeight: 500, color: '#475569' }}>價格</th>
                </tr>
              </thead>
              <tbody>
                {paginatedGroups.map(g => {
                  const isSingle = g.skus.length === 1;
                  const isExpanded = expandedGroups.has(g.title);
                  const selectedCount = g.skus.filter(s => selectedSkus.has(s.myacg_item_code)).length;
                  const allSelected = selectedCount === g.skus.length && g.skus.length > 0;
                  const someSelected = selectedCount > 0 && !allSelected;

                  return (
                    <React.Fragment key={g.title}>
                      {/* Group / Single Header Row */}
                      <tr 
                        onClick={(e) => {
                          if (!isSingle) toggleGroupExpand(g.title, e);
                        }}
                        style={{ 
                          cursor: isSingle ? 'default' : 'pointer', 
                          backgroundColor: selectedCount > 0 ? '#eff6ff' : '#fff',
                          borderBottom: '1px solid #f1f5f9'
                        }}
                      >
                        <td style={{ textAlign: 'center', padding: '12px 0' }} onClick={e => e.stopPropagation()}>
                          <input 
                            type="checkbox" 
                            checked={allSelected} 
                            ref={input => { if (input) input.indeterminate = someSelected }}
                            onChange={() => handleGroupCheck(g)} 
                          />
                        </td>
                        <td style={{ textAlign: 'center', padding: '12px 0' }}>
                          {!isSingle && (
                            isExpanded ? <ChevronDown size={16} className="text-muted"/> : <ChevronRight size={16} className="text-muted"/>
                          )}
                        </td>
                        <td style={{ padding: '12px 8px', verticalAlign: 'middle' }}>
                          <div className="flex items-center gap-sm" style={{ marginBottom: isSingle ? '4px' : '0' }}>
                            <span style={{ fontWeight: 600, fontSize: '15px', color: '#0f172a' }}>
                              <HighlightText text={g.title} highlight={searchTerm} />
                            </span>
                            {g.skus[0]?.listing_type && (
                              <ListingBadge type={g.skus[0].listing_type} />
                            )}
                            {!isSingle && (
                              <span style={{ backgroundColor: '#f1f5f9', color: '#64748b', fontSize: '11px', padding: '2px 6px', borderRadius: '12px', fontWeight: 500 }}>
                                {g.skus.length} 款
                              </span>
                            )}
                          </div>
                          
                          {isSingle && (
                            <div className="flex gap-md text-sm" style={{ color: '#64748b', fontSize: '12px', alignItems: 'center' }}>
                              <span>SKU: <HighlightText text={g.skus[0].myacg_item_code} highlight={searchTerm} /></span>
                              {g.skus[0].raw_variant_name && (
                                <span>規格: <HighlightText text={g.skus[0].raw_variant_name} highlight={searchTerm} /></span>
                              )}
                            </div>
                          )}
                        </td>
                        <td style={{ textAlign: 'center', padding: '12px 8px' }}>
                          <div className="flex justify-center">
                            {getStatusBadge(g.inPurchaseRecord)}
                          </div>
                        </td>
                        <td style={{ textAlign: 'center', color: '#64748b', fontSize: '13px', padding: '12px 8px' }}>
                          {g.latest_listed_at ? g.latest_listed_at.split(' ')[0] : '-'}
                        </td>
                        <td style={{ textAlign: 'right', color: '#475569', fontSize: '14px', padding: '12px 8px' }}>{g.totalSold}</td>
                        <td style={{ textAlign: 'right', color: '#0f172a', fontWeight: 500, fontSize: '14px', padding: '12px 16px' }}>
                          NT${g.minPrice === g.maxPrice ? g.minPrice : `${g.minPrice}~${g.maxPrice}`}
                        </td>
                      </tr>

                      {/* Expanded SKU Rows (only for multi-SKU groups) */}
                      {!isSingle && isExpanded && g.skus.map(sku => (
                        <tr key={sku.myacg_item_code} style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ textAlign: 'center', padding: '8px 0' }}>
                            <input 
                              type="checkbox" 
                              checked={selectedSkus.has(sku.myacg_item_code)} 
                              onChange={() => handleSkuCheck(sku.myacg_item_code)} 
                            />
                          </td>
                          <td></td>
                          <td colSpan={2} style={{ padding: '8px 8px' }}>
                            <div className="flex-col justify-center" style={{ paddingLeft: '8px' }}>
                              <div style={{ fontSize: '13px', color: '#475569', fontWeight: 500 }}>
                                <HighlightText text={sku.raw_variant_name || '無規格'} highlight={searchTerm} />
                              </div>
                              <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                                SKU: <HighlightText text={sku.myacg_item_code} highlight={searchTerm} />
                              </div>
                            </div>
                          </td>
                          <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '12px', padding: '8px 8px' }}>
                            {sku.myacg_listed_at ? sku.myacg_listed_at.split(' ')[0] : '-'}
                          </td>
                          <td style={{ textAlign: 'right', color: '#64748b', fontSize: '13px', padding: '8px 8px' }}>{sku.myacg_sold_quantity}</td>
                          <td style={{ textAlign: 'right', color: '#475569', fontSize: '13px', padding: '8px 16px' }}>NT${sku.final_price}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            
            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex justify-between items-center" style={{ padding: '12px 16px', borderTop: '1px solid #e2e8f0', backgroundColor: '#f8fafc' }}>
                <span className="text-sm text-muted">
                  顯示 {(currentPage - 1) * PAGE_SIZE + 1} 到 {Math.min(currentPage * PAGE_SIZE, groups.length)} 項母體，共 {groups.length} 項
                </span>
                <div className="flex gap-xs">
                  <button 
                    className="btn btn-outline" 
                    disabled={currentPage === 1} 
                    onClick={() => setCurrentPage(p => p - 1)}
                    style={{ padding: '4px 12px', fontSize: '13px' }}
                  >
                    上一頁
                  </button>
                  <span className="flex items-center text-sm font-medium" style={{ padding: '0 8px', color: '#475569' }}>
                    {currentPage} / {totalPages}
                  </span>
                  <button 
                    className="btn btn-outline" 
                    disabled={currentPage === totalPages} 
                    onClick={() => setCurrentPage(p => p + 1)}
                    style={{ padding: '4px 12px', fontSize: '13px' }}
                  >
                    下一頁
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
