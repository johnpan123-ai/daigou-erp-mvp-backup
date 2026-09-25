import { useState, useEffect, useRef, useCallback } from 'react';
import { dataProvider } from '../providers/dataProvider';
import { getProviderMode, markManualLocalEntry, setProviderMode } from '../providers/providerMode';
import {
  CLOUD_RESTORE_DISABLED_MESSAGE,
  isCloudRestoreDisabledMode,
} from '../providers/cloudRestorePolicy';
import { Settings as SettingsIcon, Download, Upload, Trash2, Database, Lock } from 'lucide-react';
import { useAuth } from '../auth/authContext';
import { useRole } from '../auth/useRole';
import { supabase, supabaseEnvironment } from '../providers/cloud/supabaseClient';
import { getEnvironmentModeLabel } from '../lib/environmentModeLabel';
import { clearSandboxData, getActiveSandboxConfig, isSandboxEnvironmentActive } from '../lib/testSandboxEnvironment';
import {
  getTestSnapshotMetadata,
  importTestSnapshot,
  prepareTestSnapshotFile,
  type TestSnapshotCandidate,
  type TestSnapshotCollectionName,
  type TestSnapshotMetadata,
} from '../lib/testSnapshotImport';
import { SettingsCountLoadGate } from './settingsCountLoadGate';

const TEST_SNAPSHOT_SUMMARY_FIELDS: { field: TestSnapshotCollectionName; label: string }[] = [
  { field: 'productGroups', label: '商品群組' },
  { field: 'productCategories', label: '商品分類' },
  { field: 'productVariants', label: 'Variants' },
  { field: 'inventory', label: 'Inventory' },
  { field: 'purchaseBatches', label: '採購批次' },
  { field: 'purchaseBatchItems', label: '採購明細' },
  { field: 'privateOrders', label: '私人訂單' },
  { field: 'privateOrderItems', label: '私人訂單明細' },
  { field: 'bundleComponents', label: '套組' },
  { field: 'japanPackages', label: '日本包裹' },
  { field: 'japanPackageItems', label: '日本包裹明細' },
  { field: 'outboundShipments', label: '出庫單' },
  { field: 'outboundShipmentItems', label: '出庫明細' },
  { field: 'salesOrders', label: '銷售訂單' },
  { field: 'salesOrderItems', label: '銷售訂單明細' },
];

export default function Settings() {
  const { user, signOut } = useAuth();
  const { role, displayName, isProfileLoading } = useRole();
  const currentMode = getProviderMode();
  const isSandbox = isSandboxEnvironmentActive();
  const sandboxConfig = getActiveSandboxConfig();
  const sandboxLabel = sandboxConfig?.label ?? 'Sandbox';
  const environmentModeLabel = getEnvironmentModeLabel(currentMode, supabaseEnvironment.role);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(null);

    if (!newPassword) {
      setPasswordError('新密碼不可為空');
      return;
    }
    if (newPassword.length < 12) {
      setPasswordError('新密碼至少 12 碼');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('新密碼與確認密碼必須一致');
      return;
    }

    setIsUpdatingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword
      });

      if (error) throw error;

      setPasswordSuccess('密碼已更新，請使用新密碼重新登入');
      setNewPassword('');
      setConfirmPassword('');

      setTimeout(async () => {
        await signOut();
      }, 2000);
    } catch (err: any) {
      setPasswordError(err.message || '更新密碼失敗，請稍後再試。');
    } finally {
      setIsUpdatingPassword(false);
    }
  };

  const [counts, setCounts] = useState({
    inventory: 0,
    salesOrders: 0,
    salesOrderItems: 0,
    productGroups: 0,
    productCategories: 0,
    productVariants: 0
  });
  const [countLoadGate] = useState(() => new SettingsCountLoadGate());
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const testSnapshotInputRef = useRef<HTMLInputElement>(null);
  const [testSnapshotCandidate, setTestSnapshotCandidate] = useState<TestSnapshotCandidate | null>(null);
  const [testSnapshotMetadata, setTestSnapshotMetadata] = useState<TestSnapshotMetadata | null>(null);
  const [testSnapshotError, setTestSnapshotError] = useState<string | null>(null);
  const [isPreparingTestSnapshot, setIsPreparingTestSnapshot] = useState(false);
  const [isImportingTestSnapshot, setIsImportingTestSnapshot] = useState(false);

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

  const loadCounts = useCallback(async (): Promise<void> => {
    const readCounts = async () => {
      const [inv, so, soi, pg, pc, pv] = await Promise.all([
        dataProvider.getInventory(),
        dataProvider.getSalesOrders(),
        dataProvider.getSalesOrderItems(),
        dataProvider.getProductGroups(),
        dataProvider.getProductCategories(),
        dataProvider.getProductVariants({ raw: true })
      ]);
      return {
        inventory: inv.length,
        salesOrders: so.length,
        salesOrderItems: soi.length,
        productGroups: pg.length,
        productCategories: pc.length,
        productVariants: pv.length
      };
    };
    const convergence = dataProvider.waitForCloudBootstrapConvergence();
    await countLoadGate.run(readCounts, setCounts);
    if (await convergence) await countLoadGate.run(readCounts, setCounts);
  }, [countLoadGate]);

  useEffect(() => {
    (window as Window & { dataProvider?: typeof dataProvider }).dataProvider = dataProvider;
    void loadCounts();
    if (isSandbox) {
      getTestSnapshotMetadata()
        .then(setTestSnapshotMetadata)
        .catch(error => setTestSnapshotError(error instanceof Error ? error.message : String(error)));
    }
    return () => {
      countLoadGate.invalidate();
    };
  }, [countLoadGate, isSandbox, loadCounts]);

  const handleExport = async () => {
    await dataProvider.exportData();
  };

  const handleExportExcel = async () => {
    try {
      const { exportToExcelBackup } = await import('../utils/excelExport');
      await exportToExcelBackup(user?.email);
      alert('Excel 備份匯出完成');
    } catch (err: any) {
      console.error('Excel export failed:', err);
      alert('Excel 備份匯出失敗，請查看 Console');
    }
  };

  const handleExportSimple = async () => {
    try {
      const { exportSimplifiedExcel } = await import('../utils/excelExportSimple');
      await exportSimplifiedExcel(user?.email);
      alert('簡易匯出完成');
    } catch (err: any) {
      console.error('Simple export failed:', err);
      alert('簡易匯出失敗，請查看 Console');
    }
  };

  const handleImportClick = () => {
    if (isCloudRestoreDisabledMode(currentMode)) {
      alert(CLOUD_RESTORE_DISABLED_MESSAGE);
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (isCloudRestoreDisabledMode(currentMode)) {
      alert(CLOUD_RESTORE_DISABLED_MESSAGE);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    try {
      const text = await file.text();
      const success = await dataProvider.importData(text);

      if (success) {
        alert('資料還原成功！');
        await loadCounts();
      } else {
        alert('還原失敗，資料未套用；匯入前的原有資料已完整保留。請確認 JSON 格式與必要集合。');
      }
    } catch (err: any) {
      alert(`還原失敗，資料未套用；匯入前的原有資料已完整保留。\n${err.message || err}`);
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

  const handleClearTestSandbox = async () => {
    if (!isSandbox) {
      alert('此操作只能在 Sandbox 模式執行。');
      return;
    }
    if (!confirm(`確定要清空 ${sandboxLabel} 嗎？\n此操作只會清除測試資料，不會影響正式雲端或一般 Local DB。`)) return;
    if (!confirm(`請再次確認：要永久清空目前所有 ${sandboxLabel} 資料嗎？`)) return;

    await clearSandboxData();
    alert(`${sandboxLabel} 已清空。正式資料未受影響。`);
    window.location.reload();
  };

  const handleTestSnapshotFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsPreparingTestSnapshot(true);
    setTestSnapshotError(null);
    setTestSnapshotCandidate(null);
    try {
      const candidate = await prepareTestSnapshotFile(file);
      setTestSnapshotCandidate(candidate);
    } catch (error) {
      setTestSnapshotError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPreparingTestSnapshot(false);
      if (testSnapshotInputRef.current) testSnapshotInputRef.current.value = '';
    }
  };

  const handleImportTestSnapshot = async () => {
    if (!testSnapshotCandidate) return;
    if (!isSandbox) {
      setTestSnapshotError('正式版 JSON 快照只能在 Sandbox 匯入。');
      return;
    }

    const confirmed = window.confirm(
      `此操作只會清除並取代目前 ${sandboxLabel} 資料。\nProduction 雲端資料不會受到影響。\n\n檔案：${testSnapshotCandidate.fileName}\n\n確定繼續嗎？`,
    );
    if (!confirmed) return;

    setIsImportingTestSnapshot(true);
    setTestSnapshotError(null);
    try {
      const result = await importTestSnapshot(testSnapshotCandidate);
      setTestSnapshotMetadata(result.metadata);
      setTestSnapshotCandidate(null);
      alert(
        `${sandboxLabel} Snapshot 匯入完成。\n\n商品群組：${result.verifiedCounts.productGroups}\nVariants：${result.verifiedCounts.productVariants}\nInventory：${result.verifiedCounts.inventory}\n日本包裹：${result.verifiedCounts.japanPackages}\n出庫單：${result.verifiedCounts.outboundShipments}\n\nProduction IndexedDB 與 localStorage 均未改變。`,
      );
      window.location.reload();
    } catch (error) {
      setTestSnapshotError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsImportingTestSnapshot(false);
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
                <div className="font-medium" style={{ marginBottom: '4px' }}>匯出 Excel 備份</div>
                <div className="text-xs text-muted">下載多分頁格式的試算表備份（用於核對與手工修復）。</div>
              </div>
              <button className="btn btn-outline" onClick={handleExportExcel}>
                <Download size={16} /> 匯出 Excel
              </button>
            </div>

            <div className="flex items-center justify-between" style={{ padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
              <div>
                <div className="font-medium" style={{ marginBottom: '4px' }}>簡易匯出 Excel</div>
                <div className="text-xs text-muted">3 頁精簡報表：商品總覽（可點入查看規格）、數量核對、採購批次。</div>
              </div>
              <button className="btn btn-outline" onClick={handleExportSimple}>
                <Download size={16} /> 簡易匯出
              </button>
            </div>

            <div className="flex items-center justify-between" style={{ padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
              <div>
                <div className="font-medium" style={{ marginBottom: '4px' }}>匯入 JSON 還原</div>
                <div className="text-xs text-muted">
                  {isCloudRestoreDisabledMode(currentMode)
                    ? 'Cloud Mode 暫不可使用；Local／Test Mode 仍可進行原子還原。'
                    : '從先前的備份檔案還原資料 (會覆蓋現有資料)。'}
                </div>
              </div>
              <button
                className="btn btn-primary"
                onClick={handleImportClick}
                disabled={isCloudRestoreDisabledMode(currentMode)}
                title={isCloudRestoreDisabledMode(currentMode) ? CLOUD_RESTORE_DISABLED_MESSAGE : undefined}
              >
                <Upload size={16} /> {isCloudRestoreDisabledMode(currentMode) ? 'Cloud Mode 暫停還原' : '匯入還原'}
              </button>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                accept=".json" 
                disabled={isCloudRestoreDisabledMode(currentMode)}
                style={{ display: 'none' }} 
              />
            </div>

            {isCloudRestoreDisabledMode(currentMode) && (
              <div
                role="alert"
                style={{
                  padding: '12px 16px',
                  border: '1px solid #f59e0b',
                  borderRadius: '8px',
                  background: '#fffbeb',
                  color: '#92400e',
                  fontSize: '13px',
                  lineHeight: 1.6,
                }}
              >
                {CLOUD_RESTORE_DISABLED_MESSAGE}
              </div>
            )}

            <div className="flex items-center justify-between" style={{ padding: '16px', border: '1px solid var(--color-warning)', backgroundColor: 'rgba(245, 158, 11, 0.05)', borderRadius: '8px' }}>
              <div>
                <div className="font-medium text-warning" style={{ marginBottom: '4px' }}>重新解析商品規格</div>
                <div className="text-xs text-muted">修正因為舊版匯入導致的規格未正確切分問題。</div>
              </div>
              <button 
                className="btn" 
                style={{ backgroundColor: 'var(--color-warning)', color: 'white' }} 
                disabled={currentMode === 'cloud' && role !== 'owner'} 
                onClick={async () => {
                  const isCloud = currentMode === 'cloud';
                  const confirmMsg = isCloud
                    ? '你目前在雲端模式，重新解析會批次更新商品分類與規格名稱，但不會刪除訂單、採購批次、私下登記。請確認你已先匯出 JSON / Excel 備份。是否繼續？'
                    : '確定要重新解析商品規格？不會刪除任何訂單與採購資料。';

                  if (!window.confirm(confirmMsg)) return;

                  try {
                    await dataProvider.reparseProductVariants();
                    if (isCloud) {
                      alert('重新解析完成，請重新整理頁面確認結果。');
                    } else {
                      alert('解析完成');
                    }
                    await loadCounts();
                  } catch (err) {
                    console.error('Reparse failed:', err);
                    alert('重新解析失敗，請查看 Console');
                  }
                }}
              >
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
            本地資料與雲端資料永久隔離；登入成功預設進入雲端，已登入時仍可手動切回本地 Sandbox。
          </p>
          
          <div style={{ marginBottom: '16px', fontWeight: 600, fontSize: '14px', color: 'var(--color-text)' }}>
            目前模式：{isSandbox ? `${sandboxLabel}（${sandboxConfig?.dbName}）` : environmentModeLabel}
          </div>

          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            <label
              onClick={() => {
                if (!isSandbox) {
                  if (setProviderMode('test')) window.location.reload();
                }
              }}
              style={{
                border: isSandbox ? `2px solid ${currentMode === 'experimental' ? '#be123c' : currentMode === 'next' ? '#0369a1' : '#6d28d9'}` : '1px solid var(--color-border)',
                borderRadius: '8px',
                padding: '16px',
                flex: '1',
                minWidth: '200px',
                cursor: isSandbox ? 'default' : 'pointer',
                position: 'relative',
                backgroundColor: isSandbox ? (currentMode === 'experimental' ? '#fff1f2' : currentMode === 'next' ? '#f0f9ff' : '#f5f3ff') : 'transparent'
              }}
            >
              <input type="radio" checked={isSandbox} readOnly style={{ position: 'absolute', top: '16px', right: '16px' }} />
              <div className="font-semibold" style={{ fontSize: '15px', marginBottom: '4px', color: currentMode === 'experimental' ? '#9f1239' : currentMode === 'next' ? '#075985' : '#5b21b6' }}>{isSandbox ? sandboxLabel : 'Test Sandbox'}</div>
              <div className="text-xs text-muted">使用獨立 Sandbox IndexedDB；程式會硬性阻止 Supabase 所有網路連線。</div>
            </label>

            <label 
              onClick={() => {
                if (currentMode !== 'local') {
                  if (user) markManualLocalEntry();
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
              <div className="font-semibold" style={{ fontSize: '15px', marginBottom: '4px' }}>本地模式｜資料不會同步雲端</div>
              <div className="text-xs text-muted">使用獨立 Local authoritative IndexedDB；不會上傳、合併或被 Cloud cache 覆蓋。</div>
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
                  if (setProviderMode('cloud')) window.location.reload();
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
              <div className={`font-semibold ${currentMode === 'cloud' ? '' : 'text-muted'}`} style={{ fontSize: '15px', marginBottom: '4px' }}>{getEnvironmentModeLabel('cloud', supabaseEnvironment.role)}</div>
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
              <div className="text-xs text-muted">雲端離線時只顯示 stale cache，所有寫入暫停；重連後只重新讀取 Server。</div>
            </label>
          </div>

          {isSandbox && (
            <div style={{ marginTop: '16px', padding: '16px', border: '1px solid #c4b5fd', borderRadius: '8px', backgroundColor: '#faf5ff' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ color: currentMode === 'experimental' ? '#9f1239' : '#5b21b6', fontWeight: 700, marginBottom: '4px' }}>{sandboxLabel} 資料管理</div>
                  <div className="text-xs text-muted">兩個操作都只會存取 {sandboxConfig?.dbName}，不會連線或寫入 Production Supabase。</div>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-primary"
                    disabled={isPreparingTestSnapshot || isImportingTestSnapshot}
                    onClick={() => testSnapshotInputRef.current?.click()}
                  >
                    <Upload size={16} /> {isPreparingTestSnapshot ? '正在檢查 JSON…' : '匯入正式版 JSON 快照'}
                  </button>
                  <input
                    ref={testSnapshotInputRef}
                    type="file"
                    accept=".json,application/json"
                    onChange={handleTestSnapshotFileChange}
                    style={{ display: 'none' }}
                  />
                  <button
                    className="btn"
                    style={{ backgroundColor: '#7c3aed', color: '#fff' }}
                    disabled={isImportingTestSnapshot}
                    onClick={handleClearTestSandbox}
                  >
                    <Trash2 size={16} /> 清空 {sandboxLabel}
                  </button>
                </div>
              </div>

              {testSnapshotMetadata && (
                <div style={{ marginTop: '14px', padding: '12px', backgroundColor: '#fff', border: '1px solid #ddd6fe', borderRadius: '8px' }}>
                  <div style={{ fontWeight: 700, color: '#4c1d95' }}>目前測試資料來源</div>
                  <div style={{ marginTop: '6px', fontSize: '14px' }}>{testSnapshotMetadata.sourceFileName}</div>
                  <div className="text-xs text-muted" style={{ marginTop: '4px' }}>
                    匯入時間：{new Date(testSnapshotMetadata.importedAt).toLocaleString('zh-TW', { hour12: false })}
                  </div>
                  <div className="text-xs text-muted" style={{ marginTop: '2px', wordBreak: 'break-all' }}>
                    SHA-256：{testSnapshotMetadata.sourceSha256}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '6px 12px', marginTop: '10px', fontSize: '13px' }}>
                    {TEST_SNAPSHOT_SUMMARY_FIELDS.map(item => (
                      <div key={item.field}><span className="text-muted">{item.label}：</span><strong>{testSnapshotMetadata.counts[item.field]}</strong></div>
                    ))}
                  </div>
                </div>
              )}

              {testSnapshotError && (
                <div style={{ marginTop: '14px', padding: '12px', border: '1px solid #fecaca', borderRadius: '8px', backgroundColor: '#fff1f2', color: '#b91c1c', fontSize: '14px' }}>
                  {testSnapshotError}
                </div>
              )}

              {testSnapshotCandidate && (
                <div style={{ marginTop: '14px', padding: '14px', border: '2px solid #8b5cf6', borderRadius: '8px', backgroundColor: '#fff' }}>
                  <div style={{ color: '#4c1d95', fontWeight: 700 }}>確認匯入正式版 JSON 快照</div>
                  <div style={{ marginTop: '8px', fontSize: '14px' }}><strong>檔案：</strong>{testSnapshotCandidate.fileName}</div>
                  <div className="text-xs text-muted" style={{ marginTop: '3px' }}>
                    大小：{(testSnapshotCandidate.fileSize / 1024 / 1024).toFixed(2)} MB
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '6px 12px', marginTop: '12px', fontSize: '13px' }}>
                    {TEST_SNAPSHOT_SUMMARY_FIELDS.map(item => (
                      <div key={item.field}><span className="text-muted">{item.label}：</span><strong>{testSnapshotCandidate.counts[item.field]}</strong></div>
                    ))}
                  </div>
                  {testSnapshotCandidate.orphanWarnings.length > 0 && (
                    <div style={{ marginTop: '12px', padding: '10px', backgroundColor: '#fffbeb', border: '1px solid #fde68a', borderRadius: '6px', color: '#92400e', fontSize: '13px' }}>
                      偵測到 {testSnapshotCandidate.orphanWarnings.reduce((sum, warning) => sum + warning.count, 0)} 筆歷史孤兒關聯；將保留原始資料，不會刪除或自動補值。
                    </div>
                  )}
                  {testSnapshotCandidate.extraTopLevelKeys.length > 0 && (
                    <div style={{ marginTop: '8px', color: '#92400e', fontSize: '12px' }}>
                      未納入的額外頂層欄位：{testSnapshotCandidate.extraTopLevelKeys.join('、')}
                    </div>
                  )}
                  <div style={{ marginTop: '12px', padding: '10px', backgroundColor: '#f5f3ff', borderRadius: '6px', color: '#5b21b6', fontWeight: 600, fontSize: '13px' }}>
                    此操作只會清除並取代目前 {sandboxLabel} 資料。Production 雲端資料不會受到影響。
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
                    <button className="btn btn-outline" disabled={isImportingTestSnapshot} onClick={() => setTestSnapshotCandidate(null)}>
                      取消
                    </button>
                    <button className="btn btn-primary" disabled={isImportingTestSnapshot} onClick={handleImportTestSnapshot}>
                      {isImportingTestSnapshot ? '正在原子匯入…' : `確認匯入 ${sandboxLabel}`}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
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
                  <strong>目前模式：</strong>{environmentModeLabel}
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

        {/* 帳號安全 */}
        {user && (
          <div className="card flex-col" style={{ gridColumn: 'span 3', marginTop: '16px' }}>
            <h3 style={{ margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Lock size={18} className="text-primary" /> 
              帳號安全
            </h3>
            <p className="text-muted text-sm" style={{ marginBottom: '16px' }}>
              在此直接修改您的登入密碼。新密碼不可為空且至少需 12 碼。成功更新密碼後將自動登出，請以新密碼重新登入。
            </p>

            {passwordError && (
              <div style={{
                padding: '12px',
                backgroundColor: '#FEF2F2',
                border: '1px solid #FEE2E2',
                color: 'var(--color-danger)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '13px',
                marginBottom: '16px',
                lineHeight: 1.5
              }}>
                {passwordError}
              </div>
            )}

            {passwordSuccess && (
              <div style={{
                padding: '12px',
                backgroundColor: '#f0fdf4',
                border: '1px solid #bbf7d0',
                color: '#166534',
                borderRadius: 'var(--radius-sm)',
                fontSize: '13px',
                marginBottom: '16px',
                lineHeight: 1.5
              }}>
                {passwordSuccess}
              </div>
            )}

            <form onSubmit={handleUpdatePassword} className="flex-col gap-md" style={{ maxWidth: '400px' }}>
              <div className="flex-col gap-xs">
                <label className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>新密碼</label>
                <input
                  type="password"
                  required
                  placeholder="請輸入新密碼"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-border)',
                    outline: 'none',
                    fontSize: '14px'
                  }}
                />
              </div>

              <div className="flex-col gap-xs">
                <label className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>確認新密碼</label>
                <input
                  type="password"
                  required
                  placeholder="請確認新密碼"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-border)',
                    outline: 'none',
                    fontSize: '14px'
                  }}
                />
              </div>

              <div style={{ marginTop: '8px' }}>
                <button
                  type="submit"
                  disabled={isUpdatingPassword}
                  className="btn btn-primary"
                  style={{ minWidth: '120px' }}
                >
                  {isUpdatingPassword ? '正在更新...' : '更新密碼'}
                </button>
              </div>
            </form>
          </div>
        )}

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
                  backgroundColor: isProfileLoading ? '#f1f5f9' : role === 'owner' ? '#ebf8ff' : role === 'staff' ? '#feebc8' : role === 'helper' ? '#e2e8f0' : '#e6fffa',
                  color: isProfileLoading ? '#94a3b8' : role === 'owner' ? '#2b6cb0' : role === 'staff' ? '#9c4221' : role === 'helper' ? '#4a5568' : '#234e52',
                  border: '1px solid currentColor',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  display: 'inline-block',
                  marginTop: '2px'
                }}>
                  {isProfileLoading ? '...' : (role || 'viewer')}
                </span>
              </div>
            </div>
            <div>
              <span className="text-muted text-xs" style={{ display: 'block', marginBottom: '4px' }}>資料來源模式 (Provider Mode)</span>
              <strong style={{ fontSize: '15px', color: 'var(--color-primary)' }}>
                {isSandbox ? `${sandboxLabel} (${sandboxConfig?.dbName})` : environmentModeLabel}
              </strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
