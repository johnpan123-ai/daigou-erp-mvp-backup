import { useState, useEffect, useMemo } from 'react';
import { db, getBaseSku, calculateFinalMyacgDemand, findMatchingInventoryItem } from '../lib/db';
import type { ProductGroup, ProductVariant, ProductCategory, PurchaseBatchItem, PrivateOrderItem, InventoryItem, SalesOrderItem } from '../lib/db';
import { Receipt, Edit2, Save, X, Search, Trash2 } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';
import { useNavigate } from 'react-router-dom';

export default function PurchaseRecords() {

  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [batchItems, setBatchItems] = useState<PurchaseBatchItem[]>([]);
  const [privateOrderItems, setPrivateOrderItems] = useState<PrivateOrderItem[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [salesOrderItems, setSalesOrderItems] = useState<SalesOrderItem[]>([]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<ProductGroup>>({});
  const navigate = useNavigate();

  const [searchTerm, setSearchTerm] = useState(() => localStorage.getItem('erp_search_term') || '');
  const [filterSource, setFilterSource] = useState(() => localStorage.getItem('erp_filter_source') || 'all');
  const [filterStatus, setFilterStatus] = useState(() => localStorage.getItem('erp_filter_status') || 'all');
  const [filterType, setFilterType] = useState(() => localStorage.getItem('erp_filter_type') || 'all');
  const [sortMode, setSortMode] = useState(() => localStorage.getItem('erp_sort_mode') || 'closing_urgent');
  const [activeTab, setActiveTab] = useState<'all' | 'proxy' | 'multi'>(() => {
    return (localStorage.getItem('erp_active_tab') as 'all' | 'proxy' | 'multi') || 'all';
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

    return false;
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
      
      if (v.myacg_item_code.toUpperCase().includes('G07073119')) {
        const invItem = findMatchingInventoryItem(v.myacg_item_code, inventory);
        const inventorySold = invItem ? invItem.myacg_sold_quantity : undefined;
        const inventoryDemand = invItem ? invItem.myacg_demand_quantity : undefined;

        const cleanCode = v.myacg_item_code.trim().toUpperCase();
        const baseVariant = getBaseSku(cleanCode);
        let orderDemand = 0;
        for (const item of salesOrderItems) {
          if (item.order_status && item.order_status.includes('已取消')) continue;
          const itemCode = item.myacg_item_code.trim().toUpperCase();
          const baseItem = getBaseSku(itemCode);
          if (
            itemCode === cleanCode ||
            (baseItem === baseVariant && (itemCode === baseItem || cleanCode === baseVariant)) ||
            (baseItem === baseVariant)
          ) {
            orderDemand += item.quantity;
          }
        }

        const finalMyacgDemand = calculateFinalMyacgDemand(v.myacg_item_code, inventory, salesOrderItems);
        const uiMyacgValue = myacgDemand;
        
        const source = (inventorySold != null && inventorySold > 0) 
          ? 'inventory' 
          : ((inventoryDemand != null && inventoryDemand > 0) ? 'inventory' : (orderDemand > 0 ? 'order' : 'zero'));

        console.table({
          sku: v.myacg_item_code,
          inventorySold: inventorySold ?? 'undefined',
          inventoryDemand: inventoryDemand ?? 'undefined',
          orderDemand,
          finalMyacgDemand,
          uiMyacgValue,
          totalDemand: demand,
          purchased,
          shortage: Math.max(demand - purchased, 0),
          source
        });
      }
      
      totalDemand += demand;
      totalPurchased += purchased;
      gap += Math.max(demand - purchased, 0);
    });
    
    return { demand: totalDemand, purchased: totalPurchased, gap };
  };

  const getGroupGap = (groupId: string) => {
    return getGroupDemandAndPurchased(groupId).gap;
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

  const { filteredAndSortedGroups, debugInfo } = useMemo(() => {
    let result = [...groups];

    // Debug print for categorization
    groups.forEach(g => {
      const groupVars = variants.filter(v => v.product_group_id === g.id);
      const invListingTypes = groupVars.map(v => {
        const invItem = inventory.find(i => i.myacg_item_code === v.myacg_item_code);
        return invItem?.listing_type || '無';
      });
      const isProxy = checkIsProxyProduct(g);
      console.log(`[Debug Proxy Categorization] Title: "${g.title}", Group ListingType: "${g.listing_type || '無'}", Inv ListingType: "${invListingTypes.join(', ')}", Category: ${isProxy ? '代理版' : '多規格'}`);
    });

    // Filter by activeTab
    if (activeTab === 'proxy') {
      result = result.filter(g => checkIsProxyProduct(g));
    } else if (activeTab === 'multi') {
      result = result.filter(g => !checkIsProxyProduct(g));
    }
    
    const debug = {
      total: result.length,
      afterSource: result.length,
      afterStatus: result.length,
      afterType: result.length,
      afterSearch: result.length,
      final: result.length
    };

    const today = new Date().toISOString().split('T')[0];

    // 1. Filter Source
    if (filterSource !== 'all') {
      result = result.filter(g => {
        if (checkIsProxyProduct(g)) return filterSource === '代理商品';
        const lowerTitle = (g.title || '').toLowerCase();
        if (lowerTitle.includes('hololive')) return filterSource === 'Hololive';
        if (lowerTitle.includes('vspo') || g.title.includes('ぶいすぽ')) return filterSource === 'VSPO';
        return false;
      });
    }
    debug.afterSource = result.length;

    // 2. Filter Status
    if (filterStatus !== 'all') {
      if (filterStatus === '開單中') {
        result = result.filter(g => !g.closing_date || g.closing_date >= today);
      } else if (filterStatus === '已結單') {
        result = result.filter(g => g.closing_date && g.closing_date < today);
      }
    }
    debug.afterStatus = result.length;

    // 3. Filter Type
    if (filterType !== 'all') {
      result = result.filter(g => {
        if (filterType === '代理版') return checkIsProxyProduct(g);
        return (g.listing_type || '一般預購') === filterType;
      });
    }
    debug.afterType = result.length;

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
    debug.afterSearch = result.length;
    debug.final = result.length;

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

    return { filteredAndSortedGroups: result, debugInfo: debug };
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

  const handleEdit = (group: ProductGroup) => {
    setEditingId(group.id);
    setEditForm(group);
  };

  const handleSave = async (id: string) => {
    const updatedGroups = groups.map(g => g.id === id ? { ...g, ...editForm } as ProductGroup : g);
    await db.saveProductGroups(updatedGroups);
    setGroups(updatedGroups);
    setEditingId(null);
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!window.confirm('確定要從訂購紀錄表移除此商品嗎？')) {
      return;
    }
    try {
      // 1. Delete Product Group
      const updatedGroups = groups.filter(g => g.id !== groupId);
      await db.saveProductGroups(updatedGroups);

      // 2. Delete Categories
      const updatedCategories = categories.filter(c => c.product_group_id !== groupId);
      await db.saveProductCategories(updatedCategories);

      // 3. Delete Variants
      const updatedVariants = variants.filter(v => v.product_group_id !== groupId);
      await db.saveProductVariants(updatedVariants);

      // 4. Delete Purchase Batches & Purchase Batch Items
      const fetchedBatches = await db.getPurchaseBatches();
      const targetBatchIds = new Set(fetchedBatches.filter(b => b.product_group_id === groupId).map(b => b.id));
      const updatedBatches = fetchedBatches.filter(b => b.product_group_id !== groupId);
      await db.savePurchaseBatches(updatedBatches);

      const fetchedBatchItems = await db.getPurchaseBatchItems();
      const updatedBatchItems = fetchedBatchItems.filter(item => !targetBatchIds.has(item.purchase_batch_id));
      await db.savePurchaseBatchItems(updatedBatchItems);

      // 5. Delete Private Orders & Private Order Items
      const fetchedPrivateOrders = await db.getPrivateOrders();
      const targetPrivateOrderIds = new Set(fetchedPrivateOrders.filter(o => o.product_group_id === groupId).map(o => o.id));
      const updatedPrivateOrders = fetchedPrivateOrders.filter(o => o.product_group_id !== groupId);
      await db.savePrivateOrders(updatedPrivateOrders);

      const fetchedPrivateOrderItems = await db.getPrivateOrderItems();
      const updatedPrivateOrderItems = fetchedPrivateOrderItems.filter(item => !targetPrivateOrderIds.has(item.private_order_id));
      await db.savePrivateOrderItems(updatedPrivateOrderItems);

      // 6. Reload Data
      await loadData();
    } catch (err) {
      console.error(err);
      alert('刪除失敗');
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
    if (editingId === id) return;
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

      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid #e2e8f0', paddingBottom: '0px', marginBottom: '16px' }}>
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
          代理版商品 ({groups.filter(checkIsProxyProduct).length})
        </button>
        <button 
          onClick={() => setActiveTab('multi')}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'multi' ? '2px solid #2563eb' : '2px solid transparent',
            color: activeTab === 'multi' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px'
          }}
        >
          多規格商品 ({groups.filter(g => !checkIsProxyProduct(g)).length})
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
        
        {/* Debug Info */}
        <div style={{ marginTop: '12px', padding: '12px', backgroundColor: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: '8px', fontSize: '12px', color: '#475569' }}>
          <div style={{ fontWeight: 600, marginBottom: '4px', color: '#334155' }}>Filter Debug Info:</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
            <div>原始商品總數：{debugInfo.total} 筆</div>
            <div>來源篩選後：{debugInfo.afterSource} 筆</div>
            <div>狀態篩選後：{debugInfo.afterStatus} 筆</div>
            <div>類型篩選後：{debugInfo.afterType} 筆</div>
            <div>搜尋篩選後：{debugInfo.afterSearch} 筆</div>
            <div style={{ fontWeight: 600, color: '#2563eb' }}>最終結果：{debugInfo.final} 筆</div>
          </div>
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
                    <th style={{ width: '10%', textAlign: 'center' }}>狀態</th>
                    <th style={{ width: '30%' }}>商品名稱</th>
                    <th style={{ width: '10%', textAlign: 'center' }}>需求</th>
                    <th style={{ width: '10%', textAlign: 'center' }}>已採購</th>
                    <th style={{ width: '10%', textAlign: 'center' }}>缺口</th>
                    <th style={{ width: '10%', textAlign: 'center' }}>購買結單日</th>
                    <th style={{ width: '10%', textAlign: 'center' }}>官方結單日</th>
                    <th style={{ width: '10%', textAlign: 'center' }}>發售月份</th>
                    <th style={{ width: '5%', textAlign: 'center' }}>官網</th>
                    <th style={{ width: '5%', textAlign: 'center' }}>編輯</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAndSortedGroups.map(g => {
                    const isEditing = editingId === g.id;
                    const { demand, purchased, gap } = getGroupDemandAndPurchased(g.id);
                    const status = getGroupStatus(g);
                    const closingDateStyle = getClosingDateStyle(g.closing_date);

                    return (
                      <tr 
                        key={g.id} 
                        onClick={(e) => handleRowClick(g.id, e)}
                        style={{ cursor: isEditing ? 'default' : 'pointer' }}
                      >
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>
                          {status.text}
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                          {isEditing ? (
                            <input className="input" style={{ width: '100%' }} value={editForm.title || ''} onChange={e => setEditForm({...editForm, title: e.target.value})} />
                          ) : (
                            <div className="flex-col gap-xs">
                              <div>{g.normalized_title || g.title}</div>
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                                {g.listing_type && (
                                  <span style={{ backgroundColor: '#e2e8f0', color: '#475569', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                    {g.listing_type}
                                  </span>
                                )}
                                <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 400 }}>
                                  [Debug] Group: {g.listing_type || '無'} | Inv: {
                                    (() => {
                                      const groupVars = variants.filter(v => v.product_group_id === g.id);
                                      const types = Array.from(new Set(groupVars.map(v => {
                                        const invItem = inventory.find(i => i.myacg_item_code === v.myacg_item_code);
                                        return invItem?.listing_type || '無';
                                      })));
                                      return types.join('/') || '無';
                                    })()
                                  } | 分類: {checkIsProxyProduct(g) ? '🟢 代理版' : '🔵 多規格'}
                                </span>
                              </div>
                            </div>
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {demand}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {purchased}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 700, color: gap > 0 ? '#ef4444' : '#166534' }}>
                          缺 {gap}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {isEditing ? (
                            <input 
                              className="input" 
                              type="date" 
                              style={{ width: '100%' }} 
                              value={editForm.purchase_date || ''} 
                              onChange={e => setEditForm({...editForm, purchase_date: e.target.value})} 
                            />
                          ) : (
                            <span style={{ color: '#475569', fontWeight: 500 }}>
                              {g.purchase_date || '-'}
                            </span>
                          )}
                        </td>
                        <td style={{ textAlign: 'center', color: isEditing ? 'inherit' : closingDateStyle.color, fontWeight: isEditing ? 'inherit' : closingDateStyle.fontWeight }}>
                          {isEditing ? (
                            <input className="input" type="date" style={{ width: '100%' }} value={editForm.closing_date || ''} onChange={e => setEditForm({...editForm, closing_date: e.target.value})} />
                          ) : closingDateStyle.text}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {isEditing ? (
                            <input className="input" style={{ width: '100%' }} value={editForm.release_month || ''} onChange={e => setEditForm({...editForm, release_month: e.target.value})} placeholder="例如：2026-11" />
                          ) : g.release_month || '-'}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {isEditing ? (
                            <input className="input" style={{ width: '100%' }} value={editForm.product_url || ''} onChange={e => setEditForm({...editForm, product_url: e.target.value})} placeholder="連結" />
                          ) : (
                            g.product_url ? (
                              <a 
                                href={g.product_url} 
                                target="_blank" 
                                rel="noreferrer" 
                                style={{ color: '#2563eb', fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '2px' }}
                                onClick={e => e.stopPropagation()}
                              >
                                🔗 官網
                              </a>
                            ) : '-'
                          )}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {isEditing ? (
                            <div className="flex items-center justify-center gap-xs">
                              <button className="btn btn-ghost text-success" style={{ padding: '4px' }} onClick={() => handleSave(g.id)}><Save size={16} /></button>
                              <button className="btn btn-ghost text-danger" style={{ padding: '4px' }} onClick={() => setEditingId(null)}><X size={16} /></button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-center gap-xs">
                              <button 
                                className="btn btn-ghost" 
                                style={{ padding: '4px' }} 
                                onClick={(e) => { e.stopPropagation(); handleEdit(g); }}
                                title="編輯"
                              >
                                <Edit2 size={16} />
                              </button>
                              <button 
                                className="btn btn-ghost text-danger" 
                                style={{ padding: '4px' }} 
                                onClick={(e) => { e.stopPropagation(); handleDeleteGroup(g.id); }}
                                title="刪除"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          )}
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
                    <th style={{ width: '12%', textAlign: 'center' }}>購買結單日</th>
                    <th style={{ width: '10%', textAlign: 'center' }}>狀態</th>
                    <th style={{ width: '34%' }}>商品名稱</th>
                    <th style={{ width: '10%', textAlign: 'center' }}>缺口</th>
                    <th style={{ width: '12%', textAlign: 'center' }}>結單日</th>
                    <th style={{ width: '10%', textAlign: 'center' }}>發售月份</th>
                    <th style={{ width: '6%', textAlign: 'center' }}>官網</th>
                    <th style={{ width: '6%', textAlign: 'center' }}>編輯</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAndSortedGroups.map(g => {
                    const isEditing = editingId === g.id;
                    const gap = getGroupGap(g.id);
                    const status = getGroupStatus(g);
                    const closingDateStyle = getClosingDateStyle(g.closing_date);

                    return (
                      <tr 
                        key={g.id} 
                        onClick={(e) => handleRowClick(g.id, e)}
                        style={{ cursor: isEditing ? 'default' : 'pointer' }}
                      >
                        <td style={{ textAlign: 'center' }}>
                          {isEditing ? (
                            <input 
                              className="input" 
                              type="date" 
                              style={{ width: '100%' }} 
                              value={editForm.purchase_date || ''} 
                              onChange={e => setEditForm({...editForm, purchase_date: e.target.value})} 
                            />
                          ) : (
                            <span style={{ color: '#475569', fontWeight: 500 }}>
                              {g.purchase_date || '-'}
                            </span>
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>
                          {status.text}
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                          {isEditing ? (
                            <input className="input" style={{ width: '100%' }} value={editForm.title || ''} onChange={e => setEditForm({...editForm, title: e.target.value})} />
                          ) : (
                            <div className="flex-col gap-xs">
                              <div>{g.normalized_title || g.title}</div>
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                                {g.listing_type && (
                                  <span style={{ backgroundColor: '#e2e8f0', color: '#475569', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                    {g.listing_type}
                                  </span>
                                )}
                                <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 400 }}>
                                  [Debug] Group: {g.listing_type || '無'} | Inv: {
                                    (() => {
                                      const groupVars = variants.filter(v => v.product_group_id === g.id);
                                      const types = Array.from(new Set(groupVars.map(v => {
                                        const invItem = inventory.find(i => i.myacg_item_code === v.myacg_item_code);
                                        return invItem?.listing_type || '無';
                                      })));
                                      return types.join('/') || '無';
                                    })()
                                  } | 分類: {checkIsProxyProduct(g) ? '🟢 代理版' : '🔵 多規格'}
                                </span>
                              </div>
                            </div>
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 700, color: gap > 0 ? '#ef4444' : '#166534' }}>
                          缺 {gap}
                        </td>
                        <td style={{ textAlign: 'center', color: isEditing ? 'inherit' : closingDateStyle.color, fontWeight: isEditing ? 'inherit' : closingDateStyle.fontWeight }}>
                          {isEditing ? (
                            <input className="input" type="date" style={{ width: '100%' }} value={editForm.closing_date || ''} onChange={e => setEditForm({...editForm, closing_date: e.target.value})} />
                          ) : closingDateStyle.text}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {isEditing ? (
                            <input className="input" style={{ width: '100%' }} value={editForm.release_month || ''} onChange={e => setEditForm({...editForm, release_month: e.target.value})} placeholder="例如：2026-11" />
                          ) : g.release_month || '-'}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {isEditing ? (
                            <input className="input" style={{ width: '100%' }} value={editForm.product_url || ''} onChange={e => setEditForm({...editForm, product_url: e.target.value})} placeholder="連結" />
                          ) : (
                            g.product_url ? (
                              <a 
                                href={g.product_url} 
                                target="_blank" 
                                rel="noreferrer" 
                                style={{ color: '#2563eb', fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '2px' }}
                                onClick={e => e.stopPropagation()}
                              >
                                🔗 官網
                              </a>
                            ) : '-'
                          )}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {isEditing ? (
                            <div className="flex items-center justify-center gap-xs">
                              <button className="btn btn-ghost text-success" style={{ padding: '4px' }} onClick={() => handleSave(g.id)}><Save size={16} /></button>
                              <button className="btn btn-ghost text-danger" style={{ padding: '4px' }} onClick={() => setEditingId(null)}><X size={16} /></button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-center gap-xs">
                              <button 
                                className="btn btn-ghost" 
                                style={{ padding: '4px' }} 
                                onClick={(e) => { e.stopPropagation(); handleEdit(g); }}
                                title="編輯"
                              >
                                <Edit2 size={16} />
                              </button>
                              <button 
                                className="btn btn-ghost text-danger" 
                                style={{ padding: '4px' }} 
                                onClick={(e) => { e.stopPropagation(); handleDeleteGroup(g.id); }}
                                title="刪除"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          )}
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
    </div>
  );
}
