import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { calculateFinalMyacgDemand } from '../lib/db';
import { dataProvider } from '../providers/dataProvider';
import type { ProductGroup, ProductVariant, ProductCategory, PurchaseBatchItem, PrivateOrderItem, InventoryItem, SalesOrderItem } from '../lib/db';
import { ClipboardList, AlertTriangle, Clock, CheckCircle2, ChevronRight, RefreshCw } from 'lucide-react';
import { supabase } from '../providers/cloud/supabaseClient';
import { supabaseProvider } from '../providers/cloud/supabaseProvider';
import { getProviderMode } from '../providers/providerMode';

export default function Dashboard() {
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [batchItems, setBatchItems] = useState<PurchaseBatchItem[]>([]);
  const [privateOrderItems, setPrivateOrderItems] = useState<PrivateOrderItem[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [salesOrderItems, setSalesOrderItems] = useState<SalesOrderItem[]>([]);
  const [refreshTime, setRefreshTime] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const navigate = useNavigate();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [activeCategoryForUpload, setActiveCategoryForUpload] = useState<string | null>(null);
  const [categoryImages, setCategoryImages] = useState<Record<string, string>>({
    all: '',
    hololive: '',
    vspo: '',
    agency: '',
    other: ''
  });

  const DEFAULT_IMAGES: Record<string, string> = {
    all: '/images/all_products.png',
    hololive: '/images/hololive.png',
    vspo: '/images/vspo.png',
    agency: '/images/proxy.png',
    other: '/images/other.png'
  };

  const refreshCategoryImages = () => {
    const mode = getProviderMode();
    if (mode === 'cloud') {
      setCategoryImages({
        all: localStorage.getItem('dashboard_cloud_img_all') || '',
        hololive: localStorage.getItem('dashboard_cloud_img_hololive') || '',
        vspo: localStorage.getItem('dashboard_cloud_img_vspo') || '',
        agency: localStorage.getItem('dashboard_cloud_img_agency') || '',
        other: localStorage.getItem('dashboard_cloud_img_other') || ''
      });
    } else {
      setCategoryImages({
        all: localStorage.getItem('dashboard_category_img_all') || '',
        hololive: localStorage.getItem('dashboard_category_img_hololive') || '',
        vspo: localStorage.getItem('dashboard_category_img_vspo') || '',
        agency: localStorage.getItem('dashboard_category_img_agency') || '',
        other: localStorage.getItem('dashboard_category_img_other') || ''
      });
    }
  };

  const triggerImageUpload = (categoryKey: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveCategoryForUpload(categoryKey);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeCategoryForUpload) return;

    const mode = getProviderMode();

    if (mode === 'cloud') {
      try {
        setIsLoading(true);
        // 1. 刪除舊圖片 (若有)
        const oldPath = localStorage.getItem(`dashboard_cloud_path_${activeCategoryForUpload}`);
        if (oldPath) {
          try {
            const { error: removeError } = await supabase.storage
              .from('category-images')
              .remove([oldPath]);
            if (removeError) {
              console.warn('[Storage] 刪除舊分類圖片失敗:', removeError.message);
            }
          } catch (err: any) {
            console.warn('[Storage] 刪除舊分類圖片發生錯誤:', err.message || err);
          }
        }

        // 2. 上傳新圖片
        const fileExt = file.name.split('.').pop();
        const newPath = `${activeCategoryForUpload}_${Date.now()}.${fileExt}`;
        const { error: uploadError } = await supabase.storage
          .from('category-images')
          .upload(newPath, file, { cacheControl: '3600', upsert: true });

        if (uploadError) {
          throw uploadError;
        }

        // 3. 取得 Public URL
        const { data: { publicUrl } } = supabase.storage
          .from('category-images')
          .getPublicUrl(newPath);

        // 4. 更新雲端資料庫與本地 localStorage 快取
        await supabaseProvider.saveDashboardCategoryImage(activeCategoryForUpload, publicUrl, newPath);
        refreshCategoryImages();
        alert('雲端圖片上傳成功！');
      } catch (err: any) {
        console.error('上傳圖片至雲端失敗:', err);
        alert(`上傳圖片失敗: ${err.message || err}`);
      } finally {
        setIsLoading(false);
      }
    } else {
      // Local Mode: 舊有 localStorage 儲存 Data URL 方式
      const reader = new FileReader();
      reader.onload = (event) => {
        const dataUrl = event.target?.result as string;
        if (dataUrl) {
          localStorage.setItem(`dashboard_category_img_${activeCategoryForUpload}`, dataUrl);
          setCategoryImages(prev => ({
            ...prev,
            [activeCategoryForUpload]: dataUrl
          }));
        }
      };
      reader.readAsDataURL(file);
    }
  };

  useEffect(() => {
    loadData();
    refreshCategoryImages();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [fetchedGroups, fetchedVars, fetchedCats, fetchedBatchItems, fetchedPrivateItems, fetchedInventory, fetchedOrderItems] = await Promise.all([
        dataProvider.getProductGroups().catch(() => []),
        dataProvider.getProductVariants().catch(() => []),
        dataProvider.getProductCategories().catch(() => []),
        dataProvider.getPurchaseBatchItems().catch(() => []),
        dataProvider.getPrivateOrderItems().catch(() => []),
        dataProvider.getInventory().catch(() => []),
        dataProvider.getSalesOrderItems().catch(() => [])
      ]);
      setGroups(fetchedGroups || []);
      setVariants(fetchedVars || []);
      setCategories(fetchedCats || []);
      setBatchItems(fetchedBatchItems || []);
      setPrivateOrderItems(fetchedPrivateItems || []);
      setInventory(fetchedInventory || []);
      setSalesOrderItems(fetchedOrderItems || []);
    } catch (e) {
      console.error('Failed to load data on Dashboard', e);
    }

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    setRefreshTime(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`);
    refreshCategoryImages();
    setIsLoading(false);
  };

  // --- Classification logic (Strictly matched with PurchaseRecords.tsx, with safety guards) ---
  const checkIsProxyProduct = (g: ProductGroup) => {
    if (!g) return false;
    if (g.listing_type === '代理版') return true;
    if (g.source_type === '代理版') return true;

    const variantsList = variants || [];
    const inventoryList = inventory || [];

    const groupVars = variantsList.filter(v => v && v.product_group_id === g.id);
    const hasProxySku = groupVars.some(v => {
      if (!v.myacg_item_code) return false;
      const invItem = inventoryList.find(i => i && i.myacg_item_code === v.myacg_item_code);
      return invItem?.listing_type === '代理版';
    });
    if (hasProxySku) return true;

    const keywords = [
      '代理版', '代理', 'gsc', 'good smile', 'max factory', 'furyu', '景品', 'sega', 'bandai', 'kotobukiya'
    ];

    const matchText = (text: any) => {
      if (!text || typeof text !== 'string') return false;
      const lower = text.toLowerCase();
      return keywords.some(kw => lower.includes(kw));
    };

    if (matchText(g.title) || matchText(g.normalized_title)) return true;

    const matchVar = groupVars.some(v => 
      v && (
        matchText(v.variant_name) || 
        matchText(v.raw_variant_name) || 
        matchText(v.product_title)
      )
    );
    if (matchVar) return true;

    const matchInv = groupVars.some(v => {
      if (!v || !v.myacg_item_code) return false;
      const invItem = inventoryList.find(i => i && i.myacg_item_code === v.myacg_item_code);
      return matchText(invItem?.product_title) || matchText(invItem?.raw_variant_name);
    });
    if (matchInv) return true;

    return false;
  };

  const normalizeForMatch = (text: any): string => {
    if (!text || typeof text !== 'string') return '';
    return text.toLowerCase().replace(/[\s!\uff01\?\uff1f\-_\(\)\uff08\uff09\.\*,]/g, '');
  };

  const isProxyProduct = (g: ProductGroup) => {
    return checkIsProxyProduct(g);
  };

  const isHololiveProduct = (g: ProductGroup) => {
    if (!g) return false;
    if (isProxyProduct(g)) return false;
    const titleNorm = normalizeForMatch(g.title);
    const normTitleNorm = normalizeForMatch(g.normalized_title);
    return titleNorm.includes('hololive') || normTitleNorm.includes('hololive');
  };

  const isVspoProduct = (g: ProductGroup) => {
    if (!g) return false;
    if (isProxyProduct(g)) return false;
    const titleNorm = normalizeForMatch(g.title);
    const normTitleNorm = normalizeForMatch(g.normalized_title);
    return titleNorm.includes('vspo') || titleNorm.includes('ぶいすぽ') || 
           normTitleNorm.includes('vspo') || normTitleNorm.includes('ぶいすぽ');
  };

  const isOtherProduct = (g: ProductGroup) => {
    if (!g) return false;
    return !isProxyProduct(g) && !isHololiveProduct(g) && !isVspoProduct(g);
  };

  const getGroupDemandAndPurchased = (groupId: string) => {
    const categoriesList = categories || [];
    const variantsList = variants || [];
    const privateOrderItemsList = privateOrderItems || [];
    const batchItemsList = batchItems || [];
    const inventoryList = inventory || [];
    const salesOrderItemsList = salesOrderItems || [];

    const catIds = new Set(categoriesList.filter(c => c && c.product_group_id === groupId).map(c => c.id));
    const groupVars = variantsList.filter(v => v && (v.product_group_id === groupId || (v.product_category_id && catIds.has(v.product_category_id))));
    
    let totalDemand = 0;
    let totalPurchased = 0;
    let gap = 0;
    
    groupVars.forEach(v => {
      if (!v) return;
      
      let myacgDemand = 0;
      try {
        myacgDemand = (v.myacg_item_code && typeof v.myacg_item_code === 'string' && v.myacg_item_code.trim()) 
          ? calculateFinalMyacgDemand(v.myacg_item_code, inventoryList, salesOrderItemsList) 
          : 0;
      } catch (err) {
        console.error(`Failed to calculate myacg demand for SKU ${v.myacg_item_code}:`, err);
      }
      myacgDemand += (v.myacg_manual_adjustment || 0);

      const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
      const privateDemand = privateOrderItemsList.filter(poi => poi && poi.product_variant_id === v.id).reduce((sum, item) => sum + (item.quantity || 0), 0);
      
      const demand = myacgDemand + wacaDemand + privateDemand;
      const purchased = batchItemsList.filter(pbi => pbi && pbi.product_variant_id === v.id).reduce((sum, item) => sum + (item.quantity || 0), 0);
      
      totalDemand += demand;
      totalPurchased += purchased;
      gap += Math.max(demand - purchased, 0);
    });
    
    return { demand: totalDemand, purchased: totalPurchased, gap };
  };

  // --- Date helpers ---
  const parseDateStr = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  };

  const getTargetClosingDate = (g: ProductGroup) => {
    if (g.purchase_date && g.purchase_date.trim() !== '') {
      return { date: g.purchase_date.trim(), type: 'purchase' as const };
    }
    if (g.closing_date && g.closing_date.trim() !== '') {
      return { date: g.closing_date.trim(), type: 'closing' as const };
    }
    return null;
  };

  const today = useMemo(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, []);

  const getRemainingDays = (dateStr: string | undefined | null) => {
    if (!dateStr) return { text: '-', days: 999 };
    const diffTime = parseDateStr(dateStr).getTime() - parseDateStr(today).getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    return {
      text: diffDays < 0 ? '已過期' : `剩 ${diffDays} 天`,
      days: diffDays
    };
  };

  // --- Dynamic Stats Computations ---
  const stats = useMemo(() => {
    const groupsList = groups || [];
    let activeCount = 0;
    let unorderedCount = 0;
    let urgent7Count = 0;
    let urgent3Count = 0;
    let closedCount = 0;

    groupsList.forEach(g => {
      if (!g) return;
      const target = getTargetClosingDate(g);
      const details = getGroupDemandAndPurchased(g.id);
      
      const isActive = !target || target.date >= today;

      if (isActive) {
        activeCount++;
        // 尚未下單商品數 (已開單且需求 > 0，但採購數量 = 0)
        if (details.demand > 0 && details.purchased === 0) {
          unorderedCount++;
        }

        // 即將結單 (7天內)
        if (target) {
          const { days } = getRemainingDays(target.date);
          if (days >= 0 && days <= 7) {
            urgent7Count++;
            if (days <= 3) {
              urgent3Count++;
            }
          }
        }
      } else {
        closedCount++;
      }
    });

    return {
      activeCount,
      unorderedCount,
      urgent7Count,
      urgent3Count,
      closedCount
    };
  }, [groups, variants, inventory, salesOrderItems, batchItems, privateOrderItems, today]);

  // Categories count
  const categoryCounts = useMemo(() => {
    const groupsList = groups || [];
    return {
      all: groupsList.length,
      hololive: groupsList.filter(isHololiveProduct).length,
      vspo: groupsList.filter(isVspoProduct).length,
      proxy: groupsList.filter(isProxyProduct).length,
      other: groupsList.filter(isOtherProduct).length,
    };
  }, [groups, variants, inventory]);

  // Release Month stats aggregation
  const releaseMonthStats = useMemo(() => {
    const counts: Record<string, number> = {};
    const groupsList = groups || [];
    const currentMonth = today.substring(0, 7); // "YYYY-MM"

    groupsList.forEach(g => {
      if (!g || !g.release_month) return;
      const match = g.release_month.match(/^(\d{4})-(\d{2})$/);
      if (!match) return;

      if (g.release_month >= currentMonth) {
        counts[g.release_month] = (counts[g.release_month] || 0) + 1;
      }
    });

    return Object.entries(counts)
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [groups, today]);

  // Urgent Groups (closing in <= 7 days, or overdue with gap)
  const urgentGroups = useMemo(() => {
    const groupsList = groups || [];
    const eligibleList: {
      group: ProductGroup;
      targetDate: string;
      targetType: 'purchase' | 'closing';
      gap: number;
      diffDays: number;
    }[] = [];

    groupsList.forEach(g => {
      if (!g) return;
      const target = getTargetClosingDate(g);
      if (!target) return;

      const { gap } = getGroupDemandAndPurchased(g.id);
      const { days } = getRemainingDays(target.date);

      const isEligible = (days >= 0 && days <= 7) || (days < 0 && gap > 0);
      if (isEligible) {
        eligibleList.push({
          group: g,
          targetDate: target.date,
          targetType: target.type,
          gap,
          diffDays: days
        });
      }
    });

    // Sort according to rules:
    // 1. 缺口 > 0 優先
    // 2. 結單日期越近越前面
    // 3. 缺口數越大越前面
    eligibleList.sort((a, b) => {
      const hasGapA = a.gap > 0;
      const hasGapB = b.gap > 0;

      if (hasGapA !== hasGapB) {
        return hasGapA ? -1 : 1;
      }

      const dateCompare = a.targetDate.localeCompare(b.targetDate);
      if (dateCompare !== 0) {
        return dateCompare;
      }

      return b.gap - a.gap;
    });

    return eligibleList.slice(0, 5);
  }, [groups, today, variants, inventory, salesOrderItems, batchItems, privateOrderItems]);

  return (
    <div className="dashboard-container">
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileChange} 
        accept="image/*" 
        style={{ display: 'none' }} 
      />
      <style>{`
        .dashboard-container {
          width: 100%;
          max-width: none;
          margin: 0;
          padding: 0;
          box-sizing: border-box;
          font-family: 'Outfit', 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #1e293b;
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .dashboard-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          border-bottom: 1px solid #f1f5f9;
          padding-bottom: 16px;
          flex-wrap: wrap;
          gap: 16px;
        }

        .dashboard-title-area h1 {
          font-size: 26px;
          font-weight: 700;
          color: #0f172a;
          margin: 0 0 6px 0;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .dashboard-title-area p {
          font-size: 14px;
          color: #64748b;
          margin: 0;
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .update-time {
          font-size: 12px;
          color: #64748b;
          background-color: #f8fafc;
          padding: 6px 12px;
          border-radius: 9999px;
          border: 1px solid #e2e8f0;
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
        }

        .btn-refresh:hover {
          background-color: #f8fafc;
          border-color: #94a3b8;
          color: #1e293b;
        }

        .btn-refresh:active {
          transform: scale(0.98);
        }

        /* KPI Cards Grid */
        .kpi-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 20px;
        }

        .kpi-card {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          padding: 16px 20px;
          height: 110px;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          gap: 16px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.02);
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          position: relative;
        }

        .kpi-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 20px rgba(0,0,0,0.04);
          border-color: #cbd5e1;
        }

        .kpi-icon-wrapper {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .kpi-info {
          display: flex;
          flex-direction: column;
        }

        .kpi-value {
          font-size: 26px;
          font-weight: 700;
          color: #0f172a;
          line-height: 1.2;
        }

        .kpi-value span {
          font-size: 14px;
          font-weight: 600;
          color: #64748b;
          margin-left: 2px;
        }

        .kpi-label {
          font-size: 14px;
          font-weight: 600;
          color: #475569;
          margin-bottom: 2px;
        }

        .kpi-sub {
          font-size: 12px;
          color: #64748b;
        }

        /* Category Section */
        .category-section {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .category-section-header {
          margin-bottom: 4px;
        }

        .category-section h3 {
          font-size: 16px;
          font-weight: 700;
          color: #0f172a;
          margin: 0 0 4px 0;
        }

        .category-section p {
          font-size: 13px;
          color: #64748b;
          margin: 0;
        }

        .category-grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 20px;
        }

        .category-card {
          display: flex;
          align-items: center;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          overflow: hidden;
          cursor: pointer;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          height: 160px;
          position: relative;
          padding: 10px;
          box-sizing: border-box;
          gap: 10px;
        }

        .category-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 20px -8px rgba(37, 99, 235, 0.15), 0 4px 12px -2px rgba(0, 0, 0, 0.04);
          border-color: #2563eb;
        }

        .category-img-container {
          width: 35%;
          height: 100%;
          border-radius: 12px;
          overflow: hidden;
          position: relative;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.05);
          background-color: #f8fafc;
        }

        .category-img-overlay {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 1;
        }

        .category-img {
          max-width: 90%;
          max-height: 90%;
          object-fit: contain;
          transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .category-card:hover .category-img {
          transform: scale(1.08);
        }

        .category-info {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          height: 100%;
          min-width: 0;
          padding: 4px 0;
          box-sizing: border-box;
        }

        .category-info-top {
          display: flex;
          flex-direction: column;
        }

        .category-name {
          font-size: 13.5px;
          font-weight: 700;
          color: #334155;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          transition: color 0.2s ease;
        }

        .category-card:hover .category-name {
          color: #2563eb;
        }

        .category-count {
          font-size: 24px;
          font-weight: 800;
          color: #0f172a;
          margin-top: 2px;
          line-height: 1;
        }

        .category-count span {
          font-size: 13px;
          font-weight: 600;
          color: #64748b;
          margin-left: 2px;
        }

        .category-link {
          font-size: 11px;
          font-weight: 700;
          color: #2563eb;
          display: inline-flex;
          align-items: center;
          gap: 2px;
          transition: all 0.2s ease;
          opacity: 0.85;
          white-space: nowrap;
        }

        .category-card:hover .category-link {
          opacity: 1;
          transform: translateX(3px);
          color: #1d4ed8;
        }

        .category-footer-row {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 6px;
          margin-top: auto;
          width: 100%;
        }

        .btn-change-image {
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 4px;
          background: #f8fafc;
          border: 1px solid #cbd5e1;
          color: #64748b;
          cursor: pointer;
          transition: all 0.2s ease;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          white-space: nowrap;
          margin-top: 2px;
        }

        .btn-change-image:hover {
          background: #f1f5f9;
          color: #1e293b;
          border-color: #94a3b8;
        }

        .btn-change-image:active {
          transform: scale(0.95);
        }


        /* Urgent section */
        .urgent-section {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .urgent-section-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          border-bottom: 1px solid #f1f5f9;
          padding-bottom: 8px;
        }

        .urgent-section-header h3 {
          font-size: 16px;
          font-weight: 700;
          color: #0f172a;
          margin: 0 0 4px 0;
        }

        .urgent-section-header p {
          font-size: 13px;
          color: #64748b;
          margin: 0;
        }

        .link-view-all {
          font-size: 13px;
          font-weight: 600;
          color: #2563eb;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 2px;
          transition: color 0.15s ease;
        }

        .link-view-all:hover {
          color: #1d4ed8;
          text-decoration: underline;
        }

        .urgent-table-container {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
        }

        .urgent-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
          font-size: 13px;
        }

        .urgent-table th {
          padding: 14px 20px;
          font-weight: 600;
          color: #475569;
          font-size: 12px;
          background-color: #f8fafc;
          border-bottom: 1px solid #e2e8f0;
        }

        .urgent-table tr {
          border-bottom: 1px solid #f1f5f9;
          transition: background-color 0.2s ease;
          height: 68px;
        }

        .urgent-table tbody tr:hover {
          background-color: #f8fafc;
        }

        .urgent-table tbody tr:last-child {
          border-bottom: none;
        }

        .urgent-table td {
          padding: 12px 20px;
          vertical-align: middle;
          color: #1e293b;
        }

        .urgent-table-title {
          font-size: 13.5px;
          font-weight: 700;
          color: #0f172a;
          margin: 0;
          line-height: 1.4;
          white-space: normal;
          word-break: break-all;
        }
      `}</style>

      {/* Header section */}
      <div className="dashboard-header">
        <div className="dashboard-title-area">
          <h1>訂購紀錄表</h1>
          <p>追蹤商品採購進度，協助您入貨與結單行程規劃與進度管理。</p>
        </div>
        <div className="header-actions">
          {refreshTime && (
            <span className="update-time">更新時間：{refreshTime}</span>
          )}
          <button className="btn-refresh" onClick={loadData} disabled={isLoading}>
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
            <span>重新整理</span>
          </button>
        </div>
      </div>

      {/* 第一區：營運摘要 */}
      <div className="kpi-grid">
        {/* 開單中商品數 */}
        <div className="kpi-card">
          <div className="kpi-icon-wrapper" style={{ backgroundColor: '#eff6ff', color: '#2563eb' }}>
            <ClipboardList size={22} />
          </div>
          <div className="kpi-info">
            <span className="kpi-label">開單中商品數</span>
            <span className="kpi-value">{stats.activeCount}<span>項</span></span>
            <span className="kpi-sub">目前進行中</span>
          </div>
        </div>

        {/* 尚未下單商品數 */}
        <div className="kpi-card">
          <div className="kpi-icon-wrapper" style={{ backgroundColor: '#fff7ed', color: '#ea580c' }}>
            <AlertTriangle size={22} />
          </div>
          <div className="kpi-info">
            <span className="kpi-label">尚未下單商品數</span>
            <span className="kpi-value">{stats.unorderedCount}<span>項</span></span>
            <span className="kpi-sub">已開單但尚未下單</span>
          </div>
        </div>

        {/* 即將結單商品數 */}
        <div className="kpi-card">
          <div className="kpi-icon-wrapper" style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}>
            <Clock size={22} />
          </div>
          <div className="kpi-info">
            <span className="kpi-label">即將結單商品數 (7天內)</span>
            <span className="kpi-value">{stats.urgent7Count}<span>項</span></span>
            <span className="kpi-sub">3天內結單：{stats.urgent3Count} 項</span>
          </div>
        </div>

        {/* 已結單商品數 */}
        <div className="kpi-card">
          <div className="kpi-icon-wrapper" style={{ backgroundColor: '#f0fdf4', color: '#16a34a' }}>
            <CheckCircle2 size={22} />
          </div>
          <div className="kpi-info">
            <span className="kpi-label">已結單商品數</span>
            <span className="kpi-value">{stats.closedCount}<span>項</span></span>
            <span className="kpi-sub">已完成結單</span>
          </div>
        </div>
      </div>

      {/* 第二區：商品分類入口 */}
      <div className="category-section">
        <div className="category-section-header">
          <h3>商品分類</h3>
          <p>點擊分類卡片可直接進入訂購紀錄表篩選特定分類</p>
        </div>
        <div className="category-grid">
          {/* 全部商品 */}
          <div className="category-card" onClick={() => navigate('/purchase-records?tab=all')}>
            <div className="category-img-container" style={{ backgroundColor: '#eff6ff' }}>
              <div className="category-img-overlay" style={{ background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.12) 0%, rgba(37, 99, 235, 0.02) 100%)' }} />
              <img className="category-img" src={categoryImages.all || DEFAULT_IMAGES.all} alt="全部商品" />
            </div>
            <div className="category-info">
              <div className="category-info-top">
                <span className="category-name">全部商品</span>
                <span className="category-count">{categoryCounts.all}<span>項</span></span>
              </div>
              <div className="category-footer-row">
                <span className="category-link">
                  查看訂購紀錄 <ChevronRight size={12} />
                </span>
                <button 
                  className="btn-change-image"
                  onClick={(e) => triggerImageUpload('all', e)}
                >
                  更換圖片
                </button>
              </div>
            </div>
          </div>

          {/* Hololive商品 */}
          <div className="category-card" onClick={() => navigate('/purchase-records?tab=hololive')}>
            <div className="category-img-container" style={{ backgroundColor: '#f5f3ff' }}>
              <div className="category-img-overlay" style={{ background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.12) 0%, rgba(139, 92, 246, 0.02) 100%)' }} />
              <img className="category-img" src={categoryImages.hololive || DEFAULT_IMAGES.hololive} alt="Hololive商品" />
            </div>
            <div className="category-info">
              <div className="category-info-top">
                <span className="category-name">Hololive商品</span>
                <span className="category-count">{categoryCounts.hololive}<span>項</span></span>
              </div>
              <div className="category-footer-row">
                <span className="category-link">
                  查看訂購紀錄 <ChevronRight size={12} />
                </span>
                <button 
                  className="btn-change-image"
                  onClick={(e) => triggerImageUpload('hololive', e)}
                >
                  更換圖片
                </button>
              </div>
            </div>
          </div>

          {/* VSPO商品 */}
          <div className="category-card" onClick={() => navigate('/purchase-records?tab=vspo')}>
            <div className="category-img-container" style={{ backgroundColor: '#fff1f2' }}>
              <div className="category-img-overlay" style={{ background: 'linear-gradient(135deg, rgba(244, 63, 94, 0.12) 0%, rgba(244, 63, 94, 0.02) 100%)' }} />
              <img className="category-img" src={categoryImages.vspo || DEFAULT_IMAGES.vspo} alt="VSPO商品" />
            </div>
            <div className="category-info">
              <div className="category-info-top">
                <span className="category-name">VSPO商品</span>
                <span className="category-count">{categoryCounts.vspo}<span>項</span></span>
              </div>
              <div className="category-footer-row">
                <span className="category-link">
                  查看訂購紀錄 <ChevronRight size={12} />
                </span>
                <button 
                  className="btn-change-image"
                  onClick={(e) => triggerImageUpload('vspo', e)}
                >
                  更換圖片
                </button>
              </div>
            </div>
          </div>

          {/* 代理版商品 */}
          <div className="category-card" onClick={() => navigate('/purchase-records?tab=agency')}>
            <div className="category-img-container" style={{ backgroundColor: '#fff7ed' }}>
              <div className="category-img-overlay" style={{ background: 'linear-gradient(135deg, rgba(249, 115, 22, 0.12) 0%, rgba(249, 115, 22, 0.02) 100%)' }} />
              <img className="category-img" src={categoryImages.agency || DEFAULT_IMAGES.agency} alt="代理版商品" />
            </div>
            <div className="category-info">
              <div className="category-info-top">
                <span className="category-name">代理版商品</span>
                <span className="category-count">{categoryCounts.proxy}<span>項</span></span>
              </div>
              <div className="category-footer-row">
                <span className="category-link">
                  查看訂購紀錄 <ChevronRight size={12} />
                </span>
                <button 
                  className="btn-change-image"
                  onClick={(e) => triggerImageUpload('agency', e)}
                >
                  更換圖片
                </button>
              </div>
            </div>
          </div>

          {/* 其他商品 */}
          <div className="category-card" onClick={() => navigate('/purchase-records?tab=other')}>
            <div className="category-img-container" style={{ backgroundColor: '#f8fafc' }}>
              <div className="category-img-overlay" style={{ background: 'linear-gradient(135deg, rgba(100, 116, 139, 0.12) 0%, rgba(100, 116, 139, 0.02) 100%)' }} />
              <img className="category-img" src={categoryImages.other || DEFAULT_IMAGES.other} alt="其他商品" />
            </div>
            <div className="category-info">
              <div className="category-info-top">
                <span className="category-name">其他商品</span>
                <span className="category-count">{categoryCounts.other}<span>項</span></span>
              </div>
              <div className="category-footer-row">
                <span className="category-link">
                  查看訂購紀錄 <ChevronRight size={12} />
                </span>
                <button 
                  className="btn-change-image"
                  onClick={(e) => triggerImageUpload('other', e)}
                >
                  更換圖片
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 第三區：即將發售商品 */}
      {releaseMonthStats.length > 0 && (
        <div className="category-section" style={{ marginTop: '8px' }}>
          <div className="category-section-header">
            <h3>即將發售商品</h3>
            <p>本月及未來月份即將發售之商品群組統計，點擊可查詢該月份商品</p>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: '20px'
          }}>
            {releaseMonthStats.map(({ month, count }) => {
              const match = month.match(/^(\d{4})-(\d{2})$/);
              const displayName = match ? `${match[1]}年${match[2]}月` : month;
              return (
                <div 
                  key={month}
                  onClick={() => navigate(`/purchase-records?tab=all&search=${month}`)}
                  style={{
                    background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
                    border: '1px solid #e2e8f0',
                    borderRadius: '16px',
                    padding: '20px',
                    cursor: 'pointer',
                    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
                    transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    position: 'relative',
                    overflow: 'hidden'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.transform = 'translateY(-4px)';
                    e.currentTarget.style.borderColor = '#2563eb';
                    e.currentTarget.style.boxShadow = '0 12px 20px -8px rgba(37, 99, 235, 0.15), 0 4px 12px -2px rgba(0, 0, 0, 0.04)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.borderColor = '#e2e8f0';
                    e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)';
                  }}
                >
                  <div style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '4px',
                    height: '100%',
                    backgroundColor: '#2563eb'
                  }} />
                  <span style={{ fontSize: '14px', fontWeight: 700, color: '#475569' }}>{displayName}</span>
                  <span style={{ fontSize: '24px', fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                    {count}
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>個商品群組</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 第四區：即將結單 / 需要處理 */}
      <div className="urgent-section">
        <div className="urgent-section-header">
          <div>
            <h3>即將結單 / 需要處理</h3>
            <p>7天內即將結單之採購商品項目及目前缺口</p>
          </div>
          <a href="/purchase-records?tab=all" onClick={(e) => { e.preventDefault(); navigate('/purchase-records?tab=all'); }} className="link-view-all">
            查看全部提醒 &gt;
          </a>
        </div>
        {urgentGroups.length === 0 ? (
          <div style={{ height: '90px', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#f8fafc', borderRadius: '16px', border: '1px dashed #e2e8f0', color: '#64748b', fontSize: '14px', boxSizing: 'border-box' }}>
            🎉 太棒了！目前沒有即將結單或需要處理的商品。
          </div>
        ) : (
          <div className="urgent-table-container">
            <table className="urgent-table">
              <thead>
                <tr>
                  <th style={{ width: '15%', paddingLeft: '24px' }}>結單類型</th>
                  <th style={{ width: '45%' }}>商品名稱</th>
                  <th style={{ width: '13%', textAlign: 'center' }}>結單日期</th>
                  <th style={{ width: '10%', textAlign: 'center' }}>剩餘天數</th>
                  <th style={{ width: '10%', textAlign: 'center' }}>缺口數量</th>
                  <th style={{ width: '10%', textAlign: 'center' }}>狀態</th>
                  <th style={{ width: '2%', paddingRight: '24px' }}></th>
                </tr>
              </thead>
              <tbody>
                {urgentGroups.map(item => {
                  const g = item.group;
                  if (!g) return null;
                  const gap = item.gap;
                  const targetDate = item.targetDate;
                  const targetType = item.targetType;
                  const diffDays = item.diffDays;
                  const remainingText = diffDays < 0 ? '已過期' : `${diffDays} 天`;

                  // Determine tags
                  const tags = [];
                  if (g.listing_type) {
                    tags.push(g.listing_type);
                  } else {
                    if (isProxyProduct(g)) {
                      tags.push('代理版');
                    } else {
                      tags.push('一般預購');
                    }
                  }
                  if (isHololiveProduct(g)) {
                    tags.push('Hololive');
                  } else if (isVspoProduct(g)) {
                    tags.push('VSPO');
                  }

                  return (
                    <tr key={g.id} onClick={() => navigate(`/purchase-records/${g.id}`)} style={{ cursor: 'pointer' }}>
                      <td style={{ paddingLeft: '24px' }}>
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          padding: '4px 12px',
                          fontSize: '11px',
                          fontWeight: 600,
                          borderRadius: '9999px',
                          backgroundColor: targetType === 'purchase' ? '#eff6ff' : '#f0fdf4',
                          color: targetType === 'purchase' ? '#2563eb' : '#16a34a',
                          border: targetType === 'purchase' ? '1px solid #bfdbfe' : '1px solid #bbf7d0'
                        }}>
                          {targetType === 'purchase' ? '購買結單' : '官方結單'}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span className="urgent-table-title">{g.normalized_title || g.title}</span>
                          <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                            {tags.map((tag, i) => (
                              <span key={i} style={{ backgroundColor: '#f1f5f9', color: '#475569', fontSize: '10px', padding: '1px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                {tag}
                              </span>
                            ))}
                          </div>
                        </div>
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: '#475569' }}>
                        {targetDate}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 700, color: '#ef4444' }}>
                        {remainingText}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 700, color: '#ef4444' }}>
                        缺口 {gap}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          padding: '4px 10px',
                          fontSize: '11px',
                          fontWeight: 600,
                          borderRadius: '9999px',
                          backgroundColor: '#fffbeb',
                          color: '#d97706',
                          border: '1px solid #fef3c7'
                        }}>
                          進行中
                        </span>
                      </td>
                      <td style={{ paddingRight: '24px', textAlign: 'right' }}>
                        <ChevronRight size={16} style={{ color: '#94a3b8' }} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
