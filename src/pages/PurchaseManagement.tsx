import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { db } from '../lib/db';
import type { 
  ProductGroup, ProductVariant, InventoryItem, ProductCategory,
  PurchaseBatch, PurchaseBatchItem, PrivateOrder, PrivateOrderItem 
} from '../lib/db';
import { ChevronRight, ChevronDown, Plus, X, ArrowLeft } from 'lucide-react';

export default function PurchaseManagement() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [group, setGroup] = useState<ProductGroup | null>(null);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [inventoryMap, setInventoryMap] = useState<Map<string, InventoryItem>>(new Map());
  const [categoryMap, setCategoryMap] = useState<Map<string, ProductCategory>>(new Map());
  
  // Data for calculation
  const [privateOrders, setPrivateOrders] = useState<PrivateOrder[]>([]);
  const [privateOrderItems, setPrivateOrderItems] = useState<PrivateOrderItem[]>([]);
  const [purchaseBatches, setPurchaseBatches] = useState<PurchaseBatch[]>([]);
  const [purchaseBatchItems, setPurchaseBatchItems] = useState<PurchaseBatchItem[]>([]);
  
  // UI States
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedOrderRows, setExpandedOrderRows] = useState<Set<string>>(new Set());

  // Modal: Private Order
  const [showPrivateOrderModal, setShowPrivateOrderModal] = useState(false);
  const [poForm, setPoForm] = useState({ customer_name: '', contact: '', note: '' });
  const [poLines, setPoLines] = useState<{ variant_id: string, quantity: number, amount: number, note: string }[]>([]);

  // Modal: Purchase Batch
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [batchForm, setBatchForm] = useState({ name: '', date: '', note: '' });
  const [batchLines, setBatchLines] = useState<{ variant_id: string, quantity: number, cost: number, note: string }[]>([]);

  useEffect(() => {
    loadData();
  }, [id]);

  const loadData = async () => {
    if (!id) return;
    const allGroups = await db.getProductGroups();
    const g = allGroups.find(x => x.id === id);
    if (!g) {
      navigate('/purchase-records');
      return;
    }
    setGroup(g);

    const allVars = await db.getProductVariants();
    const allCats = await db.getProductCategories();
    const groupCatIds = new Set(allCats.filter(c => c.product_group_id === id).map(c => c.id));
    const groupVars = allVars.filter(v => v.product_group_id === id || (v.product_category_id && groupCatIds.has(v.product_category_id)));
    
    setVariants(groupVars);
    
    const catMap = new Map(allCats.map(c => [c.id, c]));
    setCategoryMap(catMap);

    const inventory = await db.getInventory();
    const invMap = new Map(inventory.map(i => [i.myacg_item_code, i]));
    setInventoryMap(invMap);

    // Fetch new architecture data
    const allPrivateOrders = await db.getPrivateOrders();
    const allPrivateOrderItems = await db.getPrivateOrderItems();
    const groupPrivateOrders = allPrivateOrders.filter(po => po.product_group_id === id);
    const groupPoIds = new Set(groupPrivateOrders.map(po => po.id));
    const groupPrivateOrderItems = allPrivateOrderItems.filter(poi => groupPoIds.has(poi.private_order_id));
    
    setPrivateOrders(groupPrivateOrders);
    setPrivateOrderItems(groupPrivateOrderItems);

    const allBatches = await db.getPurchaseBatches();
    const allBatchItems = await db.getPurchaseBatchItems();
    const groupBatches = allBatches.filter(b => b.product_group_id === id);
    const groupBatchIds = new Set(groupBatches.map(b => b.id));
    const groupBatchItems = allBatchItems.filter(bi => groupBatchIds.has(bi.purchase_batch_id));

    setPurchaseBatches(groupBatches);
    setPurchaseBatchItems(groupBatchItems);

    // Expand all groups by default
    const groupCatTitles = new Set(allCats.filter(c => c.product_group_id === id).map(c => c.title));
    setExpandedGroups(groupCatTitles);
  };

  const handleUpdatePlatformDemand = async (vId: string, platform: 'myacg' | 'waca', totalValue: number) => {
    if (isNaN(totalValue) || totalValue < 0) totalValue = 0;
    const allVars = await db.getProductVariants();
    const target = allVars.find(v => v.id === vId);
    if (target) {
      if (platform === 'myacg') {
        const auto = target.myacg_auto_quantity || 0;
        target.myacg_manual_adjustment = totalValue - auto;
      } else {
        const auto = target.waca_auto_quantity || 0;
        target.waca_manual_adjustment = totalValue - auto;
      }
      await db.saveProductVariants(allVars);
      setVariants(variants.map(v => v.id === vId ? target : v));
    }
  };

  // --- Modal Logic: Private Order ---
  const openPrivateOrderModal = () => {
    setPoForm({ customer_name: '', contact: '', note: '' });
    setPoLines(variants.map(v => ({ variant_id: v.id, quantity: 0, amount: 0, note: '' })));
    setShowPrivateOrderModal(true);
  };

  const updatePoLine = (index: number, field: string, value: any) => {
    const newLines = [...poLines];
    newLines[index] = { ...newLines[index], [field]: value };
    setPoLines(newLines);
  };

  const handleAddPrivateOrderSubmit = async () => {
    const validLines = poLines.filter(l => l.quantity > 0);
    if (!group || !poForm.customer_name.trim() || validLines.length === 0) return;
    
    const newPoId = crypto.randomUUID();
    const newPo: PrivateOrder = {
      id: newPoId,
      product_group_id: group.id,
      customer_name: poForm.customer_name,
      contact: poForm.contact,
      note: poForm.note,
      created_at: new Date().toISOString().slice(0, 10)
    };

    const newItems: PrivateOrderItem[] = validLines.map(line => ({
      id: crypto.randomUUID(),
      private_order_id: newPoId,
      product_variant_id: line.variant_id,
      quantity: line.quantity,
      amount: line.amount,
      note: line.note
    }));

    const allPOs = await db.getPrivateOrders();
    const allPOItems = await db.getPrivateOrderItems();
    
    await db.savePrivateOrders([...allPOs, newPo]);
    await db.savePrivateOrderItems([...allPOItems, ...newItems]);
    
    setShowPrivateOrderModal(false);
    await loadData();
  };

  // --- Modal Logic: Purchase Batch ---
  const openBatchModal = () => {
    setBatchForm({ name: '', date: new Date().toISOString().slice(0, 10), note: '' });
    setBatchLines(variants.map(v => ({ variant_id: v.id, quantity: 0, cost: 0, note: '' })));
    setShowBatchModal(true);
  };

  const updateBatchLine = (index: number, field: string, value: any) => {
    const newLines = [...batchLines];
    newLines[index] = { ...newLines[index], [field]: value };
    setBatchLines(newLines);
  };

  const handleAddBatchSubmit = async () => {
    const validLines = batchLines.filter(l => l.quantity > 0);
    if (!group || !batchForm.name.trim() || validLines.length === 0) return;
    
    const newBatchId = crypto.randomUUID();
    const newBatch: PurchaseBatch = {
      id: newBatchId,
      product_group_id: group.id,
      name: batchForm.name,
      date: batchForm.date,
      note: batchForm.note,
      created_at: new Date().toISOString()
    };

    const newItems: PurchaseBatchItem[] = validLines.map(line => ({
      id: crypto.randomUUID(),
      purchase_batch_id: newBatchId,
      product_variant_id: line.variant_id,
      quantity: line.quantity,
      cost: line.cost,
      note: line.note
    }));

    const allBatches = await db.getPurchaseBatches();
    const allBatchItems = await db.getPurchaseBatchItems();
    
    await db.savePurchaseBatches([...allBatches, newBatch]);
    await db.savePurchaseBatchItems([...allBatchItems, ...newItems]);
    
    setShowBatchModal(false);
    await loadData();
  };

  const toggleGroup = (title: string) => {
    const next = new Set(expandedGroups);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    setExpandedGroups(next);
  };

  const toggleOrderRow = (vId: string) => {
    const next = new Set(expandedOrderRows);
    if (next.has(vId)) next.delete(vId);
    else next.add(vId);
    setExpandedOrderRows(next);
  };

  const formatVariantOption = (v: ProductVariant) => {
    let catTitle = '';
    if (v.product_category_id) {
      const cat = categoryMap.get(v.product_category_id);
      if (cat) catTitle = cat.title;
    }
    
    if (!catTitle || catTitle === '單品') {
      return v.variant_name;
    } else {
      return `${catTitle} - ${v.variant_name}`;
    }
  };

  if (!group) return <div className="p-xl text-center text-muted">載入中...</div>;

  // Grouping Variants by Category or Single Item
  const groupedVariants: Record<string, ProductVariant[]> = {};
  variants.forEach(v => {
    let groupKey = '';
    if (v.product_category_id) {
      const cat = categoryMap.get(v.product_category_id);
      groupKey = cat ? cat.title : `__single__${v.id}`;
    } else {
      groupKey = `__single__${v.id}`;
    }
    
    if (!groupedVariants[groupKey]) groupedVariants[groupKey] = [];
    groupedVariants[groupKey].push(v);
  });

  // Calculate top KPI numbers
  let totalDemandItems = 0;
  let totalPurchasedItems = 0;
  let totalShortageItems = 0;
  let totalEstimatedCost = 0;

  variants.forEach(v => {
    const inv = inventoryMap.get(v.myacg_item_code);
    const price = inv ? inv.final_price : 0;
    const stock = inv ? inv.myacg_available_quantity : 0;
    
    const myacgDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
    const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
    
    const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
    const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);

    const totalDemand = myacgDemand + wacaDemand + privateDemand;

    const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
    const totalPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);
    
    const needToBuy = Math.max(totalDemand - totalPurchased - stock, 0);

    totalDemandItems += totalDemand;
    totalPurchasedItems += totalPurchased;

    if (needToBuy > 0) {
      totalShortageItems += needToBuy;
      totalEstimatedCost += (needToBuy * price);
    }
  });

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f4f5f7', display: 'flex', flexDirection: 'column' }}>
      
      {/* Top Breadcrumb & Title Area */}
      <div style={{ backgroundColor: '#fff', padding: '16px 24px', borderBottom: '1px solid #e5e7eb' }}>
        <div className="flex items-center gap-sm text-muted text-sm" style={{ marginBottom: '12px' }}>
          <button className="btn btn-ghost" style={{ padding: 0 }} onClick={() => navigate('/purchase-records')}>
            <ArrowLeft size={16} />
          </button>
          <span>團務與商品管理</span>
          <span>/</span>
          <span className="text-primary font-medium">{group.title}</span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#111827' }}>
            {group.title}
          </h1>
          
          {/* Small Summary Strip */}
          <div style={{ display: 'flex', gap: '24px', fontSize: '14px', alignItems: 'center' }}>
            <div><span style={{ color: '#6b7280' }}>總需求:</span> <span style={{ fontWeight: 600 }}>{totalDemandItems}</span></div>
            <div><span style={{ color: '#6b7280' }}>已採購:</span> <span style={{ fontWeight: 600, color: '#2563eb' }}>{totalPurchasedItems}</span></div>
            <div><span style={{ color: '#6b7280' }}>缺貨:</span> <span style={{ fontWeight: 600, color: '#ef4444' }}>{totalShortageItems}</span></div>
            <div><span style={{ color: '#6b7280' }}>預估金額:</span> <span style={{ fontWeight: 600, color: '#10b981' }}>NT$ {totalEstimatedCost.toLocaleString()}</span></div>
          </div>
        </div>
      </div>

      <div style={{ padding: '24px', flex: 1, display: 'flex', flexDirection: 'column', maxWidth: '1600px', margin: '0 auto', width: '100%' }}>
        
        {/* Tab & Table Container */}
        <div className="card" style={{ padding: 0, borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)', overflow: 'hidden', display: 'flex', flexDirection: 'column', flex: 1 }}>
          
          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', backgroundColor: '#fff', padding: '0 16px' }}>
            <div style={{ padding: '16px 24px', color: '#2563eb', fontWeight: 600, borderBottom: '2px solid #2563eb', display: 'flex', alignItems: 'center', gap: '8px' }}>
              代購工作規格表 (Airtable 模式)
            </div>
            
            <div style={{ flex: 1 }} />
            
            {/* Table Actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button className="btn btn-outline" style={{ fontSize: '13px', padding: '6px 12px', backgroundColor: '#fdf2f8', color: '#db2777', borderColor: '#fbcfe8' }} onClick={openPrivateOrderModal}>
                <Plus size={14} style={{ display: 'inline-block', marginRight: '4px' }} />
                私下登記
              </button>
              <button className="btn btn-primary" style={{ fontSize: '13px', padding: '6px 12px' }} onClick={openBatchModal}>
                <Plus size={14} style={{ display: 'inline-block', marginRight: '4px' }} />
                新增採購批次
              </button>
              <div style={{ width: '1px', height: '24px', backgroundColor: '#e2e8f0', margin: '0 8px' }}></div>
              <button className="btn btn-outline" style={{ fontSize: '13px', padding: '6px 12px', backgroundColor: '#fff' }} onClick={() => setExpandedGroups(new Set(Object.keys(groupedVariants)))}>展開群組</button>
              <button className="btn btn-outline" style={{ fontSize: '13px', padding: '6px 12px', backgroundColor: '#fff' }} onClick={() => setExpandedGroups(new Set())}>收合群組</button>
            </div>
          </div>

          {/* Table Wrapper */}
          <div style={{ overflowX: 'auto', backgroundColor: '#fff', flex: 1 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', fontFamily: 'system-ui, sans-serif' }}>
              
              <thead style={{ backgroundColor: '#f9fafb', color: '#6b7280', position: 'sticky', top: 0, zIndex: 10 }}>
                <tr>
                  <th style={thStyle(30, 'center')}></th>
                  <th style={thStyle(300, 'left')}>品項規格名稱</th>
                  <th style={thStyle(100, 'right')}>單價</th>
                  <th style={thStyle(90, 'center', '#fef2f2')}>還需</th>
                  <th style={thStyle(90, 'center', '#fff7ed')}>多買</th>
                  <th style={thStyle(100, 'center')}>買動漫</th>
                  <th style={thStyle(100, 'center')}>WACA</th>
                  <th style={thStyle(100, 'center', '#fdf2f8')}>私下登記</th>
                </tr>
              </thead>
              
              <tbody>
                {Object.entries(groupedVariants).map(([title, groupItems]) => {
                  const isExpanded = expandedGroups.has(title);
                  
                  if (groupItems.length === 1) {
                    const v = groupItems[0];
                    const isOrderExpanded = expandedOrderRows.has(v.id);
                    
                    const inv = inventoryMap.get(v.myacg_item_code);
                    const price = inv ? inv.final_price : 0;
                    const stock = inv ? inv.myacg_available_quantity : 0;
                    
                    const myacgDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
                    const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                    
                    const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
                    const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);

                    const totalDemand = myacgDemand + wacaDemand + privateDemand;

                    const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
                    const totalPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);
                    
                    const needToBuy = Math.max(totalDemand - totalPurchased - stock, 0);
                    const excessBuy = Math.max(totalPurchased + stock - totalDemand, 0);

                    const displayName = v.variant_name;

                    return (
                      <React.Fragment key={v.id}>
                        <tr style={{ backgroundColor: '#fff', borderBottom: '1px solid #e5e7eb' }}>
                          <td style={tdStyle('center')}>
                            <div className="flex items-center justify-center cursor-pointer" onClick={() => toggleOrderRow(v.id)}>
                              {isOrderExpanded ? <ChevronDown size={14} className="text-primary"/> : <ChevronRight size={14} className="text-muted"/>}
                            </div>
                          </td>
                          <td style={tdStyle('left')}>
                            <div style={{ fontWeight: 600, color: '#111827' }}>{displayName}</div>
                            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>{v.myacg_item_code}</div>
                          </td>
                          <td style={tdStyle('right')}>¥ {price}</td>
                          
                          <td style={{...tdStyle('center', false, '#fef2f2'), fontWeight: 600, color: '#dc2626'}}>
                            {needToBuy > 0 ? needToBuy : ''}
                          </td>
                          <td style={{...tdStyle('center', false, '#fff7ed'), fontWeight: 600, color: '#ea580c'}}>
                            {excessBuy > 0 ? excessBuy : ''}
                          </td>
                          
                          {/* MyACG Inline Edit */}
                          <td style={tdStyle('center', false, '#f8fafc')}>
                            <input 
                              type="number" 
                              style={sheetInputStyle('center')} 
                              value={myacgDemand || ''}
                              placeholder="0"
                              onChange={e => handleUpdatePlatformDemand(v.id, 'myacg', parseInt(e.target.value))}
                            />
                          </td>
                          {/* WACA Inline Edit */}
                          <td style={tdStyle('center', false, '#f8fafc')}>
                            <input 
                              type="number" 
                              style={sheetInputStyle('center')} 
                              value={wacaDemand || ''}
                              placeholder="0"
                              onChange={e => handleUpdatePlatformDemand(v.id, 'waca', parseInt(e.target.value))}
                            />
                          </td>

                          <td style={tdStyle('center', false, '#fdf2f8')}>
                            <span style={{ fontWeight: 600, color: '#db2777' }}>{privateDemand > 0 ? privateDemand : ''}</span>
                          </td>
                        </tr>
                        {isOrderExpanded && <OrderDetailsSubRow 
                          variant={v} 
                          privateOrders={privateOrders}
                          vPrivateItems={vPrivateItems}
                          purchaseBatches={purchaseBatches}
                          vBatchItems={vBatchItems}
                          colSpan={8} 
                        />}
                      </React.Fragment>
                    );
                  }

                  // Parent Row Aggregates (For > 1 items)
                  let pMyacg = 0, pWaca = 0, pManual = 0, pNeed = 0, pExcess = 0;
                  
                  groupItems.forEach(v => {
                    const inv = inventoryMap.get(v.myacg_item_code);
                    const stock = inv ? inv.myacg_available_quantity : 0;
                    
                    const mDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
                    const wDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                    
                    const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
                    const pDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);

                    pMyacg += mDemand;
                    pWaca += wDemand;
                    pManual += pDemand;
                    
                    const tDemand = mDemand + wDemand + pDemand;
                    const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
                    const tPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);
                    
                    pNeed += Math.max(tDemand - tPurchased - stock, 0);
                    pExcess += Math.max(tPurchased + stock - tDemand, 0);
                  });

                  return (
                    <React.Fragment key={title}>
                      {/* Parent Group Row */}
                      <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                        <td style={tdStyle('center')}></td>
                        <td style={tdStyle('left')} onClick={() => toggleGroup(title)}>
                          <div className="flex items-center gap-sm cursor-pointer" style={{ fontWeight: 600, color: '#111827' }}>
                            {isExpanded ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
                            {title}
                            <span style={{ backgroundColor: '#e2e8f0', color: '#475569', padding: '2px 6px', borderRadius: '12px', fontSize: '11px', fontWeight: 500 }}>
                              {groupItems.length}
                            </span>
                          </div>
                        </td>
                        <td style={tdStyle('right', true)}>-</td>
                        
                        <td style={{...tdStyle('center', false, '#fef2f2'), fontWeight: 600, color: '#dc2626'}}>
                          {pNeed > 0 ? pNeed : ''}
                        </td>
                        <td style={{...tdStyle('center', false, '#fff7ed'), fontWeight: 600, color: '#ea580c'}}>
                          {pExcess > 0 ? pExcess : ''}
                        </td>
                        
                        <td style={tdStyle('center', true)}>{pMyacg > 0 ? pMyacg : ''}</td>
                        <td style={tdStyle('center', true)}>{pWaca > 0 ? pWaca : ''}</td>
                        <td style={tdStyle('center', true, '#fdf2f8')}>{pManual > 0 ? pManual : ''}</td>
                      </tr>

                      {/* Child SKU Rows */}
                      {isExpanded && groupItems.map((v, i) => {
                        const isOrderExpanded = expandedOrderRows.has(v.id);
                        const inv = inventoryMap.get(v.myacg_item_code);
                        const price = inv ? inv.final_price : 0;
                        const stock = inv ? inv.myacg_available_quantity : 0;
                        
                        const myacgDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
                        const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                        
                        const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
                        const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);
    
                        const totalDemand = myacgDemand + wacaDemand + privateDemand;

                        const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
                        const totalPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);
                        
                        const needToBuy = Math.max(totalDemand - totalPurchased - stock, 0);
                        const excessBuy = Math.max(totalPurchased + stock - totalDemand, 0);

                        const isLastChild = i === groupItems.length - 1;
                        const childBorderBottom = isLastChild ? '1px solid #cbd5e1' : '1px solid #f1f5f9';

                        return (
                          <React.Fragment key={v.id}>
                            <tr style={{ backgroundColor: '#fff', borderBottom: childBorderBottom }}>
                              <td style={tdStyle('center')}>
                                <div className="flex items-center justify-center cursor-pointer" onClick={() => toggleOrderRow(v.id)}>
                                  {isOrderExpanded ? <ChevronDown size={14} className="text-primary"/> : <ChevronRight size={14} className="text-muted"/>}
                                </div>
                              </td>
                              <td style={{ ...tdStyle('left'), paddingLeft: '24px', position: 'relative' }}>
                                <div style={{ position: 'absolute', left: '6px', top: 0, bottom: isLastChild ? '50%' : 0, borderLeft: '1px solid #cbd5e1' }}></div>
                                <div style={{ position: 'absolute', left: '6px', top: '50%', width: '12px', borderTop: '1px solid #cbd5e1' }}></div>
                                <div style={{ fontWeight: 500, color: '#334155' }}>{v.variant_name}</div>
                                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>{v.myacg_item_code}</div>
                              </td>
                              
                              <td style={tdStyle('right')}>¥ {price}</td>
                              
                              <td style={{...tdStyle('center', false, '#fef2f2'), fontWeight: 600, color: '#dc2626'}}>
                                {needToBuy > 0 ? needToBuy : ''}
                              </td>
                              <td style={{...tdStyle('center', false, '#fff7ed'), fontWeight: 600, color: '#ea580c'}}>
                                {excessBuy > 0 ? excessBuy : ''}
                              </td>

                              <td style={tdStyle('center', false, '#f8fafc')}>
                                <input 
                                  type="number" 
                                  style={sheetInputStyle('center')} 
                                  value={myacgDemand || ''}
                                  placeholder="0"
                                  onChange={e => handleUpdatePlatformDemand(v.id, 'myacg', parseInt(e.target.value))}
                                />
                              </td>
                              <td style={tdStyle('center', false, '#f8fafc')}>
                                <input 
                                  type="number" 
                                  style={sheetInputStyle('center')} 
                                  value={wacaDemand || ''}
                                  placeholder="0"
                                  onChange={e => handleUpdatePlatformDemand(v.id, 'waca', parseInt(e.target.value))}
                                />
                              </td>
                              
                              <td style={tdStyle('center', false, '#fdf2f8')}>
                                <span style={{ fontWeight: 600, color: '#db2777' }}>{privateDemand > 0 ? privateDemand : ''}</span>
                              </td>
                            </tr>
                            {isOrderExpanded && <OrderDetailsSubRow 
                                variant={v} 
                                privateOrders={privateOrders}
                                vPrivateItems={vPrivateItems}
                                purchaseBatches={purchaseBatches}
                                vBatchItems={vBatchItems}
                                colSpan={8} 
                              />}
                          </React.Fragment>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      {/* MODAL: Add Private Order */}
      {showPrivateOrderModal && (
        <div style={modalOverlayStyle}>
          <div style={{ ...modalStyle, maxWidth: '800px' }}>
            <div style={modalHeaderStyle}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>新增私下登記</h3>
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setShowPrivateOrderModal(false)}>
                <X size={18} />
              </button>
            </div>
            <div style={modalBodyStyle}>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: '16px', marginBottom: '24px' }}>
                <div className="form-group">
                  <label className="text-sm font-medium">客人名稱 *</label>
                  <input 
                    className="input" 
                    value={poForm.customer_name}
                    onChange={e => setPoForm({...poForm, customer_name: e.target.value})}
                    placeholder="例如：王大明"
                  />
                </div>
                <div className="form-group">
                  <label className="text-sm font-medium">聯絡方式</label>
                  <input 
                    className="input" 
                    value={poForm.contact}
                    onChange={e => setPoForm({...poForm, contact: e.target.value})}
                    placeholder="例如：0912-345-678"
                  />
                </div>
                <div className="form-group">
                  <label className="text-sm font-medium">備註</label>
                  <input 
                    className="input" 
                    value={poForm.note}
                    onChange={e => setPoForm({...poForm, note: e.target.value})}
                    placeholder="交貨方式或已付款狀態等..."
                  />
                </div>
              </div>

              <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600, color: '#475569' }}>商品明細</h4>
              <div style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'auto', maxHeight: '400px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr>
                      <th style={{ padding: '8px 12px', textAlign: 'left', width: '45%' }}>商品名稱</th>
                      <th style={{ padding: '8px 12px', textAlign: 'center', width: '15%' }}>數量</th>
                      <th style={{ padding: '8px 12px', textAlign: 'center', width: '15%' }}>金額</th>
                      <th style={{ padding: '8px 12px', textAlign: 'left', width: '40%' }}>備註</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poLines.map((line, idx) => {
                      const v = variants.find(x => x.id === line.variant_id);
                      if (!v) return null;
                      return (
                        <tr key={v.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px 12px', fontWeight: 500, color: '#334155' }}>
                            {formatVariantOption(v)}
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <input 
                              type="number" 
                              className="input" 
                              style={{ padding: '6px', textAlign: 'center' }} 
                              min="0" 
                              value={line.quantity || ''} 
                              placeholder="0"
                              onChange={e => updatePoLine(idx, 'quantity', parseInt(e.target.value) || 0)} 
                              onKeyDown={e => e.key === 'Enter' && e.preventDefault()}
                            />
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <input 
                              type="number" 
                              className="input" 
                              style={{ padding: '6px', textAlign: 'right' }} 
                              value={line.amount || ''} 
                              placeholder="0"
                              onChange={e => updatePoLine(idx, 'amount', parseFloat(e.target.value) || 0)} 
                              onKeyDown={e => e.key === 'Enter' && e.preventDefault()}
                            />
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <input 
                              type="text" 
                              className="input" 
                              style={{ padding: '6px' }} 
                              value={line.note} 
                              onChange={e => updatePoLine(idx, 'note', e.target.value)} 
                              onKeyDown={e => e.key === 'Enter' && e.preventDefault()}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={modalFooterStyle}>
              <button className="btn btn-outline" onClick={() => setShowPrivateOrderModal(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleAddPrivateOrderSubmit} disabled={!poForm.customer_name.trim() || !poLines.some(l => l.quantity > 0)}>確認建立私下登記</button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Add Purchase Batch */}
      {showBatchModal && (
        <div style={modalOverlayStyle}>
          <div style={{ ...modalStyle, maxWidth: '800px' }}>
            <div style={modalHeaderStyle}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>新增採購批次</h3>
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setShowBatchModal(false)}>
                <X size={18} />
              </button>
            </div>
            <div style={modalBodyStyle}>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: '16px', marginBottom: '24px' }}>
                <div className="form-group">
                  <label className="text-sm font-medium">批次名稱 *</label>
                  <input 
                    className="input" 
                    value={batchForm.name}
                    onChange={e => setBatchForm({...batchForm, name: e.target.value})}
                    placeholder="例如：第一次下單"
                  />
                </div>
                <div className="form-group">
                  <label className="text-sm font-medium">採購日期</label>
                  <input 
                    type="date"
                    className="input" 
                    value={batchForm.date}
                    onChange={e => setBatchForm({...batchForm, date: e.target.value})}
                  />
                </div>
                <div className="form-group">
                  <label className="text-sm font-medium">備註</label>
                  <input 
                    className="input" 
                    value={batchForm.note}
                    onChange={e => setBatchForm({...batchForm, note: e.target.value})}
                    placeholder="刷卡或集運紀錄..."
                  />
                </div>
              </div>

              <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600, color: '#475569' }}>商品明細</h4>
              <div style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'auto', maxHeight: '400px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr>
                      <th style={{ padding: '8px 12px', textAlign: 'left', width: '45%' }}>商品名稱</th>
                      <th style={{ padding: '8px 12px', textAlign: 'center', width: '15%' }}>採購數量</th>
                      <th style={{ padding: '8px 12px', textAlign: 'center', width: '15%' }}>成本</th>
                      <th style={{ padding: '8px 12px', textAlign: 'left', width: '40%' }}>備註</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchLines.map((line, idx) => {
                      const v = variants.find(x => x.id === line.variant_id);
                      if (!v) return null;
                      return (
                        <tr key={v.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px 12px', fontWeight: 500, color: '#334155' }}>
                            {formatVariantOption(v)}
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <input 
                              type="number" 
                              className="input" 
                              style={{ padding: '6px', textAlign: 'center' }} 
                              min="0" 
                              value={line.quantity || ''} 
                              placeholder="0"
                              onChange={e => updateBatchLine(idx, 'quantity', parseInt(e.target.value) || 0)} 
                              onKeyDown={e => e.key === 'Enter' && e.preventDefault()}
                            />
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <input 
                              type="number" 
                              className="input" 
                              style={{ padding: '6px', textAlign: 'right' }} 
                              value={line.cost || ''} 
                              placeholder="0"
                              onChange={e => updateBatchLine(idx, 'cost', parseFloat(e.target.value) || 0)} 
                              onKeyDown={e => e.key === 'Enter' && e.preventDefault()}
                            />
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <input 
                              type="text" 
                              className="input" 
                              style={{ padding: '6px' }} 
                              value={line.note} 
                              onChange={e => updateBatchLine(idx, 'note', e.target.value)} 
                              onKeyDown={e => e.key === 'Enter' && e.preventDefault()}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={modalFooterStyle}>
              <button className="btn btn-outline" onClick={() => setShowBatchModal(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleAddBatchSubmit} disabled={!batchForm.name.trim() || !batchLines.some(l => l.quantity > 0)}>建立採購批次</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function OrderDetailsSubRow({ 
  variant, 
  privateOrders,
  vPrivateItems,
  purchaseBatches,
  vBatchItems,
  colSpan 
}: { 
  variant: ProductVariant, 
  privateOrders: PrivateOrder[],
  vPrivateItems: PrivateOrderItem[],
  purchaseBatches: PurchaseBatch[],
  vBatchItems: PurchaseBatchItem[],
  colSpan: number 
}) {
  
  // Mapping private order headers for easy display
  const poMap = new Map(privateOrders.map(po => [po.id, po]));
  const batchMap = new Map(purchaseBatches.map(b => [b.id, b]));

  return (
    <tr style={{ backgroundColor: '#f8fafc', borderBottom: '2px solid #cbd5e1' }}>
      <td></td>
      <td colSpan={colSpan - 1} style={{ padding: '16px' }}>
        
        <div style={{ display: 'flex', gap: '24px' }}>
          
          {/* Left: Demand Sources */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
            
            {/* Platform Breakdowns */}
            <div style={{ display: 'flex', gap: '16px' }}>
              <div style={{ flex: 1, backgroundColor: '#fff', border: '1px solid #e2e8f0', padding: '12px', borderRadius: '6px' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '8px' }}>買動漫來源分析</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px' }}>
                  <span style={{ color: '#94a3b8' }}>系統自動匯入</span>
                  <span style={{ fontWeight: 600 }}>{variant.myacg_auto_quantity || 0}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px' }}>
                  <span style={{ color: '#94a3b8' }}>手動修正補償</span>
                  <span style={{ fontWeight: 600, color: (variant.myacg_manual_adjustment || 0) !== 0 ? '#ea580c' : 'inherit' }}>
                    {(variant.myacg_manual_adjustment || 0) > 0 ? `+${variant.myacg_manual_adjustment}` : (variant.myacg_manual_adjustment || 0)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', borderTop: '1px solid #f1f5f9', paddingTop: '4px', marginTop: '4px' }}>
                  <span style={{ fontWeight: 600, color: '#475569' }}>顯示總數</span>
                  <span style={{ fontWeight: 600, color: '#2563eb' }}>{(variant.myacg_auto_quantity || 0) + (variant.myacg_manual_adjustment || 0)}</span>
                </div>
              </div>
              
              <div style={{ flex: 1, backgroundColor: '#fff', border: '1px solid #e2e8f0', padding: '12px', borderRadius: '6px' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '8px' }}>WACA來源分析</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px' }}>
                  <span style={{ color: '#94a3b8' }}>系統自動匯入</span>
                  <span style={{ fontWeight: 600 }}>{variant.waca_auto_quantity || 0}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px' }}>
                  <span style={{ color: '#94a3b8' }}>手動修正補償</span>
                  <span style={{ fontWeight: 600, color: (variant.waca_manual_adjustment || 0) !== 0 ? '#ea580c' : 'inherit' }}>
                    {(variant.waca_manual_adjustment || 0) > 0 ? `+${variant.waca_manual_adjustment}` : (variant.waca_manual_adjustment || 0)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', borderTop: '1px solid #f1f5f9', paddingTop: '4px', marginTop: '4px' }}>
                  <span style={{ fontWeight: 600, color: '#475569' }}>顯示總數</span>
                  <span style={{ fontWeight: 600, color: '#2563eb' }}>{(variant.waca_auto_quantity || 0) + (variant.waca_manual_adjustment || 0)}</span>
                </div>
              </div>
            </div>

            {/* Private Orders */}
            <div style={{ border: '1px solid #e2e8f0', backgroundColor: '#fff', padding: '12px', borderRadius: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h4 style={{ margin: 0, fontSize: '13px', color: '#db2777', fontWeight: 600 }}>私下登記來源單據 ({vPrivateItems.length} 筆)</h4>
              </div>
              {vPrivateItems.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #e2e8f0', color: '#64748b' }}>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>客人名稱 (聯絡)</th>
                      <th style={{ textAlign: 'right', padding: '6px 8px' }}>數量</th>
                      <th style={{ textAlign: 'right', padding: '6px 8px' }}>金額</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>備註</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vPrivateItems.map((item, i) => {
                      const po = poMap.get(item.private_order_id);
                      if (!po) return null;
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '6px 8px' }}>{po.customer_name} {po.contact ? `(${po.contact})` : ''}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, color: '#db2777' }}>{item.quantity}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>{item.amount > 0 ? item.amount : ''}</td>
                          <td style={{ padding: '6px 8px', color: '#64748b' }}>{item.note || po.note}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div style={{ fontSize: '13px', color: '#94a3b8' }}>無登記紀錄</div>
              )}
            </div>
            
          </div>

          {/* Right: Batches Implementation */}
          <div style={{ flex: 1, backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', padding: '16px', borderRadius: '8px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#1e3a8a', fontWeight: 600 }}>採購來源單據 ({vBatchItems.length} 筆)</h4>
            
            {vBatchItems.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #93c5fd', color: '#1e40af' }}>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>批次名稱</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>日期</th>
                      <th style={{ textAlign: 'right', padding: '6px 8px' }}>數量</th>
                      <th style={{ textAlign: 'right', padding: '6px 8px' }}>成本</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>備註</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vBatchItems.map((item, i) => {
                      const batch = batchMap.get(item.purchase_batch_id);
                      if (!batch) return null;
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid #dbeafe', backgroundColor: '#fff' }}>
                          <td style={{ padding: '6px 8px', fontWeight: 500 }}>{batch.name}</td>
                          <td style={{ padding: '6px 8px', color: '#64748b' }}>{batch.date}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, color: '#2563eb' }}>{item.quantity}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>{item.cost > 0 ? item.cost : ''}</td>
                          <td style={{ padding: '6px 8px', color: '#64748b' }}>{item.note || batch.note}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
            ) : (
              <div style={{ fontSize: '13px', color: '#64748b' }}>
                尚未採購
              </div>
            )}
            
          </div>
          
        </div>

      </td>
    </tr>
  );
}

// Minimal styling helpers for the spreadsheet
function thStyle(minWidth: number, align: 'left' | 'center' | 'right', bgColor?: string): React.CSSProperties {
  return {
    minWidth: `${minWidth}px`,
    padding: '12px 16px',
    textAlign: align,
    fontWeight: 600,
    borderBottom: '1px solid #e5e7eb',
    borderRight: '1px solid #f3f4f6',
    backgroundColor: bgColor || 'transparent',
  };
}

function tdStyle(align: 'left' | 'center' | 'right', textMuted = false, bgColor = 'transparent'): React.CSSProperties {
  return {
    padding: '10px 16px',
    textAlign: align,
    borderRight: '1px solid #f1f5f9',
    backgroundColor: bgColor,
    color: textMuted ? '#94a3b8' : 'inherit',
    verticalAlign: 'middle',
  };
}

function sheetInputStyle(align: 'left' | 'center' | 'right'): React.CSSProperties {
  return {
    width: '100%',
    padding: '6px 8px',
    textAlign: align,
    fontSize: '13px',
    border: '1px solid transparent',
    borderRadius: '4px',
    backgroundColor: 'transparent',
    outline: 'none',
    transition: 'all 0.15s',
  };
}

const modalOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0, left: 0, right: 0, bottom: 0,
  backgroundColor: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000
};

const modalStyle: React.CSSProperties = {
  backgroundColor: '#fff',
  borderRadius: '8px',
  width: '100%',
  maxWidth: '400px',
  boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  maxHeight: '90vh'
};

const modalHeaderStyle: React.CSSProperties = {
  padding: '16px 20px',
  borderBottom: '1px solid #e2e8f0',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  backgroundColor: '#f8fafc',
  flexShrink: 0
};

const modalBodyStyle: React.CSSProperties = {
  padding: '20px',
  overflowY: 'auto',
  flex: 1
};

const modalFooterStyle: React.CSSProperties = {
  padding: '16px 20px',
  borderTop: '1px solid #e2e8f0',
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '12px',
  backgroundColor: '#f8fafc',
  flexShrink: 0
};

const injectedStyles = `
  input[type="number"]:hover, input[type="text"]:hover {
    background-color: rgba(0,0,0,0.03);
  }
  input[type="number"]:focus, input[type="text"]:focus {
    background-color: #fff !important;
    border: 1px solid #3b82f6 !important;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
  }
  input[type="number"]::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
`;
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.innerHTML = injectedStyles;
  document.head.appendChild(style);
}
