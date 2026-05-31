import React, { useState, useRef, useEffect } from 'react';
import { db, normalizeProductTitle } from '../lib/db';
import type { ProductGroup, ProductVariant, SalesOrder, SalesOrderItem, ImportBatch } from '../lib/db';
import { Upload, ListOrdered, X, CheckCircle, AlertTriangle, FileBox, FileText, ChevronDown, ChevronRight, Clock } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';
import { parseMyAcgOrderFile } from '../utils/myacgParser';
import type { ParsedMyAcgOrder } from '../utils/myacgParser';

interface ImportReport {
  fileName: string;
  totalOrdersRead: number;
  validOrdersCount: number;
  cancelledSkipped: number;
  duplicateSkipped: number;
  newOrderItemsCount: number;
  newGroupCount: number;
  autoAddedVariantsCount: number;
  filledExistingVariantsCount: number;
  missingCatalogCount: number;
  newGroupTitles: string[];
  missingCatalogList: ParsedMyAcgOrder[];
  // Data ready to save
  pendingVariants: ProductVariant[];
  pendingGroups: ProductGroup[];
  pendingOrders: SalesOrder[];
  pendingOrderItems: SalesOrderItem[];
  
  // Explicit details for ImportBatch log
  duplicateItemsList: ParsedMyAcgOrder[];
}

export default function OrdersImport() {
  const [isImporting, setIsImporting] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [expandedBatchIds, setExpandedBatchIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadBatches();
  }, []);

  const loadBatches = async () => {
    const data = await db.getImportBatches();
    // Sort from newest to oldest
    data.sort((a, b) => new Date(b.imported_at).getTime() - new Date(a.imported_at).getTime());
    setBatches(data);
  };

  const toggleBatch = (id: string) => {
    const next = new Set(expandedBatchIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedBatchIds(next);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setIsConfirmed(false);
    try {
      const rawItems = await parseMyAcgOrderFile(file);
      const totalOrdersRead = rawItems.length;
      const validItems = rawItems.filter(i => !i.order_status.includes('已取消'));
      const cancelledSkipped = totalOrdersRead - validItems.length;

      const allVariants = await db.getProductVariants();
      const allInventory = await db.getInventory();
      const allGroups = await db.getProductGroups();
      const existingOrders = await db.getSalesOrders();
      const existingOrderItems = await db.getSalesOrderItems();

      // Deduplication
      const existingItemKeys = new Set(existingOrderItems.map(i => `${i.order_id}_${i.myacg_item_code}_${i.variant_name || ''}_${i.price || 0}`));
      const existingOrderIds = new Set(existingOrders.map(o => o.order_number));

      let newGroupCount = 0;
      let autoAddedVariantsCount = 0;
      let filledExistingVariantsCount = 0;
      let missingCatalogCount = 0;
      let duplicateSkipped = 0;
      let newOrderItemsCount = 0;
      
      const newGroupTitles = new Set<string>();
      const missingCatalogList: ParsedMyAcgOrder[] = [];
      const sessionCreatedGroupIds = new Set<string>();

      const pendingVariants = JSON.parse(JSON.stringify(allVariants)) as ProductVariant[];
      const pendingGroups = JSON.parse(JSON.stringify(allGroups)) as ProductGroup[];
      const pendingOrdersMap = new Map<string, SalesOrder>();
      const pendingOrderItems: SalesOrderItem[] = [];
      const duplicateItemsList: ParsedMyAcgOrder[] = [];

      const requiredSkus = new Set(validItems.map(i => i.item_code));

      for (const sku of requiredSkus) {
        const inventoryItem = allInventory.find((i: any) => i.myacg_item_code === sku);
        let groupIdToUse = '';

        if (inventoryItem) {
          const groupTitle = inventoryItem.normalized_product_title || normalizeProductTitle(inventoryItem.product_title);
          let group = pendingGroups.find(g => g.title === groupTitle || g.normalized_title === groupTitle);
          
          if (!group) {
            const newGroupId = crypto.randomUUID();
            group = {
              id: newGroupId,
              title: groupTitle,
              purchase_date: new Date().toISOString().slice(0, 10),
              priority: 'Medium',
              closing_date: '',
              release_month: '',
              has_official_site: false,
              product_url: '',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              normalized_title: groupTitle
            };
            pendingGroups.push(group);
            newGroupCount++;
            newGroupTitles.add(groupTitle);
            sessionCreatedGroupIds.add(newGroupId);
            groupIdToUse = newGroupId;
          } else {
            groupIdToUse = group.id;
          }

          const groupInventoryItems = allInventory.filter((i: any) => 
            (i.normalized_product_title || normalizeProductTitle(i.product_title)) === groupTitle
          );

          for (const gi of groupInventoryItems) {
            const existingVar = pendingVariants.find(v => v.myacg_item_code === gi.myacg_item_code);
            if (!existingVar) {
              const newVar: ProductVariant = {
                id: crypto.randomUUID(),
                product_group_id: groupIdToUse,
                myacg_item_code: gi.myacg_item_code,
                product_title: gi.product_title,
                variant_name: gi.raw_variant_name || '',
                myacg_auto_quantity: 0,
                note: '',
                sort_order: 9999
              };
              pendingVariants.push(newVar);
              
              if (sessionCreatedGroupIds.has(groupIdToUse)) {
                autoAddedVariantsCount++;
              } else {
                filledExistingVariantsCount++;
              }
            }
          }
        } else {
          // Missing Catalog
          const orderDataForSku = validItems.find(i => i.item_code === sku);
          if (orderDataForSku) {
            const cleanedTitle = normalizeProductTitle(orderDataForSku.product_title);
            let group = pendingGroups.find(g => g.title === cleanedTitle || g.normalized_title === cleanedTitle);
            
            if (!group) {
              const newGroupId = crypto.randomUUID();
              group = {
                id: newGroupId,
                title: cleanedTitle,
                purchase_date: new Date().toISOString().slice(0, 10),
                priority: 'Medium',
                closing_date: '',
                release_month: '',
                has_official_site: false,
                product_url: '',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                normalized_title: cleanedTitle
              };
              pendingGroups.push(group);
              newGroupCount++;
              newGroupTitles.add(cleanedTitle);
              sessionCreatedGroupIds.add(newGroupId);
              groupIdToUse = newGroupId;
            } else {
              groupIdToUse = group.id;
            }

            const existingVar = pendingVariants.find(v => v.myacg_item_code === sku);
            if (!existingVar) {
              const newVar: ProductVariant = {
                id: crypto.randomUUID(),
                product_group_id: groupIdToUse,
                myacg_item_code: sku,
                product_title: orderDataForSku.product_title,
                variant_name: orderDataForSku.variant_name,
                myacg_auto_quantity: 0,
                note: '',
                sort_order: 9999,
                catalog_missing: true,
                source: 'myacg_order_import'
              };
              pendingVariants.push(newVar);
              missingCatalogCount++;
              missingCatalogList.push(orderDataForSku);
            }
          }
        }
      }

      for (const item of validItems) {
        const orderId = item.order_no ? `MYACG_${item.order_no}` : crypto.randomUUID(); 
        
        if (!existingOrderIds.has(item.order_no) && !pendingOrdersMap.has(orderId)) {
          pendingOrdersMap.set(orderId, {
            id: orderId,
            platform: 'myacg',
            order_number: item.order_no,
            buyer_name: item.buyer_name,
            created_at: new Date().toISOString()
          });
        }

        const itemKey = `${orderId}_${item.item_code}_${item.variant_name || ''}_${item.price || 0}`;
        if (existingItemKeys.has(itemKey)) {
          duplicateSkipped++;
          duplicateItemsList.push(item);
          continue; 
        }

        const matchingVariant = pendingVariants.find(v => v.myacg_item_code === item.item_code);
        
        pendingOrderItems.push({
          id: crypto.randomUUID(),
          order_id: orderId,
          product_variant_id: matchingVariant?.id,
          myacg_item_code: item.item_code,
          product_name: item.product_title,
          variant_name: item.variant_name,
          quantity: item.quantity,
          price: item.price,
          amount: item.amount,
          order_status: item.order_status
        });
        
        newOrderItemsCount++;
      }

      setReport({
        fileName: file.name,
        totalOrdersRead,
        validOrdersCount: validItems.length,
        cancelledSkipped,
        duplicateSkipped,
        newOrderItemsCount,
        newGroupCount,
        autoAddedVariantsCount,
        filledExistingVariantsCount,
        missingCatalogCount,
        newGroupTitles: Array.from(newGroupTitles),
        missingCatalogList,
        pendingVariants,
        pendingGroups,
        pendingOrders: Array.from(pendingOrdersMap.values()),
        pendingOrderItems,
        duplicateItemsList
      });

    } catch (error) {
      console.error(error);
      alert('預覽解析失敗：' + (error as Error).message);
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleConfirmImport = async () => {
    if (!report) return;
    
    setIsImporting(true);
    try {
      // Save Main Data
      await db.saveProductGroups(report.pendingGroups);
      await db.saveProductVariants(report.pendingVariants);
      const currentOrders = await db.getSalesOrders();
      await db.saveSalesOrders([...currentOrders, ...report.pendingOrders]);
      const currentOrderItems = await db.getSalesOrderItems();
      await db.saveSalesOrderItems([...currentOrderItems, ...report.pendingOrderItems]);

      // Save ImportBatch
      const newBatch: ImportBatch = {
        id: crypto.randomUUID(),
        platform: 'myacg',
        file_name: report.fileName,
        imported_at: new Date().toISOString(),
        total_rows: report.totalOrdersRead,
        valid_rows: report.validOrdersCount,
        skipped_cancelled_rows: report.cancelledSkipped,
        new_order_items: report.newOrderItemsCount,
        skipped_duplicate_items: report.duplicateSkipped,
        created_groups_count: report.newGroupCount,
        completed_group_skus_count: report.autoAddedVariantsCount + report.filledExistingVariantsCount,
        catalog_missing_count: report.missingCatalogCount,
        note: '',
        details: {
          newOrderItems: report.pendingOrderItems,
          skippedDuplicateItems: report.duplicateItemsList,
          createdGroups: report.newGroupTitles,
          completedGroupSkus: [],
          catalogMissingSkus: report.missingCatalogList
        }
      };

      const currentBatches = await db.getImportBatches();
      await db.saveImportBatches([...currentBatches, newBatch]);
      
      await loadBatches();

      setIsConfirmed(true);
    } catch (err) {
      console.error(err);
      alert('寫入資料庫時發生錯誤：' + (err as Error).message);
    } finally {
      setIsImporting(false);
    }
  };

  const modalOverlayStyle: React.CSSProperties = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
  };
  const modalStyle: React.CSSProperties = {
    backgroundColor: '#fff', borderRadius: '8px', width: '1000px', maxHeight: '90vh',
    display: 'flex', flexDirection: 'column', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)'
  };
  const modalHeaderStyle: React.CSSProperties = {
    padding: '16px 24px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
  };
  const modalBodyStyle: React.CSSProperties = {
    padding: '24px', overflowY: 'auto', flex: 1
  };
  const statBoxStyle: React.CSSProperties = {
    padding: '12px 8px', borderRadius: '8px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center'
  };

  return (
    <div className="flex-col gap-lg" style={{ padding: '0 24px', maxWidth: '1600px', margin: '0 auto' }}>
      <div className="flex justify-between items-center" style={{ padding: '16px 0', borderBottom: '1px solid var(--color-border)' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>訂單快速匯入</h1>
          <p className="text-muted text-sm" style={{ margin: 0, marginTop: '4px' }}>支援匯入買動漫訂單 CSV 檔案，自動儲存明細並重新計算需求數量。</p>
        </div>
        <div className="flex gap-sm">
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            accept=".csv" 
            style={{ display: 'none' }} 
          />
          <button className="btn btn-primary" onClick={handleImportClick} disabled={isImporting}>
            <Upload size={16} /> {isImporting ? '處理中...' : '匯入預覽'}
          </button>
        </div>
      </div>

      <div className="flex-col gap-md">
        <EmptyState
          icon={ListOrdered}
          title="準備匯入訂單"
          description="點擊右上角按鈕選擇訂單檔案。系統將進行二階段預覽解析，確認無誤後才正式寫入資料庫並重新計算商品需求。"
          actionLabel="選擇訂單檔案"
          onAction={handleImportClick}
        />
      </div>

      <div className="flex-col gap-md mt-8">
        <div className="flex items-center gap-sm" style={{ paddingBottom: '16px', borderBottom: '1px solid var(--color-border)' }}>
          <Clock size={20} className="text-primary" />
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>匯入紀錄</h2>
        </div>
        
        {batches.length === 0 ? (
          <p className="text-muted text-center" style={{ padding: '32px 0' }}>尚無匯入紀錄</p>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table className="erp-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: '40px' }}></th>
                  <th>匯入時間</th>
                  <th>平台</th>
                  <th>檔案名稱</th>
                  <th style={{ textAlign: 'right' }}>讀取明細</th>
                  <th style={{ textAlign: 'right' }}>新增明細</th>
                  <th style={{ textAlign: 'right' }}>重複跳過</th>
                  <th style={{ textAlign: 'right' }}>已取消跳過</th>
                  <th style={{ textAlign: 'right' }}>自動建立母體</th>
                  <th style={{ textAlign: 'right' }}>補齊 SKU</th>
                  <th style={{ textAlign: 'right' }}>主檔缺失</th>
                </tr>
              </thead>
              <tbody>
                {batches.map(batch => {
                  const isExpanded = expandedBatchIds.has(batch.id);
                  return (
                    <React.Fragment key={batch.id}>
                      <tr 
                        style={{ cursor: 'pointer', backgroundColor: isExpanded ? 'var(--color-bg-surface-active)' : '#fff' }}
                        onClick={() => toggleBatch(batch.id)}
                      >
                        <td style={{ textAlign: 'center' }}>
                          {isExpanded ? <ChevronDown size={18} className="text-muted" /> : <ChevronRight size={18} className="text-muted" />}
                        </td>
                        <td>{new Date(batch.imported_at).toLocaleString('zh-TW', { hour12: false })}</td>
                        <td>
                          <span style={{ backgroundColor: '#e0f2fe', color: '#0369a1', padding: '2px 8px', borderRadius: '12px', fontSize: '12px', fontWeight: 500 }}>
                            {batch.platform.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ fontWeight: 500 }}>{batch.file_name}</td>
                        <td style={{ textAlign: 'right' }}>{batch.total_rows}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: batch.new_order_items > 0 ? '#059669' : 'inherit' }}>{batch.new_order_items}</td>
                        <td style={{ textAlign: 'right', color: '#eab308' }}>{batch.skipped_duplicate_items}</td>
                        <td style={{ textAlign: 'right', color: '#94a3b8' }}>{batch.skipped_cancelled_rows}</td>
                        <td style={{ textAlign: 'right' }}>{batch.created_groups_count}</td>
                        <td style={{ textAlign: 'right' }}>{batch.completed_group_skus_count}</td>
                        <td style={{ textAlign: 'right', color: batch.catalog_missing_count > 0 ? '#dc2626' : 'inherit' }}>{batch.catalog_missing_count}</td>
                      </tr>
                      {isExpanded && (
                        <tr style={{ backgroundColor: '#f8fafc' }}>
                          <td></td>
                          <td colSpan={10} style={{ padding: '24px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
                              
                              <div>
                                <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600, color: '#059669' }}>
                                  本次新增訂單明細 ({batch.details.newOrderItems.length})
                                </h4>
                                <div style={{ maxHeight: '200px', overflowY: 'auto', backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                                  <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px' }}>
                                    {batch.details.newOrderItems.map((item: any, idx: number) => (
                                      <li key={idx} style={{ marginBottom: '4px' }}>
                                        <span className="text-muted">[{item.order_id.replace('MYACG_', '')}]</span> {item.product_name} - {item.variant_name} <span style={{ fontWeight: 600 }}>x{item.quantity}</span>
                                      </li>
                                    ))}
                                    {batch.details.newOrderItems.length === 0 && <span className="text-muted">無</span>}
                                  </ul>
                                </div>
                              </div>

                              <div>
                                <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600, color: '#eab308' }}>
                                  本次重複跳過明細 ({batch.details.skippedDuplicateItems.length})
                                </h4>
                                <div style={{ maxHeight: '200px', overflowY: 'auto', backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                                  <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px' }}>
                                    {batch.details.skippedDuplicateItems.map((item: any, idx: number) => (
                                      <li key={idx} style={{ marginBottom: '4px' }}>
                                        <span className="text-muted">[{item.order_no}]</span> {item.product_title} - {item.variant_name}
                                      </li>
                                    ))}
                                    {batch.details.skippedDuplicateItems.length === 0 && <span className="text-muted">無</span>}
                                  </ul>
                                </div>
                              </div>

                              <div>
                                <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600, color: '#2563eb' }}>
                                  本次自動建立商品母體 ({batch.details.createdGroups.length})
                                </h4>
                                <div style={{ maxHeight: '200px', overflowY: 'auto', backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                                  <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px' }}>
                                    {batch.details.createdGroups.map((title: string, idx: number) => (
                                      <li key={idx} style={{ marginBottom: '4px' }}>{title}</li>
                                    ))}
                                    {batch.details.createdGroups.length === 0 && <span className="text-muted">無</span>}
                                  </ul>
                                </div>
                              </div>

                              <div>
                                <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600, color: '#dc2626' }}>
                                  本次主檔缺失 SKU ({batch.details.catalogMissingSkus.length})
                                </h4>
                                <div style={{ maxHeight: '200px', overflowY: 'auto', backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                                  <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px' }}>
                                    {batch.details.catalogMissingSkus.map((item: any, idx: number) => (
                                      <li key={idx} style={{ marginBottom: '4px' }}>
                                        <span style={{ fontWeight: 600 }}>{item.item_code}</span>: {item.product_title} - {item.variant_name}
                                      </li>
                                    ))}
                                    {batch.details.catalogMissingSkus.length === 0 && <span className="text-muted">無</span>}
                                  </ul>
                                </div>
                              </div>

                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {report && (
        <div style={modalOverlayStyle}>
          <div style={modalStyle}>
            <div style={modalHeaderStyle}>
              <div className="flex items-center gap-sm">
                {isConfirmed ? <CheckCircle size={20} color="#059669" /> : <FileText size={20} color="#2563eb" />}
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: isConfirmed ? '#059669' : '#1e40af' }}>
                  {isConfirmed ? '匯入完成！已寫入資料庫' : '匯入預覽報告 (尚未寫入)'}
                </h3>
              </div>
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setReport(null)}>
                <X size={20} />
              </button>
            </div>
            <div style={modalBodyStyle}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '12px', marginBottom: '24px' }}>
                <div style={statBoxStyle}>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#334155' }}>{report.totalOrdersRead}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>讀取明細</div>
                </div>
                <div style={statBoxStyle}>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#3b82f6' }}>{report.validOrdersCount}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>有效明細</div>
                </div>
                <div style={statBoxStyle}>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#94a3b8' }}>{report.cancelledSkipped}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>已取消跳過</div>
                </div>
                <div style={statBoxStyle}>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#059669' }}>{report.newOrderItemsCount}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>新增訂單明細</div>
                </div>
                <div style={statBoxStyle}>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#eab308' }}>{report.duplicateSkipped}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>重複明細跳過</div>
                </div>
                <div style={statBoxStyle}>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#8b5cf6' }}>{report.newGroupCount}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>自動建立母體</div>
                </div>
                <div style={statBoxStyle}>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#14b8a6' }}>{report.filledExistingVariantsCount}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>補齊同母體 SKU</div>
                </div>
                <div style={statBoxStyle}>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#b91c1c' }}>{report.missingCatalogCount}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>主檔缺失 SKU</div>
                </div>
              </div>

              {report.newGroupTitles.length > 0 && (
                <div style={{ marginBottom: '24px', padding: '16px', backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px' }}>
                  <div className="flex items-center gap-sm" style={{ marginBottom: '8px', color: '#1d4ed8' }}>
                    <FileBox size={18} />
                    <h4 style={{ margin: 0, fontWeight: 600 }}>將自動加入的商品母體 ({report.newGroupCount} 筆)</h4>
                  </div>
                  <p style={{ margin: 0, fontSize: '13px', color: '#1e40af', marginBottom: '12px' }}>
                    包含底下相關的所有 SKU 共 {report.autoAddedVariantsCount} 筆將拉入紀錄表。
                  </p>
                  <div style={{ maxHeight: '150px', overflowY: 'auto' }}>
                    <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: '#1e3a8a' }}>
                      {report.newGroupTitles.map((title, idx) => (
                        <li key={idx} style={{ marginBottom: '4px' }}>{title}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {report.missingCatalogCount > 0 && (
                <div style={{ padding: '16px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px' }}>
                  <div className="flex items-center gap-sm" style={{ marginBottom: '8px', color: '#b91c1c' }}>
                    <AlertTriangle size={18} />
                    <h4 style={{ margin: 0, fontWeight: 600 }}>商品主檔缺失 SKU ({report.missingCatalogCount} 筆)</h4>
                  </div>
                  <p style={{ margin: 0, fontSize: '13px', color: '#991b1b', marginBottom: '12px' }}>
                    以下 SKU 存在於訂單，但在商品主檔中找不到，將建立臨時母體。
                  </p>
                  <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                    <table className="erp-table" style={{ width: '100%', fontSize: '13px', backgroundColor: '#fff' }}>
                      <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                        <tr>
                          <th>SKU</th>
                          <th>商品名稱</th>
                          <th>數量</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.missingCatalogList.map((v, i) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 500 }}>{v.item_code}</td>
                            <td>{v.product_title}</td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>{v.quantity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

            </div>
            <div style={{ padding: '16px 24px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
              {isConfirmed ? (
                <button className="btn btn-primary" onClick={() => setReport(null)}>完成關閉</button>
              ) : (
                <>
                  <button className="btn btn-ghost" onClick={() => setReport(null)} disabled={isImporting}>取消</button>
                  <button className="btn btn-primary" onClick={handleConfirmImport} disabled={isImporting}>
                    {isImporting ? '寫入中...' : '確認匯入'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
