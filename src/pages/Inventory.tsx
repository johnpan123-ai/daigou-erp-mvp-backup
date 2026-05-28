import React, { useState, useEffect, useRef, useMemo } from 'react';
import { db } from '../lib/db';
import type { InventoryItem } from '../lib/db';
import { parseMyAcgFile } from '../utils/myacgParser';
import { Upload, RefreshCw, PackageX, ChevronDown, ChevronRight } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';

interface InventoryGroup {
  title: string;
  skus: InventoryItem[];
  totalStock: number;
  totalSold: number;
  minPrice: number;
  maxPrice: number;
}

export default function Inventory() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  
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
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    try {
      const parsedItems = await parseMyAcgFile(file);
      await db.upsertInventory(parsedItems);
      await loadItems();
      alert(`成功匯入/更新 ${parsedItems.length} 筆商品主檔`);
    } catch (err) {
      console.error(err);
      alert('匯入失敗，請確認檔案格式是否正確');
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCreatePurchaseRecords = async () => {
    if (selectedSkus.size === 0) return;
    try {
      await db.createPurchaseRecordFromInventory(Array.from(selectedSkus));
      alert(`成功為 ${selectedSkus.size} 項 SKU 建立/加入訂購紀錄！`);
      setSelectedSkus(new Set());
    } catch (e) {
      alert('建立失敗');
      console.error(e);
    }
  };

  // Grouping logic
  const groups = useMemo(() => {
    const map = new Map<string, InventoryGroup>();
    for (const item of items) {
      if (!map.has(item.product_title)) {
        map.set(item.product_title, {
          title: item.product_title,
          skus: [],
          totalStock: 0,
          totalSold: 0,
          minPrice: Infinity,
          maxPrice: -Infinity
        });
      }
      const g = map.get(item.product_title)!;
      g.skus.push(item);
      g.totalStock += item.myacg_available_quantity;
      g.totalSold += item.myacg_sold_quantity;
      if (item.final_price < g.minPrice) g.minPrice = item.final_price;
      if (item.final_price > g.maxPrice) g.maxPrice = item.final_price;
    }
    return Array.from(map.values()).sort((a, b) => b.totalSold - a.totalSold);
  }, [items]);

  // Pagination on Groups
  const PAGE_SIZE = 50;
  const totalPages = Math.ceil(groups.length / PAGE_SIZE);
  const paginatedGroups = groups.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const toggleGroupExpand = (title: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(expandedGroups);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    setExpandedGroups(next);
  };

  const handleGroupCheck = (g: InventoryGroup) => {
    const next = new Set(selectedSkus);
    // Are all SKUs in this group selected?
    const allSelected = g.skus.every(sku => next.has(sku.myacg_item_code));
    if (allSelected) {
      // Deselect all
      g.skus.forEach(sku => next.delete(sku.myacg_item_code));
    } else {
      // Select all
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

  return (
    <div className="flex-col gap-lg" style={{ padding: '0 24px', maxWidth: '1600px', margin: '0 auto' }}>
      <div className="flex justify-between items-center" style={{ padding: '16px 0', borderBottom: '1px solid var(--color-border)' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>商品主檔</h1>
          <p className="text-muted text-sm" style={{ margin: 0, marginTop: '4px' }}>管理所有庫存商品 SKU 與基礎資訊</p>
        </div>
        <div className="flex gap-sm">
          {selectedSkus.size > 0 && (
            <button className="btn btn-primary" onClick={handleCreatePurchaseRecords}>
              建立訂購紀錄 ({selectedSkus.size} 款)
            </button>
          )}
          <button className="btn btn-outline" onClick={loadItems}>
            <RefreshCw size={16} /> 重新整理
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

      <div className="flex-col gap-md">
        {groups.length === 0 ? (
          <EmptyState
            icon={PackageX}
            title="尚未匯入商品主檔"
            description="請先匯入買動漫的匯出檔案，建立系統內 SKU 與庫存清單"
            actionLabel="匯入 XLS"
            onAction={handleImportClick}
          />
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="erp-table" style={{ width: '100%', tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>
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
                  <th style={{ width: '40px' }}></th>
                  <th>母體商品名稱 (Product Title)</th>
                  <th style={{ width: '100px', textAlign: 'center' }}>SKU 款數</th>
                  <th style={{ width: '100px', textAlign: 'right' }}>總庫存</th>
                  <th style={{ width: '100px', textAlign: 'right' }}>總銷售</th>
                  <th style={{ width: '200px', textAlign: 'right' }}>價格範圍</th>
                </tr>
              </thead>
              <tbody>
                {paginatedGroups.map(g => {
                  const isExpanded = expandedGroups.has(g.title);
                  const selectedCount = g.skus.filter(s => selectedSkus.has(s.myacg_item_code)).length;
                  const allSelected = selectedCount === g.skus.length && g.skus.length > 0;
                  const someSelected = selectedCount > 0 && !allSelected;

                  return (
                    <React.Fragment key={g.title}>
                      {/* Group Header Row */}
                      <tr 
                        onClick={(e) => toggleGroupExpand(g.title, e)}
                        style={{ 
                          cursor: 'pointer', 
                          backgroundColor: selectedCount > 0 ? 'var(--color-bg-surface-active)' : 'transparent',
                          borderLeft: selectedCount > 0 ? '4px solid var(--color-primary)' : '4px solid transparent'
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
                        <td style={{ textAlign: 'center' }}>
                          {isExpanded ? <ChevronDown size={18} className="text-muted"/> : <ChevronRight size={18} className="text-muted"/>}
                        </td>
                        <td style={{ fontWeight: 600 }}>{g.title}</td>
                        <td style={{ textAlign: 'center' }}>{g.skus.length}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{g.totalStock}</td>
                        <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>{g.totalSold}</td>
                        <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>
                          NT${g.minPrice === g.maxPrice ? g.minPrice : `${g.minPrice}~${g.maxPrice}`}
                        </td>
                      </tr>

                      {/* Expanded SKU Rows */}
                      {isExpanded && g.skus.map(sku => (
                        <tr key={sku.myacg_item_code} style={{ backgroundColor: 'var(--color-bg-base)' }}>
                          <td style={{ textAlign: 'center' }}>
                            <input 
                              type="checkbox" 
                              checked={selectedSkus.has(sku.myacg_item_code)} 
                              onChange={() => handleSkuCheck(sku.myacg_item_code)} 
                            />
                          </td>
                          <td></td>
                          <td colSpan={2}>
                            <div className="flex gap-sm items-center text-sm">
                              <span className="text-muted" style={{ width: '120px' }}>{sku.myacg_item_code}</span>
                              <span style={{ fontWeight: 500 }}>{sku.raw_variant_name}</span>
                            </div>
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 500 }}>{sku.myacg_available_quantity}</td>
                          <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>{sku.myacg_sold_quantity}</td>
                          <td style={{ textAlign: 'right' }}>NT${sku.final_price}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            
            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex justify-between items-center" style={{ padding: '12px 16px', borderTop: '1px solid var(--color-border)', backgroundColor: 'var(--color-bg-base)' }}>
                <span className="text-sm text-muted">
                  顯示 {(currentPage - 1) * PAGE_SIZE + 1} 到 {Math.min(currentPage * PAGE_SIZE, groups.length)} 項商品母體，共 {groups.length} 項
                </span>
                <div className="flex gap-xs">
                  <button 
                    className="btn btn-outline" 
                    disabled={currentPage === 1} 
                    onClick={() => setCurrentPage(p => p - 1)}
                  >
                    上一頁
                  </button>
                  <span className="flex items-center text-sm font-medium" style={{ padding: '0 8px' }}>
                    {currentPage} / {totalPages}
                  </span>
                  <button 
                    className="btn btn-outline" 
                    disabled={currentPage === totalPages} 
                    onClick={() => setCurrentPage(p => p + 1)}
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
