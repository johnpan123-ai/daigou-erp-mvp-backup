import { useState, useEffect, useMemo } from 'react';
import { db, calculateFinalMyacgDemand } from '../lib/db';
import type { ProductGroup, ProductVariant, ProductCategory, PurchaseBatchItem, PrivateOrderItem, InventoryItem, SalesOrderItem } from '../lib/db';
import { Receipt, Search } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';
import { useNavigate, useLocation } from 'react-router-dom';

export default function PurchaseRecords() {

  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [batchItems, setBatchItems] = useState<PurchaseBatchItem[]>([]);
  const [privateOrderItems, setPrivateOrderItems] = useState<PrivateOrderItem[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [salesOrderItems, setSalesOrderItems] = useState<SalesOrderItem[]>([]);

  const [editMode, setEditMode] = useState<boolean>(false);
  const navigate = useNavigate();
  const location = useLocation();


  const [searchTerm, setSearchTerm] = useState(() => localStorage.getItem('erp_search_term') || '');
  const [filterSource, setFilterSource] = useState(() => localStorage.getItem('erp_filter_source') || 'all');
  const [filterStatus, setFilterStatus] = useState(() => localStorage.getItem('erp_filter_status') || 'all');
  const [filterType, setFilterType] = useState(() => localStorage.getItem('erp_filter_type') || 'all');
  const [sortMode, setSortMode] = useState(() => localStorage.getItem('erp_sort_mode') || 'closing_urgent');
  const [activeTab, setActiveTab] = useState<'all' | 'hololive' | 'vspo' | 'proxy' | 'other'>(() => {
    return (localStorage.getItem('erp_active_tab') as 'all' | 'hololive' | 'vspo' | 'proxy' | 'other') || 'all';
  });

  useEffect(() => {
    localStorage.setItem('erp_search_term', searchTerm);
    localStorage.setItem('erp_filter_source', filterSource);
    localStorage.setItem('erp_filter_status', filterStatus);
    localStorage.setItem('erp_filter_type', filterType);
    localStorage.setItem('erp_sort_mode', sortMode);
  }, [searchTerm, filterSource, filterStatus, filterType, sortMode]);

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
  }, [location.search, setActiveTab]);


  const getGroupStatus = (g: ProductGroup) => {
    const today = new Date().toISOString().split('T')[0];
    if (!g.closing_date || g.closing_date >= today) {
      return { text: '🟢 開單中', active: true };
    }
    return { text: '⚫ 已結單', active: false };
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
    
    groupVars.forEach(v => {
      myacg += calculateFinalMyacgDemand(v.myacg_item_code, inventory, salesOrderItems) + (v.myacg_manual_adjustment || 0);
      waca += (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
      privateOrder += privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((sum, item) => sum + item.quantity, 0);
      purchased += batchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((sum, item) => sum + item.quantity, 0);
    });
    
    const demand = myacg + waca + privateOrder;
    const gap = Math.max(demand - purchased, 0);
    
    return { myacg, waca, privateOrder, purchased, gap };
  };

  const getGroupDemandAndPurchased = (groupId: string) => {
    const catIds = new Set(categories.filter(c => c.product_group_id === groupId).map(c => c.id));
    const groupVars = variants.filter(v => v.product_group_id === groupId || (v.product_category_id && catIds.has(v.product_category_id)));
    
    let totalDemand = 0;
    let totalPurchased = 0;
    let gap = 0;
    
    groupVars.forEach(v => {
      const myacgDemand = calculateFinalMyacgDemand(v.myacg_item_code, inventory, salesOrderItems) + (v.myacg_manual_adjustment || 0);
      const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
      const privateDemand = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((sum, item) => sum + item.quantity, 0);
      
      const demand = myacgDemand + wacaDemand + privateDemand;
      const purchased = batchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((sum, item) => sum + item.quantity, 0);
      
      
      
      totalDemand += demand;
      totalPurchased += purchased;
      gap += Math.max(demand - purchased, 0);
    });
    
    return { demand: totalDemand, purchased: totalPurchased, gap };
  };


  const getClosingDateStyle = (closingDate: string | undefined | null) => {
    if (!closingDate) return { text: '-', color: '#64748b', fontWeight: 400 };
    
    const todayStr = new Date().toISOString().split('T')[0];
    if (closingDate < todayStr) {
      return { text: closingDate, color: '#ef4444', fontWeight: 700 };
    }
    
    const todayTime = new Date(todayStr).getTime();
    const closingTime = new Date(closingDate).getTime();
    const diffDays = Math.ceil((closingTime - todayTime) / (1000 * 60 * 60 * 24));
    
    if (diffDays >= 0 && diffDays <= 3) {
      return { text: closingDate, color: '#f97316', fontWeight: 700 };
    }
    
    return { text: closingDate, color: '#334155', fontWeight: 500 };
  };

  const filteredAndSortedGroups = useMemo(() => {
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

    const today = new Date().toISOString().split('T')[0];

    // 1. Filter Source
    if (filterSource !== 'all') {
      result = result.filter(g => {
        if (filterSource === '代理商品') return isProxyProduct(g);
        if (filterSource === 'Hololive') return isHololiveProduct(g);
        if (filterSource === 'VSPO') return isVspoProduct(g);
        return false;
      });
    }

    // 2. Filter Status
    if (filterStatus !== 'all') {
      if (filterStatus === '開單中') {
        result = result.filter(g => !g.closing_date || g.closing_date >= today);
      } else if (filterStatus === '已結單') {
        result = result.filter(g => g.closing_date && g.closing_date < today);
      }
    }

    // 3. Filter Type
    if (filterType !== 'all') {
      result = result.filter(g => {
        if (filterType === '代理版') return checkIsProxyProduct(g);
        return (g.listing_type || '一般預購') === filterType;
      });
    }

    // 4. Search
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

    // 5. Sort
    result.sort((a, b) => {
      if (sortMode === 'closing_urgent') {
        const activeA = !a.closing_date || a.closing_date >= today;
        const activeB = !b.closing_date || b.closing_date >= today;
        
        if (activeA !== activeB) {
          return activeA ? -1 : 1;
        }
        
        const dateA = a.closing_date || '9999-12-31';
        const dateB = b.closing_date || '9999-12-31';
        return dateA.localeCompare(dateB);
      } else if (sortMode === 'closing_asc') {
        const dateA = a.closing_date || '9999-12-31';
        const dateB = b.closing_date || '9999-12-31';
        return dateA.localeCompare(dateB);
      } else {
        const timeA = new Date(a.created_at || a.purchase_date || 0).getTime();
        const timeB = new Date(b.created_at || b.purchase_date || 0).getTime();
        return timeB - timeA;
      }
    });

    return result;
  }, [groups, searchTerm, filterSource, filterStatus, filterType, sortMode, variants, categories, batchItems, privateOrderItems, activeTab, inventory]);


  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const [fetchedGroups, fetchedVars, fetchedCats, fetchedBatchItems, fetchedPrivateItems, fetchedInventory, fetchedOrderItems] = await Promise.all([
      db.getProductGroups(),
      db.getProductVariants(),
      db.getProductCategories(),
      db.getPurchaseBatchItems(),
      db.getPrivateOrderItems(),
      db.getInventory(),
      db.getSalesOrderItems()
    ]);
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
    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        return { ...g, [field]: value } as ProductGroup;
      }
      return g;
    });
    setGroups(updatedGroups);
    await db.saveProductGroups(updatedGroups);
  };

  const handleUpdateGroupPlatformDemand = async (groupId: string, platform: 'myacg' | 'waca', totalValue: number) => {
    if (isNaN(totalValue) || totalValue < 0) totalValue = 0;
    
    const catIds = new Set(categories.filter(c => c.product_group_id === groupId).map(c => c.id));
    const groupVars = variants.filter(v => v.product_group_id === groupId || (v.product_category_id && catIds.has(v.product_category_id)));
    
    if (groupVars.length === 0) return;
    const targetVar = groupVars[0];
    
    const allVars = await db.getProductVariants();
    const dbTarget = allVars.find(v => v.id === targetVar.id);
    
    if (dbTarget) {
      if (platform === 'myacg') {
        const auto = calculateFinalMyacgDemand(dbTarget.myacg_item_code, inventory, salesOrderItems);
        dbTarget.myacg_manual_adjustment = totalValue - auto;
      } else {
        const auto = dbTarget.waca_auto_quantity || 0;
        dbTarget.waca_manual_adjustment = totalValue - auto;
      }
      
      await db.saveProductVariants(allVars);
      setVariants(variants.map(v => v.id === targetVar.id ? dbTarget : v));
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
    <div className="flex-col gap-lg">

      <div className="flex justify-between items-center" style={{ marginBottom: 'var(--spacing-md)' }}>
        <div>
          <h1 style={{ marginBottom: '4px', fontSize: '20px', fontWeight: 600 }}>訂購紀錄表</h1>
          <p className="text-muted text-sm" style={{ margin: 0 }}>總體商品群組清單，點擊進入該群組進行採購與需求管理。</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid #e2e8f0', paddingBottom: '0px', marginBottom: '16px', flexWrap: 'wrap' }}>
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
            marginBottom: '-1px'
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
            marginBottom: '-1px'
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
            marginBottom: '-1px'
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
            marginBottom: '-1px'
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
            marginBottom: '-1px'
          }}
        >
          其他商品 ({groups.filter(isOtherProduct).length})
        </button>
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
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>商品狀態</span>
            <select className="input" style={{ width: '120px', height: '36px', fontSize: '13px' }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="all">全部</option>
              <option value="開單中">開單中</option>
              <option value="已結單">已結單</option>
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
          </div>

        </div>

        <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
          共 <span style={{ color: '#2563eb', fontWeight: 700, fontSize: '15px' }}>{filteredAndSortedGroups.length}</span> 筆商品符合條件
        </div>
        


      </div>

      <div className="flex-col gap-md">
        {filteredAndSortedGroups.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title={groups.length === 0 ? "尚未有訂購紀錄" : "找不到符合的紀錄"}
            description={groups.length === 0 ? "您可以透過匯入商品清單來自動產生母體，或手動建立。" : "請嘗試調整搜尋關鍵字或篩選條件。"}
            actionLabel={groups.length === 0 ? "前往商品清單匯入" : ""}
            onAction={() => groups.length === 0 ? navigate('/inventory') : undefined}
          />

        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {activeTab === 'proxy' ? (
              <table className="erp-table" style={{ width: '100%', tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ width: '8%', textAlign: 'center' }}>狀態</th>
                    <th style={{ width: '23%' }}>商品名稱</th>
                    <th style={{ width: '8%', textAlign: 'center' }}>買動漫</th>
                    <th style={{ width: '8%', textAlign: 'center' }}>WACA</th>
                    <th style={{ width: '8%', textAlign: 'center' }}>私下登記</th>
                    <th style={{ width: '8%', textAlign: 'center' }}>已採購</th>
                    <th style={{ width: '8%', textAlign: 'center' }}>缺口</th>
                    <th style={{ width: '12%', textAlign: 'center' }}>購買結單日</th>
                    <th style={{ width: '12%', textAlign: 'center' }}>官方結單日</th>
                    <th style={{ width: '7%', textAlign: 'center' }}>發售月份</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAndSortedGroups.map(g => {
                    const details = getGroupPlatformDetails(g.id);
                    const status = getGroupStatus(g);
                    const closingDateStyle = getClosingDateStyle(g.closing_date);

                    return (
                      <tr 
                        key={g.id} 
                        onClick={(e) => handleRowClick(g.id, e)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>
                          {status.text}
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                          <div className="flex-col gap-xs">
                            <div>{g.normalized_title || g.title}</div>
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
                          {editMode ? (
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
                          {editMode ? (
                            <input 
                              type="number"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={details.waca} 
                              onChange={e => handleUpdateGroupPlatformDemand(g.id, 'waca', parseInt(e.target.value) || 0)} 
                              onClick={e => e.stopPropagation()}
                              min={0}
                            />
                          ) : (
                            details.waca
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
                        <td style={{ textAlign: 'center' }}>
                          {editMode ? (
                            <input 
                              className="input" 
                              type="date" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px' }} 
                              value={g.purchase_date || ''} 
                              onChange={e => handleUpdateGroupField(g.id, 'purchase_date', e.target.value)} 
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            <span style={{ color: '#475569', fontWeight: 500 }}>
                              {g.purchase_date || '-'}
                            </span>
                          )}
                        </td>
                        <td style={{ textAlign: 'center', color: editMode ? 'inherit' : closingDateStyle.color, fontWeight: editMode ? 'inherit' : closingDateStyle.fontWeight }}>
                          {editMode ? (
                            <input 
                              className="input" 
                              type="date" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px' }} 
                              value={g.closing_date || ''} 
                              onChange={e => handleUpdateGroupField(g.id, 'closing_date', e.target.value)} 
                              onClick={e => e.stopPropagation()}
                            />
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
                              placeholder="例如：2026-11"
                            />
                          ) : g.release_month || '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <table className="erp-table" style={{ width: '100%', tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ width: '8%', textAlign: 'center' }}>狀態</th>
                    <th style={{ width: '25%' }}>商品名稱</th>
                    <th style={{ width: '8%', textAlign: 'center' }}>買動漫</th>
                    <th style={{ width: '8%', textAlign: 'center' }}>WACA</th>
                    <th style={{ width: '8%', textAlign: 'center' }}>已採購</th>
                    <th style={{ width: '8%', textAlign: 'center' }}>缺口</th>
                    <th style={{ width: '12%', textAlign: 'center' }}>購買結單日</th>
                    <th style={{ width: '12%', textAlign: 'center' }}>官方結單日</th>
                    <th style={{ width: '7%', textAlign: 'center' }}>發售月份</th>
                    <th style={{ width: '4%', textAlign: 'center' }}>官網</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAndSortedGroups.map(g => {
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
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>
                          {status.text}
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                          <div className="flex-col gap-xs">
                            <div>{g.normalized_title || g.title}</div>
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
                          {editMode ? (
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
                          {editMode ? (
                            <input 
                              type="number"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={details.waca} 
                              onChange={e => handleUpdateGroupPlatformDemand(g.id, 'waca', parseInt(e.target.value) || 0)} 
                              onClick={e => e.stopPropagation()}
                              min={0}
                            />
                          ) : (
                            details.waca
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {details.purchased}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 700, color: demandAndPurchased.gap > 0 ? '#ef4444' : '#166534' }}>
                          缺 {demandAndPurchased.gap}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {editMode ? (
                            <input 
                              className="input" 
                              type="date" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px' }} 
                              value={g.purchase_date || ''} 
                              onChange={e => handleUpdateGroupField(g.id, 'purchase_date', e.target.value)} 
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            <span style={{ color: '#475569', fontWeight: 500 }}>
                              {g.purchase_date || '-'}
                            </span>
                          )}
                        </td>
                        <td style={{ textAlign: 'center', color: editMode ? 'inherit' : closingDateStyle.color, fontWeight: editMode ? 'inherit' : closingDateStyle.fontWeight }}>
                          {editMode ? (
                            <input 
                              className="input" 
                              type="date" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px' }} 
                              value={g.closing_date || ''} 
                              onChange={e => handleUpdateGroupField(g.id, 'closing_date', e.target.value)} 
                              onClick={e => e.stopPropagation()}
                            />
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
                              placeholder="例如：2026-11"
                            />
                          ) : g.release_month || '-'}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {g.product_url ? (
                            <a 
                              href={g.product_url} 
                              target="_blank" 
                              rel="noreferrer" 
                              style={{ color: '#2563eb', fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '2px' }}
                              onClick={e => e.stopPropagation()}
                            >
                              🔗 官網
                            </a>
                          ) : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
      
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
