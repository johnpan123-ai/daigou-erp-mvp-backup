import { useState, useEffect, useMemo, useRef } from 'react';
import { calculateFinalMyacgDemand, getBaseSku, calculateVariantDemandAndPurchased, calculateGroupDemandAndPurchased, normalizeDateInput } from '../lib/db';
import { dataProvider, StaleDataError } from '../providers/dataProvider';

import type { ProductGroup, ProductVariant, ProductCategory, PurchaseBatchItem, PrivateOrderItem, InventoryItem, SalesOrderItem } from '../lib/db';
import { Receipt, Search, Trash2, Calendar, Copy, Check, ExternalLink } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';
import { useNavigate, useLocation } from 'react-router-dom';
import { useViewport } from '../contexts/ViewportContext';
import { useResizableColumns } from '../hooks/useResizableColumns';

const DEFAULT_COL_WIDTHS = {
  title: 350,
  myacg: 80,
  waca: 80,
  privateOrder: 90,
  totalDemand: 90,
  purchased: 80,
  gap: 80,
  closingDate: 120,
  releaseMonth: 100,
  productUrl: 120
};


const ScrollWrapper = ({ children, isMobile }: { children: React.ReactNode; isMobile: boolean }) => {
  if (isMobile) {
    return (
      <div className="mobile-scroll-wrapper" style={{ width: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {children}
      </div>
    );
  }
  return <>{children}</>;
};

const WACA_META_ID = '00000000-0000-4000-a000-000000000000';

const formatWacaDate = (dateStr: string) => {
  if (!dateStr) return '尚未更新';
  if (dateStr.includes('T') && !isNaN(Date.parse(dateStr))) {
    const d = new Date(dateStr);
    const YYYY = d.getFullYear();
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    const HH = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${YYYY}/${MM}/${DD} ${HH}:${mm}:${ss}`;
  }
  return dateStr.replace(/-/g, '/');
};

export default function PurchaseRecords() {
  const { isMobile } = useViewport();

  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [batchItems, setBatchItems] = useState<PurchaseBatchItem[]>([]);
  const [privateOrderItems, setPrivateOrderItems] = useState<PrivateOrderItem[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [salesOrderItems, setSalesOrderItems] = useState<SalesOrderItem[]>([]);

  const [editMode, setEditMode] = useState<boolean>(false);

  const [wacaMeta, setWacaMeta] = useState<ProductGroup | null>(null);
  const [showWacaDialog, setShowWacaDialog] = useState<boolean>(false);
  const [animateWacaDialog, setAnimateWacaDialog] = useState<boolean>(false);

  const openWacaDialog = () => {
    setShowWacaDialog(true);
  };

  const closeWacaDialog = () => {
    setAnimateWacaDialog(false);
    setTimeout(() => setShowWacaDialog(false), 220);
  };

  useEffect(() => {
    if (showWacaDialog) {
      let rAFId = requestAnimationFrame(() => {
        rAFId = requestAnimationFrame(() => {
          setAnimateWacaDialog(true);
        });
      });
      return () => cancelAnimationFrame(rAFId);
    } else {
      setAnimateWacaDialog(false);
    }
  }, [showWacaDialog]);
  const [selectedWacaUpdater, setSelectedWacaUpdater] = useState<'小河馬' | 'Flanlove' | '許願'>('小河馬');

  const handleUpdateAgent = async (groupId: string, agent: string) => {
    if (guardAgainstStaleWrite()) return;

    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        return { ...g, proxy_agent: agent || undefined } as ProductGroup;
      }
      return g;
    });

    setGroups(updatedGroups);

    try {
      await dataProvider.saveProductGroups(updatedGroups);
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      throw err;
    }
  };

  const [draftDemands, setDraftDemands] = useState<Record<string, string>>({});

  const [draftClosingDates, setDraftClosingDates] = useState<Record<string, string>>({});

  const getClosingDateInputVal = (g: ProductGroup): string => {
    if (draftClosingDates[g.id] !== undefined) {
      return draftClosingDates[g.id];
    }
    return g.closing_date || '';
  };

  const handleCommitClosingDate = async (groupId: string, rawVal: string) => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    const currentVal = group.closing_date || '';
    if (rawVal.trim() === currentVal.trim()) {
      setDraftClosingDates(prev => {
        const next = { ...prev };
        delete next[groupId];
        return next;
      });
      return;
    }

    if (rawVal.trim() === '') {
      await handleUpdateGroupField(groupId, 'closing_date', '');
      return;
    }

    const normalized = normalizeDateInput(rawVal);
    if (normalized) {
      await handleUpdateGroupField(groupId, 'closing_date', normalized);
    } else {
      // Keep in draft for incomplete inputs, do not sync, do not alert
      console.log(`[Date Input] incomplete/invalid input ignored: ${rawVal}`);
    }
  };

  const handleCancelClosingDateDraft = (groupId: string) => {
    setDraftClosingDates(prev => {
      const next = { ...prev };
      delete next[groupId];
      return next;
    });
  };

  const handleUpdateDraft = (groupId: string, platform: 'myacg' | 'waca' | 'purchased', value: string) => {
    setDraftDemands(prev => ({
      ...prev,
      [`${groupId}_${platform}`]: value
    }));
  };

  const handleCommitDraft = async (groupId: string, platform: 'myacg' | 'waca' | 'purchased') => {
    const key = `${groupId}_${platform}`;
    const valStr = draftDemands[key];
    if (valStr !== undefined) {
      const val = parseInt(valStr, 10) || 0;
      setDraftDemands(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      await handleUpdateGroupPlatformDemand(groupId, platform, val);
    }
  };

  const handleCancelDraft = (groupId: string, platform: 'myacg' | 'waca' | 'purchased') => {
    setDraftDemands(prev => {
      const next = { ...prev };
      delete next[`${groupId}_${platform}`];
      return next;
    });
  };

  const getDynamicGap = (groupId: string, originalGap: number) => {
    const catIds = new Set(categories.filter(c => c.product_group_id === groupId).map(c => c.id));
    const groupVars = variants.filter(v => v.product_group_id === groupId || (v.product_category_id && catIds.has(v.product_category_id)));
    if (groupVars.length === 0) return originalGap;

    const v0 = groupVars[0];
    
    // Calculate original computed values for v0
    // MyACG
    const rawMyacgQty = calculateFinalMyacgDemand(v0.myacg_item_code, inventory, salesOrderItems);
    const localMyacg = (rawMyacgQty >= 0 ? rawMyacgQty : 0) + (v0.myacg_manual_adjustment ?? 0);
    const autoMyacg = (v0.myacg_auto_quantity !== null && v0.myacg_auto_quantity !== undefined && v0.myacg_auto_quantity >= 0)
      ? v0.myacg_auto_quantity + (v0.myacg_manual_adjustment ?? 0)
      : null;
    const rawMyacg = (v0.effective_myacg_quantity !== null && v0.effective_myacg_quantity !== undefined && v0.effective_myacg_quantity >= 0)
      ? v0.effective_myacg_quantity + (v0.myacg_manual_adjustment ?? 0)
      : (autoMyacg ?? (v0 as any).myacg_quantity ?? localMyacg);
    const v0_Myacg = rawMyacg >= 0 ? rawMyacg : 0;

    // WACA
    const localWaca = (v0.waca_auto_quantity ?? 0) + (v0.waca_manual_adjustment ?? 0);
    const autoWaca = (v0.waca_auto_quantity !== null && v0.waca_auto_quantity !== undefined && v0.waca_auto_quantity >= 0)
      ? v0.waca_auto_quantity + (v0.waca_manual_adjustment ?? 0)
      : null;
    const rawWaca = autoWaca ?? (v0 as any).waca_quantity ?? localWaca;
    const v0_Waca = rawWaca >= 0 ? rawWaca : 0;

    // Private
    const localPrivate = privateOrderItems.filter(poi => poi.product_variant_id === v0.id).reduce((sum, item) => sum + item.quantity, 0);
    const rawPrivate = v0.private_manual_adjustment ?? (v0 as any).private_quantity ?? localPrivate;
    const v0_Private = rawPrivate >= 0 ? rawPrivate : 0;

    // Purchased
    const localPurchased = batchItems.filter(pbi => pbi.product_variant_id === v0.id).reduce((sum, item) => sum + item.quantity, 0);

    const manualPurchased = v0.purchased_manual_adjustment;
    const legacyPurchased = (v0 as any).ordered_quantity ?? (v0 as any).ordered_qty;

    let rawPurchased = 0;
    if (typeof manualPurchased === 'number' && manualPurchased > 0) {
      rawPurchased = manualPurchased;
    } else if (localPurchased > 0) {
      rawPurchased = localPurchased;
    } else if (typeof legacyPurchased === 'number' && legacyPurchased > 0) {
      rawPurchased = legacyPurchased;
    }

    const v0_Purchased = rawPurchased;

    const v0_OriginalDemand = v0_Myacg + v0_Waca + v0_Private;
    const v0_OriginalGap = Math.max(v0_OriginalDemand - v0_Purchased, 0);

    // Apply draft overrides to v0
    const draftMyacgKey = `${groupId}_myacg`;
    const draftWacaKey = `${groupId}_waca`;
    const draftPurchasedKey = `${groupId}_purchased`;

    // For myacg: draft value overrides v0.myacg_manual_adjustment
    let new_v0_Myacg = v0_Myacg;
    if (draftDemands[draftMyacgKey] !== undefined) {
      const draftMyacgVal = parseInt(draftDemands[draftMyacgKey], 10) || 0;
      const myacgWithoutManual = v0_Myacg - (v0.myacg_manual_adjustment ?? 0);
      new_v0_Myacg = Math.max(myacgWithoutManual + draftMyacgVal, 0);
    }

    // For waca: draft value overrides v0.waca_manual_adjustment
    let new_v0_Waca = v0_Waca;
    if (draftDemands[draftWacaKey] !== undefined) {
      const draftWacaManual = parseInt(draftDemands[draftWacaKey], 10) || 0;
      const wacaWithoutManual = v0_Waca - (v0.waca_manual_adjustment ?? 0);
      new_v0_Waca = Math.max(wacaWithoutManual + draftWacaManual, 0);
    }

    // For purchased: draft value overrides v0.purchased_manual_adjustment
    let new_v0_Purchased = v0_Purchased;
    if (draftDemands[draftPurchasedKey] !== undefined) {
      new_v0_Purchased = parseInt(draftDemands[draftPurchasedKey], 10) || 0;
    }

    const new_v0_Demand = new_v0_Myacg + new_v0_Waca + v0_Private;
    const new_v0_Gap = Math.max(new_v0_Demand - new_v0_Purchased, 0);

    return Math.max(originalGap - v0_OriginalGap + new_v0_Gap, 0);
  };

  const [isStale, setIsStale] = useState<boolean>(false);

  console.log(`[UI Render] UI groups count: ${groups.length}`);
  console.log(`[UI Render] UI variants count: ${variants.length}`);

  const { colWidths, handleMouseDown, resetWidths } = useResizableColumns(
    'erp_purchase_records_col_widths',
    DEFAULT_COL_WIDTHS
  );

  const navigate = useNavigate();
  const location = useLocation();

  // Batch edit states and datepicker refs
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [batchClosingDate, setBatchClosingDate] = useState('');
  const [batchReleaseMonth, setBatchReleaseMonth] = useState('');

  const datePickerRefs = useRef<Record<string, HTMLInputElement | null>>({});


  const [searchTerm, setSearchTerm] = useState(() => localStorage.getItem('erp_search_term') || '');
  const [filterSource, setFilterSource] = useState(() => localStorage.getItem('erp_filter_source') || 'all');
  const [filterType, setFilterType] = useState(() => localStorage.getItem('erp_filter_type') || 'all');
  const [sortMode, setSortMode] = useState(() => localStorage.getItem('erp_sort_mode') || 'closing_urgent');
  const [activeTab, setActiveTab] = useState<'all' | 'hololive' | 'vspo' | 'proxy' | 'other'>(() => {
    return (localStorage.getItem('erp_active_tab') as 'all' | 'hololive' | 'vspo' | 'proxy' | 'other') || 'all';
  });

  const [secondaryTab, setSecondaryTab] = useState<'progress' | 'closed' | 'to_purchase' | 'all'>('progress');
  const [completedExpanded, setCompletedExpanded] = useState<boolean>(false);

  const normalizeDate = (dateStr: string | undefined | null): string | null => {
    if (!dateStr) return null;
    const clean = dateStr.trim().replace(/\//g, '-');
    const match = clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!match) return null;
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const checkIsGroupClosed = (g: ProductGroup): boolean => {
    const closing = normalizeDate(g.closing_date);
    if (!closing) return false;
    const todayStr = getTodayStr();
    return todayStr > closing;
  };

  const getTodayStr = (): string => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const checkIsGroupOverdue = (g: ProductGroup): boolean => {
    const closing = normalizeDate(g.closing_date);
    if (!closing) return false;
    const todayStr = getTodayStr();
    return closing < todayStr;
  };

  const checkIsToPurchase = (g: ProductGroup): boolean => {
    const closing = normalizeDate(g.closing_date);
    if (!closing) return false;
    const todayStr = getTodayStr();
    if (closing > todayStr) return false;
    
    const details = getGroupPlatformDetails(g.id);
    const demandAndPurchased = getGroupDemandAndPurchased(g.id);
    const isProxy = isProxyProduct(g);
    const totalDemand = isProxy 
      ? (details.myacg + details.wacaManual + details.privateOrder) 
      : demandAndPurchased.demand;
    const purchased = isProxy ? details.purchased : demandAndPurchased.purchased;

    return purchased < totalDemand;
  };

  useEffect(() => {
    localStorage.setItem('erp_search_term', searchTerm);
    localStorage.setItem('erp_filter_source', filterSource);
    localStorage.setItem('erp_filter_type', filterType);
    localStorage.setItem('erp_sort_mode', sortMode);
  }, [searchTerm, filterSource, filterType, sortMode]);

  useEffect(() => {
    localStorage.setItem('erp_active_tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const tabParam = searchParams.get('tab');
    if (tabParam) {
      if (tabParam === 'all') setActiveTab('all');
      else if (tabParam === 'hololive') setActiveTab('hololive');
      else if (tabParam === 'vspo') setActiveTab('vspo');
      else if (tabParam === 'agency') setActiveTab('proxy');
      else if (tabParam === 'other') setActiveTab('other');
    }
    const searchParam = searchParams.get('search');
    if (searchParam) {
      setSearchTerm(searchParam);
    }
  }, [location.search, setActiveTab]);

  useEffect(() => {
    const state = location.state as { resetSearch?: number } | null;
    if (state?.resetSearch) {
      setSearchTerm('');
      setFilterSource('all');
      setFilterType('all');
      setActiveTab('all');
      setSecondaryTab('progress');

      // Clear localStorage so the reset persists
      localStorage.setItem('erp_search_term', '');
      localStorage.setItem('erp_filter_source', 'all');
      localStorage.setItem('erp_filter_type', 'all');
      localStorage.setItem('erp_active_tab', 'all');
      localStorage.setItem('erp_active_secondary_tab', 'progress');

      // Replace history to clear state
      navigate(location.pathname + location.search, { replace: true, state: null });
    }
  }, [location.state, location.pathname, location.search, navigate]);


  const [copiedGroupId, setCopiedGroupId] = useState<string | null>(null);
  const handleCopyTitle = async (groupId: string, title: string) => {
    try {
      await navigator.clipboard.writeText(title);
      setCopiedGroupId(groupId);
      setTimeout(() => {
        setCopiedGroupId(current => current === groupId ? null : current);
      }, 1000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  const getGroupStatus = (g: ProductGroup) => {
    const isClosed = checkIsGroupClosed(g);
    console.log({
      title: g.normalized_title || g.title,
      status: (g as any).status,
      closing_date: g.closing_date,
      today: getTodayStr(),
      computedStatus: isClosed ? '已結單' : '開單中'
    });
    if (isClosed) {
      return { text: '⚫ 已結單', active: false };
    }
    return { text: '🟢 開單中', active: true };
  };

  const checkIsProxyProduct = (g: ProductGroup) => {
    // 1. 優先讀 ProductGroup.listing_type
    if (g.listing_type === '代理版') return true;
    if (g.source_type === '代理版') return true;

    // 2. 如果沒有，從該 ProductGroup 底下的 ProductVariant 對應 InventoryItem 讀 InventoryItem.listing_type
    const groupVars = variants.filter(v => v.product_group_id === g.id);
    const hasProxySku = groupVars.some(v => {
      const invItem = inventory.find(i => i.myacg_item_code === v.myacg_item_code);
      return invItem?.listing_type === '代理版';
    });
    if (hasProxySku) return true;

    // 3. 商品名稱/規格名稱/InventoryItem名稱是否包含關鍵字
    const keywords = [
      '代理版',
      '代理',
      'gsc',
      'good smile',
      'max factory',
      'furyu',
      '景品',
      'sega',
      'bandai',
      'kotobukiya'
    ];

    const matchText = (text: string | undefined | null) => {
      if (!text) return false;
      const lower = text.toLowerCase();
      return keywords.some(kw => lower.includes(kw));
    };

    if (matchText(g.title) || matchText(g.normalized_title)) return true;

    const matchVar = groupVars.some(v => 
      matchText(v.variant_name) || 
      matchText(v.raw_variant_name) || 
      matchText(v.product_title)
    );
    if (matchVar) return true;

    const matchInv = groupVars.some(v => {
      const invItem = inventory.find(i => i.myacg_item_code === v.myacg_item_code);
      return matchText(invItem?.product_title) || matchText(invItem?.raw_variant_name);
    });
    if (matchInv) return true;

  };

  const normalizeForMatch = (text: string | undefined | null): string => {
    if (!text) return '';
    return text
      .toLowerCase()
      .replace(/[\s!\uff01\?\uff1f\-_\(\)\uff08\uff09\.\*,]/g, '');
  };

  const isProxyProduct = (g: ProductGroup) => {
    return !!checkIsProxyProduct(g);
  };

  const isHololiveProduct = (g: ProductGroup) => {
    if (isProxyProduct(g)) return false;
    const titleNorm = normalizeForMatch(g.title);
    const normTitleNorm = normalizeForMatch(g.normalized_title);
    return titleNorm.includes('hololive') || normTitleNorm.includes('hololive');
  };

  const isVspoProduct = (g: ProductGroup) => {
    if (isProxyProduct(g)) return false;
    const titleNorm = normalizeForMatch(g.title);
    const normTitleNorm = normalizeForMatch(g.normalized_title);
    return titleNorm.includes('vspo') || titleNorm.includes('ぶいすぽ') || 
           normTitleNorm.includes('vspo') || normTitleNorm.includes('ぶいすぽ');
  };

  const isOtherProduct = (g: ProductGroup) => {
    return !isProxyProduct(g) && !isHololiveProduct(g) && !isVspoProduct(g);
  };

  const getGroupPlatformDetails = (groupId: string) => {
    const catIds = new Set(categories.filter(c => c.product_group_id === groupId).map(c => c.id));
    const groupVars = variants.filter(v => v.product_group_id === groupId || (v.product_category_id && catIds.has(v.product_category_id)));
    
    let myacg = 0;
    let waca = 0;
    let privateOrder = 0;
    let purchased = 0;
    let myacgManual = 0;
    let wacaManual = 0;
    let totalGap = 0;
    
    groupVars.forEach(v => {
      const res = calculateVariantDemandAndPurchased(v, privateOrderItems, batchItems, inventory, salesOrderItems);
      myacg += res.myacg;
      waca += res.waca;
      privateOrder += res.privateOrder;
      purchased += res.purchased;
      myacgManual += (v.myacg_manual_adjustment ?? 0);
      wacaManual += (v.waca_manual_adjustment ?? 0);
      totalGap += res.gap;
    });
    
    const hasCatalogMissing = groupVars.some(v => v.catalog_missing === true);
    return { myacg, waca, privateOrder, purchased, gap: totalGap, myacgManual, wacaManual, hasCatalogMissing };
  };

  const getGroupDemandAndPurchased = (groupId: string) => {
    return calculateGroupDemandAndPurchased(
      groupId,
      categories,
      variants,
      privateOrderItems,
      batchItems,
      inventory,
      salesOrderItems
    );
  };

  const getGroupSkuAndPriceRange = (groupId: string) => {
    const catIds = new Set(categories.filter(c => c.product_group_id === groupId).map(c => c.id));
    const groupVars = variants.filter(v => v.product_group_id === groupId || (v.product_category_id && catIds.has(v.product_category_id)));
    
    const skus = Array.from(new Set(groupVars.map(v => v.myacg_item_code).filter(Boolean)));
    const baseSkus = Array.from(new Set(skus.map(code => getBaseSku(code))));
    const skuDisplay = baseSkus.length > 0 ? baseSkus.slice(0, 2).join(', ') + (baseSkus.length > 2 ? '...' : '') : '無SKU';

    const itemCodes = groupVars.map(v => v.myacg_item_code);
    const matchedInventoryItems = inventory.filter(item => itemCodes.includes(item.myacg_item_code));
    const prices = matchedInventoryItems.map(item => item.final_price).filter(p => p !== undefined && p !== null);
    let priceDisplay = '';
    if (prices.length > 0) {
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      priceDisplay = minPrice === maxPrice ? `¥${minPrice.toLocaleString()}` : `¥${minPrice.toLocaleString()} - ¥${maxPrice.toLocaleString()}`;
    } else {
      priceDisplay = '無價格';
    }

    return { skuDisplay, priceDisplay, count: groupVars.length };
  };

  const getClosingDateStyle = (closingDate: string | undefined | null) => {
    if (!closingDate) return { text: '-', color: '#64748b', fontWeight: 400 };
    
    const todayStr = getTodayStr();
    const closing = normalizeDate(closingDate);
    if (!closing) {
      return { text: closingDate, color: '#334155', fontWeight: 500 };
    }
    if (closing < todayStr) {
      return { text: closingDate, color: '#ef4444', fontWeight: 700 };
    }
    
    const todayTime = new Date(todayStr).getTime();
    const closingTime = new Date(closing).getTime();
    const diffDays = Math.ceil((closingTime - todayTime) / (1000 * 60 * 60 * 24));
    
    if (diffDays >= 0 && diffDays <= 3) {
      return { text: closingDate, color: '#f97316', fontWeight: 700 };
    }
    
    return { text: closingDate, color: '#334155', fontWeight: 500 };
  };

  const baseGroups = useMemo(() => {
    let result = [...groups];

    // Filter by activeTab
    if (activeTab === 'hololive') {
      result = result.filter(g => isHololiveProduct(g));
    } else if (activeTab === 'vspo') {
      result = result.filter(g => isVspoProduct(g));
    } else if (activeTab === 'proxy') {
      result = result.filter(g => isProxyProduct(g));
    } else if (activeTab === 'other') {
      result = result.filter(g => isOtherProduct(g));
    }

    // 1. Filter Source
    if (filterSource !== 'all') {
      result = result.filter(g => {
        if (filterSource === '代理商品') return isProxyProduct(g);
        if (filterSource === 'Hololive') return isHololiveProduct(g);
        if (filterSource === 'VSPO') return isVspoProduct(g);
        return false;
      });
    }

    // 2. Filter Type
    if (filterType !== 'all') {
      result = result.filter(g => {
        if (filterType === '代理版') return checkIsProxyProduct(g);
        return (g.listing_type || '一般預購') === filterType;
      });
    }

    // 3. Search
    if (searchTerm.trim()) {
      const lowerTerm = searchTerm.toLowerCase();
      result = result.filter(g => {
        const isProxy = checkIsProxyProduct(g);
        const effectiveListingType = isProxy ? '代理版' : (g.listing_type || '');
        
        // Find variants in this group (including categories mapped to this group)
        const catIds = new Set(categories.filter(c => c.product_group_id === g.id).map(c => c.id));
        const groupVars = variants.filter(v => v.product_group_id === g.id || (v.product_category_id && catIds.has(v.product_category_id)));
        
        const hasMatchingVariantOrCategory = groupVars.some(v => {
          if (v.variant_name && v.variant_name.toLowerCase().includes(lowerTerm)) return true;
          if (v.raw_variant_name && v.raw_variant_name.toLowerCase().includes(lowerTerm)) return true;
          if (v.product_category_id) {
            const cat = categories.find(c => c.id === v.product_category_id);
            if (cat && cat.title && cat.title.toLowerCase().includes(lowerTerm)) return true;
          }
          return false;
        });

        return (
          (g.title && g.title.toLowerCase().includes(lowerTerm)) ||
          (g.normalized_title && g.normalized_title.toLowerCase().includes(lowerTerm)) ||
          (g.release_month && g.release_month.toLowerCase().includes(lowerTerm)) ||
          (g.closing_date && g.closing_date.toLowerCase().includes(lowerTerm)) ||
          effectiveListingType.includes(lowerTerm) ||
          (g.product_url && g.product_url.toLowerCase().includes(lowerTerm)) ||
          hasMatchingVariantOrCategory
        );
      });
    }

    return result;
  }, [groups, searchTerm, filterSource, filterType, activeTab, variants, categories, inventory]);

  const { progressCount, closedCount, allCount, toPurchaseCount } = useMemo(() => {
    const progress = baseGroups.filter(g => !checkIsGroupClosed(g)).length;
    const closed = baseGroups.filter(g => checkIsGroupClosed(g)).length;
    const total = baseGroups.length;
    const toPurchase = baseGroups.filter(g => checkIsToPurchase(g)).length;
    return { progressCount: progress, closedCount: closed, allCount: total, toPurchaseCount: toPurchase };
  }, [baseGroups]);

  const completedGroups = useMemo(() => {
    if (secondaryTab !== 'progress') return [];

    let result = baseGroups.filter(g => {
      if (checkIsGroupClosed(g)) return false; // Must be in-progress
      return checkIsGroupOverdue(g);
    });

    result.sort((a, b) => {
      if (sortMode === 'closing_urgent') {
        const activeA = !checkIsGroupClosed(a);
        const activeB = !checkIsGroupClosed(b);
        if (activeA !== activeB) return activeA ? -1 : 1;
        
        const dateA = a.closing_date ? a.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateB = b.closing_date ? b.closing_date.replace(/\//g, '-') : '9999-12-31';
        return dateA.localeCompare(dateB);
      } else if (sortMode === 'closing_asc') {
        const dateA = a.closing_date ? a.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateB = b.closing_date ? b.closing_date.replace(/\//g, '-') : '9999-12-31';
        return dateA.localeCompare(dateB);
      } else {
        const timeA = new Date(a.created_at || 0).getTime();
        const timeB = new Date(b.created_at || 0).getTime();
        return timeB - timeA;
      }
    });

    return result;
  }, [baseGroups, secondaryTab, sortMode]);

  const filteredAndSortedGroups = useMemo(() => {
    let result = [...baseGroups];

    // Filter by progress/closed tab
    if (secondaryTab === 'progress') {
      result = result.filter(g => {
        if (checkIsGroupClosed(g)) return false;
        
        // Overdue items go to the bottom section
        const isOverdue = checkIsGroupOverdue(g);
        if (isOverdue) {
          return false;
        }
        
        return true;
      });
    } else if (secondaryTab === 'closed') {
      result = result.filter(g => checkIsGroupClosed(g));
    } else if (secondaryTab === 'to_purchase') {
      result = result.filter(g => checkIsToPurchase(g));
    }

    // Sort
    result.sort((a, b) => {
      if (sortMode === 'closing_urgent') {
        const activeA = !checkIsGroupClosed(a);
        const activeB = !checkIsGroupClosed(b);
        
        if (activeA !== activeB) {
          return activeA ? -1 : 1;
        }
        
        const dateA = a.closing_date ? a.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateB = b.closing_date ? b.closing_date.replace(/\//g, '-') : '9999-12-31';
        return dateA.localeCompare(dateB);
      } else if (sortMode === 'closing_asc') {
        const dateA = a.closing_date ? a.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateB = b.closing_date ? b.closing_date.replace(/\//g, '-') : '9999-12-31';
        return dateA.localeCompare(dateB);
      } else {
        const timeA = new Date(a.created_at || 0).getTime();
        const timeB = new Date(b.created_at || 0).getTime();
        return timeB - timeA;
      }
    });

    return result;
  }, [baseGroups, secondaryTab, sortMode]);

  const [stableEditOrder, setStableEditOrder] = useState<string[] | null>(null);
  const [stableCompletedOrder, setStableCompletedOrder] = useState<string[] | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editMode) {
      setStableEditOrder(filteredAndSortedGroups.map(g => g.id));
      setStableCompletedOrder(completedGroups.map(g => g.id));
    } else {
      setStableEditOrder(null);
      setStableCompletedOrder(null);
    }
  }, [editMode, searchTerm, filterSource, filterType, activeTab, secondaryTab, sortMode]);



  const displayedMainGroups = useMemo(() => {
    if (editMode && stableEditOrder) {
      const mapped = stableEditOrder
        .map(id => groups.find(g => g.id === id))
        .filter((g): g is ProductGroup => !!g);
      const existingIds = new Set(stableEditOrder);
      const newGroups = filteredAndSortedGroups.filter(g => !existingIds.has(g.id));
      return [...mapped, ...newGroups];
    }
    return filteredAndSortedGroups;
  }, [editMode, stableEditOrder, filteredAndSortedGroups, groups]);

  const displayedCompletedGroups = useMemo(() => {
    if (editMode && stableCompletedOrder) {
      const mapped = stableCompletedOrder
        .map(id => groups.find(g => g.id === id))
        .filter((g): g is ProductGroup => !!g);
      const existingIds = new Set(stableCompletedOrder);
      const newGroups = completedGroups.filter(g => !existingIds.has(g.id));
      return [...mapped, ...newGroups];
    }
    return completedGroups;
  }, [editMode, stableCompletedOrder, completedGroups, groups]);

  useEffect(() => {
    if (searchTerm.trim().length > 0) {
      if (completedGroups.length > 0) {
        setCompletedExpanded(true);
      }
    } else {
      setCompletedExpanded(false);
    }
  }, [searchTerm, completedGroups.length]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const [fetchedGroups, fetchedVars, fetchedCats, fetchedBatchItems, fetchedPrivateItems, fetchedInventory, fetchedOrderItems] = await Promise.all([
      dataProvider.getProductGroups(),
      dataProvider.getProductVariants(),
      dataProvider.getProductCategories(),
      dataProvider.getPurchaseBatchItems(),
      dataProvider.getPrivateOrderItems(),
      dataProvider.getInventory(),
      dataProvider.getSalesOrderItems()
    ]);
    console.log(`[UI Load] UI groups count: ${fetchedGroups.length}`);
    console.log(`[UI Load] UI variants count: ${fetchedVars.length}`);
    console.log('[UI Load] variants sample:', fetchedVars.length > 0 ? JSON.stringify(fetchedVars[0]) : 'empty');
    
    let finalGroups = fetchedGroups;

    // localStorage migration logic
    const storedMap = localStorage.getItem('erp_proxy_agent_map');
    if (storedMap) {
      try {
        const localMap = JSON.parse(storedMap);
        let migrated = false;
        
        const nextGroups = fetchedGroups.map(g => {
          const localAgent = localMap[g.id];
          if (localAgent && g.proxy_agent !== localAgent) {
            migrated = true;
            return { ...g, proxy_agent: localAgent };
          }
          return g;
        });

        if (!migrated) {
          // Condition 1: storedMap exists, but no migratable data
          localStorage.removeItem('erp_proxy_agent_map');
          console.log("[Migration] No migratable data found. Deleted erp_proxy_agent_map.");
        } else {
          // Condition 2 & 3: migrated === true
          // 1. Check stale status first
          if (dataProvider.checkIsStaleLive && dataProvider.checkIsStaleLive()) {
            console.warn("[Migration Warning] Local data is stale. Aborting migration to prevent overwriting cloud. LocalStorage preserved.");
            alert("偵測到雲端資料已有新變更。請重新載入網頁以取得最新狀態，系統將在重新載入後自動完成代理商舊資料搬移與同步。");
          } else {
            console.log("[Migration] Attempting to save migrated proxy agents to database...");
            await dataProvider.saveProductGroups(nextGroups);
            finalGroups = nextGroups;
            console.log("[Migration] Database write successful.");
            
            // Condition 2: save succeeded -> safely delete localStorage
            localStorage.removeItem('erp_proxy_agent_map');
            console.log("[Migration] Local storage 'erp_proxy_agent_map' successfully deleted.");
          }
        }
      } catch (e) {
        // Condition 3: migrated === true, but save fails / StaleDataError / network error
        console.error("[Migration ERROR] Failed to complete database migration. LocalStorage preserved. Error:", e);
      }
    }

    const meta = finalGroups.find(g => g.id === WACA_META_ID) || null;
    setWacaMeta(meta);
    const regularGroups = finalGroups.filter(g => g.id !== WACA_META_ID);
    
    setGroups(regularGroups);
    setVariants(fetchedVars);
    setCategories(fetchedCats);
    setBatchItems(fetchedBatchItems);
    setPrivateOrderItems(fetchedPrivateItems);
    setInventory(fetchedInventory);
    setSalesOrderItems(fetchedOrderItems);
    dataProvider.registerFreshLoad();
  };

  const handleUpdateWacaMeta = async (updatedBy: string) => {
    if (guardAgainstStaleWrite()) return;
    
    const nowStr = new Date().toISOString();
    
    const wacaMetaId = WACA_META_ID;
    const allGroups = await dataProvider.getProductGroups();
    const existingMeta = allGroups.find(g => g.id === wacaMetaId);
    
    let updatedMeta: ProductGroup;
    if (existingMeta) {
      updatedMeta = {
        ...existingMeta,
        proxy_agent: updatedBy,
        closing_date: nowStr,
        updated_at: new Date().toISOString()
      };
    } else {
      updatedMeta = {
        id: wacaMetaId,
        title: 'WACA_UPDATE_METADATA_DO_NOT_DELETE',
        purchase_date: new Date().toISOString().split('T')[0],
        priority: 'Low',
        closing_date: nowStr,
        release_month: '',
        has_official_site: false,
        product_url: '',
        proxy_agent: updatedBy,
        show_in_purchase_list: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    }
    
    const newAllGroups = [...allGroups.filter(g => g.id !== wacaMetaId), updatedMeta];
    
    try {
      await dataProvider.saveProductGroups(newAllGroups);
      setWacaMeta(updatedMeta);
      closeWacaDialog();
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      throw err;
    }
  };

  const guardAgainstStaleWrite = (): boolean => {
    const liveStale = dataProvider.checkIsStaleLive();
    if (isStale || liveStale) {
      alert('資料已在其他分頁更新，請重新載入最新資料後再編輯。');
      return true; // blocked
    }
    return false; // allowed
  };

  const handleReloadData = async () => {
    await loadData();
  };

  useEffect(() => {
    const unsubscribe = dataProvider.onStaleChange(setIsStale);
    setIsStale(dataProvider.checkIsStaleLive());
    return unsubscribe;
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showWacaDialog) {
        closeWacaDialog();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showWacaDialog]);

  const handleUpdateGroupField = async (groupId: string, field: string, value: any) => {
    if (guardAgainstStaleWrite()) return;
    if (!['purchase_date', 'closing_date', 'release_month', 'product_url'].includes(field)) {
      return;
    }
    if (field === 'closing_date') {
      setDraftClosingDates(prev => {
        const next = { ...prev };
        delete next[groupId];
        return next;
      });
    }
    let processedValue = value;
    if ((field === 'closing_date' || field === 'purchase_date') && typeof value === 'string') {
      processedValue = value.replace(/-/g, '/');
    }
    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        return { ...g, [field]: processedValue } as ProductGroup;
      }
      return g;
    });
    setGroups(updatedGroups);
    try {
      await dataProvider.saveProductGroups(updatedGroups);
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      throw err;
    }
  };

  const handleBatchApply = async () => {
    if (guardAgainstStaleWrite()) return;
    if (selectedGroupIds.size === 0) {
      alert('請先選取商品項目！');
      return;
    }
    if (!batchClosingDate.trim() && !batchReleaseMonth.trim()) {
      alert('請填寫欲批次套用的官方結單日或發售月份！');
      return;
    }

    const confirmMsg = `您即將批次更新 ${selectedGroupIds.size} 筆商品群組的日期資訊，是否確認？`;
    if (!window.confirm(confirmMsg)) return;

    let finalBatchClosingDate = '';
    if (batchClosingDate.trim()) {
      const normalized = normalizeDateInput(batchClosingDate);
      if (!normalized) {
        alert('官方結單日格式不正確，請輸入正確的日期格式 (例如 10/5、2026-10-05)！');
        return;
      }
      finalBatchClosingDate = normalized.replace(/-/g, '/');
    }

    const updatedGroups = groups.map(g => {
      if (selectedGroupIds.has(g.id)) {
        const nextGroup = { ...g };
        if (finalBatchClosingDate) {
          nextGroup.closing_date = finalBatchClosingDate;
        }
        if (batchReleaseMonth.trim()) {
          nextGroup.release_month = batchReleaseMonth.trim();
        }
        return nextGroup;
      }
      return g;
    });

    setGroups(updatedGroups);
    try {
      await dataProvider.saveProductGroups(updatedGroups);
      setSelectedGroupIds(new Set());
      setBatchClosingDate('');
      setBatchReleaseMonth('');
      alert('批次更新完成！');
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      throw err;
    }
  };

  const handlePaste = async (
    e: React.ClipboardEvent<HTMLInputElement>,
    startRowIndex: number,
    field: 'closing_date' | 'release_month' | 'purchase_date' | 'product_url',
    sourceList: ProductGroup[] = filteredAndSortedGroups
  ) => {
    if (guardAgainstStaleWrite()) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) return;

    const listToUpdate = sourceList.slice(startRowIndex, startRowIndex + lines.length);
    if (listToUpdate.length === 0) return;

    const groupMap = new Map(groups.map(g => [g.id, g]));
    listToUpdate.forEach((item, offset) => {
      const dbGroup = groupMap.get(item.id);
      if (dbGroup) {
        let val = lines[offset];
        if (field === 'closing_date' || field === 'purchase_date') {
          const normalized = normalizeDateInput(val);
          if (normalized) {
            val = normalized.replace(/-/g, '/');
          } else {
            // Keep unchanged if it cannot be normalized
            return;
          }
        }
        dbGroup[field] = val;
      }
    });

    const nextGroups = Array.from(groupMap.values());
    setGroups(nextGroups);
    try {
      await dataProvider.saveProductGroups(nextGroups);
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      throw err;
    }
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    field: string,
    tableId: string
  ) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const nextInput = document.querySelector(
        `input[data-table="${tableId}"][data-row="${rowIndex + 1}"][data-field="${field}"]`
      ) as HTMLInputElement;
      if (nextInput) {
        nextInput.focus();
        nextInput.select();
      }
    }
  };

  const formatReleaseMonth = (val: string | undefined | null) => {
    if (!val) return '-';
    const match = val.match(/^(\d{4})-(\d{2})$/);
    if (match) {
      return `${match[1]}年${match[2]}月`;
    }
    return val;
  };

  const handleUpdateGroupPlatformDemand = async (groupId: string, platform: 'myacg' | 'waca' | 'purchased', totalValue: number) => {
    if (guardAgainstStaleWrite()) return;
    if (isNaN(totalValue) || totalValue < 0) totalValue = 0;
    
    const g = groups.find(x => x.id === groupId);
    if (!g || !isProxyProduct(g)) {
      console.warn(`[Edit Blocked] Only proxy products are allowed to modify platform quantities at the group level.`);
      return;
    }
    
    const catIds = new Set(categories.filter(c => c.product_group_id === groupId).map(c => c.id));
    const groupVars = variants.filter(v => v.product_group_id === groupId || (v.product_category_id && catIds.has(v.product_category_id)));
    
    if (groupVars.length === 0) return;
    const targetVar = groupVars[0];
    
    const allVars = await dataProvider.getProductVariants();
    const dbTarget = allVars.find(v => v.id === targetVar.id);
    
    if (dbTarget) {
      let patch: Partial<ProductVariant> = {};
      if (platform === 'myacg') {
        patch = { myacg_manual_adjustment: totalValue };
      } else if (platform === 'waca') {
        patch = { waca_manual_adjustment: totalValue };
      } else if (platform === 'purchased') {
        patch = { purchased_manual_adjustment: totalValue };
      }
      patch.updated_at = new Date().toISOString();
      await dataProvider.updateProductVariantPatch(targetVar.id, patch);
      setVariants(variants.map(v => v.id === targetVar.id ? { ...v, ...patch } : v));
    }
  };

  const handleDeleteGroup = async (groupId: string, groupTitle: string) => {
    if (guardAgainstStaleWrite()) return;
    const confirmDelete = window.confirm(`確定要刪除「${groupTitle}」嗎？`);
    if (!confirmDelete) return;

    try {
      await dataProvider.deleteProductGroup(groupId);
      alert(`已成功刪除商品群組「${groupTitle}」。`);
      await loadData();
    } catch (e) {
      alert('刪除失敗');
      console.error(e);
    }
  };

  const handleBatchDelete = async () => {
    if (guardAgainstStaleWrite()) return;
    if (selectedGroupIds.size === 0) return;
    const confirmDelete = window.confirm(`確定刪除已選取的 ${selectedGroupIds.size} 筆商品？`);
    if (!confirmDelete) return;

    try {
      const idsToDelete = Array.from(selectedGroupIds);
      await dataProvider.deleteProductGroups(idsToDelete);
      alert(`已成功刪除 ${idsToDelete.length} 筆商品群組。`);
      setSelectedGroupIds(new Set());
      await loadData();
    } catch (e) {
      alert('批次刪除失敗，請重試。');
      console.error(e);
    }
  };  const handleBatchUpdateShowInPurchaseList = async (show: boolean) => {
    if (guardAgainstStaleWrite()) return;
    if (selectedGroupIds.size === 0) return;
    const actionName = show ? '加入採購總表' : '移出採購總表';

    try {
      const nextGroups = groups.map(g => {
        if (selectedGroupIds.has(g.id)) {
          return { ...g, show_in_purchase_list: show } as ProductGroup;
        }
        return g;
      });

      setGroups(nextGroups);
      await dataProvider.saveProductGroups(nextGroups);
      alert(`已成功將 ${selectedGroupIds.size} 筆商品${actionName}。`);
      setSelectedGroupIds(new Set());
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      alert(`批次${actionName}失敗，請重試。`);
      console.error(err);
    }
  };


  const handleRowClick = (id: string, e: React.MouseEvent) => {
    // Don't navigate if clicking inputs/buttons or selecting product name text
    if ((e.target as HTMLElement).tagName === 'INPUT' || 
        (e.target as HTMLElement).tagName === 'SELECT' || 
        (e.target as HTMLElement).tagName === 'BUTTON' ||
        (e.target as HTMLElement).closest('button') ||
        (e.target as HTMLElement).closest('.product-name-text')) {
      return;
    }
    if (editMode) return;
    navigate(`/purchase-records/${id}`);
  };



  return (
    <div className="flex-col gap-lg" style={{ paddingBottom: isMobile ? '180px' : '0px' }}>
      <style>{`
        .erp-table th {
          padding: 0 !important;
        }

        .th-inner {
          position: relative;
          padding: 8px 12px;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          width: 100%;
          height: 100%;
          min-height: 38px;
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

        @media (max-width: 767px) {
          .mobile-card-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 8px;
            background-color: #f8fafc;
          }
          .mobile-product-card {
            display: flex;
            align-items: center;
            padding: 8px 10px;
            background-color: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
            transition: all 0.2s ease;
          }
          .mobile-product-card.selected {
            background-color: #f0fdf4;
            border-color: #86efac;
          }
          .card-checkbox-wrapper {
            margin-right: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }
          .card-content-wrapper {
            display: flex;
            flex-direction: column;
            gap: 4px;
            flex: 1;
            min-width: 0;
          }
          .card-title-row {
            display: flex;
            align-items: flex-start;
            gap: 4px;
            min-width: 0;
          }
          .card-title {
            font-size: 13px;
            font-weight: 600;
            color: #1e293b;
            line-height: 1.35;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            text-overflow: ellipsis;
            word-break: break-all;
            flex: 1;
          }
          .badge-missing {
            background-color: #ffedd5;
            color: #ea580c;
            padding: 1px 4px;
            border-radius: 3px;
            font-weight: 600;
            font-size: 9px;
            white-space: nowrap;
            flex-shrink: 0;
          }
          .card-sku-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
            color: #64748b;
            gap: 8px;
          }
          .card-sku {
            text-overflow: ellipsis;
            overflow: hidden;
            white-space: nowrap;
            min-width: 0;
            flex: 1;
          }
          .card-price {
            font-weight: 600;
            color: #0f172a;
            white-space: nowrap;
            flex-shrink: 0;
          }
          .card-badges-row {
            display: flex;
            flex-wrap: wrap;
            gap: 4px 6px;
            align-items: center;
            margin-top: 1px;
            font-size: 11px;
            color: #64748b;
          }
          .badge-purchase {
            font-size: 9px;
            padding: 1px 4px;
            border-radius: 3px;
            font-weight: 600;
          }
          .badge-purchase.added {
            background-color: #dbeafe;
            color: #1d4ed8;
          }
          .badge-purchase.not-added {
            background-color: #f1f5f9;
            color: #64748b;
          }
          .badge-count {
            background-color: #f1f5f9;
            color: #475569;
            font-size: 9px;
            padding: 1px 4px;
            border-radius: 3px;
            font-weight: 600;
          }
        }
        @media (min-width: 1400px) {
          .th-inner {
            padding: 10px 14px !important;
            min-height: 44px !important;
          }
          .resizer-handle {
            top: 6px !important;
            bottom: 6px !important;
          }
        }
        @media (min-width: 2500px) {
          .th-inner {
            padding: 12px 18px !important;
            min-height: 50px !important;
          }
          .resizer-handle {
            top: 8px !important;
            bottom: 8px !important;
          }
        }
      `}</style>


      <div className="flex justify-between items-center" style={{ marginBottom: 'var(--spacing-md)' }}>
        <div>
          <h1 style={{ marginBottom: '4px', fontSize: '20px', fontWeight: 600 }}>訂購紀錄表</h1>
          <p className="text-muted text-sm" style={{ margin: 0 }}>總體商品群組清單，點擊進入該群組進行採購與需求管理。</p>
        </div>
      </div>

      {isStale && (
        <div style={{
          backgroundColor: '#fef3c7',
          borderLeft: '4px solid #d97706',
          padding: '16px',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderRadius: '4px',
          boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>⚠️</span>
            <span style={{ color: '#92400e', fontWeight: 500 }}>資料已在其他分頁更新，請重新整理後再編輯。</span>
          </div>
          <button
            onClick={handleReloadData}
            style={{
              backgroundColor: '#d97706',
              color: '#ffffff',
              border: 'none',
              padding: '6px 12px',
              borderRadius: '4px',
              fontWeight: 600,
              fontSize: '13px',
              cursor: 'pointer',
              marginLeft: 'auto',
              transition: 'background-color 0.2s'
            }}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#b45309'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#d97706'}
          >
            重新載入最新資料
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: isMobile ? '4px' : '8px', borderBottom: '1px solid #e2e8f0', paddingBottom: '0px', marginBottom: '16px', flexWrap: isMobile ? 'nowrap' : 'wrap', overflowX: isMobile ? 'auto' : 'visible', width: '100%', maxWidth: '100%', WebkitOverflowScrolling: 'touch' }}>
        <button 
          onClick={() => { setActiveTab('all'); setSearchTerm(''); }}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'all' ? '2px solid #2563eb' : '2px solid transparent',
            color: activeTab === 'all' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            whiteSpace: 'nowrap',
            flex: isMobile ? '0 0 auto' : undefined
          }}
        >
          全部商品 ({groups.length})
        </button>
        <button 
          onClick={() => { setActiveTab('hololive'); setSearchTerm(''); }}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'hololive' ? '2px solid #2563eb' : '2px solid transparent',
            color: activeTab === 'hololive' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            whiteSpace: 'nowrap',
            flex: isMobile ? '0 0 auto' : undefined
          }}
        >
          Hololive商品 ({groups.filter(isHololiveProduct).length})
        </button>
        <button 
          onClick={() => { setActiveTab('vspo'); setSearchTerm(''); }}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'vspo' ? '2px solid #2563eb' : '2px solid transparent',
            color: activeTab === 'vspo' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            whiteSpace: 'nowrap',
            flex: isMobile ? '0 0 auto' : undefined
          }}
        >
          VSPO商品 ({groups.filter(isVspoProduct).length})
        </button>
        <button 
          onClick={() => { setActiveTab('proxy'); setSearchTerm(''); }}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'proxy' ? '2px solid #2563eb' : '2px solid transparent',
            color: activeTab === 'proxy' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            whiteSpace: 'nowrap',
            flex: isMobile ? '0 0 auto' : undefined
          }}
        >
          代理版商品 ({groups.filter(isProxyProduct).length})
        </button>
        <button 
          onClick={() => { setActiveTab('other'); setSearchTerm(''); }}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'other' ? '2px solid #2563eb' : '2px solid transparent',
            color: activeTab === 'other' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            whiteSpace: 'nowrap',
            flex: isMobile ? '0 0 auto' : undefined
          }}
        >
          其他商品 ({groups.filter(isOtherProduct).length})
        </button>

        {/* WACA 迷你更新資訊區塊 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 16px',
          fontSize: '13px',
          color: '#475569',
          marginLeft: isMobile ? '0' : 'auto',
          alignSelf: 'center',
          whiteSpace: 'nowrap',
          borderLeft: isMobile ? 'none' : '1px solid #e2e8f0',
          paddingLeft: isMobile ? '16px' : '24px',
          flexShrink: 0
        }}>
          <span style={{ fontWeight: 600 }}>
            {wacaMeta?.closing_date 
              ? `WACA：${formatWacaDate(wacaMeta.closing_date)}・${wacaMeta.proxy_agent || '無'}` 
              : 'WACA：尚未更新'}
          </span>
          <button
            onClick={() => {
              if (wacaMeta?.proxy_agent) {
                const currentAgent = wacaMeta.proxy_agent as any;
                if (['小河馬', 'Flanlove', '許願'].includes(currentAgent)) {
                  setSelectedWacaUpdater(currentAgent);
                }
              }
              openWacaDialog();
            }}
            style={{
              padding: '2px 8px',
              fontSize: '12px',
              fontWeight: 600,
              color: '#2563eb',
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: '4px',
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
            onMouseEnter={e => {
              e.currentTarget.style.backgroundColor = '#dbeafe';
              e.currentTarget.style.color = '#1d4ed8';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.backgroundColor = '#eff6ff';
              e.currentTarget.style.color = '#2563eb';
            }}
          >
            更新紀錄
          </button>
        </div>
      </div>

      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        marginBottom: '16px',
        flexWrap: 'wrap',
        gap: '12px'
      }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => { setSecondaryTab('progress'); }}
            style={{
              padding: '6px 16px',
              fontSize: '13px',
              fontWeight: 600,
              borderRadius: '20px',
              cursor: 'pointer',
              border: '1px solid ' + (secondaryTab === 'progress' ? '#2563eb' : '#cbd5e1'),
              backgroundColor: secondaryTab === 'progress' ? '#eff6ff' : '#ffffff',
              color: secondaryTab === 'progress' ? '#2563eb' : '#475569',
              transition: 'all 0.15s ease'
            }}
          >
            進行中 ({progressCount})
          </button>
          <button
            onClick={() => { setSecondaryTab('closed'); }}
            style={{
              padding: '6px 16px',
              fontSize: '13px',
              fontWeight: 600,
              borderRadius: '20px',
              cursor: 'pointer',
              border: '1px solid ' + (secondaryTab === 'closed' ? '#2563eb' : '#cbd5e1'),
              backgroundColor: secondaryTab === 'closed' ? '#eff6ff' : '#ffffff',
              color: secondaryTab === 'closed' ? '#2563eb' : '#475569',
              transition: 'all 0.15s ease'
            }}
          >
            已結單 ({closedCount})
          </button>
          <button
            onClick={() => { setSecondaryTab('to_purchase'); }}
            style={{
              padding: '6px 16px',
              fontSize: '13px',
              fontWeight: 600,
              borderRadius: '20px',
              cursor: 'pointer',
              border: '1px solid ' + (secondaryTab === 'to_purchase' ? '#ef4444' : (toPurchaseCount > 0 ? '#fca5a5' : '#cbd5e1')),
              backgroundColor: secondaryTab === 'to_purchase' ? '#fee2e2' : (toPurchaseCount > 0 ? '#fff5f5' : '#ffffff'),
              color: secondaryTab === 'to_purchase' ? '#ef4444' : (toPurchaseCount > 0 ? '#dc2626' : '#475569'),
              transition: 'all 0.15s ease'
            }}
          >
            🚨 待採購 ({toPurchaseCount})
          </button>
          <button
            onClick={() => { setSecondaryTab('all'); }}
            style={{
              padding: '6px 16px',
              fontSize: '13px',
              fontWeight: 600,
              borderRadius: '20px',
              cursor: 'pointer',
              border: '1px solid ' + (secondaryTab === 'all' ? '#2563eb' : '#cbd5e1'),
              backgroundColor: secondaryTab === 'all' ? '#eff6ff' : '#ffffff',
              color: secondaryTab === 'all' ? '#2563eb' : '#475569',
              transition: 'all 0.15s ease'
            }}
          >
            全部 ({allCount})
          </button>
        </div>


      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '16px', backgroundColor: '#fff', padding: '16px', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
        
        <div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '0 12px', height: '40px' }}>
          <Search size={18} style={{ color: '#64748b', marginRight: '8px' }} />
          <input 
            type="text" 
            placeholder="搜尋品項、商品名稱、月份、類型..." 
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ border: 'none', background: 'transparent', outline: 'none', width: '100%', fontSize: '14px', color: '#334155' }}
          />
        </div>
        
        {isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {/* Row 1: Source and Type filters side-by-side */}
            <div style={{ display: 'flex', gap: '10px', width: '100%' }}>
              {/* Column 1: Source */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>商品來源</span>
                <select 
                  className="select" 
                  style={{ width: '100%', height: '36px', fontSize: '13px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 8px', backgroundColor: '#fff' }} 
                  value={filterSource} 
                  onChange={e => { setFilterSource(e.target.value); setSearchTerm(''); }}
                >
                  <option value="all">全部</option>
                  <option value="Hololive">Hololive</option>
                  <option value="VSPO">VSPO</option>
                  <option value="代理商品">代理商品</option>
                </select>
              </div>
              {/* Column 2: Type */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>商品種類</span>
                <select 
                  className="select" 
                  style={{ width: '100%', height: '36px', fontSize: '13px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 8px', backgroundColor: '#fff' }} 
                  value={filterType} 
                  onChange={e => { setFilterType(e.target.value); setSearchTerm(''); }}
                >
                  <option value="all">全部</option>
                  <option value="一般預購">一般預購</option>
                  <option value="現貨">現貨</option>
                  <option value="現地代購">現地代購</option>
                  <option value="日本代購">日本代購</option>
                  <option value="代理版">代理版</option>
                </select>
              </div>
            </div>

            {/* Row 2: Sort select */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>排序</span>
              <select 
                className="select" 
                style={{ width: '100%', height: '36px', fontSize: '13px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 8px', backgroundColor: '#fff' }} 
                value={sortMode} 
                onChange={e => { setSortMode(e.target.value); setSearchTerm(''); }}
              >
                <option value="closing_urgent">開單中優先 + 結單日近優先</option>
                <option value="created_desc">建立時間 (新到舊)</option>
                <option value="closing_asc">結單日 (近到遠)</option>
              </select>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>商品來源</span>
              <select className="input" style={{ width: '140px', height: '36px', fontSize: '13px' }} value={filterSource} onChange={e => { setFilterSource(e.target.value); setSearchTerm(''); }}>
                <option value="all">全部</option>
                <option value="Hololive">Hololive</option>
                <option value="VSPO">VSPO</option>
                <option value="代理商品">代理商品</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>商品類型</span>
              <select className="input" style={{ width: '140px', height: '36px', fontSize: '13px' }} value={filterType} onChange={e => { setFilterType(e.target.value); setSearchTerm(''); }}>
                <option value="all">全部</option>
                <option value="一般預購">一般預購</option>
                <option value="現貨">現貨</option>
                <option value="現地代購">現地代購</option>
                <option value="日本代購">日本代購</option>
                <option value="代理版">代理版</option>
              </select>
            </div>

            <div style={{ flex: 1 }}></div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>排序</span>
              <select className="input" style={{ width: '220px', height: '36px', fontSize: '13px' }} value={sortMode} onChange={e => { setSortMode(e.target.value); setSearchTerm(''); }}>
                <option value="closing_urgent">開單中優先 + 結單日近優先</option>
                <option value="created_desc">建立時間 (新到舊)</option>
                <option value="closing_asc">結單日 (近到遠)</option>
              </select>
              <button
                onClick={() => {
                  resetWidths();
                  alert('欄位寬度已重設為預設值！');
                }}
                style={{
                  height: '36px',
                  padding: '0 12px',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#475569',
                  backgroundColor: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  display: 'inline-flex',
                  alignItems: 'center',
                  whiteSpace: 'nowrap'
                }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = '#f8fafc'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = '#ffffff'}
              >
                重置欄位寬度
              </button>
            </div>

          </div>
        )}

        <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span>共</span>
          <span style={{ color: '#2563eb', fontWeight: 700, fontSize: '15px' }}>
            {secondaryTab === 'progress' ? filteredAndSortedGroups.length + completedGroups.length : filteredAndSortedGroups.length}
          </span>
          <span>筆商品符合條件</span>
          {secondaryTab === 'progress' && (
            <span style={{ color: '#64748b', fontSize: '12px' }}>
              (進行中: {filteredAndSortedGroups.length} 筆 / 已過結單日: {completedGroups.length} 筆)
            </span>
          )}
        </div>
      </div>


      {editMode && (
        <div style={{
          backgroundColor: '#eff6ff',
          border: '1px solid #bfdbfe',
          borderRadius: '12px',
          padding: '16px',
          marginBottom: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '14px', fontWeight: 700, color: '#1e40af' }}>批量編輯 ({selectedGroupIds.size} 筆已選取)</span>
            <span style={{ fontSize: '12px', color: '#1e40af' }}>勾選左側核取方塊後，填寫下方欄位並點擊套用</span>
          </div>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>官方結單日：</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }}>
                <input
                  type="text"
                  className="input"
                  placeholder="YYYY/MM/DD"
                  value={batchClosingDate}
                  onChange={e => setBatchClosingDate(e.target.value)}
                  style={{ width: '150px', height: '36px', fontSize: '13px', paddingRight: '24px' }}
                />
                <Calendar
                  size={14}
                  style={{ position: 'absolute', right: '8px', color: '#64748b', cursor: 'pointer' }}
                  onClick={() => {
                    const el = document.getElementById('batch-datepicker-input') as HTMLInputElement | null;
                    if (el) el.showPicker();
                  }}
                />
                <input
                  id="batch-datepicker-input"
                  type="date"
                  style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
                  value={batchClosingDate ? batchClosingDate.replace(/\//g, '-') : ''}
                  onChange={e => {
                    setBatchClosingDate(e.target.value.replace(/-/g, '/'));
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>發售月份：</span>
              <input
                type="text"
                className="input"
                placeholder="YYYY-MM (如 2026-07)"
                value={batchReleaseMonth}
                onChange={e => setBatchReleaseMonth(e.target.value)}
                style={{ width: '180px', height: '36px', fontSize: '13px' }}
              />
            </div>

            <button
              onClick={handleBatchApply}
              disabled={selectedGroupIds.size === 0}
              style={{
                padding: '0 16px',
                height: '36px',
                backgroundColor: selectedGroupIds.size > 0 ? '#2563eb' : '#9ca3af',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '13px',
                cursor: selectedGroupIds.size > 0 ? 'pointer' : 'not-allowed',
                transition: 'all 0.2s'
              }}
            >
              套用至勾選商品
            </button>
          </div>
        </div>
      )}

      {selectedGroupIds.size > 0 && (
        <div style={{
          backgroundColor: '#fef2f2',
          border: '1px solid #fee2e2',
          borderRadius: '12px',
          padding: '16px',
          marginBottom: '16px',
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          alignItems: isMobile ? 'stretch' : 'center',
          justifyContent: 'space-between',
          gap: '12px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '14px', fontWeight: 700, color: '#991b1b' }}>
              已選取 {selectedGroupIds.size} 筆商品
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              onClick={() => handleBatchUpdateShowInPurchaseList(true)}
              style={{
                padding: '0 16px',
                height: '36px',
                backgroundColor: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <span>加入採購總表</span>
            </button>
            <button
              onClick={() => handleBatchUpdateShowInPurchaseList(false)}
              style={{
                padding: '0 16px',
                height: '36px',
                backgroundColor: '#ea580c',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <span>移出採購總表</span>
            </button>
            <button
              onClick={handleBatchDelete}
              style={{
                padding: '0 16px',
                height: '36px',
                backgroundColor: '#dc2626',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <Trash2 size={14} />
              <span>批次刪除</span>
            </button>
            <button
              onClick={() => setSelectedGroupIds(new Set())}
              style={{
                padding: '0 16px',
                height: '36px',
                backgroundColor: '#ffffff',
                color: '#4b5563',
                border: '1px solid #d1d5db',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              取消選取
            </button>
          </div>
        </div>
      )}

      {/* Table section */}
      {(() => {
        const renderGroupsTable = (list: ProductGroup[], tableId: string) => {
          if (isMobile) {
            return (
              <div className="mobile-card-list">
                {list.map((g) => {
                  const details = getGroupPlatformDetails(g.id);
                  const demandAndPurchased = getGroupDemandAndPurchased(g.id);
                  const { skuDisplay, count } = getGroupSkuAndPriceRange(g.id);

                  const isProxy = activeTab === 'proxy';
                  const totalDemand = isProxy 
                    ? (details.myacg + details.wacaManual + details.privateOrder) 
                    : demandAndPurchased.demand;
                  const purchased = isProxy ? details.purchased : demandAndPurchased.purchased;
                  const gap = isProxy ? getDynamicGap(g.id, details.gap) : demandAndPurchased.gap;

                  const isChecked = selectedGroupIds.has(g.id);

                  return (
                    <div 
                      key={g.id}
                      className={`mobile-product-card ${isChecked ? 'selected' : ''}`}
                      onClick={(e) => handleRowClick(g.id, e)}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        padding: '12px',
                        backgroundColor: isChecked ? '#f0fdf4' : '#ffffff',
                        border: isChecked ? '1px solid #86efac' : '1px solid #e2e8f0',
                        borderRadius: '8px',
                        boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
                        gap: '10px'
                      }}
                    >
                      {/* Left: checkbox */}
                      <div className="card-checkbox-wrapper" onClick={e => e.stopPropagation()} style={{ marginTop: '2px', flexShrink: 0 }}>
                        <input 
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            const next = new Set(selectedGroupIds);
                            if (e.target.checked) {
                              next.add(g.id);
                            } else {
                              next.delete(g.id);
                            }
                            setSelectedGroupIds(next);
                          }}
                          style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                        />
                      </div>

                      {/* Right: details stacked */}
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        
                        {/* Line 1: Product Name (max 2 lines) */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '4px', minWidth: 0 }}>
                          <span style={{ 
                            fontSize: '14px', 
                            fontWeight: 600, 
                            color: '#1e293b', 
                            lineHeight: '1.4',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            wordBreak: 'break-word',
                            flex: 1
                          }}>
                            {g.normalized_title || g.title}
                            {gap > 0 && (
                              <span style={{
                                backgroundColor: '#fee2e2',
                                color: '#991b1b',
                                padding: '2px 8px',
                                borderRadius: '12px',
                                fontWeight: 600,
                                fontSize: '12px',
                                marginLeft: '6px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                lineHeight: 1
                              }}>
                                -{gap}
                              </span>
                            )}
                          </span>

                        </div>

                        {/* Line 2: SKU */}
                        <div style={{ fontSize: '12px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          SKU: {skuDisplay}
                        </div>

                        {/* Line 3: Status badge / Variant count / Is in purchase list */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                          <span style={{ 
                            fontSize: '11px', 
                            fontWeight: 600,
                            color: getGroupStatus(g).active ? '#15803d' : '#475569',
                            backgroundColor: getGroupStatus(g).active ? '#dcfce7' : '#f1f5f9',
                            padding: '2px 6px',
                            borderRadius: '4px'
                          }}>
                            {getGroupStatus(g).text}
                          </span>
                          <span style={{ 
                            backgroundColor: '#f1f5f9', 
                            color: '#475569', 
                            fontSize: '11px', 
                            padding: '2px 6px', 
                            borderRadius: '4px', 
                            fontWeight: 500 
                          }}>
                            {count} 規格
                          </span>
                          <span style={{ 
                            fontSize: '11px', 
                            padding: '2px 6px', 
                            borderRadius: '4px', 
                            fontWeight: 600,
                            backgroundColor: (g as any).show_in_purchase_list ? '#dbeafe' : '#f1f5f9',
                            color: (g as any).show_in_purchase_list ? '#1d4ed8' : '#64748b'
                          }}>
                            {(g as any).show_in_purchase_list ? '已入採購單' : '未入採購單'}
                          </span>
                        </div>

                        {/* Line 4: Demands */}
                        <div style={{ fontSize: '13px', color: '#475569', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <span>需求 <strong>{totalDemand}</strong></span>
                          <span style={{ color: '#cbd5e1' }}>|</span>
                          <span>已採購 <strong>{purchased}</strong></span>
                          <span style={{ color: '#cbd5e1' }}>|</span>
                          {gap > 0 && (
                            <>
                              <span style={{ color: '#cbd5e1' }}>|</span>
                              <span style={{ color: '#ef4444', fontWeight: 700 }}>-{gap}</span>
                            </>
                          )}
                        </div>

                        {/* Line 5: Closing Date & Release Month */}
                        <div style={{ fontSize: '13px', color: '#475569', display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' }}>
                          <div>結單日：{(() => {
                            if (!g.closing_date) return '-';
                            const clean = g.closing_date.replace(/\//g, '-');
                            const parts = clean.split('-');
                            if (parts.length >= 3) {
                              return `${parts[1]}/${parts[2]}`;
                            }
                            return g.closing_date;
                          })()}</div>
                          <div>發售：{formatReleaseMonth(g.release_month)}</div>
                        </div>

                      </div>
                    </div>
                  );
                })}
              </div>
            );
          }

          return (
            <>
              {activeTab === 'proxy' ? (
              <ScrollWrapper isMobile={isMobile}>
                <table className="erp-table" style={{ width: '100%', tableLayout: 'fixed', minWidth: isMobile ? '1200px' : undefined }}>
                <thead>
                  <tr>
                    <th style={{ width: '40px', textAlign: 'center' }}>
                      <input 
                        type="checkbox"
                        checked={list.length > 0 && list.every(g => selectedGroupIds.has(g.id))}
                        onChange={(e) => {
                          if (e.target.checked) {
                            if (list.length > 50) {
                              const confirmSelect = window.confirm(`您即將選取 ${list.length} 筆商品進行批次編輯，是否確定？`);
                              if (!confirmSelect) return;
                            }
                            setSelectedGroupIds(new Set(list.map(g => g.id)));
                          } else {
                            setSelectedGroupIds(new Set());
                          }
                        }}
                      />
                    </th>
                    {editMode && <th style={{ width: '60px', textAlign: 'center' }}>刪除</th>}
                    <th style={{ width: '90px' }}>
                      <div className="th-inner justify-center">
                        <span>狀態</span>
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.title}px` }}>
                      <div className="th-inner">
                        <span>商品名稱</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('title', e)} />
                      </div>
                    </th>
                    <th style={{ width: '100px' }}>
                      <div className="th-inner justify-center">
                        <span>代理商</span>
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.myacg}px` }}>
                      <div className="th-inner justify-center">
                        <span>買動漫</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('myacg', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.waca}px` }}>
                      <div className="th-inner justify-center">
                        <span>WACA</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('waca', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.privateOrder}px` }}>
                      <div className="th-inner justify-center">
                        <span>私下登記</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('privateOrder', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.totalDemand || 90}px` }}>
                      <div className="th-inner justify-center">
                        <span>總需求</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('totalDemand', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.purchased}px` }}>
                      <div className="th-inner justify-center">
                        <span>已採購</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('purchased', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.gap}px` }}>
                      <div className="th-inner justify-center">
                        <span>缺口</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('gap', e)} />
                      </div>
                    </th>
    
                    {editMode && (
                      <>
                        <th style={{ width: `${colWidths.closingDate}px` }}>
                          <div className="th-inner justify-center">
                            <span>官方結單日</span>
                            <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('closingDate', e)} />
                          </div>
                        </th>
                        <th style={{ width: `${colWidths.releaseMonth}px` }}>
                          <div className="th-inner justify-center">
                            <span>發售月份</span>
                            <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('releaseMonth', e)} />
                          </div>
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {list.map((g, idx) => {
                    const details = getGroupPlatformDetails(g.id);
                    const status = getGroupStatus(g);
                    const closingDateStyle = getClosingDateStyle(g.closing_date);

                    const dynamicGap = getDynamicGap(g.id, details.gap);
    
                    return (
                      <tr 
                        key={g.id} 
                        onClick={(e) => handleRowClick(g.id, e)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                          <input 
                            type="checkbox"
                            checked={selectedGroupIds.has(g.id)}
                            onChange={(e) => {
                              const next = new Set(selectedGroupIds);
                              if (e.target.checked) {
                                next.add(g.id);
                              } else {
                                next.delete(g.id);
                              }
                              setSelectedGroupIds(next);
                            }}
                          />
                        </td>
                        {editMode && (
                          <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                            <button 
                              onClick={() => handleDeleteGroup(g.id, g.normalized_title || g.title)}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#ef4444',
                                cursor: 'pointer',
                                padding: '4px 8px',
                                fontSize: '12px',
                                fontWeight: 600,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                borderRadius: '4px',
                                transition: 'all 0.2s'
                              }}
                              onMouseEnter={e => {
                                e.currentTarget.style.backgroundColor = '#fef2f2';
                              }}
                              onMouseLeave={e => {
                                e.currentTarget.style.backgroundColor = 'transparent';
                              }}
                            >
                              <Trash2 size={14} />
                              <span>刪除</span>
                            </button>
                          </td>
                        )}
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>
                          {status.text}
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                          <div className="flex-col gap-xs">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              <span className="product-name-text" style={{ userSelect: 'text', cursor: 'text' }}>{g.normalized_title || g.title}</span>
                              {dynamicGap > 0 && (
                                <span style={{
                                  backgroundColor: '#fee2e2',
                                  color: '#991b1b',
                                  padding: '2px 8px',
                                  borderRadius: '12px',
                                  fontWeight: 600,
                                  fontSize: '12px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  lineHeight: 1
                                }}>
                                  -{dynamicGap}
                                </span>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate(`/purchase-records/${g.id}`);
                                }}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: '4px',
                                  cursor: 'pointer',
                                  color: '#2563eb',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  borderRadius: '4px',
                                  transition: 'all 0.2s',
                                  flexShrink: 0
                                }}
                                onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#eff6ff'; }}
                                onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                                title="進入商品詳情"
                              >
                                <ExternalLink size={14} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopyTitle(g.id, g.normalized_title || g.title);
                                }}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: '4px',
                                  cursor: 'pointer',
                                  color: copiedGroupId === g.id ? '#10b981' : '#94a3b8',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  borderRadius: '4px',
                                  transition: 'all 0.2s',
                                  flexShrink: 0
                                }}
                                title="複製商品名稱"
                              >
                                {copiedGroupId === g.id ? (
                                  <>
                                    <Check size={14} style={{ color: '#10b981' }} />
                                    <span style={{ fontSize: '11px', fontWeight: 600, color: '#10b981' }}>已複製</span>
                                  </>
                                ) : (
                                  <Copy size={14} />
                                )}
                              </button>

                            </div>
                            {editMode ? (
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                                {g.listing_type && (
                                  <span style={{ backgroundColor: '#e2e8f0', color: '#475569', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                    {g.listing_type}
                                  </span>
                                )}
                              </div>
                            ) : (() => {
                              const isClosed = closingDateStyle.color === '#ef4444';
                              const isUrgent = closingDateStyle.color === '#f97316';
                              const closingDateTagStyle = isClosed
                                ? { background: '#fee2e2', color: '#ef4444', border: '1px solid #fca5a5' }
                                : isUrgent
                                ? { background: '#ffedd5', color: '#ea580c', border: '1px solid #fed7aa' }
                                : { background: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0' };

                              const formatClosingDateSimplified = (dateStr: string | undefined | null) => {
                                if (!dateStr) return '';
                                const clean = dateStr.replace(/\//g, '-');
                                const parts = clean.split('-');
                                if (parts.length >= 3) {
                                  return `結單 ${parts[1]}/${parts[2]}`;
                                }
                                return `結單 ${dateStr}`;
                              };

                              return (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px', alignItems: 'center', fontSize: '11px', marginTop: '4px' }}>
                                  {g.listing_type && (
                                    <span style={{ backgroundColor: '#e2e8f0', color: '#475569', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                      {g.listing_type}
                                    </span>
                                  )}
                                  {g.closing_date && (
                                    <span style={{ ...closingDateTagStyle, borderRadius: '4px', padding: '2px 6px', display: 'inline-flex', alignItems: 'center', fontWeight: isClosed || isUrgent ? 600 : 500 }}>
                                      {formatClosingDateSimplified(g.closing_date)}
                                    </span>
                                  )}
                                  {g.release_month && (
                                    <span style={{ background: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '4px', padding: '2px 6px', fontWeight: 500 }}>
                                      發售：{formatReleaseMonth(g.release_month)}
                                    </span>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </td>
                        <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                          <select
                            value={g.proxy_agent || ''}
                            onChange={(e) => handleUpdateAgent(g.id, e.target.value)}
                            className="select"
                            style={{ 
                              width: '100%', 
                              height: '32px', 
                              padding: '0 4px', 
                              fontSize: '13px', 
                              borderRadius: '4px',
                              border: '1px solid #d1d5db',
                              backgroundColor: '#fff',
                              color: g.proxy_agent ? '#1e293b' : '#94a3b8',
                              fontWeight: g.proxy_agent ? 600 : 400
                            }}
                          >
                            <option value="">(無)</option>
                            <option value="鉅霖">鉅霖</option>
                            <option value="萬榮">萬榮</option>
                          </select>
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input 
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={draftDemands[`${g.id}_myacg`] !== undefined ? draftDemands[`${g.id}_myacg`] : String(details.myacg)} 
                              onChange={e => handleUpdateDraft(g.id, 'myacg', e.target.value.replace(/[^0-9]/g, ''))} 
                              onBlur={() => handleCommitDraft(g.id, 'myacg')}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  e.currentTarget.blur();
                                } else if (e.key === 'Escape') {
                                  handleCancelDraft(g.id, 'myacg');
                                  e.currentTarget.blur();
                                }
                              }}
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            details.myacg
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input 
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={draftDemands[`${g.id}_waca`] !== undefined ? draftDemands[`${g.id}_waca`] : String(details.wacaManual)} 
                              onChange={e => handleUpdateDraft(g.id, 'waca', e.target.value.replace(/[^0-9]/g, ''))} 
                              onBlur={() => handleCommitDraft(g.id, 'waca')}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  e.currentTarget.blur();
                                } else if (e.key === 'Escape') {
                                  handleCancelDraft(g.id, 'waca');
                                  e.currentTarget.blur();
                                }
                              }}
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            details.wacaManual
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#475569' }}>
                          {details.privateOrder}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 700, color: '#1e293b' }}>
                          {(() => {
                            const myacgVal = (editMode && isProxyProduct(g) && draftDemands[`${g.id}_myacg`] !== undefined)
                              ? (parseInt(draftDemands[`${g.id}_myacg`], 10) || 0)
                              : details.myacg;
                            const wacaVal = (editMode && isProxyProduct(g) && draftDemands[`${g.id}_waca`] !== undefined)
                              ? (parseInt(draftDemands[`${g.id}_waca`], 10) || 0)
                              : details.wacaManual;
                            const privateVal = details.privateOrder;
                            return myacgVal + wacaVal + privateVal;
                          })()}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input 
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={draftDemands[`${g.id}_purchased`] !== undefined ? draftDemands[`${g.id}_purchased`] : String(details.purchased)} 
                              onChange={e => handleUpdateDraft(g.id, 'purchased', e.target.value.replace(/[^0-9]/g, ''))} 
                              onBlur={() => handleCommitDraft(g.id, 'purchased')}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  e.currentTarget.blur();
                                } else if (e.key === 'Escape') {
                                  handleCancelDraft(g.id, 'purchased');
                                  e.currentTarget.blur();
                                }
                              }}
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            details.purchased
                          )}</td>
                        <td style={{ textAlign: 'center', fontWeight: 700, color: '#ef4444' }}>
                          {dynamicGap > 0 ? `-${dynamicGap}` : ''}
                        </td>
    
                        {editMode && (
                          <>
                            <td style={{ textAlign: 'center', color: editMode ? 'inherit' : closingDateStyle.color, fontWeight: editMode ? 'inherit' : closingDateStyle.fontWeight }}>
                              {editMode ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }}>
                                  <input 
                                    className="input" 
                                    type="text" 
                                    placeholder="YYYY/MM/DD"
                                    style={{ width: '100%', height: '32px', padding: '0 24px 0 8px', fontSize: '13px' }} 
                                    value={getClosingDateInputVal(g)} 
                                    onChange={e => setDraftClosingDates(prev => ({ ...prev, [g.id]: e.target.value }))} 
                                    onClick={e => e.stopPropagation()}
                                    onBlur={() => handleCommitClosingDate(g.id, getClosingDateInputVal(g))}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') {
                                        handleCommitClosingDate(g.id, getClosingDateInputVal(g));
                                      } else if (e.key === 'Escape') {
                                        handleCancelClosingDateDraft(g.id);
                                        e.currentTarget.blur();
                                      }
                                      handleKeyDown(e, idx, 'closing_date', tableId);
                                    }}
                                    onPaste={e => handlePaste(e, idx, 'closing_date', list)}
                                    data-table={tableId}
                                    data-row={idx}
                                    data-field="closing_date"
                                  />
                                  <Calendar 
                                    size={14} 
                                    style={{ position: 'absolute', right: '8px', color: '#64748b', cursor: 'pointer' }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      datePickerRefs.current[g.id]?.showPicker();
                                    }}
                                  />
                                  <input 
                                    type="date"
                                    ref={el => { datePickerRefs.current[g.id] = el; }}
                                    style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
                                    value={g.closing_date ? g.closing_date.replace(/\//g, '-') : ''}
                                    onChange={e => handleUpdateGroupField(g.id, 'closing_date', e.target.value)}
                                    onClick={e => e.stopPropagation()}
                                  />
                                </div>
                              ) : closingDateStyle.text}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              {editMode ? (
                                <input 
                                  className="input" 
                                  style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px' }} 
                                  value={g.release_month || ''} 
                                  onChange={e => handleUpdateGroupField(g.id, 'release_month', e.target.value)} 
                                  onClick={e => e.stopPropagation()}
                                  onKeyDown={e => handleKeyDown(e, idx, 'release_month', tableId)}
                                  onPaste={e => handlePaste(e, idx, 'release_month', list)}
                                  data-table={tableId}
                                  data-row={idx}
                                  data-field="release_month"
                                  placeholder="例如：2026-11"
                                />
                              ) : formatReleaseMonth(g.release_month)}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </ScrollWrapper>
            ) : (
              <ScrollWrapper isMobile={isMobile}>
                <table className="erp-table" style={{ width: '100%', tableLayout: 'fixed', minWidth: isMobile ? '1200px' : undefined }}>
                <thead>
                  <tr>
                    <th style={{ width: '40px', textAlign: 'center' }}>
                      <input 
                        type="checkbox"
                        checked={list.length > 0 && list.every(g => selectedGroupIds.has(g.id))}
                        onChange={(e) => {
                          if (e.target.checked) {
                            if (list.length > 50) {
                              const confirmSelect = window.confirm(`您即將選取 ${list.length} 筆商品進行批次編輯，是否確定？`);
                              if (!confirmSelect) return;
                            }
                            setSelectedGroupIds(new Set(list.map(g => g.id)));
                          } else {
                            setSelectedGroupIds(new Set());
                          }
                        }}
                      />
                    </th>
                    {editMode && <th style={{ width: '60px', textAlign: 'center' }}>刪除</th>}
                    <th style={{ width: '90px' }}>
                      <div className="th-inner justify-center">
                        <span>狀態</span>
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.title}px` }}>
                      <div className="th-inner">
                        <span>商品名稱</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('title', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.myacg}px` }}>
                      <div className="th-inner justify-center">
                        <span>買動漫</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('myacg', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.waca}px` }}>
                      <div className="th-inner justify-center">
                        <span>WACA</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('waca', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.purchased}px` }}>
                      <div className="th-inner justify-center">
                        <span>已採購</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('purchased', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.gap}px` }}>
                      <div className="th-inner justify-center">
                        <span>缺口</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('gap', e)} />
                      </div>
                    </th>
                    {editMode && (
                      <>
                        <th style={{ width: `${colWidths.closingDate}px` }}>
                          <div className="th-inner justify-center">
                            <span>官方結單日</span>
                            <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('closingDate', e)} />
                          </div>
                        </th>
                        <th style={{ width: `${colWidths.releaseMonth}px` }}>
                          <div className="th-inner justify-center">
                            <span>發售月份</span>
                            <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('releaseMonth', e)} />
                          </div>
                        </th>
                        <th style={{ width: `${colWidths.productUrl}px` }}>
                          <div className="th-inner justify-center">
                            <span>官網</span>
                            <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('productUrl', e)} />
                          </div>
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {list.map((g, idx) => {
                    const details = getGroupPlatformDetails(g.id);
                    const demandAndPurchased = getGroupDemandAndPurchased(g.id);
                    const status = getGroupStatus(g);
                    const closingDateStyle = getClosingDateStyle(g.closing_date);
    
                    return (
                      <tr 
                        key={g.id} 
                        onClick={(e) => handleRowClick(g.id, e)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                          <input 
                            type="checkbox"
                            checked={selectedGroupIds.has(g.id)}
                            onChange={(e) => {
                              const next = new Set(selectedGroupIds);
                              if (e.target.checked) {
                                next.add(g.id);
                              } else {
                                next.delete(g.id);
                              }
                              setSelectedGroupIds(next);
                            }}
                          />
                        </td>
                        {editMode && (
                          <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                            <button 
                              onClick={() => handleDeleteGroup(g.id, g.normalized_title || g.title)}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#ef4444',
                                cursor: 'pointer',
                                padding: '4px 8px',
                                fontSize: '12px',
                                fontWeight: 600,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                borderRadius: '4px',
                                transition: 'all 0.2s'
                              }}
                              onMouseEnter={e => {
                                e.currentTarget.style.backgroundColor = '#fef2f2';
                              }}
                              onMouseLeave={e => {
                                e.currentTarget.style.backgroundColor = 'transparent';
                              }}
                            >
                              <Trash2 size={14} />
                              <span>刪除</span>
                            </button>
                          </td>
                        )}
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>
                          {editMode ? (
                            status.text
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px' }}>
                              <span>{status.text}</span>
                              {g.listing_type && (
                                <span style={{ 
                                  backgroundColor: '#e2e8f0', 
                                  color: '#475569', 
                                  fontSize: '10px', 
                                  padding: '1px 4px', 
                                  borderRadius: '3px', 
                                  fontWeight: 500,
                                  marginTop: '2px'
                                }}>
                                  {g.listing_type}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                          <div className="flex-col gap-xs">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              <span className="product-name-text" style={{ userSelect: 'text', cursor: 'text' }}>{g.normalized_title || g.title}</span>
                              {demandAndPurchased.gap > 0 && (
                                <span style={{
                                  backgroundColor: '#fee2e2',
                                  color: '#991b1b',
                                  padding: '2px 8px',
                                  borderRadius: '12px',
                                  fontWeight: 600,
                                  fontSize: '12px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  lineHeight: 1
                                }}>
                                  -{demandAndPurchased.gap}
                                </span>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate(`/purchase-records/${g.id}`);
                                }}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: '4px',
                                  cursor: 'pointer',
                                  color: '#2563eb',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  borderRadius: '4px',
                                  transition: 'all 0.2s',
                                  flexShrink: 0
                                }}
                                onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#eff6ff'; }}
                                onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                                title="進入商品詳情"
                              >
                                <ExternalLink size={14} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopyTitle(g.id, g.normalized_title || g.title);
                                }}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: '4px',
                                  cursor: 'pointer',
                                  color: copiedGroupId === g.id ? '#10b981' : '#94a3b8',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  borderRadius: '4px',
                                  transition: 'all 0.2s',
                                  flexShrink: 0
                                }}
                                title="複製商品名稱"
                              >
                                {copiedGroupId === g.id ? (
                                  <>
                                    <Check size={14} style={{ color: '#10b981' }} />
                                    <span style={{ fontSize: '11px', fontWeight: 600, color: '#10b981' }}>已複製</span>
                                  </>
                                ) : (
                                  <Copy size={14} />
                                )}
                              </button>

                            </div>
                            {editMode ? (
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                                {g.listing_type && (
                                  <span style={{ backgroundColor: '#e2e8f0', color: '#475569', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                    {g.listing_type}
                                  </span>
                                )}
                              </div>
                            ) : (() => {
                              const isClosed = closingDateStyle.color === '#ef4444';
                              const isUrgent = closingDateStyle.color === '#f97316';
                              const closingDateTagStyle = isClosed
                                ? { background: '#fee2e2', color: '#ef4444', border: '1px solid #fca5a5' }
                                : isUrgent
                                ? { background: '#ffedd5', color: '#ea580c', border: '1px solid #fed7aa' }
                                : { background: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0' };
    
                              const formatClosingDateSimplified = (dateStr: string | undefined | null) => {
                                if (!dateStr) return '';
                                const clean = dateStr.replace(/\//g, '-');
                                const parts = clean.split('-');
                                if (parts.length >= 3) {
                                  return `結單 ${parts[1]}/${parts[2]}`;
                                }
                                return `結單 ${dateStr}`;
                              };
    
                              return (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px', alignItems: 'center', fontSize: '11px', marginTop: '4px' }}>
                                  {g.closing_date && (
                                    <span style={{ ...closingDateTagStyle, borderRadius: '4px', padding: '2px 6px', display: 'inline-flex', alignItems: 'center', fontWeight: isClosed || isUrgent ? 600 : 500 }}>
                                      {formatClosingDateSimplified(g.closing_date)}
                                    </span>
                                  )}
                                  {g.release_month && (
                                    <span style={{ background: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '4px', padding: '2px 6px', fontWeight: 500 }}>
                                      發售：{formatReleaseMonth(g.release_month)}
                                    </span>
                                  )}
                                  {g.product_url && (
                                    <a 
                                      href={g.product_url} 
                                      target="_blank" 
                                      rel="noreferrer" 
                                      onClick={e => e.stopPropagation()}
                                      style={{ color: '#2563eb', textDecoration: 'none', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: '2px' }}
                                      onMouseEnter={e => { e.currentTarget.style.color = '#1d4ed8'; }}
                                      onMouseLeave={e => { e.currentTarget.style.color = '#2563eb'; }}
                                    >
                                      🔗 官網
                                    </a>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input 
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={details.myacg} 
                              onChange={e => handleUpdateGroupPlatformDemand(g.id, 'myacg', parseInt(e.target.value.replace(/[^0-9]/g, '')) || 0)} 
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            details.myacg
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input 
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={details.wacaManual} 
                              onChange={e => handleUpdateGroupPlatformDemand(g.id, 'waca', parseInt(e.target.value.replace(/[^0-9]/g, '')) || 0)} 
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            details.wacaManual
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {details.purchased}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 700, color: '#ef4444' }}>
                          {demandAndPurchased.gap > 0 ? `-${demandAndPurchased.gap}` : ''}
                        </td>
                        {editMode && (
                          <>
                            <td style={{ textAlign: 'center', color: editMode ? 'inherit' : closingDateStyle.color, fontWeight: editMode ? 'inherit' : closingDateStyle.fontWeight }}>
                              {editMode ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }}>
                                  <input 
                                    className="input" 
                                    type="text" 
                                    placeholder="YYYY/MM/DD"
                                    style={{ width: '100%', height: '32px', padding: '0 24px 0 8px', fontSize: '13px' }} 
                                    value={getClosingDateInputVal(g)} 
                                    onChange={e => setDraftClosingDates(prev => ({ ...prev, [g.id]: e.target.value }))} 
                                    onClick={e => e.stopPropagation()}
                                    onBlur={() => handleCommitClosingDate(g.id, getClosingDateInputVal(g))}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') {
                                        handleCommitClosingDate(g.id, getClosingDateInputVal(g));
                                      } else if (e.key === 'Escape') {
                                        handleCancelClosingDateDraft(g.id);
                                        e.currentTarget.blur();
                                      }
                                      handleKeyDown(e, idx, 'closing_date', tableId);
                                    }}
                                    onPaste={e => handlePaste(e, idx, 'closing_date', list)}
                                    data-table={tableId}
                                    data-row={idx}
                                    data-field="closing_date"
                                  />
                                  <Calendar 
                                    size={14} 
                                    style={{ position: 'absolute', right: '8px', color: '#64748b', cursor: 'pointer' }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      datePickerRefs.current[g.id]?.showPicker();
                                    }}
                                  />
                                  <input 
                                    type="date"
                                    ref={el => { datePickerRefs.current[g.id] = el; }}
                                    style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
                                    value={g.closing_date ? g.closing_date.replace(/\//g, '-') : ''}
                                    onChange={e => handleUpdateGroupField(g.id, 'closing_date', e.target.value)}
                                    onClick={e => e.stopPropagation()}
                                  />
                                </div>
                              ) : closingDateStyle.text}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              {editMode ? (
                                <input 
                                  className="input" 
                                  style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px' }} 
                                  value={g.release_month || ''} 
                                  onChange={e => handleUpdateGroupField(g.id, 'release_month', e.target.value)} 
                                  onClick={e => e.stopPropagation()}
                                  onKeyDown={e => handleKeyDown(e, idx, 'release_month', tableId)}
                                  onPaste={e => handlePaste(e, idx, 'release_month', list)}
                                  data-table={tableId}
                                  data-row={idx}
                                  data-field="release_month"
                                  placeholder="例如：2026-11"
                                />
                              ) : formatReleaseMonth(g.release_month)}
                            </td>
                            <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                              {editMode ? (
                                <input 
                                  className="input" 
                                  style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px' }} 
                                  value={g.product_url || ''} 
                                  onChange={e => handleUpdateGroupField(g.id, 'product_url', e.target.value)} 
                                  onKeyDown={e => handleKeyDown(e, idx, 'product_url', tableId)}
                                  onPaste={e => handlePaste(e, idx, 'product_url', list)}
                                  data-table={tableId}
                                  data-row={idx}
                                  data-field="product_url"
                                  placeholder="官網網址"
                                />
                              ) : g.product_url ? (
                                <a 
                                  href={g.product_url} 
                                  target="_blank" 
                                  rel="noreferrer" 
                                  style={{ color: '#2563eb', fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '2px' }}
                                >
                                  🔗 官網
                                </a>
                              ) : '-'}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </ScrollWrapper>
            )}
          </>
        );
      };
    
      return (
        <div className="flex-col gap-md">
          {(filteredAndSortedGroups.length === 0 && completedGroups.length === 0) ? (
            <EmptyState
              icon={Receipt}
              title={groups.length === 0 ? "尚未有訂購紀錄" : "找不到符合的紀錄"}
              description={groups.length === 0 ? "您可以透過匯入商品清單來自動產生母體，或手動建立。" : "請嘗試調整搜尋關鍵字或篩選條件。"}
              actionLabel={groups.length === 0 ? "前往商品清單匯入" : ""}
              onAction={() => groups.length === 0 ? navigate('/inventory') : undefined}
            />
          ) : (
            <div className="flex-col gap-md">
              {displayedMainGroups.length > 0 && (
                <div className="card" style={{ padding: 0, overflow: 'hidden', width: '100%', maxWidth: '100%' }}>
                  {renderGroupsTable(displayedMainGroups, 'main')}
                </div>
              )}
    
              {secondaryTab === 'progress' && completedGroups.length > 0 && (
                <div style={{ marginTop: '8px' }}>
                  <button
                    onClick={() => setCompletedExpanded(!completedExpanded)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      padding: '12px 16px',
                      backgroundColor: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      borderRadius: '12px',
                      fontSize: '14px',
                      fontWeight: 600,
                      color: '#475569',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)'
                    }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = '#f1f5f9'}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = '#f8fafc'}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>{completedExpanded ? '▼' : '▶'}</span>
                      <span>已過結單日商品 ({completedGroups.length})</span>
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#94a3b8', fontWeight: 500 }}>
                      {completedExpanded ? '點擊收合' : '點擊展開'}
                    </span>
                  </button>
                  {completedExpanded && (
                    <div className="card" style={{ padding: 0, overflow: 'hidden', width: '100%', maxWidth: '100%', marginTop: '8px' }}>
                      {renderGroupsTable(displayedCompletedGroups, 'completed')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      );
    })()}

      {/* WACA 更新紀錄對話框 */}
      {showWacaDialog && (
        <div 
          className={`modal-overlay ${animateWacaDialog ? 'active' : ''}`} 
          onClick={closeWacaDialog}
        >
          <div 
            className="modal-content" 
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '360px' }}
          >
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>更新 WACA 記錄</h3>
            </div>
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>選擇更新人</label>
                <select
                  id="waca-updater-select"
                  value={selectedWacaUpdater}
                  onChange={e => setSelectedWacaUpdater(e.target.value as any)}
                  style={{
                    width: '100%',
                    height: '38px',
                    padding: '0 10px',
                    fontSize: '14px',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    outline: 'none',
                    backgroundColor: '#fff',
                    color: '#0f172a'
                  }}
                >
                  <option value="小河馬">小河馬</option>
                  <option value="Flanlove">Flanlove</option>
                  <option value="許願">許願</option>
                </select>
              </div>
            </div>
            <div style={{
              padding: '12px 20px',
              backgroundColor: '#f8fafc',
              borderTop: '1px solid #e2e8f0',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '10px'
            }}>
              <button
                onClick={closeWacaDialog}
                style={{
                  padding: '6px 14px',
                  fontSize: '13.5px',
                  fontWeight: 600,
                  color: '#475569',
                  backgroundColor: '#fff',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                取消
              </button>
              <button
                onClick={() => handleUpdateWacaMeta(selectedWacaUpdater)}
                style={{
                  padding: '6px 14px',
                  fontSize: '13.5px',
                  fontWeight: 600,
                  color: '#fff',
                  backgroundColor: '#2563eb',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                儲存
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Floating Action Button (FAB) */}
      <button
        onClick={() => setEditMode(!editMode)}
        style={{
          position: 'fixed',
          bottom: isMobile ? 'calc(env(safe-area-inset-bottom) + 72px)' : '24px',
          right: isMobile ? '16px' : '24px',
          zIndex: 9999,
          height: isMobile ? '40px' : '46px',
          padding: isMobile ? '10px 16px' : '0 24px',
          fontWeight: 700,
          fontSize: isMobile ? '13px' : '14px',
          borderRadius: '9999px',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          backgroundColor: editMode ? '#ea580c' : '#2563eb',
          color: '#ffffff',
          boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
          transition: 'all 0.2s ease',
          outline: 'none'
        }}
      >
        {editMode ? '✏️ 編輯模式' : '🔒 鎖定模式'}
      </button>
    </div>
  );
}
