import { useState, useEffect, useMemo, useRef } from 'react';
import { calculateFinalMyacgDemand } from '../lib/db';
import { dataProvider } from '../providers/dataProvider';

import type { ProductGroup, ProductVariant, ProductCategory, PurchaseBatchItem, PrivateOrderItem, InventoryItem, SalesOrderItem } from '../lib/db';
import { Receipt, Search, Trash2, Calendar, Copy, Check } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';
import { useNavigate, useLocation } from 'react-router-dom';
import { useViewport } from '../contexts/ViewportContext';

const DEFAULT_COL_WIDTHS = {
  title: 350,
  myacg: 80,
  waca: 80,
  privateOrder: 90,
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
  let sampleLogged = false;

  console.log(`[UI Render] UI groups count: ${groups.length}`);
  console.log(`[UI Render] UI variants count: ${variants.length}`);

  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const saved = localStorage.getItem('erp_purchase_records_col_widths');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        // ignore
      }
    }
    return DEFAULT_COL_WIDTHS;
  });

  const handleMouseDown = (colKey: string, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = colWidths[colKey] || DEFAULT_COL_WIDTHS[colKey as keyof typeof DEFAULT_COL_WIDTHS];

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const newWidth = Math.max(50, startWidth + dx);
      setColWidths(prev => ({
        ...prev,
        [colKey]: newWidth
      }));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      
      setColWidths(current => {
        localStorage.setItem('erp_purchase_records_col_widths', JSON.stringify(current));
        return current;
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

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

  const [secondaryTab, setSecondaryTab] = useState<'progress' | 'closed' | 'all'>('progress');
  const [completedExpanded, setCompletedExpanded] = useState<boolean>(false);

  const checkIsGroupClosed = (g: ProductGroup): boolean => {
    const statusVal = (g as any).status;
    const isClosedVal = (g as any).is_closed;
    if (statusVal !== undefined && statusVal !== null) {
      return statusVal === '已結單';
    }
    if (isClosedVal !== undefined && isClosedVal !== null) {
      return isClosedVal === true;
    }
    return false;
  };

  const getTodayStr = (): string => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const checkIsGroupOverdue = (g: ProductGroup): boolean => {
    if (!g.closing_date) return false;
    const todayStr = getTodayStr();
    const cleanDate = g.closing_date.replace(/\//g, '-');
    return cleanDate < todayStr;
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
      // 買動漫數量
      const rawMyacgQty = calculateFinalMyacgDemand(v.myacg_item_code, inventory, salesOrderItems);
      const localMyacg = (rawMyacgQty >= 0 ? rawMyacgQty : 0) + (v.myacg_manual_adjustment ?? 0);
      const autoMyacg = (v.myacg_auto_quantity !== null && v.myacg_auto_quantity !== undefined && v.myacg_auto_quantity >= 0)
        ? v.myacg_auto_quantity + (v.myacg_manual_adjustment ?? 0)
        : null;
      const rawMyacg = (v.effective_myacg_quantity !== null && v.effective_myacg_quantity !== undefined && v.effective_myacg_quantity >= 0)
        ? v.effective_myacg_quantity + (v.myacg_manual_adjustment ?? 0)
        : (autoMyacg ?? (v as any).myacg_quantity ?? localMyacg);
      const vMyacg = rawMyacg >= 0 ? rawMyacg : 0;

      // WACA 數量
      const localWaca = (v.waca_auto_quantity ?? 0) + (v.waca_manual_adjustment ?? 0);
      const autoWaca = (v.waca_auto_quantity !== null && v.waca_auto_quantity !== undefined && v.waca_auto_quantity >= 0)
        ? v.waca_auto_quantity + (v.waca_manual_adjustment ?? 0)
        : null;
      const rawWaca = autoWaca ?? (v as any).waca_quantity ?? localWaca;
      const vWaca = rawWaca >= 0 ? rawWaca : 0;

      // 私下數量
      const localPrivate = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((sum, item) => sum + item.quantity, 0);
      const rawPrivate = v.private_manual_adjustment ?? (v as any).private_quantity ?? localPrivate;
      const vPrivate = rawPrivate >= 0 ? rawPrivate : 0;

      // 已採購 / 已下單數量
      const localPurchased = batchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((sum, item) => sum + item.quantity, 0);
      const rawPurchased = v.purchased_manual_adjustment ?? (v as any).ordered_quantity ?? (v as any).ordered_qty ?? localPurchased;
      const vPurchased = rawPurchased >= 0 ? rawPurchased : 0;

      myacg += vMyacg;
      waca += vWaca;
      privateOrder += vPrivate;
      purchased += vPurchased;
      myacgManual += (v.myacg_manual_adjustment ?? 0);
      wacaManual += (v.waca_manual_adjustment ?? 0);

      const vTotalDemand = vMyacg + vWaca + vPrivate;
      totalGap += Math.max(vTotalDemand - vPurchased, 0);

      if (!sampleLogged) {
        console.log('[UI Quantity Calc] sample variant:', JSON.stringify(v));
        console.log('[UI Quantity Calc] myacg computed:', vMyacg);
        console.log('[UI Quantity Calc] waca computed:', vWaca);
        console.log('[UI Quantity Calc] private computed:', vPrivate);
        console.log('[UI Quantity Calc] purchased computed:', vPurchased);
        sampleLogged = true;
      }
    });
    
    const hasCatalogMissing = groupVars.some(v => v.catalog_missing === true);
    return { myacg, waca, privateOrder, purchased, gap: totalGap, myacgManual, wacaManual, hasCatalogMissing };
  };

  const getGroupDemandAndPurchased = (groupId: string) => {
    const catIds = new Set(categories.filter(c => c.product_group_id === groupId).map(c => c.id));
    const groupVars = variants.filter(v => v.product_group_id === groupId || (v.product_category_id && catIds.has(v.product_category_id)));
    
    let totalDemand = 0;
    let totalPurchased = 0;
    let gap = 0;
    const hasCatalogMissing = groupVars.some(v => v.catalog_missing === true);
    
    groupVars.forEach(v => {
      // 買動漫數量
      const rawMyacgQty = calculateFinalMyacgDemand(v.myacg_item_code, inventory, salesOrderItems);
      const localMyacg = (rawMyacgQty >= 0 ? rawMyacgQty : 0) + (v.myacg_manual_adjustment ?? 0);
      const autoMyacg = (v.myacg_auto_quantity !== null && v.myacg_auto_quantity !== undefined && v.myacg_auto_quantity >= 0)
        ? v.myacg_auto_quantity + (v.myacg_manual_adjustment ?? 0)
        : null;
      const rawMyacg = (v.effective_myacg_quantity !== null && v.effective_myacg_quantity !== undefined && v.effective_myacg_quantity >= 0)
        ? v.effective_myacg_quantity + (v.myacg_manual_adjustment ?? 0)
        : (autoMyacg ?? (v as any).myacg_quantity ?? localMyacg);
      const vMyacg = rawMyacg >= 0 ? rawMyacg : 0;

      // WACA 數量
      const localWaca = (v.waca_auto_quantity ?? 0) + (v.waca_manual_adjustment ?? 0);
      const autoWaca = (v.waca_auto_quantity !== null && v.waca_auto_quantity !== undefined && v.waca_auto_quantity >= 0)
        ? v.waca_auto_quantity + (v.waca_manual_adjustment ?? 0)
        : null;
      const rawWaca = autoWaca ?? (v as any).waca_quantity ?? localWaca;
      const vWaca = rawWaca >= 0 ? rawWaca : 0;

      // 私下數量
      const localPrivate = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((sum, item) => sum + item.quantity, 0);
      const rawPrivate = v.private_manual_adjustment ?? (v as any).private_quantity ?? localPrivate;
      const vPrivate = rawPrivate >= 0 ? rawPrivate : 0;

      // 已採購 / 已下單數量
      const localPurchased = batchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((sum, item) => sum + item.quantity, 0);
      const rawPurchased = v.purchased_manual_adjustment ?? (v as any).ordered_quantity ?? (v as any).ordered_qty ?? localPurchased;
      const vPurchased = rawPurchased >= 0 ? rawPurchased : 0;

      const demand = vMyacg + vWaca + vPrivate;
      
      totalDemand += demand;
      totalPurchased += vPurchased;
      gap += Math.max(demand - vPurchased, 0);
    });
    
    return { demand: totalDemand, purchased: totalPurchased, gap, hasCatalogMissing };
  };


  const getClosingDateStyle = (closingDate: string | undefined | null) => {
    if (!closingDate) return { text: '-', color: '#64748b', fontWeight: 400 };
    
    const todayStr = getTodayStr();
    const cleanDate = closingDate.replace(/\//g, '-');
    if (cleanDate < todayStr) {
      return { text: closingDate, color: '#ef4444', fontWeight: 700 };
    }
    
    const todayTime = new Date(todayStr).getTime();
    const closingTime = new Date(cleanDate).getTime();
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
        return (
          (g.title && g.title.toLowerCase().includes(lowerTerm)) ||
          (g.normalized_title && g.normalized_title.toLowerCase().includes(lowerTerm)) ||
          (g.release_month && g.release_month.toLowerCase().includes(lowerTerm)) ||
          (g.closing_date && g.closing_date.toLowerCase().includes(lowerTerm)) ||
          effectiveListingType.includes(lowerTerm) ||
          (g.product_url && g.product_url.toLowerCase().includes(lowerTerm))
        );
      });
    }

    return result;
  }, [groups, searchTerm, filterSource, filterType, activeTab, variants, categories, inventory]);

  const { progressCount, closedCount, allCount } = useMemo(() => {
    const progress = baseGroups.filter(g => !checkIsGroupClosed(g)).length;
    const closed = baseGroups.filter(g => checkIsGroupClosed(g)).length;
    const total = baseGroups.length;
    return { progressCount: progress, closedCount: closed, allCount: total };
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
    setGroups(fetchedGroups);
    setVariants(fetchedVars);
    setCategories(fetchedCats);
    setBatchItems(fetchedBatchItems);
    setPrivateOrderItems(fetchedPrivateItems);
    setInventory(fetchedInventory);
    setSalesOrderItems(fetchedOrderItems);
  };

  const handleUpdateGroupField = async (groupId: string, field: string, value: any) => {
    if (!['purchase_date', 'closing_date', 'release_month', 'product_url'].includes(field)) {
      return;
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
    await dataProvider.saveProductGroups(updatedGroups);
  };

  const handleBatchApply = async () => {
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

    const updatedGroups = groups.map(g => {
      if (selectedGroupIds.has(g.id)) {
        const nextGroup = { ...g };
        if (batchClosingDate.trim()) {
          nextGroup.closing_date = batchClosingDate.trim().replace(/-/g, '/');
        }
        if (batchReleaseMonth.trim()) {
          nextGroup.release_month = batchReleaseMonth.trim();
        }
        return nextGroup;
      }
      return g;
    });

    setGroups(updatedGroups);
    await dataProvider.saveProductGroups(updatedGroups);
    
    setSelectedGroupIds(new Set());
    setBatchClosingDate('');
    setBatchReleaseMonth('');
    alert('批次更新完成！');
  };

  const handlePaste = async (
    e: React.ClipboardEvent<HTMLInputElement>,
    startRowIndex: number,
    field: 'closing_date' | 'release_month' | 'purchase_date' | 'product_url',
    sourceList: ProductGroup[] = filteredAndSortedGroups
  ) => {
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
          val = val.replace(/-/g, '/');
        }
        dbGroup[field] = val;
      }
    });

    const nextGroups = Array.from(groupMap.values());
    setGroups(nextGroups);
    await dataProvider.saveProductGroups(nextGroups);
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

  const handleUpdateGroupPlatformDemand = async (groupId: string, platform: 'myacg' | 'waca', totalValue: number) => {
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
      } else {
        patch = { waca_manual_adjustment: totalValue };
      }
      patch.updated_at = new Date().toISOString();
      await dataProvider.updateProductVariantPatch(targetVar.id, patch);
      setVariants(variants.map(v => v.id === targetVar.id ? { ...v, ...patch } : v));
    }
  };

  const handleDeleteGroup = async (groupId: string, groupTitle: string) => {
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
  };


  const handleRowClick = (id: string, e: React.MouseEvent) => {
    // Don't navigate if clicking inputs/buttons
    if ((e.target as HTMLElement).tagName === 'INPUT' || 
        (e.target as HTMLElement).tagName === 'SELECT' || 
        (e.target as HTMLElement).tagName === 'BUTTON' ||
        (e.target as HTMLElement).closest('button')) {
      return;
    }
    if (editMode) return;
    navigate(`/purchase-records/${id}`);
  };



  return (
    <div className="flex-col gap-lg" style={{ paddingBottom: isMobile ? '80px' : '0px' }}>
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
      `}</style>


      <div className="flex justify-between items-center" style={{ marginBottom: 'var(--spacing-md)' }}>
        <div>
          <h1 style={{ marginBottom: '4px', fontSize: '20px', fontWeight: 600 }}>訂購紀錄表</h1>
          <p className="text-muted text-sm" style={{ margin: 0 }}>總體商品群組清單，點擊進入該群組進行採購與需求管理。</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: isMobile ? '4px' : '8px', borderBottom: '1px solid #e2e8f0', paddingBottom: '0px', marginBottom: '16px', flexWrap: isMobile ? 'nowrap' : 'wrap', overflowX: isMobile ? 'auto' : 'visible', width: '100%', maxWidth: '100%', WebkitOverflowScrolling: 'touch' }}>
        <button 
          onClick={() => setActiveTab('all')}
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
          onClick={() => setActiveTab('hololive')}
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
          onClick={() => setActiveTab('vspo')}
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
          onClick={() => setActiveTab('proxy')}
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
          onClick={() => setActiveTab('other')}
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
            onClick={() => setSecondaryTab('progress')}
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
            onClick={() => setSecondaryTab('closed')}
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
            onClick={() => setSecondaryTab('all')}
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
        
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>商品來源</span>
            <select className="input" style={{ width: '140px', height: '36px', fontSize: '13px' }} value={filterSource} onChange={e => setFilterSource(e.target.value)}>
              <option value="all">全部</option>
              <option value="Hololive">Hololive</option>
              <option value="VSPO">VSPO</option>
              <option value="代理商品">代理商品</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>商品類型</span>
            <select className="input" style={{ width: '140px', height: '36px', fontSize: '13px' }} value={filterType} onChange={e => setFilterType(e.target.value)}>
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
            <select className="input" style={{ width: '220px', height: '36px', fontSize: '13px' }} value={sortMode} onChange={e => setSortMode(e.target.value)}>
              <option value="closing_urgent">開單中優先 + 結單日近優先</option>
              <option value="created_desc">建立時間 (新到舊)</option>
              <option value="closing_asc">結單日 (近到遠)</option>
            </select>
            <button
              onClick={() => {
                setColWidths(DEFAULT_COL_WIDTHS);
                localStorage.removeItem('erp_purchase_records_col_widths');
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
          <div style={{ display: 'flex', gap: '8px' }}>
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
                  </tr>
                </thead>
                <tbody>
                  {list.map((g, idx) => {
                    const details = getGroupPlatformDetails(g.id);
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
                          {status.text}
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                          <div className="flex-col gap-xs">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              <span>{g.normalized_title || g.title}</span>
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
                              {details.hasCatalogMissing && (
                                <span style={{
                                  backgroundColor: '#ffedd5',
                                  color: '#ea580c',
                                  padding: '2px 8px',
                                  borderRadius: '4px',
                                  fontWeight: 600,
                                  fontSize: '11px',
                                  whiteSpace: 'nowrap'
                                }}>
                                  [清單無此項]
                                </span>
                              )}
                            </div>
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                              {g.listing_type && (
                                <span style={{ backgroundColor: '#e2e8f0', color: '#475569', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                  {g.listing_type}
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input 
                              type="number"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={details.myacg} 
                              onChange={e => handleUpdateGroupPlatformDemand(g.id, 'myacg', parseInt(e.target.value) || 0)} 
                              onClick={e => e.stopPropagation()}
                              min={0}
                            />
                          ) : (
                            details.myacg
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input 
                              type="number"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={details.wacaManual} 
                              onChange={e => handleUpdateGroupPlatformDemand(g.id, 'waca', parseInt(e.target.value) || 0)} 
                              onClick={e => e.stopPropagation()}
                              min={0}
                            />
                          ) : (
                            details.wacaManual
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#475569' }}>
                          {details.privateOrder}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {details.purchased}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 700, color: details.gap > 0 ? '#ef4444' : '#166534' }}>
                          缺 {details.gap}
                        </td>
    
                        <td style={{ textAlign: 'center', color: editMode ? 'inherit' : closingDateStyle.color, fontWeight: editMode ? 'inherit' : closingDateStyle.fontWeight }}>
                          {editMode ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }}>
                              <input 
                                className="input" 
                                type="text" 
                                placeholder="YYYY/MM/DD"
                                style={{ width: '100%', height: '32px', padding: '0 24px 0 8px', fontSize: '13px' }} 
                                value={g.closing_date || ''} 
                                onChange={e => handleUpdateGroupField(g.id, 'closing_date', e.target.value)} 
                                onClick={e => e.stopPropagation()}
                                onKeyDown={e => handleKeyDown(e, idx, 'closing_date', tableId)}
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
                              <span>{g.normalized_title || g.title}</span>
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
                              {editMode && demandAndPurchased.hasCatalogMissing && (
                                <span style={{
                                  backgroundColor: '#ffedd5',
                                  color: '#ea580c',
                                  padding: '2px 8px',
                                  borderRadius: '4px',
                                  fontWeight: 600,
                                  fontSize: '11px',
                                  whiteSpace: 'nowrap'
                                }}>
                                  [清單無此項]
                                </span>
                              )}
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
                              type="number"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={details.myacg} 
                              onChange={e => handleUpdateGroupPlatformDemand(g.id, 'myacg', parseInt(e.target.value) || 0)} 
                              onClick={e => e.stopPropagation()}
                              min={0}
                            />
                          ) : (
                            details.myacg
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input 
                              type="number"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={details.wacaManual} 
                              onChange={e => handleUpdateGroupPlatformDemand(g.id, 'waca', parseInt(e.target.value) || 0)} 
                              onClick={e => e.stopPropagation()}
                              min={0}
                            />
                          ) : (
                            details.wacaManual
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {details.purchased}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 700, color: demandAndPurchased.gap > 0 ? '#ef4444' : '#166534' }}>
                          缺 {demandAndPurchased.gap}
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
                                    value={g.closing_date || ''} 
                                    onChange={e => handleUpdateGroupField(g.id, 'closing_date', e.target.value)} 
                                    onClick={e => e.stopPropagation()}
                                    onKeyDown={e => handleKeyDown(e, idx, 'closing_date', tableId)}
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
              {filteredAndSortedGroups.length > 0 && (
                <div className="card" style={{ padding: 0, overflow: 'hidden', width: '100%', maxWidth: '100%' }}>
                  {renderGroupsTable(filteredAndSortedGroups, 'main')}
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
                      {renderGroupsTable(completedGroups, 'completed')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      );
    })()}
      
      {/* Floating Action Button (FAB) */}
      <button
        onClick={() => setEditMode(!editMode)}
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          zIndex: 9999,
          height: '46px',
          padding: '0 24px',
          fontWeight: 700,
          fontSize: '14px',
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
