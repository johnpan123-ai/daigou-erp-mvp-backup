import React, { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } from 'react';
import { dataProvider } from '../providers/dataProvider';
import { cloudMutationFailureMessage } from '../providers/cloud/cloudFieldCas';
import {
  isVariantDestructiveSyncGuardError,
  isVariantSyncGuardAcceptanceUiEnabled,
  isVariantSyncReadFailureInjectionEnabled,
  VARIANT_DESTRUCTIVE_SYNC_GUARD_MESSAGE,
  normalizeProductTitle,
} from '../lib/db';
import type { InventoryItem, ProductGroup } from '../lib/db';
import { parseMyAcgFile } from '../utils/myacgParser';
import { classifyMyAcgImportError, myAcgImportDiagnostic } from '../utils/myacgImportErrors';
import { Upload, Download, RefreshCw, RotateCcw, PackageX, ChevronDown, ChevronRight, Search, ShoppingBag, CheckCircle, Clock, Building2, Play, Heart, SlidersHorizontal, Plus } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';
import { PageHeader, PageShell } from '../components/layout/PageHeader';
import { useResizableColumns } from '../hooks/useResizableColumns';
import { createAndDownloadWorkbenchBackup } from '../lib/workbenchJsonBackup';
import { linksFromMyAcgInventory, mergeMyAcgMasterLinks } from '../waca/masterReference';
import { getProviderMode } from '../providers/providerMode';
import {
  CLOUD_RESTORE_DISABLED_MESSAGE,
  isCloudRestoreDisabledMode,
} from '../providers/cloudRestorePolicy';
import { useCloudResourceSync } from '../contexts/CloudRealtimeSyncContext';
import { BuyAnimeResumeError, buyAnimeRecoveryDiagnostic, type BuyAnimeImportRecord } from '../providers/cloud/buyAnimeImportResume';
import { buyAnimeFlowLabel, getBuyAnimeFlowPresentation, subscribeBuyAnimeFlow } from '../providers/cloud/buyAnimeImportCoordinator';

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

const shouldSyncImportedInventoryWithExistingGroups = (
  importedItems: InventoryItem[],
  groups: ProductGroup[],
): boolean => {
  const importedTitles = new Set(importedItems.map(item => (
    item.normalized_product_title || normalizeProductTitle(item.product_title)
  )).filter(Boolean));
  return groups.some(group => importedTitles.has(group.normalized_title || normalizeProductTitle(group.title)));
};

export default function Inventory() {
  const currentMode = getProviderMode();
  const isCloudRestoreDisabled = isCloudRestoreDisabledMode(currentMode);
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
  const loadGenerationRef = useRef(0);

  const { colWidths, handleMouseDown, resetWidths } = useResizableColumns(
    'erp_inventory_col_widths',
    DEFAULT_COL_WIDTHS
  );

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [lastBackupTime, setLastBackupTime] = useState<string | null>(null);
  const [isRollbackPending, setIsRollbackPending] = useState(false);
  const [isExportingBackup, setIsExportingBackup] = useState(false);
  const [backupNotice, setBackupNotice] = useState<string>('');
  const [importDiagnostic, setImportDiagnostic] = useState<ReturnType<typeof myAcgImportDiagnostic> | null>(null);
  const [importRecovery, setImportRecovery] = useState<BuyAnimeImportRecord | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const flow = useSyncExternalStore(subscribeBuyAnimeFlow, getBuyAnimeFlowPresentation, getBuyAnimeFlowPresentation);
  const [variantGuardProbeNotice, setVariantGuardProbeNotice] = useState<string>('');
  const showVariantGuardAcceptanceUi = isVariantSyncGuardAcceptanceUiEnabled();
  const injectVariantReadFailure = isVariantSyncReadFailureInjectionEnabled();

  const loadItems = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    const convergence = dataProvider.waitForCloudBootstrapConvergence();
    await dataProvider.getProductGroups();
    let snapshot = await dataProvider.getInventoryCatalogSnapshot();
    if (generation !== loadGenerationRef.current) return;
    setProductGroups(snapshot.productGroups);
    setItems(snapshot.inventory);

    // The four-second freshness boundary may intentionally expose the previous
    // cache while the same Cloud pull continues. Once that pull atomically
    // replaces the cache, re-read the paired collections for this generation.
    if (await convergence) {
      snapshot = await dataProvider.getInventoryCatalogSnapshot();
      if (generation !== loadGenerationRef.current) return;
      setProductGroups(snapshot.productGroups);
      setItems(snapshot.inventory);
    }
    
    try {
      const backup = await dataProvider.getLastImportBackup();
      setLastBackupTime(backup ? backup.timestamp : null);
    } catch (backupErr) {
      console.error('Failed to load last import backup timestamp:', backupErr);
    }
    
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    setRefreshTime(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`);
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadItems(), 0);
    return () => {
      window.clearTimeout(initialLoad);
      loadGenerationRef.current += 1;
    };
  }, [loadItems]);

  useCloudResourceSync(
    'inventory-catalog',
    ['inventory', 'products'],
    isImporting || isRollbackPending || recoveryBusy,
    loadItems,
  );

  const existingGroupTitles = useMemo(() => {
    return new Set(productGroups.map(g => g.normalized_title || g.title));
  }, [productGroups]);

  const handleImportClick = () => {
    if (isImporting) return;
    fileInputRef.current?.click();
  };

  const recoverImport = useCallback(async () => {
    setRecoveryBusy(true);
    setRecoveryError('');
    try {
      await dataProvider.waitForCloudBootstrapConvergence();
      const completed = await dataProvider.recoverPendingBuyAnimeImport({ onStage: stage => setImportStatus(buyAnimeFlowLabel(stage)) });
      setImportRecovery(null);
      if (completed) { setImportStatus('匯入完成'); await loadItems(); }
    } catch (cause) {
      setImportDiagnostic(buyAnimeRecoveryDiagnostic(cause, cause instanceof BuyAnimeResumeError ? cause.record : undefined));
      if (cause instanceof BuyAnimeResumeError && cause.record) setImportRecovery(cause.record);
      setRecoveryError('同步暫時未完成，請稍後重試。已儲存的主檔不會重送。');
      setImportStatus('');
    } finally { setRecoveryBusy(false); }
  }, [loadItems]);

  const createPreImportBackup = async () => {
    const timestamp = new Date();
    const timestampIso = timestamp.toISOString();
    let backup;
    try {
      backup = await createAndDownloadWorkbenchBackup(dataProvider, 'workbench-before-xls-import', timestamp);
      await dataProvider.saveLastImportBackup({ data: backup.json, timestamp: timestampIso });
    } catch (cause) {
      const error = new Error('BUYANIME_BACKUP_FAILED', { cause });
      error.name = 'BuyAnimeBackupError';
      throw error;
    }
    setLastBackupTime(timestampIso);
    setBackupNotice(`已建立匯入前備份：${backup.filename}`);
    return backup;
  };

  const handleManualExportBackup = async () => {
    setIsExportingBackup(true);
    setBackupNotice('');
    try {
      const backup = await createAndDownloadWorkbenchBackup(dataProvider, 'workbench-backup');
      setBackupNotice(`JSON 備份已建立：${backup.filename}`);
      alert(`JSON 備份已建立並開始下載。\n檔名：${backup.filename}`);
    } catch (error: any) {
      console.error('[Manual Backup ERROR]:', error);
      alert(`JSON 備份失敗：${error?.message || error}`);
    } finally {
      setIsExportingBackup(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isImporting) return;

    setIsImporting(true);
    setBackupNotice('');
    setImportDiagnostic(null);
    setRecoveryError('');
    setImportStatus('匯入中…');
    const importRequestId = `catalog_import_${crypto.randomUUID()}`;
    let importPhase: 'parse' | 'commit' = 'parse';
    try {
      const parsedItems = await parseMyAcgFile(file);
      const currentImportId = importRequestId;
      const currentTimestamp = new Date().toISOString();
      const itemsWithBatchMeta = parsedItems.map(item => ({
        ...item,
        latest_catalog_import_id: currentImportId,
        catalog_last_seen_at: currentTimestamp
      }));
      importPhase = 'commit';
      if (currentMode === 'cloud' || currentMode === 'fallback') {
        const completed = await dataProvider.completeBuyAnimeImport(itemsWithBatchMeta, file.name, {
          beforeStart: createPreImportBackup,
          onStage: stage => setImportStatus(buyAnimeFlowLabel(stage)),
        });
        setImportRecovery(null);
        await loadItems();
        setImportStatus(`匯入完成（新增 ${completed.stats.newCount}、更新 ${completed.stats.updatedCount}）`);
        return;
      }
      // NEXT remains local and keeps the same backup-before-dispatch gate.
      await createPreImportBackup();
      const stats = await dataProvider.upsertInventory(itemsWithBatchMeta);

      const cloudMode = false; // Cloud uses the durable staged pipeline above; NEXT remains local.
      let shouldSync = !cloudMode;
      let syncStats: Awaited<ReturnType<typeof dataProvider.syncProductGroupsWithInventory>> = {
        filledVariantsCount: 0,
        affectedGroupsCount: 0,
        upgradedSkusCount: 0,
      };
      let postCommitIssue: 'catalog-readback' | 'group-sync' | 'ui-readback' | null = null;
      try {
        const authoritativeGroups = await dataProvider.getProductGroups();
        shouldSync = !cloudMode
          || shouldSyncImportedInventoryWithExistingGroups(itemsWithBatchMeta, authoritativeGroups);
      } catch {
        postCommitIssue = 'catalog-readback';
      }
      if (!postCommitIssue && shouldSync) {
        try {
          syncStats = await dataProvider.syncProductGroupsWithInventory();
        } catch {
          postCommitIssue = 'group-sync';
        }
      }
      // The catalog is the authoritative GP → G evidence source in both
      // environments. Persist it while the uploaded parent code is still
      // available; a later WACA import must not require this file again.
      if (!postCommitIssue && (currentMode === 'next' || cloudMode)) {
        try {
          const variants = await dataProvider.getAuthoritativeWacaVariants();
          const evidence = linksFromMyAcgInventory(itemsWithBatchMeta, variants, file.name, currentTimestamp);
          if (evidence.links.length) {
            const waca = await dataProvider.getNextWacaSnapshot();
            const masterLinks = mergeMyAcgMasterLinks(waca.masterLinks, evidence.links);
            await dataProvider.commitNextWacaSnapshot({ ...waca, masterLinks }, waca.revision, false);
          }
        } catch (error) {
          console.error('[NEXT MyACG master link capture]', error);
          postCommitIssue = 'group-sync';
        }
      }
      try {
        await loadItems();
      } catch {
        postCommitIssue ||= 'ui-readback';
      }

      if (postCommitIssue) {
        const followUp = postCommitIssue === 'group-sync'
          ? '訂購紀錄表的商品群組／規格同步未完成'
          : postCommitIssue === 'catalog-readback'
            ? '訂購紀錄表同步資格的雲端查驗未完成'
            : '匯入後的雲端資料重新讀取未完成';
        alert(`Catalog 主檔已寫入雲端（新增 ${stats.newCount}、更新 ${stats.updatedCount}）。\n\n${followUp}，本次不會自動重試。請勿重複匯入同一檔案；請先重新讀取雲端資料並查證現況。`);
        return;
      }
      
      const report = `📊【買動漫 Catalog 匯入結果】

一、Catalog 暫存主檔

* 檔案原始列數：${stats.total} 筆
* 本次新增到暫存主檔：${stats.newCount} 筆
* 本次更新暫存主檔：${stats.updatedCount} 筆
  註：這裡只是買動漫商品主檔快取，不代表訂購紀錄表新增規格。

二、訂購紀錄表同步

* 受影響商品群組：${syncStats.affectedGroupsCount} 組
* 實際新增規格：${syncStats.filledVariantsCount} 筆
* 舊 SKU 自動升級為新子編號：${syncStats.upgradedSkusCount || 0} 筆
${cloudMode && !shouldSync ? '* 本次項目沒有對應既有訂購商品群組；維持「未加入」，未執行跨表規格同步。' : ''}

三、檢查提醒

* 若「實際新增規格」不是預期數字，請先不要繼續匯入其他資料
* 若「舊 SKU 自動升級」有數字，代表 UUID 與採購關聯維持不變`;

      alert(report);
    } catch (err) {
      if (err instanceof Error && err.name === 'BuyAnimeBackupError') {
        setImportStatus('匯入前 JSON 備份失敗，已中止 XLS 匯入。');
        alert('匯入前 JSON 備份失敗，已中止 XLS 匯入。');
        return;
      }
      if (currentMode === 'cloud' || currentMode === 'fallback') {
        if (err instanceof BuyAnimeResumeError && err.record) {
          setImportDiagnostic(buyAnimeRecoveryDiagnostic(err, err.record));
          setImportRecovery(err.record);
          setRecoveryError('匯入暫時未完成，請稍後重試。已儲存的主檔不會重送。');
          setImportStatus('');
          try { await loadItems(); } catch { /* Keep the committed intent, never infer rollback from a cache display read. */ }
          return;
        }
        try {
          const pending = await dataProvider.getBuyAnimeImportRecovery();
          if (pending) {
            setImportRecovery(pending);
            setRecoveryError('同步暫時未完成，請稍後重試。已儲存的主檔不會重送。');
            setImportStatus('');
            return;
          }
        } catch { /* Do not claim rollback without commit evidence. */ }
      }
      const failure = classifyMyAcgImportError(err, importPhase);
      const diagnostic = myAcgImportDiagnostic(failure, importRequestId);
      setImportDiagnostic(diagnostic);
      setImportStatus('匯入未完成');
      console.error('[BuyAnime Import]', diagnostic);
      alert(
        isVariantDestructiveSyncGuardError(err)
          ? VARIANT_DESTRUCTIVE_SYNC_GUARD_MESSAGE
          : failure.message,
      );
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleVariantGuardFaultInjection = async () => {
    setVariantGuardProbeNotice(
      injectVariantReadFailure ? '正在模擬商品規格讀取失敗…' : '正在執行正常規格同步驗證…',
    );
    try {
      const result = await dataProvider.syncProductGroupsWithInventory();
      if (injectVariantReadFailure) {
        setVariantGuardProbeNotice('故障注入未被阻擋，請停止驗收。');
        alert('故障注入未被阻擋，請停止驗收。');
        return;
      }
      const message = `正常同步完成：新增規格 ${result.filledVariantsCount}、影響群組 ${result.affectedGroupsCount}`;
      setVariantGuardProbeNotice(message);
      alert(message);
    } catch (error) {
      if (isVariantDestructiveSyncGuardError(error)) {
        setVariantGuardProbeNotice(VARIANT_DESTRUCTIVE_SYNC_GUARD_MESSAGE);
        alert(VARIANT_DESTRUCTIVE_SYNC_GUARD_MESSAGE);
        return;
      }
      setVariantGuardProbeNotice(`故障注入發生非預期錯誤：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };

  const handleRollbackBackup = async () => {
    if (isCloudRestoreDisabled) {
      alert(CLOUD_RESTORE_DISABLED_MESSAGE);
      return;
    }

    const backup = await dataProvider.getLastImportBackup();
    if (!backup) {
      alert('找不到任何可用備份！');
      return;
    }

    const confirmRollback = window.confirm(
      `【核心資料還原警告】\n\n您即將把商品主檔、訂購紀錄、商品群組、規格、採購批次、自訂訂單等核心資料，完全還原至上次匯入前的狀態（備份時間：${new Date(backup.timestamp).toLocaleString()}）。\n\n還原後將會完全覆蓋此備份時間點之後的所有修改與匯入。您確定要繼續嗎？`
    );
    if (!confirmRollback) return;

    setIsRollbackPending(true);
    try {
      const backupData = JSON.parse(backup.data);
      const success = await dataProvider.restoreBackup(backupData);
      if (success) {
        alert('核心資料庫還原成功！已回復至上次匯入前狀態。');
        await loadItems();
      }
    } catch (err: any) {
      console.error('[Rollback ERROR]:', err);
      alert(`還原失敗：${err.message || err}`);
    } finally {
      setIsRollbackPending(false);
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
      alert(cloudMutationFailureMessage(e));
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
      alert(cloudMutationFailureMessage(e));
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
    <PageShell className="inventory-container">
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

        .btn-export-backup {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 16px;
          font-size: 14px;
          font-weight: 700;
          color: #ffffff;
          background: #047857;
          border: 1px solid #047857;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
          box-shadow: 0 1px 2px rgba(4, 120, 87, 0.18);
        }

        .btn-export-backup:hover:not(:disabled) {
          background: #065f46;
          border-color: #065f46;
        }

        .btn-export-backup:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .inventory-more-actions {
          position: relative;
        }

        .inventory-more-actions > summary {
          list-style: none;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 8px 12px;
          font-size: 13px;
          font-weight: 600;
          color: #64748b;
          background: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          cursor: pointer;
          user-select: none;
        }

        .inventory-more-actions > summary::-webkit-details-marker {
          display: none;
        }

        .inventory-more-actions-menu {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          z-index: 20;
          min-width: 190px;
          padding: 8px;
          background: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 10px;
          box-shadow: 0 12px 28px rgba(15, 23, 42, 0.16);
        }

        .inventory-more-actions-menu .btn-rollback-backup {
          width: 100%;
          justify-content: center;
        }

        .btn-rollback-backup {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 16px;
          font-size: 14px;
          font-weight: 600;
          color: #d97706;
          background: #fffbeb;
          border: 1px solid #fde68a;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        }

        .btn-rollback-backup:hover {
          background-color: #fef3c7;
          border-color: #fcd34d;
        }

        .btn-rollback-backup:active {
          transform: scale(0.98);
        }

        .btn-rollback-backup:disabled {
          opacity: 0.6;
          cursor: not-allowed;
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
      <PageHeader className="inventory-header">
        <div className="inventory-title-left">
          <div className="inventory-title-area">
        <h1>買動漫匯入</h1>
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
            <button
              className="btn-export-backup"
              onClick={handleManualExportBackup}
              disabled={isImporting || isExportingBackup}
            >
              <Download size={14} />
              <span>{isExportingBackup ? '備份中...' : '匯出 JSON 備份'}</span>
            </button>
            {showVariantGuardAcceptanceUi && (
              <button
                type="button"
                className="btn-rollback-backup"
                onClick={handleVariantGuardFaultInjection}
                disabled={isImporting}
                title="僅限 Next／Experimental 開發環境的 P0-G 人工驗收"
              >
                {injectVariantReadFailure ? '執行 P0-G 規格讀取故障注入' : '執行 P0-G 正常同步驗證'}
              </button>
            )}
            {(lastBackupTime || isCloudRestoreDisabled) && (
              <details className="inventory-more-actions">
                <summary>更多操作 <ChevronDown size={14} /></summary>
                <div className="inventory-more-actions-menu">
                  <button
                    className="btn-rollback-backup"
                    onClick={handleRollbackBackup}
                    disabled={isRollbackPending || isImporting || isCloudRestoreDisabled}
                    title={isCloudRestoreDisabled
                      ? CLOUD_RESTORE_DISABLED_MESSAGE
                      : `上次匯入前備份時間：${new Date(lastBackupTime!).toLocaleString()}`}
                  >
                    <RotateCcw size={14} />
                    <span>{isCloudRestoreDisabled ? 'Cloud Mode 暫停還原' : isRollbackPending ? '還原中...' : '還原上次狀態'}</span>
                  </button>
                  {isCloudRestoreDisabled && (
                    <div style={{ maxWidth: '280px', padding: '8px 10px', color: '#92400e', fontSize: '12px', lineHeight: 1.5 }}>
                      {CLOUD_RESTORE_DISABLED_MESSAGE}
                    </div>
                  )}
                </div>
              </details>
            )}
            {selectedSkus.size > 0 && (
              <button className="btn btn-primary" onClick={handleCreatePurchaseRecords} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <span>建立訂購紀錄 ({selectedSkus.size} 筆)</span>
              </button>
            )}
          </div>
          {backupNotice && (
            <div style={{ marginTop: '8px', fontSize: '12px', color: '#047857', fontWeight: 600 }}>
              {backupNotice}
            </div>
          )}
          {importDiagnostic && (
            <details style={{ marginTop: '8px', fontSize: '12px', color: '#b91c1c' }}>
              <summary>匯入技術資訊</summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {JSON.stringify(importDiagnostic, null, 2)}
              </pre>
            </details>
          )}
          {(importStatus || recoveryError || flow.label || flow.error) && (
            <section role="status" data-testid="buyanime-import-recovery" style={{ marginTop: '12px', fontSize: '13px' }}>
              <div>{recoveryError || flow.error || importStatus || flow.label}</div>
              {(recoveryError || flow.error) && <button type="button" className="btn btn-secondary" onClick={() => void recoverImport()} disabled={recoveryBusy || isImporting}>重試同步</button>}
              {importRecovery && <details style={{ marginTop: '8px', fontSize: '12px' }}>
                <summary>匯入進度技術資訊</summary>
                <div style={{ overflowWrap: 'anywhere' }}>批次：{importRecovery.batchId}<br />階段：{importRecovery.stage}<br />預期／批次筆數：{importRecovery.expected.length}<br />商品／規格：{['CATALOG_VERIFIED','WACA_EVIDENCE_PENDING','COMPLETE'].includes(importRecovery.stage) ? '已核對' : '待完成／核對'}<br />WACA 來源：{importRecovery.stage === 'COMPLETE' ? '已完成' : '待完成'}</div>
              </details>}
            </section>
          )}
          {variantGuardProbeNotice && (
            <div
              role="status"
              data-testid="variant-sync-guard-probe-notice"
              style={{ marginTop: '8px', fontSize: '12px', color: '#b91c1c', fontWeight: 700 }}
            >
              {variantGuardProbeNotice}
            </div>
          )}
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
      </PageHeader>

      {/* KPI Cards Row */}
      <div className="kpi-row workspace-stats workspace-stats-six" data-workspace-stats>
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
      <div className="filter-bar-card workspace-toolbar" data-workspace-toolbar>
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
              resetWidths();
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
      <div className="inventory-list-card workspace-content workspace-panel" data-workspace-content>
        {groups.length === 0 ? (
          <EmptyState
            compact
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
                        <tr key={sku.inventory_key || `${sku.myacg_item_code}-${sku.raw_variant_name || ""}`} style={{ backgroundColor: '#f8fafc' }}>
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
    </PageShell>
  );
}
