import { useState, useEffect, useRef } from 'react';
import { db } from '../lib/db';
import { Settings as SettingsIcon, Download, Upload, Trash2, Database } from 'lucide-react';

export default function Settings() {
  const [counts, setCounts] = useState({
    inventory: 0,
    salesOrders: 0,
    salesOrderItems: 0,
    productGroups: 0,
    productCategories: 0,
    productVariants: 0
  });
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadCounts();
  }, []);

  const loadCounts = async () => {
    const [inv, so, soi, pg, pc, pv] = await Promise.all([
      db.getInventory(),
      db.getSalesOrders(),
      db.getSalesOrderItems(),
      db.getProductGroups(),
      db.getProductCategories(),
      db.getProductVariants()
    ]);
    
    setCounts({
      inventory: inv.length,
      salesOrders: so.length,
      salesOrderItems: soi.length,
      productGroups: pg.length,
      productCategories: pc.length,
      productVariants: pv.length
    });
  };

  const handleExport = async () => {
    await db.exportData();
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const success = await db.importData(text);
      if (success) {
        alert('資料還原成功！');
        await loadCounts();
      } else {
        alert('還原失敗，格式不正確。');
      }
    } catch (err) {
      alert('讀取檔案失敗。');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleClearPurchaseRecords = async () => {
    if (confirm('確定要清空所有「訂購紀錄」(ProductGroup / Category / Variant) 嗎？\n您的「商品主檔」(Inventory) 將會保留。')) {
      await db.clearPurchaseRecords();
      alert('訂購紀錄已清空。');
      await loadCounts();
    }
  };

  const handleClear = async () => {
    if (confirm('警告：確定要清空所有資料嗎？此操作無法復原！\n強烈建議先點擊「匯出 JSON 備份」。')) {
      if (confirm('請再次確認，真的要清空所有資料庫？')) {
        await db.clearData();
        alert('資料已全數清空。');
        await loadCounts();
      }
    }
  };

  return (
    <div className="flex-col gap-lg" style={{ padding: '0 24px', maxWidth: '1200px', margin: '0 auto' }}>
      <div className="flex items-center gap-sm" style={{ padding: '16px 0', borderBottom: '1px solid var(--color-border)' }}>
        <SettingsIcon size={24} className="text-primary" />
        <div>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>系統設定</h1>
          <p className="text-muted text-sm" style={{ margin: 0, marginTop: '4px' }}>資料庫管理、備份與還原</p>
        </div>
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="card flex-col">
          <h3 style={{ margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Database size={18} className="text-primary" /> 
            資料庫狀態
          </h3>
          <div className="flex-col gap-sm" style={{ backgroundColor: 'var(--color-bg-base)', padding: '16px', borderRadius: '8px' }}>
            <div className="flex justify-between">
              <span className="text-muted text-sm">商品主檔 (InventoryItem)</span>
              <span className="font-semibold">{counts.inventory} 筆</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted text-sm">訂購紀錄母體 (ProductGroup)</span>
              <span className="font-semibold">{counts.productGroups} 筆</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted text-sm">商品分類 (ProductCategory)</span>
              <span className="font-semibold">{counts.productCategories} 筆</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted text-sm">商品 SKU (ProductVariant)</span>
              <span className="font-semibold">{counts.productVariants} 筆</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted text-sm">銷售訂單 (SalesOrder)</span>
              <span className="font-semibold">{counts.salesOrders} 筆</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted text-sm">訂單明細 (SalesOrderItem)</span>
              <span className="font-semibold">{counts.salesOrderItems} 筆</span>
            </div>
          </div>
        </div>

        <div className="card flex-col" style={{ gridColumn: 'span 2' }}>
          <h3 style={{ margin: '0 0 16px 0' }}>資料備份與還原</h3>
          <p className="text-muted text-sm" style={{ marginBottom: '24px' }}>
            所有的 ERP 資料目前皆儲存在您的瀏覽器本地端 (LocalStorage)。<br/>
            建議您在進行大量匯入或測試前，先將資料匯出為 JSON 檔案備份。
          </p>

          <div className="flex-col gap-md">
            <div className="flex items-center justify-between" style={{ padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
              <div>
                <div className="font-medium" style={{ marginBottom: '4px' }}>匯出 JSON 備份</div>
                <div className="text-xs text-muted">下載當前所有資料庫資料的 JSON 檔案。</div>
              </div>
              <button className="btn btn-outline" onClick={handleExport}>
                <Download size={16} /> 匯出 JSON
              </button>
            </div>

            <div className="flex items-center justify-between" style={{ padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
              <div>
                <div className="font-medium" style={{ marginBottom: '4px' }}>匯入 JSON 還原</div>
                <div className="text-xs text-muted">從先前的備份檔案還原資料 (會覆蓋現有資料)。</div>
              </div>
              <button className="btn btn-primary" onClick={handleImportClick}>
                <Upload size={16} /> 匯入還原
              </button>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                accept=".json" 
                style={{ display: 'none' }} 
              />
            </div>

            <div className="flex items-center justify-between" style={{ padding: '16px', border: '1px solid var(--color-warning)', backgroundColor: 'rgba(245, 158, 11, 0.05)', borderRadius: '8px' }}>
              <div>
                <div className="font-medium text-warning" style={{ marginBottom: '4px' }}>重新解析商品規格</div>
                <div className="text-xs text-muted">修正因為舊版匯入導致的規格未正確切分問題。</div>
              </div>
              <button className="btn" style={{ backgroundColor: 'var(--color-warning)', color: 'white' }} onClick={async () => {
                if (confirm('確定要重新解析商品規格？不會刪除任何訂單與採購資料。')) {
                  await db.reparseProductVariants();
                  alert('解析完成');
                  await loadCounts();
                }
              }}>
                重新解析
              </button>
            </div>

            <div className="flex items-center justify-between" style={{ padding: '16px', border: '1px solid var(--color-warning)', backgroundColor: 'rgba(245, 158, 11, 0.05)', borderRadius: '8px' }}>
              <div>
                <div className="font-medium text-warning" style={{ marginBottom: '4px' }}>清空訂購紀錄資料</div>
                <div className="text-xs text-muted">只清除訂購紀錄 (Group/Category/Variant)，不影響商品主檔。</div>
              </div>
              <button className="btn" style={{ backgroundColor: 'var(--color-warning)', color: 'white' }} onClick={handleClearPurchaseRecords}>
                <Trash2 size={16} /> 清空紀錄
              </button>
            </div>

            <div className="flex items-center justify-between" style={{ padding: '16px', border: '1px solid var(--color-danger)', backgroundColor: '#FEF2F2', borderRadius: '8px' }}>
              <div>
                <div className="font-medium text-danger" style={{ marginBottom: '4px' }}>危險操作：清空全部資料</div>
                <div className="text-xs text-danger" style={{ opacity: 0.8 }}>將清空所有測試與正式資料，操作無法復原。</div>
              </div>
              <button className="btn" style={{ backgroundColor: 'var(--color-danger)', color: 'white' }} onClick={handleClear}>
                <Trash2 size={16} /> 清空 Reset
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
