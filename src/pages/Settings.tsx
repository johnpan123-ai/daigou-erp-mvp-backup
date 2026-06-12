import { useState, useEffect, useRef } from 'react';
import { dataProvider } from '../providers/dataProvider';
import { getProviderMode, setProviderMode } from '../providers/providerMode';
import { Settings as SettingsIcon, Download, Upload, Trash2, Database } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { useRole } from '../auth/useRole';

export default function Settings() {
  const { user } = useAuth();
  const { role, displayName } = useRole();
  const currentMode = getProviderMode();

  const [counts, setCounts] = useState({
    inventory: 0,
    salesOrders: 0,
    salesOrderItems: 0,
    productGroups: 0,
    productCategories: 0,
    productVariants: 0
  });
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [connectionStatus, setConnectionStatus] = useState<'未測試' | '連線成功' | '連線失敗'>('未測試');
  const [connectionDetail, setConnectionDetail] = useState<string>('');
  const [isTesting, setIsTesting] = useState<boolean>(false);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setConnectionStatus('未測試');
    setConnectionDetail('');
    try {
      const { supabaseProvider } = await import('../providers/cloud/supabaseProvider');
      const message = await supabaseProvider.testConnection();
      setConnectionStatus('連線成功');
      setConnectionDetail(`伺服器回傳訊息：${message}`);
    } catch (err: any) {
      setConnectionStatus('連線失敗');
      setConnectionDetail(`錯誤詳情：${err.message || err}`);
    } finally {
      setIsTesting(false);
    }
  };

  useEffect(() => {
    (window as any).dataProvider = dataProvider;
    loadCounts();
  }, []);

  const loadCounts = async () => {
    const [inv, so, soi, pg, pc, pv] = await Promise.all([
      dataProvider.getInventory(),
      dataProvider.getSalesOrders(),
      dataProvider.getSalesOrderItems(),
      dataProvider.getProductGroups(),
      dataProvider.getProductCategories(),
      dataProvider.getProductVariants()
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
    await dataProvider.exportData();
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (currentMode === 'cloud') {
      const confirmImport = window.confirm('目前為雲端模式，匯入此 JSON 備份將覆蓋雲端資料。是否確定還原？');
      if (!confirmImport) {
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
    }

    try {
      const text = await file.text();
      let success = false;

      if (currentMode === 'cloud') {
        let backupData;
        try {
          backupData = JSON.parse(text);
        } catch (parseErr: any) {
          throw new Error(`JSON 檔案解析失敗：${parseErr.message}`);
        }
        success = await dataProvider.restoreBackup(backupData);
      } else {
        success = await dataProvider.importData(text);
      }

      if (success) {
        alert('資料還原成功！');
        await loadCounts();
      } else {
        alert('還原失敗，格式不正確。');
      }
    } catch (err: any) {
      alert(`還原失敗：${err.message || err}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleClearPurchaseRecords = async () => {
    if (currentMode === 'cloud') {
      alert('雲端模式下不支援清空訂購紀錄！');
      return;
    }
    if (confirm('確定要清空所有「訂購紀錄」(ProductGroup / Category / Variant) 嗎？\n您的「商品主檔」(Inventory) 將會保留。')) {
      await dataProvider.clearPurchaseRecords();
      alert('訂購紀錄已清空。');
      await loadCounts();
    }
  };

  const handleClear = async () => {
    if (currentMode === 'cloud') {
      alert('雲端模式下不支援清空全部資料！');
      return;
    }
    if (confirm('警告：確定要清空所有資料嗎？此操作無法復原！\n強烈建議先點擊「匯出 JSON 備份」。')) {
      if (confirm('請再次確認，真的要清空所有資料庫？')) {
        await dataProvider.clearData();
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
              <button className="btn" style={{ backgroundColor: 'var(--color-warning)', color: 'white' }} disabled={currentMode === 'cloud'} onClick={async () => {
                if (confirm('確定要重新解析商品規格？不會刪除任何訂單與採購資料。')) {
                  await dataProvider.reparseProductVariants();
                  alert('解析完成');
                  await loadCounts();
                }
              }}>
                重新解析
              </button>
            </div>

            <div className="flex items-center justify-between" style={{ padding: '16px', border: '1px solid var(--color-warning)', backgroundColor: 'rgba(245, 158, 11, 0.05)', borderRadius: '8px' }}>
              <div>
                <div className="font-medium text-warning" style={{ marginBottom: '4px' }}>重新整理商品標題</div>
                <div className="text-xs text-muted">清理商品名稱中多餘的促銷/代購文字，僅保留商品主體。不影響原始名稱。</div>
              </div>
              <button className="btn" style={{ backgroundColor: 'var(--color-warning)', color: 'white' }} disabled={currentMode === 'cloud'} onClick={async () => {
                if (confirm('確定要重新整理所有商品標題嗎？')) {
                  await dataProvider.reparseProductTitles();
                  alert('清理完成');
                  await loadCounts();
                }
              }}>
                清理標題
              </button>
            </div>

            <div className="flex items-center justify-between" style={{ padding: '16px', border: '1px solid var(--color-warning)', backgroundColor: 'rgba(245, 158, 11, 0.05)', borderRadius: '8px' }}>
              <div>
                <div className="font-medium text-warning" style={{ marginBottom: '4px' }}>清空訂購紀錄資料</div>
                <div className="text-xs text-muted">只清除訂購紀錄 (Group/Category/Variant)，不影響商品主檔。</div>
              </div>
              <button className="btn" style={{ backgroundColor: 'var(--color-warning)', color: 'white' }} disabled={currentMode === 'cloud'} onClick={handleClearPurchaseRecords}>
                <Trash2 size={16} /> 清空紀錄
              </button>
            </div>

            <div className="flex items-center justify-between" style={{ padding: '16px', border: '1px solid var(--color-danger)', backgroundColor: '#FEF2F2', borderRadius: '8px' }}>
              <div>
                <div className="font-medium text-danger" style={{ marginBottom: '4px' }}>危險操作：清空全部資料</div>
                <div className="text-xs text-danger" style={{ opacity: 0.8 }}>將清空所有測試與正式資料，操作無法復原。</div>
              </div>
              <button className="btn" style={{ backgroundColor: 'var(--color-danger)', color: 'white' }} disabled={currentMode === 'cloud'} onClick={handleClear}>
                <Trash2 size={16} /> 清空 Reset
              </button>
            </div>
          </div>
        </div>

        {/* 資料來源模式 */}
        <div className="card flex-col" style={{ gridColumn: 'span 3' }}>
          <h3 style={{ margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Database size={18} className="text-primary" /> 
            資料來源模式
          </h3>
          <p className="text-muted text-sm" style={{ marginBottom: '16px' }}>
            設定系統的資料讀寫來源。目前系統雲端化規劃中，目前預設並強制為「本地模式」。
          </p>
          
          <div style={{ marginBottom: '16px', fontWeight: 600, fontSize: '14px', color: 'var(--color-text)' }}>
            目前模式：{getProviderMode() === 'local' ? '本地模式' : getProviderMode() === 'cloud' ? '雲端模式' : '備援模式'}
          </div>

          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            <label 
              onClick={() => {
                if (currentMode !== 'local') {
                  setProviderMode('local');
                  window.location.reload();
                }
              }}
              style={{ 
                border: currentMode === 'local' ? '2px solid var(--color-primary)' : '1px solid var(--color-border)', 
                borderRadius: '8px', 
                padding: '16px', 
                flex: '1', 
                minWidth: '200px', 
                cursor: 'pointer',
                position: 'relative',
                backgroundColor: currentMode === 'local' ? 'rgba(134, 59, 255, 0.05)' : 'transparent'
              }}
            >
              <input type="radio" checked={currentMode === 'local'} readOnly style={{ position: 'absolute', top: '16px', right: '16px' }} />
              <div className="font-semibold" style={{ fontSize: '15px', marginBottom: '4px' }}>本地模式（可用）</div>
              <div className="text-xs text-muted">使用瀏覽器 LocalStorage/IndexedDB 儲存資料，完全在本地執行。</div>
            </label>

            <label 
              onClick={() => {
                if (currentMode !== 'cloud') {
                  if (!user) {
                    console.log('[Provider Mode] blocked: login required');
                    if (confirm('請先登入後再使用雲端模式！點擊「確定」將為您導向登入頁面。')) {
                      window.location.href = '/login';
                    }
                    return;
                  }
                  setProviderMode('cloud');
                  window.location.reload();
                }
              }}
              style={{ 
                border: currentMode === 'cloud' ? '2px solid var(--color-primary)' : '1px solid var(--color-border)', 
                borderRadius: '8px', 
                padding: '16px', 
                flex: '1', 
                minWidth: '200px', 
                cursor: 'pointer',
                position: 'relative',
                backgroundColor: currentMode === 'cloud' ? 'rgba(134, 59, 255, 0.05)' : 'transparent'
              }}
            >
              <input type="radio" checked={currentMode === 'cloud'} readOnly style={{ position: 'absolute', top: '16px', right: '16px' }} />
              <div className={`font-semibold ${currentMode === 'cloud' ? '' : 'text-muted'}`} style={{ fontSize: '15px', marginBottom: '4px' }}>雲端模式</div>
              <div className="text-xs text-muted">與 Supabase 雲端資料庫同步，支援多使用者即時協同編輯。</div>
            </label>

            <label 
              onClick={() => alert('此模式尚未啟用，之後會在雲端化階段開放。')}
              style={{ 
                border: '1px solid var(--color-border)', 
                borderRadius: '8px', 
                padding: '16px', 
                flex: '1', 
                minWidth: '200px', 
                cursor: 'not-allowed',
                opacity: '0.6',
                position: 'relative'
              }}
            >
              <input type="radio" checked={false} readOnly style={{ position: 'absolute', top: '16px', right: '16px' }} />
              <div className="font-semibold text-muted" style={{ fontSize: '15px', marginBottom: '4px' }}>備援模式（尚未啟用）</div>
              <div className="text-xs text-muted">雲端模式無法連線時，自動切換至本地快取編輯，並在連線後自動同步。</div>
            </label>
          </div>
        </div>

        {/* Supabase 連線測試 */}
        {(() => {
          let statusBg = '#f7fafc';
          let statusColor = '#4a5568';
          let statusBorder = '#e2e8f0';

          if (connectionStatus === '連線成功') {
            statusBg = '#e6fffa';
            statusColor = '#319795';
            statusBorder = '#b2f5ea';
          } else if (connectionStatus === '連線失敗') {
            statusBg = '#fff5f5';
            statusColor = '#e53e3e';
            statusBorder = '#fed7d7';
          }

          return (
            <div className="card flex-col" style={{ gridColumn: 'span 3', marginTop: '16px' }}>
              <h3 style={{ margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Database size={18} className="text-primary" /> 
                Supabase 連線測試 (POC)
              </h3>
              <p className="text-muted text-sm" style={{ marginBottom: '16px' }}>
                驗證雲端模式所需的 API 連線狀態。此功能會向 Supabase 查詢健康檢查測試資料表 (erp_healthcheck)。
              </p>

              <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div>
                  <strong>目前模式：</strong>{currentMode === 'local' ? '本地模式' : currentMode === 'cloud' ? '雲端模式' : '備援模式'}
                </div>
                <div>
                  <strong>Supabase 狀態：</strong>
                  <span className="badge" style={{ 
                    padding: '2px 8px', 
                    borderRadius: '4px',
                    fontSize: '12px',
                    fontWeight: 600,
                    backgroundColor: statusBg,
                    color: statusColor,
                    border: `1px solid ${statusBorder}`
                  }}>
                    {connectionStatus}
                  </span>
                </div>
                {connectionDetail && (
                  <div style={{ fontSize: '13px', padding: '8px 12px', borderRadius: '4px', backgroundColor: 'var(--color-bg-base)', border: '1px solid var(--color-border)', wordBreak: 'break-all' }}>
                    {connectionDetail}
                  </div>
                )}
              </div>

              <div>
                <button 
                  className="btn btn-primary" 
                  onClick={handleTestConnection}
                  disabled={isTesting}
                >
                  {isTesting ? '正在測試...' : '測試連線'}
                </button>
              </div>
            </div>
          );
        })()}

        {/* 使用者身分與權限 */}
        <div className="card flex-col" style={{ gridColumn: 'span 3', marginTop: '16px' }}>
          <h3 style={{ margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <SettingsIcon size={18} className="text-primary" /> 
            目前登入者身分與權限
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', backgroundColor: 'var(--color-bg-base)', padding: '16px', borderRadius: '8px' }}>
            <div>
              <span className="text-muted text-xs" style={{ display: 'block', marginBottom: '4px' }}>目前登入者 (Email)</span>
              <strong style={{ fontSize: '15px' }}>{user?.email || '未登入 (Offline)'}</strong>
            </div>
            <div>
              <span className="text-muted text-xs" style={{ display: 'block', marginBottom: '4px' }}>顯示名稱 (Display Name)</span>
              <strong style={{ fontSize: '15px' }}>{displayName || '無'}</strong>
            </div>
            <div>
              <span className="text-muted text-xs" style={{ display: 'block', marginBottom: '4px' }}>目前角色 (Role)</span>
              <div>
                <span className="badge" style={{ 
                  backgroundColor: role === 'owner' ? '#ebf8ff' : role === 'staff' ? '#feebc8' : role === 'helper' ? '#e2e8f0' : '#e6fffa', 
                  color: role === 'owner' ? '#2b6cb0' : role === 'staff' ? '#9c4221' : role === 'helper' ? '#4a5568' : '#234e52', 
                  border: '1px solid currentColor', 
                  padding: '2px 8px', 
                  borderRadius: '4px', 
                  fontSize: '12px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  display: 'inline-block',
                  marginTop: '2px'
                }}>
                  {role || 'viewer'}
                </span>
              </div>
            </div>
            <div>
              <span className="text-muted text-xs" style={{ display: 'block', marginBottom: '4px' }}>資料來源模式 (Provider Mode)</span>
              <strong style={{ fontSize: '15px', color: 'var(--color-primary)' }}>
                {currentMode === 'local' ? '本地模式 (Local)' : currentMode === 'cloud' ? '雲端模式 (Cloud)' : '備援模式 (Fallback)'}
              </strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
