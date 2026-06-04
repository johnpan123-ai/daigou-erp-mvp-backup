import React, { useState, useRef, useEffect, useMemo } from 'react';
import { normalizeProductTitle } from '../lib/db';
import { dataProvider } from '../providers/dataProvider';
import type { ProductGroup, ProductVariant, SalesOrder, SalesOrderItem, ImportBatch } from '../lib/db';
import { Upload, ListOrdered, X, CheckCircle, AlertTriangle, FileBox, FileText, ChevronDown, ChevronRight, Clock } from 'lucide-react';
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
  cancelledOrderNos?: string[];
}

export default function OrdersImport() {
  const [isImporting, setIsImporting] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [expandedBatchIds, setExpandedBatchIds] = useState<Set<string>>(new Set());
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [refreshTime, setRefreshTime] = useState<string>('');

  useEffect(() => {
    loadBatches();
  }, []);

  const loadBatches = async () => {
    const data = await dataProvider.getImportBatches();
    // Sort from newest to oldest
    data.sort((a, b) => new Date(b.imported_at).getTime() - new Date(a.imported_at).getTime());
    setBatches(data);

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    setRefreshTime(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`);
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

      const allVariants = await dataProvider.getProductVariants();
      const allInventory = await dataProvider.getInventory();
      const allGroups = await dataProvider.getProductGroups();
      const existingOrders = await dataProvider.getSalesOrders();
      const existingOrderItems = await dataProvider.getSalesOrderItems();

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

      const csvCancelledOrderNos = Array.from(new Set(
        rawItems.filter(i => i.order_status.includes('已取消')).map(i => i.order_no)
      ));

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
        duplicateItemsList,
        cancelledOrderNos: csvCancelledOrderNos
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
      await dataProvider.saveProductGroups(report.pendingGroups);
      await dataProvider.saveProductVariants(report.pendingVariants);
      const currentOrders = await dataProvider.getSalesOrders();
      await dataProvider.saveSalesOrders([...currentOrders, ...report.pendingOrders]);
      const currentOrderItems = await dataProvider.getSalesOrderItems();
      
      const csvCancelledOrderNos = new Set(report.cancelledOrderNos || []);
      const updatedOrderItems = currentOrderItems.map(item => {
        const order = currentOrders.find(o => o.id === item.order_id);
        if (order && csvCancelledOrderNos.has(order.order_number)) {
          return { ...item, order_status: '已取消' };
        }
        return item;
      });

      await dataProvider.saveSalesOrderItems([...updatedOrderItems, ...report.pendingOrderItems]);

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

      const currentBatches = await dataProvider.getImportBatches();
      await dataProvider.saveImportBatches([...currentBatches, newBatch]);
      
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

  const filteredBatches = useMemo(() => {
    if (filterStatus === 'all') return batches;
    if (filterStatus === 'completed') {
      return batches.filter(b => b.catalog_missing_count === 0);
    }
    if (filterStatus === 'partial') {
      return batches.filter(b => b.catalog_missing_count > 0);
    }
    return batches;
  }, [batches, filterStatus]);

  return (
    <div className="import-container">
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileChange} 
        accept=".csv" 
        style={{ display: 'none' }} 
      />
      <style>{`
        .import-container {
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

        .import-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding-bottom: 8px;
          flex-wrap: wrap;
          gap: 16px;
        }

        .import-title-area h1 {
          font-size: 26px;
          font-weight: 700;
          color: #0f172a;
          margin: 0 0 6px 0;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .import-title-area p {
          font-size: 14px;
          color: #64748b;
          margin: 0;
        }

        .import-header-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .import-update-time {
          font-size: 12px;
          color: #64748b;
          background-color: #ffffff;
          padding: 6px 12px;
          border-radius: 9999px;
          border: 1px solid #e2e8f0;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
        }

        .btn-refresh {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          font-size: 12px;
          font-weight: 600;
          color: #475569;
          background: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 9999px;
          cursor: pointer;
          transition: all 0.15s ease;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
        }

        .btn-refresh:hover {
          background-color: #f8fafc;
          border-color: #94a3b8;
          color: #1e293b;
        }

        .btn-refresh:active {
          transform: scale(0.98);
        }

        /* Outer actions wrapper */
        .import-actions-wrapper {
          background-color: #ffffff;
          border-radius: 16px;
          padding: 24px;
          border: 1px solid #e2e8f0;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
          box-sizing: border-box;
          width: 100%;
        }

        /* Two card layout */
        .import-cards-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
          width: 100%;
        }

        @media (max-width: 768px) {
          .import-cards-grid {
            grid-template-columns: 1fr;
          }
        }

        .import-card {
          padding: 24px;
          display: flex;
          gap: 20px;
          align-items: flex-start;
          border-radius: 12px;
          box-sizing: border-box;
          height: 100%;
          min-height: 200px;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        }

        .import-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 15px -3px rgba(0,0,0,0.05), 0 4px 6px -2px rgba(0,0,0,0.05);
        }

        .import-card.left-card {
          background-color: #ffffff;
          border: 1px solid #e2e8f0;
        }

        .import-card.right-card {
          background-color: #f0f7ff;
          border: 1px solid #bfdbfe;
        }

        .import-card-icon {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background-color: #2563eb;
          color: #ffffff;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          box-shadow: 0 2px 4px rgba(37, 99, 235, 0.2);
        }

        .import-card-content {
          display: flex;
          flex-direction: column;
          gap: 16px;
          flex: 1;
          min-width: 0;
        }

        .import-card-title {
          margin: 0;
          font-size: 16px;
          font-weight: 700;
          color: #0f172a;
        }

        .import-card-desc {
          margin: 4px 0 0 0;
          font-size: 13px;
          color: #64748b;
        }

        .import-card-btn-area {
          display: flex;
          gap: 10px;
        }

        .btn-import-primary {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 20px;
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

        .btn-import-primary:hover {
          background-color: #1d4ed8;
        }

        .btn-import-primary:active {
          transform: scale(0.98);
        }

        .btn-import-secondary {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 20px;
          font-size: 14px;
          font-weight: 600;
          color: #475569;
          background-color: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        }

        .btn-import-secondary:hover {
          background-color: #f8fafc;
          border-color: #94a3b8;
          color: #1e293b;
        }

        .btn-import-secondary:active {
          transform: scale(0.98);
        }

        .import-card-tip {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          font-size: 12px;
          line-height: 1.5;
        }

        .tip-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          font-size: 10px;
          font-weight: 700;
          flex-shrink: 0;
          margin-top: 1px;
        }

        .tip-badge-grey {
          background-color: #64748b;
          color: #ffffff;
        }

        .tip-badge-blue {
          background-color: #2563eb;
          color: #ffffff;
        }

        /* History Card */
        .history-card {
          background-color: #ffffff;
          border-radius: 16px;
          border: 1px solid #e2e8f0;
          box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03);
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          width: 100%;
          box-sizing: border-box;
        }

        .history-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .history-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 18px;
          font-weight: 700;
          color: #0f172a;
          margin: 0;
        }

        .history-select {
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 600;
          color: #475569;
          background-color: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          cursor: pointer;
          outline: none;
          transition: all 0.15s ease;
        }

        .history-select:hover {
          border-color: #94a3b8;
        }

        .import-table-card {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
        }

        .import-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
          font-size: 13px;
        }

        .import-table th {
          padding: 16px;
          font-weight: 600;
          color: #475569;
          font-size: 12px;
          background-color: #f8fafc;
          border-bottom: 1px solid #e2e8f0;
          white-space: nowrap;
        }

        .import-table tr {
          border-bottom: 1px solid #f1f5f9;
          transition: background-color 0.2s ease;
        }

        .import-table tbody tr.batch-row {
          cursor: pointer;
          height: 64px;
        }

        .import-table tbody tr.batch-row:hover {
          background-color: #f8fafc;
        }

        .import-table td {
          padding: 14px 16px;
          vertical-align: middle;
          box-sizing: border-box;
        }

        .import-table tbody tr:last-child {
          border-bottom: none;
        }

        /* Badges & Text styles */
        .badge-platform {
          background-color: #eff6ff;
          color: #2563eb;
          padding: 4px 10px;
          border-radius: 9999px;
          font-size: 11px;
          font-weight: 700;
          border: 1px solid #dbeafe;
          letter-spacing: 0.02em;
        }

        .badge-status-completed {
          display: inline-flex;
          align-items: center;
          padding: 4px 12px;
          font-size: 11px;
          font-weight: 600;
          border-radius: 9999px;
          background-color: #ecfdf5;
          color: #047857;
          border: 1px solid #a7f3d0;
        }

        .badge-status-partial {
          display: inline-flex;
          align-items: center;
          padding: 4px 12px;
          font-size: 11px;
          font-weight: 600;
          border-radius: 9999px;
          background-color: #fff7ed;
          color: #c2410c;
          border: 1px solid #fed7aa;
        }

        .text-count-new {
          font-weight: 600;
          color: #16a34a;
        }

        .text-count-skipped {
          font-weight: 600;
          color: #ea580c;
        }

        .text-count-missing {
          font-weight: 600;
          color: #dc2626;
        }

        /* Pagination style */
        .table-pagination {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 16px;
          padding-top: 16px;
          border-top: 1px solid #f1f5f9;
          font-size: 13px;
          color: #64748b;
        }
        .pagination-buttons {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .pagination-btn {
          width: 28px;
          height: 28px;
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
        .pagination-btn:hover:not(:disabled) {
          background-color: #f8fafc;
          border-color: #94a3b8;
        }
        .pagination-btn.active {
          background-color: #eff6ff;
          border-color: #3b82f6;
          color: #2563eb;
        }
        .pagination-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>

      {/* Header section */}
      <div className="import-header">
        <div className="import-title-area">
          <h1>訂單快速匯入</h1>
          <p>支援匯入買家訂單 CSV 檔案，自動進行明細並重新計算需求數量。</p>
        </div>
        <div className="import-header-actions">
          {refreshTime && (
            <span className="import-update-time">更新時間：{refreshTime}</span>
          )}
          <button className="btn-refresh" onClick={loadBatches} disabled={isImporting}>
            <Clock size={14} />
            <span>重新整理</span>
          </button>
        </div>
      </div>

      {/* Import Action Cards Section */}
      <div className="import-actions-wrapper">
        <div className="import-cards-grid">
          {/* 左卡：匯入訂單檔案 */}
          <div className="import-card left-card">
            <div className="import-card-icon">
              <Upload size={22} />
            </div>
            <div className="import-card-content">
              <div>
                <h3 className="import-card-title">匯入訂單檔案</h3>
                <p className="import-card-desc">支援 CSV 格式，最大檔案大小 10MB</p>
              </div>
              <div className="import-card-btn-area">
                <button className="btn-import-primary" onClick={handleImportClick} disabled={isImporting}>
                  <Upload size={16} /> <span>{isImporting ? '處理中...' : '匯入檔案'}</span>
                </button>
              </div>
              <div className="import-card-tip" style={{ color: '#64748b' }}>
                <span className="tip-badge tip-badge-grey">i</span>
                <span>CSV 欄位需求：商品編號、商品名稱、數量、單價、買家名稱（可選）</span>
              </div>
            </div>
          </div>

          {/* 右卡：準備匯入訂單 */}
          <div className="import-card right-card">
            <div className="import-card-icon">
              <ListOrdered size={22} />
            </div>
            <div className="import-card-content">
              <div>
                <h3 className="import-card-title">準備匯入訂單</h3>
                <p className="import-card-desc">選擇匯入檔案並預覽內容，確認後即可匯入系統</p>
              </div>
              <div className="import-card-btn-area">
                <button className="btn-import-secondary" onClick={handleImportClick} disabled={isImporting}>
                  <ListOrdered size={16} style={{ color: '#2563eb' }} /> <span style={{ color: '#2563eb' }}>選擇可匯入檔案</span>
                </button>
              </div>
              <div className="import-card-tip" style={{ color: '#2563eb' }}>
                <span className="tip-badge tip-badge-blue">i</span>
                <span>系統將進行二階段預覽解析，確認後進入正式匯入流程</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* History Card Section */}
      <div className="history-card">
        <div className="history-header">
          <div className="history-title">
            <Clock size={20} style={{ color: '#64748b' }} />
            <span>匯入紀錄</span>
          </div>
          <select 
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="history-select"
          >
            <option value="all">全部狀態</option>
            <option value="completed">匯入完成</option>
            <option value="partial">部分匯入</option>
          </select>
        </div>
        
        {filteredBatches.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '64px 24px', textAlign: 'center' }}>
            <div style={{ width: '64px', height: '64px', borderRadius: '50%', backgroundColor: '#f1f5f9', color: '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px' }}>
              <Clock size={32} />
            </div>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#475569' }}>尚無匯入紀錄</h3>
            <p style={{ margin: '8px 0 0 0', fontSize: '14px', color: '#94a3b8' }}>匯入訂單 CSV 後，紀錄會顯示在這裡</p>
          </div>
        ) : (
          <>
            <div className="import-table-card">
              <table className="import-table">
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
                    <th style={{ textAlign: 'right' }}>自動建立草稿</th>
                    <th style={{ textAlign: 'right' }}>補齊 SKU</th>
                    <th style={{ textAlign: 'right' }}>主檔缺失</th>
                    <th style={{ textAlign: 'center', width: '120px' }}>狀態</th>
                    <th style={{ width: '40px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBatches.map(batch => {
                    const isExpanded = expandedBatchIds.has(batch.id);
                    const isCompleted = batch.catalog_missing_count === 0;
                    return (
                      <React.Fragment key={batch.id}>
                        <tr 
                          className="batch-row"
                          style={{ backgroundColor: isExpanded ? '#f8fafc' : '#ffffff' }}
                          onClick={() => toggleBatch(batch.id)}
                        >
                          <td style={{ textAlign: 'center' }}>
                            {isExpanded ? <ChevronDown size={18} className="text-muted" /> : <ChevronRight size={18} className="text-muted" />}
                          </td>
                          <td style={{ color: '#475569', fontWeight: 500 }}>
                            {new Date(batch.imported_at).toLocaleString('zh-TW', { hour12: false })}
                          </td>
                          <td>
                            <span className="badge-platform">
                              {batch.platform.toUpperCase()}
                            </span>
                          </td>
                          <td style={{ fontWeight: 600, color: '#1e293b', wordBreak: 'break-all' }}>{batch.file_name}</td>
                          <td style={{ textAlign: 'right', fontWeight: 500, color: '#475569' }}>{batch.total_rows}</td>
                          <td style={{ textAlign: 'right' }} className="text-count-new">
                            {batch.new_order_items}
                          </td>
                          <td style={{ textAlign: 'right' }} className="text-count-skipped">
                            {batch.skipped_duplicate_items}
                          </td>
                          <td style={{ textAlign: 'right', color: '#64748b', fontWeight: 500 }}>{batch.skipped_cancelled_rows}</td>
                          <td style={{ textAlign: 'right', color: '#475569', fontWeight: 500 }}>{batch.created_groups_count}</td>
                          <td style={{ textAlign: 'right', color: '#475569', fontWeight: 500 }}>{batch.completed_group_skus_count}</td>
                          <td style={{ textAlign: 'right' }} className={batch.catalog_missing_count > 0 ? 'text-count-missing' : ''}>
                            {batch.catalog_missing_count}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <span className={isCompleted ? 'badge-status-completed' : 'badge-status-partial'}>
                              {isCompleted ? '匯入完成' : '部分匯入'}
                            </span>
                          </td>
                          <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '16px', fontWeight: 'bold' }} onClick={(e) => { e.stopPropagation(); toggleBatch(batch.id); }}>
                            •••
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr style={{ backgroundColor: '#f8fafc' }}>
                            <td></td>
                            <td colSpan={12} style={{ padding: '24px' }}>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
                                
                                <div>
                                  <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600, color: '#16a34a' }}>
                                    本次新增訂單明細 ({batch.details.newOrderItems.length})
                                  </h4>
                                  <div style={{ maxHeight: '200px', overflowY: 'auto', backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                                    <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: '#475569' }}>
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
                                  <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600, color: '#ea580c' }}>
                                    本次重複跳過明細 ({batch.details.skippedDuplicateItems.length})
                                  </h4>
                                  <div style={{ maxHeight: '200px', overflowY: 'auto', backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                                    <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: '#475569' }}>
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
                                    本次自動建立商品草稿 ({batch.details.createdGroups.length})
                                  </h4>
                                  <div style={{ maxHeight: '200px', overflowY: 'auto', backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                                    <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: '#475569' }}>
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
                                    <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: '#475569' }}>
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

            {/* Pagination */}
            <div className="table-pagination">
              <span>共 {filteredBatches.length} 筆</span>
              <div className="pagination-buttons">
                <button className="pagination-btn" disabled>&lt;</button>
                <button className="pagination-btn active">1</button>
                <button className="pagination-btn" disabled>&gt;</button>
              </div>
            </div>
          </>
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
