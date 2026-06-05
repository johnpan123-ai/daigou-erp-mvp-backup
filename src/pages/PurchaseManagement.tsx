import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getBaseSku, calculateFinalMyacgDemand } from '../lib/db';
import { dataProvider } from '../providers/dataProvider';
import type { 
  ProductGroup, ProductVariant, InventoryItem, ProductCategory,
  PurchaseBatch, PurchaseBatchItem, PrivateOrder, PrivateOrderItem 
} from '../lib/db';
import { ChevronRight, ChevronDown, Plus, X, ArrowLeft, Search, AlertTriangle, Package, CheckSquare, RefreshCw, DollarSign } from 'lucide-react';
import PurchaseBatchTab from '../components/PurchaseBatchTab';
import PrivateOrderTab from '../components/PrivateOrderTab';
import { useViewport } from '../contexts/ViewportContext';


const HighlightText = ({ text, highlight }: { text: string | undefined | null; highlight: string }) => {
  if (!text) return null;
  if (!highlight.trim()) return <>{text}</>;
  const parts = text.split(new RegExp(`(${highlight})`, 'gi'));
  return (
    <>
      {parts.map((part, i) => 
        part.toLowerCase() === highlight.toLowerCase() ? (
          <span key={i} style={{ backgroundColor: '#fef08a', padding: '0 2px', borderRadius: '2px', color: '#854d0e' }}>{part}</span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
};

const renderStatusBadge = (needToBuy: number, excessBuy: number, totalDemand: number) => {
  if (needToBuy > 0) {
    return (
      <span style={{
        backgroundColor: '#FEE2E2',
        color: '#DC2626',
        border: '1px solid #fecaca',
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        fontWeight: 600,
        display: 'inline-block'
      }}>
        待採購 {needToBuy}
      </span>
    );
  }
  if (excessBuy > 0) {
    return (
      <span style={{
        backgroundColor: '#fff7ed',
        color: '#c2410c',
        border: '1px solid #ffedd5',
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        fontWeight: 600,
        display: 'inline-block'
      }}>
        多買 {excessBuy}
      </span>
    );
  }
  if (totalDemand === 0) {
    return (
      <span style={{
        backgroundColor: '#EFF6FF',
        color: '#2563EB',
        border: '1px solid #dbeafe',
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        fontWeight: 600,
        display: 'inline-block'
      }}>
        無需求
      </span>
    );
  }
  return (
    <span style={{
      backgroundColor: '#f0fdf4',
      color: '#166534',
      border: '1px solid #dcfce7',
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '12px',
      fontWeight: 600,
      display: 'inline-block'
    }}>
      完成
    </span>
  );
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

export default function PurchaseManagement() {
  const { isMobile } = useViewport();

  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const getVariantDemands = (v: ProductVariant) => {
    const inventoryList = Array.from(inventoryMap.values());
    
    // 買動漫數量
    const rawMyacgQty = calculateFinalMyacgDemand(v.myacg_item_code, inventoryList, salesOrderItems);
    const localMyacg = (rawMyacgQty >= 0 ? rawMyacgQty : 0) + (v.myacg_manual_adjustment ?? 0);
    const autoMyacg = (v.myacg_auto_quantity !== null && v.myacg_auto_quantity !== undefined && v.myacg_auto_quantity >= 0)
      ? v.myacg_auto_quantity + (v.myacg_manual_adjustment ?? 0)
      : null;
    const rawMyacg = (v.effective_myacg_quantity !== null && v.effective_myacg_quantity !== undefined && v.effective_myacg_quantity >= 0)
      ? v.effective_myacg_quantity
      : (autoMyacg ?? (v as any).myacg_quantity ?? localMyacg);
    const myacgDemand = rawMyacg >= 0 ? rawMyacg : 0;

    // WACA 數量
    const localWaca = (v.waca_auto_quantity ?? 0) + (v.waca_manual_adjustment ?? 0);
    const autoWaca = (v.waca_auto_quantity !== null && v.waca_auto_quantity !== undefined && v.waca_auto_quantity >= 0)
      ? v.waca_auto_quantity + (v.waca_manual_adjustment ?? 0)
      : null;
    const rawWaca = autoWaca ?? (v as any).waca_quantity ?? localWaca;
    const wacaDemand = rawWaca >= 0 ? rawWaca : 0;

    // 私下數量
    const privateDemand = privateOrderItems
      .filter(poi => poi.product_variant_id === v.id)
      .reduce((sum, item) => sum + Number(item.quantity || 0), 0);

    // 已採購 / 已下單數量
    const purchased = purchaseBatchItems
      .filter(pbi => pbi.product_variant_id === v.id)
      .reduce((sum, item) => sum + Number(item.quantity || 0), 0);

    const totalDemand = myacgDemand + wacaDemand + privateDemand;
    const gap = totalDemand - purchased;

    return { myacgDemand, wacaDemand, privateDemand, totalDemand, purchased, gap };
  };

  const [editMode, setEditMode] = useState<boolean>(() => {
    return localStorage.getItem('purchase_management_edit_mode') === 'true';
  });
  const [canWrite, setCanWrite] = useState<boolean>(false);

  const getVariantDefaultJpyCost = (v: ProductVariant): number | undefined | null => {
    return (v.default_jpy_cost !== undefined && v.default_jpy_cost !== null) 
      ? v.default_jpy_cost 
      : variantDefaultJpyCosts[v.id];
  };

  const getVariantDefaultTwdCost = (v: ProductVariant): number | undefined | null => {
    return (v.default_twd_cost !== undefined && v.default_twd_cost !== null) 
      ? v.default_twd_cost 
      : variantDefaultTwdCosts[v.id];
  };
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [exchangeRate, setExchangeRate] = useState<number>(() => {
    const val = localStorage.getItem('erp_exchange_rate');
    return val ? parseFloat(val) : 0.23;
  });

  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => {
        setToastMessage(null);
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  const toggleEditMode = () => {
    const nextVal = !editMode;
    setEditMode(nextVal);
    localStorage.setItem('purchase_management_edit_mode', String(nextVal));
    setToastMessage(nextVal ? '已進入編輯模式，可修改數量' : '已鎖定數量欄位，避免誤觸');
  };

  const [group, setGroup] = useState<ProductGroup | null>(null);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [inventoryMap, setInventoryMap] = useState<Map<string, InventoryItem>>(new Map());
  const [categoryMap, setCategoryMap] = useState<Map<string, ProductCategory>>(new Map());

  const [variantDefaultJpyCosts, setVariantDefaultJpyCosts] = useState<Record<string, number>>(() => {
    try {
      const stored = localStorage.getItem('variant_default_jpy_costs');
      return stored ? JSON.parse(stored) : {};
    } catch (e) {
      return {};
    }
  });

  const handleUpdateDefaultJpyCost = async (variantId: string, valStr: string) => {
    if (!canWrite) return;
    const val = valStr === '' ? null : parseInt(valStr);
    
    // Log price update
    console.log(`[Default Cost Sync] update variant: id=${variantId}, jpy=${val}, twd=N/A`);

    const updated = { ...variantDefaultJpyCosts };
    if (val === null || isNaN(val) || val <= 0) {
      delete updated[variantId];
    } else {
      updated[variantId] = val;
    }
    setVariantDefaultJpyCosts(updated);
    localStorage.setItem('variant_default_jpy_costs', JSON.stringify(updated));

    const allVars = await dataProvider.getProductVariants();
    const target = allVars.find(v => v.id === variantId);
    if (target) {
      const updatedVars = allVars.map(v => 
        v.id === variantId 
          ? { ...v, default_jpy_cost: val } 
          : v
      );
      if (updatedVars.length > 0) {
        await dataProvider.saveProductVariants(updatedVars);
      }
      setVariants(variants.map(v => v.id === variantId ? { ...v, default_jpy_cost: val } : v));
    }
  };

  const [variantDefaultTwdCosts, setVariantDefaultTwdCosts] = useState<Record<string, number>>(() => {
    try {
      const stored = localStorage.getItem('variant_default_twd_costs');
      return stored ? JSON.parse(stored) : {};
    } catch (e) {
      return {};
    }
  });

  const handleUpdateDefaultTwdCost = async (variantId: string, valStr: string) => {
    if (!canWrite) return;
    const val = valStr === '' ? null : parseInt(valStr);

    // Log price update
    console.log(`[Default Cost Sync] update variant: id=${variantId}, jpy=N/A, twd=${val}`);

    const updated = { ...variantDefaultTwdCosts };
    if (val === null || isNaN(val) || val <= 0) {
      delete updated[variantId];
    } else {
      updated[variantId] = val;
    }
    setVariantDefaultTwdCosts(updated);
    localStorage.setItem('variant_default_twd_costs', JSON.stringify(updated));

    const allVars = await dataProvider.getProductVariants();
    const target = allVars.find(v => v.id === variantId);
    if (target) {
      const updatedVars = allVars.map(v => 
        v.id === variantId 
          ? { ...v, default_twd_cost: val } 
          : v
      );
      if (updatedVars.length > 0) {
        await dataProvider.saveProductVariants(updatedVars);
      }
      setVariants(variants.map(v => v.id === variantId ? { ...v, default_twd_cost: val } : v));
    }
  };

  const cleanDailiTitle = (title: string): string => {
    if (!title) return '';
    let res = title;
    const keywords = [
      '【小河馬日本代購】',
      '【小河馬代購】',
      '小河馬日本代購',
      '小河馬代購',
      '預購',
      '現貨',
      '日本代購',
      '現地代購',
      '代理版',
      '代理',
      '日版',
      '再版',
      '預約'
    ];
    keywords.forEach(kw => {
      res = res.replaceAll(kw, '');
    });
    res = res.replace(/\d{2,4}年\d{1,2}月/g, '');
    res = res.replace(/\s+/g, ' ').trim();
    return res;
  };

  const getDisplayProductName = (v: ProductVariant): string => {
    const variantName = (v.variant_name || '').trim();
    const productTitle = group?.title || '';
    const isDaili = group?.listing_type === '代理版';
    
    if (isDaili) {
      // 1. variant_name (unless blank, null, undefined, 單品, 一箱)
      if (variantName && variantName !== '單品' && variantName !== '一箱') {
        return variantName;
      }
      // 2. cleanDailiTitle(product_title)
      const cleaned = cleanDailiTitle(productTitle);
      if (cleaned) {
        return cleaned;
      }
      // 3. product_title
      if (productTitle) {
        return productTitle;
      }
      // 4. group.title
      if (group?.title) {
        return group.title;
      }
      // 5. SKU
      return v.myacg_item_code || '未命名規格';
    } else {
      // Standard Product (Category - Variant)
      if (v.product_category_id) {
        const cat = categoryMap.get(v.product_category_id);
        if (cat && cat.title && cat.title !== '單品') {
          return `${cat.title} - ${variantName || '單品'}`;
        }
      }
      if (variantName) {
        return variantName;
      }
      if (productTitle) {
        return productTitle;
      }
      return v.myacg_item_code || '未命名規格';
    }
  };
  
  // Data for calculation
  const [salesOrderItems, setSalesOrderItems] = useState<any[]>([]);
  
  const [searchTerm, setSearchTerm] = useState('');
  const [manualExpandedGroups, setManualExpandedGroups] = useState<Set<string>>(new Set());


  const toggleManualGroup = (title: string) => {
    const newSet = new Set(manualExpandedGroups);
    if (newSet.has(title)) newSet.delete(title);
    else newSet.add(title);
    setManualExpandedGroups(newSet);
  };

  const [filterMode, setFilterMode] = useState<'all' | 'abnormal'>('all');

  const [sortMode, setSortMode] = useState<'catalog' | 'shortage'>('catalog');

  const [privateOrders, setPrivateOrders] = useState<PrivateOrder[]>([]);
  const [privateOrderItems, setPrivateOrderItems] = useState<PrivateOrderItem[]>([]);
  const [purchaseBatches, setPurchaseBatches] = useState<PurchaseBatch[]>([]);
  const [purchaseBatchItems, setPurchaseBatchItems] = useState<PurchaseBatchItem[]>([]);
  
  // UI States
  const [activeTab, setActiveTab] = useState<'worksheet' | 'purchase_batches' | 'private_orders'>('worksheet');

  const [showPrivateOrderModal, setShowPrivateOrderModal] = useState(false);
  const [editingPoId, setEditingPoId] = useState<string | null>(null);
  const [poForm, setPoForm] = useState({ customer_name: '', contact: '', note: '' });
  const [poLines, setPoLines] = useState<{ variant_id: string, quantity: number, amount: number, note: string }[]>([]);

  // Modal: Purchase Batch
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [onlyShowShortage, setOnlyShowShortage] = useState(false);
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [batchForm, setBatchForm] = useState({ name: '', date: '', note: '' });
  const [batchLines, setBatchLines] = useState<{ variant_id: string, quantity: number, cost: number, note: string }[]>([]);

  useEffect(() => {
    loadData();
  }, [id]);


  const loadData = async () => {
    if (!id) return;
    const allGroups = await dataProvider.getProductGroups();
    const g = allGroups.find(x => x.id === id);
    if (!g) {
      navigate('/purchase-records');
      return;
    }
    setGroup(g);

    const allVars = await dataProvider.getProductVariants();
    const allCats = await dataProvider.getProductCategories();
    const catMap = new Map(allCats.map(c => [c.id, c]));
    setCategoryMap(catMap);

    const groupCatIds = new Set(allCats.filter(c => c.product_group_id === id).map(c => c.id));
    const groupVars = allVars.filter(v => v.product_group_id === id || (v.product_category_id && groupCatIds.has(v.product_category_id)));
    
    // Sort groupVars to match display order in worksheet (purely natural SKU order)
    groupVars.sort((a, b) => {
      return (a.myacg_item_code || '').localeCompare(b.myacg_item_code || '', undefined, { numeric: true, sensitivity: 'base' });
    });

    const writePermission = await dataProvider.canWriteCloud();
    setCanWrite(writePermission);

    // Sync legacy costs to variants and update cost state maps
    const jpyCosts = { ...variantDefaultJpyCosts };
    const twdCosts = { ...variantDefaultTwdCosts };
    let needsSync = false;

    const updatedGroupVars = groupVars.map(v => {
      let updatedJpy = v.default_jpy_cost;
      let updatedTwd = v.default_twd_cost;
      let variantChanged = false;

      // Hydrate local state if variant has database cost
      if (v.default_jpy_cost !== undefined && v.default_jpy_cost !== null) {
        jpyCosts[v.id] = v.default_jpy_cost;
      } else {
        // Fallback to local storage cost if database column is null/empty
        const localJpy = jpyCosts[v.id];
        if (localJpy !== undefined && localJpy !== null) {
          updatedJpy = localJpy;
          variantChanged = true;
        }
      }

      if (v.default_twd_cost !== undefined && v.default_twd_cost !== null) {
        twdCosts[v.id] = v.default_twd_cost;
      } else {
        const localTwd = twdCosts[v.id];
        if (localTwd !== undefined && localTwd !== null) {
          updatedTwd = localTwd;
          variantChanged = true;
        }
      }

      if (variantChanged) {
        needsSync = true;
        return {
          ...v,
          default_jpy_cost: updatedJpy,
          default_twd_cost: updatedTwd
        };
      }
      return v;
    });

    setVariantDefaultJpyCosts(jpyCosts);
    setVariantDefaultTwdCosts(twdCosts);
    localStorage.setItem('variant_default_jpy_costs', JSON.stringify(jpyCosts));
    localStorage.setItem('variant_default_twd_costs', JSON.stringify(twdCosts));

    if (needsSync && writePermission) {
      console.log('[Default Cost Sync] Migrating legacy local storage costs to cloud...');
      if (allVars && allVars.length > 0) {
        const updatedAllVars = allVars.map(av => {
          const match = updatedGroupVars.find(gv => gv.id === av.id);
          if (match && (match.default_jpy_cost !== av.default_jpy_cost || match.default_twd_cost !== av.default_twd_cost)) {
            return {
              ...av,
              default_jpy_cost: match.default_jpy_cost,
              default_twd_cost: match.default_twd_cost
            };
          }
          return av;
        });
        await dataProvider.saveProductVariants(updatedAllVars);
      }
    }

    setVariants(updatedGroupVars);

    const inventory = await dataProvider.getInventory();
    const invMap = new Map(inventory.map(i => [i.myacg_item_code, i]));
    setInventoryMap(invMap);

    // Fetch new architecture data
    const allPrivateOrders = await dataProvider.getPrivateOrders();
    const allPrivateOrderItems = await dataProvider.getPrivateOrderItems();
    const groupPrivateOrders = allPrivateOrders.filter(po => po.product_group_id === id);
    const groupPoIds = new Set(groupPrivateOrders.map(po => po.id));
    const groupPrivateOrderItems = allPrivateOrderItems.filter(poi => groupPoIds.has(poi.private_order_id));
    
    setPrivateOrders(groupPrivateOrders);
    setPrivateOrderItems(groupPrivateOrderItems);

    const allBatches = await dataProvider.getPurchaseBatches();
    const allBatchItems = await dataProvider.getPurchaseBatchItems();
    const groupBatches = allBatches.filter(b => b.product_group_id === id);
    const groupBatchIds = new Set(groupBatches.map(b => b.id));
    const groupBatchItems = allBatchItems.filter(bi => groupBatchIds.has(bi.purchase_batch_id));

    
    setPurchaseBatches(groupBatches);
    setPurchaseBatchItems(groupBatchItems);

    const allSOI = await dataProvider.getSalesOrderItems();
    const groupSOI = allSOI.filter(i => {
      const iCode = i.myacg_item_code;
      return groupVars.some(v => 
        v.myacg_item_code === iCode || 
        (getBaseSku(v.myacg_item_code) === getBaseSku(iCode) && 
         (v.myacg_item_code === getBaseSku(v.myacg_item_code) || iCode === getBaseSku(iCode)))
      );
    });

    setSalesOrderItems(groupSOI);
  };


  const handleUpdatePlatformDemand = async (vId: string, platform: 'myacg' | 'waca', totalValue: number) => {
    if (isNaN(totalValue) || totalValue < 0) totalValue = 0;
    const allVars = await dataProvider.getProductVariants();
    const target = allVars.find(v => v.id === vId);
    if (target) {
      if (platform === 'myacg') {
        const myacgQty = calculateFinalMyacgDemand(target.myacg_item_code, Array.from(inventoryMap.values()), salesOrderItems);
        const rawAuto = (target.effective_myacg_quantity !== null && target.effective_myacg_quantity !== undefined && target.effective_myacg_quantity >= 0)
          ? target.effective_myacg_quantity
          : ((target.myacg_auto_quantity !== null && target.myacg_auto_quantity !== undefined && target.myacg_auto_quantity >= 0)
            ? target.myacg_auto_quantity
            : (myacgQty >= 0 ? myacgQty : 0));
        const auto = rawAuto >= 0 ? rawAuto : 0;
        target.myacg_manual_adjustment = totalValue - auto;
      } else {
        const auto = (target.waca_auto_quantity !== null && target.waca_auto_quantity !== undefined && target.waca_auto_quantity >= 0)
          ? target.waca_auto_quantity
          : 0;
        target.waca_manual_adjustment = totalValue - auto;
      }
      await dataProvider.saveProductVariants(allVars);
      setVariants(variants.map(v => v.id === vId ? target : v));
    }
  };

  // --- Modal Logic: Private Order ---
  const openPrivateOrderModal = () => {
    setEditingPoId(null);
    setPoForm({ customer_name: '', contact: '', note: '' });
    setPoLines(variants.map(v => ({ variant_id: v.id, quantity: 0, amount: 0, note: '' })));
    setShowPrivateOrderModal(true);
  };

  const handleEditOrder = (order: PrivateOrder) => {
    setEditingPoId(order.id);
    setPoForm({ customer_name: order.customer_name, contact: order.contact || '', note: order.note || '' });
    setPoLines(variants.map(v => {
      const existing = privateOrderItems.find(i => i.product_variant_id === v.id && i.private_order_id === order.id);
      return {
        variant_id: v.id,
        quantity: existing ? existing.quantity : 0,
        amount: existing ? existing.amount : 0,
        note: existing?.note || ''
      };
    }));
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
    
    const allPOs = await dataProvider.getPrivateOrders();
    const allPOItems = await dataProvider.getPrivateOrderItems();

    if (editingPoId) {
      const idx = allPOs.findIndex(o => o.id === editingPoId);
      if (idx !== -1) {
        allPOs[idx] = { ...allPOs[idx], customer_name: poForm.customer_name, contact: poForm.contact, note: poForm.note };
      }
      const newPOItems = allPOItems.filter(i => i.private_order_id !== editingPoId);
      const updatedItems: PrivateOrderItem[] = validLines.map(line => ({
        id: crypto.randomUUID(),
        private_order_id: editingPoId,
        product_variant_id: line.variant_id,
        quantity: line.quantity,
        amount: line.amount,
        note: line.note
      }));
      await dataProvider.savePrivateOrders(allPOs);
      await dataProvider.savePrivateOrderItems([...newPOItems, ...updatedItems]);
    } else {
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
      
      await dataProvider.savePrivateOrders([...allPOs, newPo]);
      await dataProvider.savePrivateOrderItems([...allPOItems, ...newItems]);
    }
    
    setShowPrivateOrderModal(false);
    await loadData();
  };

  // --- Modal Logic: Purchase Batch ---
  const openBatchModal = () => {
    setEditingBatchId(null);
    setOnlyShowShortage(false);
    setBatchForm({ name: '', date: new Date().toISOString().slice(0, 10), note: '' });
    
    const isDaili = group?.listing_type === '代理版';
    setBatchLines(variants.map(v => {
      const defCost = isDaili ? getVariantDefaultTwdCost(v) : getVariantDefaultJpyCost(v);
      const latCost = getLatestBatchCost(v.id);
      const initialCost = (defCost !== undefined && defCost !== null) ? defCost : (latCost || 0);
      return { variant_id: v.id, quantity: 0, cost: initialCost, note: '' };
    }));
    setShowBatchModal(true);
  };

  const handleEditBatch = (batch: PurchaseBatch) => {
    setEditingBatchId(batch.id);
    setOnlyShowShortage(false);
    setBatchForm({ name: batch.name, date: batch.date, note: batch.note || '' });
    setBatchLines(variants.map(v => {
      const existing = purchaseBatchItems.find(i => i.product_variant_id === v.id && i.purchase_batch_id === batch.id);
      return {
        variant_id: v.id,
        quantity: existing ? existing.quantity : 0,
        cost: existing ? existing.cost : 0,
        note: existing?.note || ''
      };
    }));
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
    
    const allBatches = await dataProvider.getPurchaseBatches();
    const allBatchItems = await dataProvider.getPurchaseBatchItems();

    if (editingBatchId) {
      const idx = allBatches.findIndex(b => b.id === editingBatchId);
      if (idx !== -1) {
        allBatches[idx] = { ...allBatches[idx], name: batchForm.name, date: batchForm.date, note: batchForm.note };
      }
      const newItems = allBatchItems.filter(i => i.purchase_batch_id !== editingBatchId);
      const updatedItems: PurchaseBatchItem[] = validLines.map(line => ({
        id: crypto.randomUUID(),
        purchase_batch_id: editingBatchId,
        product_variant_id: line.variant_id,
        quantity: line.quantity,
        cost: line.cost,
        note: line.note
      }));
      await dataProvider.savePurchaseBatches(allBatches);
      await dataProvider.savePurchaseBatchItems([...newItems, ...updatedItems]);
    } else {
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

      await dataProvider.savePurchaseBatches([...allBatches, newBatch]);
      await dataProvider.savePurchaseBatchItems([...allBatchItems, ...newItems]);
    }
    
    setShowBatchModal(false);
    await loadData();
  };







  const getVariantShortageForModal = (v: ProductVariant) => {
    const { totalDemand } = getVariantDemands(v);
    const purchased = purchaseBatchItems
      .filter(pbi => pbi.product_variant_id === v.id && pbi.purchase_batch_id !== editingBatchId)
      .reduce((sum, item) => sum + item.quantity, 0);

    return totalDemand - purchased;
  };

  if (!group) return <div className="p-xl text-center text-muted">載入中...</div>;

  // Grouping Variants by Category or Single Item
  // KPI Calculations
  let totalShortage = 0;
  let totalExcess = 0;
  let totalPurchased = 0;
  let totalDemand = 0;
  let jpyNeedToBuy = 0;
  let jpyPurchased = 0;

  // Daili specific metric variables
  let dailiTotalOrderAmount = 0;
  let dailiNeedToBuyCost = 0;
  let dailiPurchasedCost = 0;

  const isDaili = group?.listing_type === '代理版';

  const batchMap = new Map(purchaseBatches.map(b => [b.id, b]));

  const getLatestBatchCost = (variantId: string): number | null => {
    const items = purchaseBatchItems.filter(item => item.product_variant_id === variantId && item.cost > 0);
    if (items.length === 0) return null;
    
    items.sort((a, b) => {
      const batchA = batchMap.get(a.purchase_batch_id);
      const batchB = batchMap.get(b.purchase_batch_id);
      if (!batchA || !batchB) return 0;
      const dateCompare = (batchA.date || '').localeCompare(batchB.date || '');
      if (dateCompare !== 0) return dateCompare;
      return (batchA.created_at || '').localeCompare(batchB.created_at || '');
    });
    
    return items[items.length - 1].cost;
  };

  variants.forEach(v => {
    const { totalDemand: vTotalDemand, purchased: vPurchased } = getVariantDemands(v);
    const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
    totalDemand += vTotalDemand;
    totalPurchased += vPurchased;
    
    const needToBuy = Math.max(vTotalDemand - vPurchased, 0);
    const excessBuy = Math.max(vPurchased - vTotalDemand, 0);

    totalShortage += needToBuy;
    totalExcess += excessBuy;

    // JPY Standard
    const defaultCost = getVariantDefaultJpyCost(v);
    const latestCost = getLatestBatchCost(v.id);
    const activeCost = (defaultCost !== undefined && defaultCost !== null) ? defaultCost : (latestCost || 0);
    jpyNeedToBuy += needToBuy * activeCost;
    jpyPurchased += vBatchItems.reduce((sum, item) => sum + (item.quantity * (item.cost || 0)), 0);

    // Daili TWD
    const invItem = inventoryMap.get(v.myacg_item_code);
    const finalPrice = invItem?.final_price ?? 0;
    dailiTotalOrderAmount += vTotalDemand * finalPrice;

    const defaultTwdCost = getVariantDefaultTwdCost(v);
    const latestTwdCost = getLatestBatchCost(v.id);
    const activeTwdCost = (defaultTwdCost !== undefined && defaultTwdCost !== null) ? defaultTwdCost : (latestTwdCost || 0);
    dailiNeedToBuyCost += needToBuy * activeTwdCost;
    dailiPurchasedCost += vBatchItems.reduce((sum, item) => sum + (item.quantity * (item.cost || 0)), 0);
  });

  const jpyTotalDemand = jpyNeedToBuy + jpyPurchased;
  const estimatedTwd = jpyTotalDemand * exchangeRate;

  const dailiTotalCost = dailiNeedToBuyCost + dailiPurchasedCost;
  const dailiGrossProfit = dailiTotalOrderAmount - dailiTotalCost;



  let totalOrdersAmount = 0;
  salesOrderItems.forEach(i => {
    if (i.order_status !== '已取消' && i.order_status !== 'CANCELED') {
      if (typeof i.amount === 'number') {
        totalOrdersAmount += i.amount;
      } else {
        totalOrdersAmount += (i.quantity * (i.price || 0));
      }
    }
  });



  const compareNatural = (a: string, b: string) => {
    return (a || '').localeCompare(b || '', undefined, { numeric: true, sensitivity: 'base' });
  };

  interface ParsedVariant {
    categoryTitle: string | null;
    variantDisplayName: string;
  }

  const parseVariantFallback = (v: ProductVariant, categoryMap: Map<string, ProductCategory>): ParsedVariant => {
    // Rule 1: product_category_id exists
    if (v.product_category_id) {
      const cat = categoryMap.get(v.product_category_id);
      if (cat) {
        return {
          categoryTitle: cat.title,
          variantDisplayName: v.variant_name
        };
      }
    }

    // Rule 2: parse from variant_name or raw_variant_name
    const name = (v.variant_name || v.raw_variant_name || '').trim();
    
    // Check pattern "分類名稱 - 分類名稱 角色名" or "分類名稱 - 角色名"
    if (name.includes(' - ')) {
      const parts = name.split(' - ');
      const prefix = parts[0].trim();
      let rest = parts.slice(1).join(' - ').trim();
      if (rest.startsWith(prefix)) {
        let sub = rest.slice(prefix.length).trim();
        // Remove any leading dash/separator
        if (sub.startsWith('-') || sub.startsWith('_') || sub.startsWith('—')) {
          sub = sub.slice(1).trim();
        }
        return {
          categoryTitle: prefix,
          variantDisplayName: sub || rest
        };
      }
      return {
        categoryTitle: prefix,
        variantDisplayName: rest
      };
    }

    // Check pattern with whitespace: "分類名稱 角色名"
    const whitespaceRegex = /\s+/;
    if (whitespaceRegex.test(name)) {
      const parts = name.split(whitespaceRegex);
      const prefix = parts[0].trim();
      const rest = parts.slice(1).join(' ').trim();
      if (prefix && rest) {
        return {
          categoryTitle: prefix,
          variantDisplayName: rest
        };
      }
    }

    // Fallback: no category parsed
    return {
      categoryTitle: null,
      variantDisplayName: name
    };
  };

  // Pre-parse variants locally for UI fallback grouping
  const parsedVariantsMap = new Map<string, ParsedVariant>();
  variants.forEach(v => {
    parsedVariantsMap.set(v.id, parseVariantFallback(v, categoryMap));
  });

  const categoryCountMap = new Map<string, number>();
  variants.forEach(v => {
    const parsed = parsedVariantsMap.get(v.id);
    if (parsed && parsed.categoryTitle) {
      categoryCountMap.set(parsed.categoryTitle, (categoryCountMap.get(parsed.categoryTitle) || 0) + 1);
    }
  });

  const groupedVariants: Record<string, ProductVariant[]> = {};
  variants.forEach(v => {
    const parsed = parsedVariantsMap.get(v.id);
    let groupKey = '';
    // ProductCategory/parsed category exists and has variants count > 1 globally
    if (parsed && parsed.categoryTitle && (categoryCountMap.get(parsed.categoryTitle) || 0) > 1) {
      groupKey = `category:${parsed.categoryTitle}`;
    } else {
      groupKey = `__single__${v.id}`;
    }
    
    if (!groupedVariants[groupKey]) groupedVariants[groupKey] = [];
    groupedVariants[groupKey].push(v);
  });

  Object.values(groupedVariants).forEach(groupItems => {
    groupItems.sort((a, b) => compareNatural(a.myacg_item_code, b.myacg_item_code));
  });

  const getGroupSortOrder = (_key: string, items: ProductVariant[]) => {
    const itemSorts = items
      .map(v => Number(v.sort_order ?? (v as any).import_sort_index ?? 9999))
      .filter(n => Number.isFinite(n));

    if (itemSorts.length > 0) {
      return Math.min(...itemSorts);
    }

    return 999999;
  };

  const getGroupMinSku = (items: ProductVariant[]) => {
    return items
      .map(v => v.myacg_item_code || '')
      .filter(Boolean)
      .sort(compareNatural)[0] || '';
  };

  // Debug table logging
  const debugInfo = Object.entries(groupedVariants).map(([key, items]) => {
    const isCat = key.startsWith('category:');
    const title = isCat ? key.slice('category:'.length) : (items[0]?.raw_variant_name || items[0]?.variant_name || '');
    return {
      key,
      title,
      minSku: getGroupMinSku(items),
      sortOrder: getGroupSortOrder(key, items),
      isCategory: isCat,
      itemCount: items.length
    };
  });
  console.table(debugInfo);

  let sortedGroupEntries = Object.entries(groupedVariants).sort(([, itemsA], [, itemsB]) => {
    const skuA = getGroupMinSku(itemsA);
    const skuB = getGroupMinSku(itemsB);
    return compareNatural(skuA, skuB);
  });

  if (sortMode === 'shortage') {
    sortedGroupEntries = sortedGroupEntries.sort(([, itemsA], [, itemsB]) => {
      const getShortage = (items: ProductVariant[]) => items.reduce((sum, v) => {
        const { totalDemand, purchased } = getVariantDemands(v);
        return sum + Math.max(totalDemand - purchased, 0);
      }, 0);
      return getShortage(itemsB) - getShortage(itemsA);
    });
  }

  const costSample = variants.find(v => (v.default_jpy_cost !== undefined && v.default_jpy_cost !== null) || (v.default_twd_cost !== undefined && v.default_twd_cost !== null)) || variants[0];
  console.log('[Default Cost Sync] UI render sample:', costSample ? { id: costSample.id, default_jpy_cost: costSample.default_jpy_cost, default_twd_cost: costSample.default_twd_cost } : 'empty');

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
          <span className="text-primary font-medium">{isDaili ? cleanDailiTitle(group.title) : group.title}</span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#111827', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isDaili ? cleanDailiTitle(group.normalized_title || group.title) : (group.normalized_title || group.title)}
            {group.listing_type && (
              <span style={{ backgroundColor: '#e2e8f0', color: '#475569', fontSize: '12px', padding: '2px 8px', borderRadius: '4px', fontWeight: 500 }}>
                {group.listing_type}
              </span>
            )}
          </h1>
        </div>
      </div>

      <div style={{ padding: '24px', paddingBottom: isMobile ? '80px' : '24px', flex: 1, display: 'flex', flexDirection: 'column', maxWidth: '1600px', margin: '0 auto', width: '100%' }}>
        
        {/* Top Summary Cards */}
        {activeTab === 'worksheet' && (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: '16px', marginBottom: '24px' }}>
            
            {/* Total Shortage */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>總缺貨數</div>
                <AlertTriangle size={20} color="#ef4444" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: isMobile ? '22px' : '28px', fontWeight: 700, color: '#ef4444' }}>{totalShortage}</span>
                <span style={{ fontSize: '13px', color: '#64748b' }}>件</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>需採購補齊</div>
            </div>

            {/* Total Excess */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>總多買數</div>
                <RefreshCw size={20} color="#f97316" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: isMobile ? '22px' : '28px', fontWeight: 700, color: '#f97316' }}>{totalExcess}</span>
                <span style={{ fontSize: '13px', color: '#64748b' }}>件</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>數量過多</div>
            </div>

            {/* Total Demand */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>總需求數</div>
                <Package size={20} color="#64748b" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: isMobile ? '22px' : '28px', fontWeight: 700, color: '#1e293b' }}>{totalDemand}</span>
                <span style={{ fontSize: '13px', color: '#64748b' }}>件</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>所有需求加總</div>
            </div>

            {/* Total Amount (Orders NTD) */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>訂單總金額</div>
                <DollarSign size={20} color="#10b981" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: isMobile ? '20px' : '28px', fontWeight: 700, color: '#1e293b' }}>{(isDaili ? dailiTotalOrderAmount : totalOrdersAmount).toLocaleString()}</span>
                <span style={{ fontSize: '13px', color: '#64748b' }}>NT$</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '總需求數量 × 買動漫售價' : '訂單商品總額'}</div>
            </div>

            {isDaili ? (
              <>
                {/* 待採購成本 */}
                <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>待採購成本</div>
                    <DollarSign size={20} color="#ef4444" />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                    <span style={{ fontSize: isMobile ? '18px' : '28px', fontWeight: 700, color: '#ef4444' }}>NT$ {dailiNeedToBuyCost.toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>缺少數量 × 台幣成本</div>
                </div>

                {/* 已採購成本 */}
                <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>已採購成本</div>
                    <CheckSquare size={20} color="#2563eb" />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                    <span style={{ fontSize: isMobile ? '18px' : '28px', fontWeight: 700, color: '#2563eb' }}>NT$ {dailiPurchasedCost.toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>採購批次已付台幣成本</div>
                </div>

                {/* 總成本 */}
                <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>總成本</div>
                    <Package size={20} color="#16a34a" />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                    <span style={{ fontSize: isMobile ? '18px' : '28px', fontWeight: 700, color: '#16a34a' }}>NT$ {dailiTotalCost.toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>待採購成本 + 已採購成本</div>
                </div>

                {/* 預估毛利 */}
                <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>預估毛利</div>
                    <DollarSign size={20} color="#ca8a04" />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                    <span style={{ fontSize: isMobile ? '18px' : '28px', fontWeight: 700, color: '#ca8a04' }}>NT$ {dailiGrossProfit.toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>訂單總金額 - 總成本</div>
                </div>
              </>
            ) : (
              <>
                {/* 1. 待採購日幣 */}
                <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>待採購日幣</div>
                    <DollarSign size={20} color="#ef4444" />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                    <span style={{ fontSize: '28px', fontWeight: 700, color: '#ef4444' }}>¥ {jpyNeedToBuy.toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>目前還要花多少日幣</div>
                </div>

                {/* 2. 已採購日幣 */}
                <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>已採購日幣</div>
                    <CheckSquare size={20} color="#2563eb" />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                    <span style={{ fontSize: '28px', fontWeight: 700, color: '#2563eb' }}>¥ {jpyPurchased.toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>目前已花掉多少日幣</div>
                </div>

                {/* 3. 總需求日幣 */}
                <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>總需求日幣</div>
                    <Package size={20} color="#16a34a" />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                    <span style={{ fontSize: '28px', fontWeight: 700, color: '#16a34a' }}>¥ {jpyTotalDemand.toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>整批商品總成本(日幣)</div>
                </div>

                {/* 4. 預估台幣 */}
                <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>預估台幣</div>
                    <DollarSign size={20} color="#ca8a04" />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                    <span style={{ fontSize: '28px', fontWeight: 700, color: '#ca8a04' }}>NTD {Math.round(estimatedTwd).toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>總需求日幣 × 匯率 {exchangeRate}</div>
                </div>
              </>
            )}

          </div>
        )}

        {/* Tab Header */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          marginBottom: '16px', 
          width: '100%', 
          maxWidth: '100%',
          overflowX: 'auto', 
          WebkitOverflowScrolling: 'touch'
        }}>
          <div style={{ 
            display: 'flex', 
            backgroundColor: '#e2e8f0', 
            padding: '4px', 
            borderRadius: '8px', 
            marginRight: 'auto',
            width: 'max-content',
            flexShrink: 0
          }}>
            <div 
              style={{ 
                padding: '8px 16px', 
                cursor: 'pointer', 
                fontWeight: 600, 
                fontSize: '14px', 
                borderRadius: '6px', 
                color: activeTab === 'worksheet' ? '#1e293b' : '#64748b', 
                backgroundColor: activeTab === 'worksheet' ? '#fff' : 'transparent', 
                boxShadow: activeTab === 'worksheet' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none', 
                whiteSpace: 'nowrap',
                flex: '0 0 auto'
              }}
              onClick={() => setActiveTab('worksheet')}
            >代購工作規格表</div>
            <div 
              style={{ 
                padding: '8px 16px', 
                cursor: 'pointer', 
                fontWeight: 600, 
                fontSize: '14px', 
                borderRadius: '6px', 
                color: activeTab === 'purchase_batches' ? '#1e293b' : '#64748b', 
                backgroundColor: activeTab === 'purchase_batches' ? '#fff' : 'transparent', 
                boxShadow: activeTab === 'purchase_batches' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none', 
                whiteSpace: 'nowrap',
                flex: '0 0 auto'
              }}
              onClick={() => setActiveTab('purchase_batches')}
            >採購批次紀錄</div>
            <div 
              style={{ 
                padding: '8px 16px', 
                cursor: 'pointer', 
                fontWeight: 600, 
                fontSize: '14px', 
                borderRadius: '6px', 
                color: activeTab === 'private_orders' ? '#1e293b' : '#64748b', 
                backgroundColor: activeTab === 'private_orders' ? '#fff' : 'transparent', 
                boxShadow: activeTab === 'private_orders' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none', 
                whiteSpace: 'nowrap',
                flex: '0 0 auto'
              }}
              onClick={() => setActiveTab('private_orders')}
            >私下登記紀錄</div>
          </div>
        </div>

        {/* Toolbar */}
        {activeTab === 'worksheet' && (
          <div style={{ 
            display: 'flex', 
            flexDirection: isMobile ? 'column' : 'row',
            alignItems: isMobile ? 'stretch' : 'center', 
            gap: isMobile ? '12px' : '0px',
            marginBottom: '16px', 
            padding: '16px', 
            backgroundColor: '#fff', 
            borderRadius: '12px', 
            border: '1px solid #e5e7eb', 
            boxShadow: '0 1px 2px rgba(0,0,0,0.05)' 
          }}>
            {/* Row 1: Mode Toggle Buttons */}
            <div style={{ display: 'flex', justifyContent: isMobile ? 'center' : 'flex-start' }}>
              <div style={{ display: 'flex', backgroundColor: '#f1f5f9', padding: '4px', borderRadius: '8px', width: isMobile ? '100%' : 'auto' }}>
                <div 
                  style={{ flex: isMobile ? 1 : 'none', textAlign: 'center', padding: '6px 16px', cursor: 'pointer', fontWeight: 600, fontSize: '13px', borderRadius: '6px', color: filterMode === 'all' ? '#1e293b' : '#64748b', backgroundColor: filterMode === 'all' ? '#fff' : 'transparent', boxShadow: filterMode === 'all' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none' }}
                  onClick={() => setFilterMode('all')}
                >顯示全部商品</div>
                <div 
                  style={{ flex: isMobile ? 1 : 'none', textAlign: 'center', padding: '6px 16px', cursor: 'pointer', fontWeight: 600, fontSize: '13px', borderRadius: '6px', color: filterMode === 'abnormal' ? '#2563eb' : '#64748b', backgroundColor: filterMode === 'abnormal' ? '#fff' : 'transparent', boxShadow: filterMode === 'abnormal' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none' }}
                  onClick={() => setFilterMode('abnormal')}
                >缺貨採購模式</div>
              </div>
            </div>

            {!isMobile && <div style={{ margin: '0 16px', width: '1px', height: '24px', backgroundColor: '#e2e8f0' }}></div>}

            {/* Row 2: Sort Select & Exchange Rate */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <select 
                className="input" 
                style={{ width: isMobile ? '100%' : '200px', height: '36px', fontSize: '13px', padding: '0 12px' }}
                value={sortMode}
                onChange={e => setSortMode(e.target.value as 'catalog' | 'shortage')}
              >
                <option value="catalog">依商品主檔順序排序</option>
                <option value="shortage">依缺貨多寡排序</option>
              </select>

              {!isMobile && <div style={{ margin: '0 16px', width: '1px', height: '24px', backgroundColor: '#e2e8f0' }}></div>}

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: isMobile ? '100%' : 'auto' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#64748b', whiteSpace: 'nowrap' }}>設定匯率:</span>
                <input 
                  type="number" 
                  step="0.0001"
                  min="0"
                  className="input" 
                  style={{ flex: isMobile ? 1 : 'none', width: isMobile ? 'auto' : '80px', height: '36px', fontSize: '13px', padding: '0 8px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '6px' }}
                  value={exchangeRate || ''}
                  onChange={e => {
                    const val = parseFloat(e.target.value) || 0;
                    setExchangeRate(val);
                    localStorage.setItem('erp_exchange_rate', String(val));
                  }}
                />
              </div>
            </div>

            {!isMobile && <div style={{ flex: 1 }}></div>}

            {/* Row 3: Search bar & Action Buttons */}
            <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'center', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: '6px', border: '1px solid #cbd5e1', padding: '0 12px', height: '36px', width: isMobile ? '100%' : '240px' }}>
                <Search size={16} style={{ color: '#64748b', marginRight: '8px' }} />
                <input 
                  type="text" 
                  placeholder="搜尋商品..." 
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  style={{ border: 'none', background: 'transparent', outline: 'none', width: '100%', fontSize: '13px', color: '#334155' }}
                />
              </div>

              <div style={{ display: 'flex', gap: '8px', width: isMobile ? '100%' : 'auto' }}>
                <button 
                  className="btn btn-outline" 
                  style={{ 
                    flex: isMobile ? 1 : 'none',
                    fontSize: '13px', 
                    padding: '6px 12px', 
                    backgroundColor: '#fdf2f8', 
                    color: '#db2777', 
                    borderColor: '#fbcfe8',
                    opacity: editMode ? 1 : 0.6,
                    cursor: editMode ? 'pointer' : 'not-allowed'
                  }}
                  disabled={!editMode}
                  onClick={openPrivateOrderModal}
                >
                  <Plus size={14} style={{ display: 'inline-block', marginRight: '4px' }} /> 私下登記
                </button>
                <button 
                  className="btn btn-outline" 
                  style={{ 
                    flex: isMobile ? 1 : 'none',
                    fontSize: '13px', 
                    padding: '6px 12px', 
                    backgroundColor: '#eff6ff', 
                    color: '#2563eb', 
                    borderColor: '#bfdbfe',
                    opacity: editMode ? 1 : 0.6,
                    cursor: editMode ? 'pointer' : 'not-allowed'
                  }}
                  disabled={!editMode}
                  onClick={openBatchModal}
                >
                  <Plus size={14} style={{ display: 'inline-block', marginRight: '4px' }} /> 新增採購批次
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Card List Area (Standard Mode) */}
        {activeTab === 'worksheet' && filterMode === 'all' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, paddingBottom: '40px' }}>
            {sortedGroupEntries.filter(([groupKey, groupItems]) => {
              // 1. Search Filter
              if (searchTerm) {
                const lowerSearch = searchTerm.toLowerCase();
                const catTitle = groupKey.startsWith('category:') 
                  ? (isDaili ? cleanDailiTitle(groupKey.slice('category:'.length)) : groupKey.slice('category:'.length))
                  : getDisplayProductName(groupItems[0]);
                const groupMatch = catTitle.toLowerCase().includes(lowerSearch);
                const hasMatch = groupItems.some(v => 
                  (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                  (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                );
                if (!groupMatch && !hasMatch) return false;
              }

              return true;

            }).map(([groupKey, groupItems]) => {
              const catTitle = groupKey.startsWith('category:') 
                ? (isDaili ? cleanDailiTitle(groupKey.slice('category:'.length)) : groupKey.slice('category:'.length))
                : getDisplayProductName(groupItems[0]);
              
              const lowerSearch = searchTerm.toLowerCase();
              const isSearchMatched = searchTerm.trim() !== '' && (
                catTitle.toLowerCase().includes(lowerSearch) || 
                groupItems.some(v => 
                  (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                  (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                )
              );
              const isExpanded = isSearchMatched ? true : manualExpandedGroups.has(groupKey);
              
              // Compute Group Aggregates
              let pMyacg = 0, pWaca = 0, pManual = 0, pNeed = 0, pExcess = 0, pPurchased = 0, pDemand = 0;
              groupItems.forEach(v => {
                const { myacgDemand, wacaDemand, privateDemand, totalDemand: tDemand, purchased: tPurchased } = getVariantDemands(v);

                pMyacg += myacgDemand;
                pWaca += wacaDemand;
                pManual += privateDemand;
                pDemand += tDemand;
                pPurchased += tPurchased;
                
                pNeed += Math.max(tDemand - tPurchased, 0);
                pExcess += Math.max(tPurchased - tDemand, 0);
              });

              // Decide Border Color
              let borderColor = "#CBD5E1";
              if (pNeed > 0) {
                borderColor = "#F87171";
              } else if (pDemand > 0) {
                borderColor = "#22C55E";
              }

              // SINGLE ITEM RENDERING
              if (groupKey.startsWith('__single__')) {
                const v = groupItems[0];
                
                
                
                return (
                  <div key={v.id} className="card shadow-sm rounded-lg overflow-hidden bg-white" style={{ width: '100%', maxWidth: '100%', overflow: 'hidden', borderTop: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', borderLeft: `4px solid ${borderColor}` }}>
                    <ScrollWrapper isMobile={isMobile}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed', minWidth: isMobile ? '800px' : undefined }}>
                      {isDaili ? (
                        <>
                          <colgroup>
                            <col style={{ width: '30%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '12%' }} />
                            <col style={{ width: '9%' }} />
                            <col style={{ width: '9%' }} />
                            <col style={{ width: '9%' }} />
                            <col style={{ width: '9%' }} />
                          </colgroup>
                          <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                            <tr>
                              <th style={{ padding: '8px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                              <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫售價</th>
                              <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>成本</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                            </tr>
                          </thead>
                        </>
                      ) : (
                        <>
                          <colgroup>
                            <col style={{ width: '30%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '13%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '12%' }} />
                            <col style={{ width: '12%' }} />
                          </colgroup>
                          <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                            <tr>
                              <th style={{ padding: '8px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                              <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>單價</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                            </tr>
                          </thead>
                        </>
                      )}
                      <tbody>
                        <tr>
                          <td style={{ padding: '10px 20px', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <div style={{ fontWeight: 700, color: '#0F172A', fontSize: '15px', lineHeight: 1.35, marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={catTitle}>
                              <HighlightText text={catTitle} highlight={searchTerm} />
                            </div>
                            <div style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8', marginTop: '2px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.myacg_item_code}>
                              SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />
                            </div>
                          </td>
                          {isDaili ? (
                            <>
                              <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                NT$ {(inventoryMap.get(v.myacg_item_code)?.final_price ?? 0).toLocaleString()}
                              </td>
                              <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                {editMode && canWrite ? (
                                  <input
                                    type="number"
                                    min="0"
                                    placeholder="-"
                                    style={{
                                      width: '80px',
                                      height: '28px',
                                      textAlign: 'right',
                                      border: '1px solid #cbd5e1',
                                      borderRadius: '4px',
                                      fontSize: '14px',
                                      fontWeight: 600,
                                      color: '#1E293B',
                                      backgroundColor: '#ffffff',
                                      padding: '0 8px',
                                      margin: '0 0 0 auto',
                                      display: 'block'
                                    }}
                                    value={getVariantDefaultTwdCost(v) ?? ''}
                                    onChange={e => handleUpdateDefaultTwdCost(v.id, e.target.value)}
                                  />
                                ) : (
                                  (() => {
                                    const defCost = getVariantDefaultTwdCost(v);
                                    if (defCost !== undefined && defCost !== null) {
                                      return `NT$ ${defCost}`;
                                    }
                                    const latCost = getLatestBatchCost(v.id);
                                    if (latCost !== null) {
                                      return `NT$ ${latCost}`;
                                    }
                                    return '-';
                                  })()
                                )}
                              </td>
                            </>
                          ) : (
                            <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                              {editMode && canWrite ? (
                                <input
                                  type="number"
                                  min="0"
                                  placeholder="-"
                                  style={{
                                    width: '80px',
                                    height: '28px',
                                    textAlign: 'right',
                                    border: '1px solid #cbd5e1',
                                    borderRadius: '4px',
                                    fontSize: '14px',
                                    fontWeight: 600,
                                    color: '#1E293B',
                                    backgroundColor: '#ffffff',
                                    padding: '0 8px',
                                    margin: '0 0 0 auto',
                                    display: 'block'
                                  }}
                                  value={getVariantDefaultJpyCost(v) ?? ''}
                                  onChange={e => handleUpdateDefaultJpyCost(v.id, e.target.value)}
                                />
                              ) : (
                                (() => {
                                  const defCost = getVariantDefaultJpyCost(v);
                                  if (defCost !== undefined && defCost !== null) {
                                    return `¥ ${defCost}`;
                                  }
                                  const latCost = getLatestBatchCost(v.id);
                                  if (latCost !== null) {
                                    return `¥ ${latCost}`;
                                  }
                                  return '-';
                                })()
                              )}
                            </td>
                          )}
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            {renderStatusBadge(pNeed, pExcess, pDemand)}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <input 
                              type="number" 
                              style={{ 
                                width: '64px', 
                                height: '28px', 
                                textAlign: 'center', 
                                border: '1px solid #cbd5e1', 
                                borderRadius: '4px', 
                                fontSize: '14px', 
                                fontWeight: 600, 
                                color: editMode ? '#1E293B' : '#64748b', 
                                backgroundColor: editMode ? '#ffffff' : '#f8fafc',
                                cursor: editMode ? 'text' : 'not-allowed',
                                margin: '0 auto', 
                                display: 'block' 
                              }} 
                              value={pMyacg || ''}
                              placeholder="0"
                              onChange={e => handleUpdatePlatformDemand(v.id, 'myacg', parseInt(e.target.value))}
                              disabled={!editMode}
                            />
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <input 
                              type="number" 
                              style={{ 
                                width: '64px', 
                                height: '28px', 
                                textAlign: 'center', 
                                border: '1px solid #cbd5e1', 
                                borderRadius: '4px', 
                                fontSize: '14px', 
                                fontWeight: 600, 
                                color: editMode ? '#1E293B' : '#64748b', 
                                backgroundColor: editMode ? '#ffffff' : '#f8fafc',
                                cursor: editMode ? 'text' : 'not-allowed',
                                margin: '0 auto', 
                                display: 'block' 
                              }} 
                              value={pWaca || ''}
                              placeholder="0"
                              onChange={e => handleUpdatePlatformDemand(v.id, 'waca', parseInt(e.target.value))}
                              disabled={!editMode}
                            />
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: pManual > 0 ? '#1E293B' : '#94a3b8', backgroundColor: pManual > 0 ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>
                              {pManual > 0 ? pManual : '-'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: pPurchased > 0 ? '#1E293B' : '#94a3b8' }}>
                              {pPurchased > 0 ? pPurchased : '-'}
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    </ScrollWrapper>
                  </div>
                );
              }

              // CATEGORY CARD RENDERING
              return (
                <div key={groupKey} className="card shadow-sm rounded-lg bg-white" style={{ width: '100%', maxWidth: '100%', overflow: 'hidden', borderTop: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', borderLeft: `4px solid ${borderColor}` }}>
                  
                  {/* Category Header Row */}
                  <div 
                    style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                    onClick={() => toggleManualGroup(groupKey)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '15px' }}>
                        <HighlightText text={catTitle} highlight={searchTerm} />
                      </div>
                      <span style={{ backgroundColor: '#f1f5f9', color: '#64748b', padding: '2px 8px', borderRadius: '12px', fontSize: '12px', fontWeight: 500 }}>
                        共 {groupItems.length} 款
                      </span>
                      {pNeed > 0 && (
                        <span style={{
                          backgroundColor: '#FEE2E2',
                          color: '#DC2626',
                          border: '1px solid #fecaca',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '12px',
                          fontWeight: 600,
                          marginLeft: '8px',
                          display: 'inline-block'
                        }}>
                          待採購 {pNeed}
                        </span>
                      )}
                      {pNeed === 0 && pExcess > 0 && (
                        <span style={{
                          backgroundColor: '#fff7ed',
                          color: '#c2410c',
                          border: '1px solid #ffedd5',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '12px',
                          fontWeight: 600,
                          marginLeft: '8px',
                          display: 'inline-block'
                        }}>
                          多買 {pExcess}
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '8px' : '16px', fontSize: '13px', color: '#64748b' }}>
                      {!isMobile && (
                        <>
                          <span>總需求 {pDemand}</span>
                          <span>已採購 {pPurchased}</span>
                          <span>待採購 {pNeed}</span>
                          <span>多買 {pExcess}</span>
                          <span>私下 {pManual}</span>
                        </>
                      )}
                      {isMobile && pNeed > 0 && (
                        <span style={{ color: '#ef4444', fontWeight: 600 }}>缺 {pNeed}</span>
                      )}
                      <div style={{ color: '#94a3b8', display: 'flex', alignItems: 'center' }}>
                        {isExpanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                      </div>
                    </div>
                  </div>

                  {/* Expanded SKU Table */}
                  {isExpanded && (
                    <div style={{ borderTop: '1px solid #f1f5f9' }}>
                      <ScrollWrapper isMobile={isMobile}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed', minWidth: isMobile ? '800px' : undefined }}>
                        {isDaili ? (
                          <>
                            <colgroup>
                              <col style={{ width: '30%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '12%' }} />
                              <col style={{ width: '9%' }} />
                              <col style={{ width: '9%' }} />
                              <col style={{ width: '9%' }} />
                              <col style={{ width: '9%' }} />
                            </colgroup>
                            <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                              <tr>
                                <th style={{ padding: '10px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                                <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫售價</th>
                                <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>成本</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                              </tr>
                            </thead>
                          </>
                        ) : (
                          <>
                            <colgroup>
                              <col style={{ width: '30%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '13%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '12%' }} />
                              <col style={{ width: '12%' }} />
                            </colgroup>
                            <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                              <tr>
                                <th style={{ padding: '10px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                                <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>單價</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                              </tr>
                            </thead>
                          </>
                        )}
                        <tbody>
                          {(() => {
                            const filteredList = groupItems.filter(v => {
                              if (!searchTerm.trim()) return true;
                              const lowerSearch = searchTerm.toLowerCase();
                              return (
                                (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                                (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                              );
                            });
                            
                            return filteredList.map((v, i) => {
                              const { myacgDemand, wacaDemand, privateDemand, totalDemand, purchased: totalPurchased } = getVariantDemands(v);
                              
                              const needToBuy = Math.max(totalDemand - totalPurchased, 0);
                              const excessBuy = Math.max(totalPurchased - totalDemand, 0);

                              return (
                                <tr key={v.id} style={{ borderBottom: i === filteredList.length - 1 ? 'none' : '1px solid #F1F5F9' }}>
                                  <td style={{ padding: '12px 20px', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    <div style={{ fontWeight: 700, color: '#0F172A', fontSize: '15px', lineHeight: 1.35, marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={getDisplayProductName(v)}>
                                      <HighlightText text={isDaili ? getDisplayProductName(v) : (parsedVariantsMap.get(v.id)?.variantDisplayName || v.variant_name || v.product_title || '單品')} highlight={searchTerm} />
                                    </div>
                                    <div style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8', marginTop: '2px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.myacg_item_code}>
                                      SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />
                                    </div>
                                  </td>
                                  {isDaili ? (
                                    <>
                                      <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                        NT$ {(inventoryMap.get(v.myacg_item_code)?.final_price ?? 0).toLocaleString()}
                                      </td>
                                      <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                        {editMode && canWrite ? (
                                          <input
                                            type="number"
                                            min="0"
                                            placeholder="-"
                                            style={{
                                              width: '80px',
                                              height: '28px',
                                              textAlign: 'right',
                                              border: '1px solid #cbd5e1',
                                              borderRadius: '4px',
                                              fontSize: '14px',
                                              fontWeight: 600,
                                              color: '#1E293B',
                                              backgroundColor: '#ffffff',
                                              padding: '0 8px',
                                              margin: '0 0 0 auto',
                                              display: 'block'
                                            }}
                                            value={getVariantDefaultTwdCost(v) ?? ''}
                                            onChange={e => handleUpdateDefaultTwdCost(v.id, e.target.value)}
                                          />
                                        ) : (
                                          (() => {
                                            const defCost = getVariantDefaultTwdCost(v);
                                            if (defCost !== undefined && defCost !== null) {
                                              return `NT$ ${defCost}`;
                                            }
                                            const latCost = getLatestBatchCost(v.id);
                                            if (latCost !== null) {
                                              return `NT$ ${latCost}`;
                                            }
                                            return '-';
                                          })()
                                        )}
                                      </td>
                                    </>
                                  ) : (
                                    <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                      {editMode && canWrite ? (
                                        <input
                                          type="number"
                                          min="0"
                                          placeholder="-"
                                          style={{
                                            width: '80px',
                                            height: '28px',
                                            textAlign: 'right',
                                            border: '1px solid #cbd5e1',
                                            borderRadius: '4px',
                                            fontSize: '14px',
                                            fontWeight: 600,
                                            color: '#1E293B',
                                            backgroundColor: '#ffffff',
                                            padding: '0 8px',
                                            margin: '0 0 0 auto',
                                            display: 'block'
                                          }}
                                          value={getVariantDefaultJpyCost(v) ?? ''}
                                          onChange={e => handleUpdateDefaultJpyCost(v.id, e.target.value)}
                                        />
                                      ) : (
                                        (() => {
                                          const defCost = getVariantDefaultJpyCost(v);
                                          if (defCost !== undefined && defCost !== null) {
                                            return `¥ ${defCost}`;
                                          }
                                          const latCost = getLatestBatchCost(v.id);
                                          if (latCost !== null) {
                                            return `¥ ${latCost}`;
                                          }
                                          return '-';
                                        })()
                                      )}
                                    </td>
                                  )}
                                
                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    {renderStatusBadge(needToBuy, excessBuy, totalDemand)}
                                  </td>

                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <input 
                                      type="number" 
                                      style={{ 
                                        width: '64px', 
                                        height: '28px', 
                                        textAlign: 'center', 
                                        border: '1px solid #cbd5e1', 
                                        borderRadius: '4px', 
                                        fontSize: '14px', 
                                        fontWeight: 600, 
                                        color: editMode ? '#1E293B' : '#64748b', 
                                        backgroundColor: editMode ? '#ffffff' : '#f8fafc',
                                        cursor: editMode ? 'text' : 'not-allowed',
                                        margin: '0 auto', 
                                        display: 'block' 
                                      }} 
                                      value={myacgDemand || ''}
                                      placeholder="0"
                                      onChange={e => handleUpdatePlatformDemand(v.id, 'myacg', parseInt(e.target.value))}
                                      disabled={!editMode}
                                    />
                                  </td>
                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <input 
                                      type="number" 
                                      style={{ 
                                        width: '64px', 
                                        height: '28px', 
                                        textAlign: 'center', 
                                        border: '1px solid #cbd5e1', 
                                        borderRadius: '4px', 
                                        fontSize: '14px', 
                                        fontWeight: 600, 
                                        color: editMode ? '#1E293B' : '#64748b', 
                                        backgroundColor: editMode ? '#ffffff' : '#f8fafc',
                                        cursor: editMode ? 'text' : 'not-allowed',
                                        margin: '0 auto', 
                                        display: 'block' 
                                      }} 
                                      value={wacaDemand || ''}
                                      placeholder="0"
                                      onChange={e => handleUpdatePlatformDemand(v.id, 'waca', parseInt(e.target.value))}
                                      disabled={!editMode}
                                    />
                                  </td>
                                  
                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <span style={{ fontSize: '14px', fontWeight: 600, color: privateDemand > 0 ? '#1E293B' : '#94a3b8', backgroundColor: privateDemand > 0 ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>
                                      {privateDemand > 0 ? privateDemand : '-'}
                                    </span>
                                  </td>

                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <span style={{ fontSize: '14px', fontWeight: 600, color: totalPurchased > 0 ? '#1E293B' : '#94a3b8' }}>
                                      {totalPurchased > 0 ? totalPurchased : '-'}
                                    </span>
                                  </td>
                                </tr>
                              );
                            });
                          })()}
                        </tbody>
                      </table>
                    </ScrollWrapper>
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Shortage Purchasing List (only when activeTab === 'worksheet' and filterMode === 'abnormal') */}
        {activeTab === 'worksheet' && filterMode === 'abnormal' && (() => {
          // 1. Process all groups and variants to extract actual shortages (needToBuy > 0)
          const shortageGroups = sortedGroupEntries.map(([groupKey, groupItems]) => {
            const catTitle = groupKey.startsWith('category:') 
              ? (isDaili ? cleanDailiTitle(groupKey.slice('category:'.length)) : groupKey.slice('category:'.length))
              : getDisplayProductName(groupItems[0]);
            
            // Apply Search Filter first
            if (searchTerm) {
              const lowerSearch = searchTerm.toLowerCase();
              const groupMatch = catTitle.toLowerCase().includes(lowerSearch);
              const hasMatch = groupItems.some(v => 
                (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
              );
              if (!groupMatch && !hasMatch) return null;
            }

            const itemsWithShortage = groupItems.map(v => {
              const { totalDemand, purchased: totalPurchased } = getVariantDemands(v);
              const needToBuy = Math.max(totalDemand - totalPurchased, 0);
              
              return { variant: v, needToBuy };
            }).filter(item => item.needToBuy > 0);

            const totalGroupShortage = itemsWithShortage.reduce((sum, item) => sum + item.needToBuy, 0);
            
            if (totalGroupShortage === 0) return null;

            return {
              groupKey,
              catTitle,
              items: itemsWithShortage,
              totalShortage: totalGroupShortage
            };
          }).filter((g): g is NonNullable<typeof g> => g !== null);

          // 2. Sort by totalShortage descending
          shortageGroups.sort((a, b) => b.totalShortage - a.totalShortage);

          // 3. Stats
          const totalAbnormalProductsCount = shortageGroups.length;
          const totalAbnormalShortageCount = shortageGroups.reduce((sum, g) => sum + g.totalShortage, 0);

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, paddingBottom: '40px' }}>
              {/* Statistics Header */}
              <div style={{ 
                padding: '16px 20px', 
                backgroundColor: '#fff', 
                borderRadius: '12px', 
                border: '1px solid #e5e7eb', 
                boxShadow: '0 1px 2px rgba(0,0,0,0.05)', 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center' 
              }}>
                <span style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>缺貨採購清單</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: 600, color: '#475569' }}>
                  <span>共 <strong style={{ color: '#2563eb' }}>{totalAbnormalProductsCount}</strong> 種商品</span>
                  <span style={{ color: '#cbd5e1' }}>|</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    待採購 
                    <strong style={{
                      backgroundColor: '#FEE2E2',
                      color: '#DC2626',
                      border: '1px solid #fecaca',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontWeight: 700
                    }}>
                      {totalAbnormalShortageCount}
                    </strong>
                  </span>
                </div>
              </div>

              {/* Cleared list message */}
              {totalAbnormalProductsCount === 0 && (
                <div className="card text-center" style={{ padding: '40px', backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '12px', color: '#64748b' }}>
                  🎉 目前沒有任何缺貨商品！
                </div>
              )}

              {/* Shopping List Items */}
              {shortageGroups.map(g => {
                const isSingleItem = g.groupKey.startsWith('__single__');
                
                if (isSingleItem) {
                  return (
                    <div 
                      key={g.groupKey} 
                      className="card shadow-sm rounded-lg overflow-hidden bg-white" 
                      style={{ 
                        width: '100%',
                        maxWidth: '100%',
                        overflow: 'hidden',
                        borderTop: '1px solid #e5e7eb', 
                        borderRight: '1px solid #e5e7eb', 
                        borderBottom: '1px solid #e5e7eb', 
                        borderLeft: '4px solid #F87171',
                        padding: '16px 20px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        height: '60px'
                      }}
                    >
                      <span style={{ fontSize: '16px', fontWeight: 700, color: '#0F172A' }}>
                        <HighlightText text={g.catTitle} highlight={searchTerm} />
                      </span>
                      <span style={{
                        backgroundColor: '#FEE2E2',
                        color: '#DC2626',
                        border: '1px solid #fecaca',
                        padding: '4px 12px',
                        borderRadius: '6px',
                        fontSize: '14px',
                        fontWeight: 700
                      }}>
                        待採購 {g.totalShortage}
                      </span>
                    </div>
                  );
                }

                // Multi-spec Product (category group)
                return (
                  <div 
                    key={g.groupKey} 
                    className="card shadow-sm rounded-lg overflow-hidden bg-white" 
                    style={{ 
                      width: '100%',
                      maxWidth: '100%',
                      overflow: 'hidden',
                      borderTop: '1px solid #e5e7eb', 
                      borderRight: '1px solid #e5e7eb', 
                      borderBottom: '1px solid #e5e7eb', 
                      borderLeft: '4px solid #F87171',
                      padding: '16px 20px'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                      <span style={{ fontSize: '16px', fontWeight: 700, color: '#0F172A', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ color: '#64748b' }}>▼</span> 
                        <HighlightText text={g.catTitle} highlight={searchTerm} />
                      </span>
                      <span style={{
                        backgroundColor: '#FEE2E2',
                        color: '#DC2626',
                        border: '1px solid #fecaca',
                        padding: '4px 12px',
                        borderRadius: '6px',
                        fontSize: '14px',
                        fontWeight: 700
                      }}>
                        待採購 {g.totalShortage}
                      </span>
                    </div>
                    
                    <div style={{ paddingLeft: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {g.items.map(item => (
                        <div key={item.variant.id} style={{ fontSize: '14px', color: '#475569', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ color: '#94a3b8' }}>•</span>
                          <span>
                            <HighlightText text={isDaili ? getDisplayProductName(item.variant) : (parsedVariantsMap.get(item.variant.id)?.variantDisplayName || item.variant.variant_name || item.variant.product_title || '單品')} highlight={searchTerm} />
                          </span>
                          <span style={{ fontWeight: 700, color: '#0F172A', marginLeft: '4px' }}>×{item.needToBuy}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Render Purchase Batch Tab */}
        {activeTab === 'purchase_batches' && (
          <PurchaseBatchTab 
            batches={purchaseBatches} 
            batchItems={purchaseBatchItems} 
            variants={variants} 
            onRefresh={loadData} 
            onEditBatch={handleEditBatch}
            getDisplayProductName={getDisplayProductName}
          />
        )}

        {/* Render Private Order Tab */}
        {activeTab === 'private_orders' && (
          <PrivateOrderTab 
            orders={privateOrders} 
            orderItems={privateOrderItems} 
            variants={variants} 
            onRefresh={loadData} 
            onEditOrder={handleEditOrder}
            getDisplayProductName={getDisplayProductName}
          />
        )}
      </div>

      {/* Modals... (Keep Private Order and Batch Modals Unchanged) */}
      {showPrivateOrderModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="card" style={{ width: '600px', maxHeight: '90vh', overflowY: 'auto', backgroundColor: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', padding: '16px', borderBottom: '1px solid #e5e7eb' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>{editingPoId ? '編輯私下登記' : '新增私下登記'}</h2>
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setShowPrivateOrderModal(false)}><X size={20} /></button>
            </div>
            
            <div style={{ padding: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>買家名稱 *</label>
                  <input className="input" type="text" value={poForm.customer_name} onChange={e => setPoForm({...poForm, customer_name: e.target.value})} style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>聯絡方式</label>
                  <input className="input" type="text" value={poForm.contact} onChange={e => setPoForm({...poForm, contact: e.target.value})} style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>訂單備註</label>
                  <input className="input" type="text" value={poForm.note} onChange={e => setPoForm({...poForm, note: e.target.value})} style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px' }} />
                </div>
              </div>

              <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '14px', color: '#1e293b' }}>商品需求明細</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '24px' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f8fafc', color: '#64748b' }}>
                    <th style={{ padding: '8px', textAlign: 'left', fontWeight: 500 }}>商品規格</th>
                    <th style={{ padding: '8px', textAlign: 'center', fontWeight: 500, width: '80px' }}>數量</th>
                    <th style={{ padding: '8px', textAlign: 'right', fontWeight: 500, width: '100px' }}>實收金額</th>
                  </tr>
                </thead>
                <tbody>
                  {variants.map((v, idx) => (
                    <tr key={v.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '8px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <div style={{ fontWeight: 600, color: '#1e293b' }}>
                            {getDisplayProductName(v)}
                          </div>
                          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                            SKU: {v.myacg_item_code}
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '8px', textAlign: 'center' }}>
                        <input className="input" type="number" min="0" value={poLines[idx]?.quantity || ''} onChange={e => updatePoLine(idx, 'quantity', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px 8px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px' }} />
                      </td>
                      <td style={{ padding: '8px', textAlign: 'right' }}>
                        <input className="input" type="number" min="0" value={poLines[idx]?.amount || ''} onChange={e => updatePoLine(idx, 'amount', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px 8px', textAlign: 'right', border: '1px solid #cbd5e1', borderRadius: '4px' }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button className="btn btn-outline" style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #cbd5e1' }} onClick={() => setShowPrivateOrderModal(false)}>取消</button>
                <button className="btn btn-primary" style={{ padding: '8px 16px', borderRadius: '6px', backgroundColor: '#2563eb', color: '#fff' }} onClick={handleAddPrivateOrderSubmit} disabled={!poForm.customer_name.trim()}>儲存</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showBatchModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="card" style={{ width: '600px', maxHeight: '90vh', overflowY: 'auto', backgroundColor: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', padding: '16px', borderBottom: '1px solid #e5e7eb' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>{editingBatchId ? '編輯採購批次' : '新增採購批次'}</h2>
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setShowBatchModal(false)}><X size={20} /></button>
            </div>
            
            <div style={{ padding: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>批次名稱 *</label>
                  <input className="input" type="text" value={batchForm.name} onChange={e => setBatchForm({...batchForm, name: e.target.value})} placeholder="例如：2023-11-20 安利美特採購" style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>採購日期</label>
                  <input className="input" type="date" value={batchForm.date} onChange={e => setBatchForm({...batchForm, date: e.target.value})} style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>備註</label>
                  <input className="input" type="text" value={batchForm.note} onChange={e => setBatchForm({...batchForm, note: e.target.value})} style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px' }} />
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ fontWeight: 600, fontSize: '14px', color: '#1e293b' }}>採購明細</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#475569', cursor: 'pointer', userSelect: 'none' }}>
                  <input 
                    type="checkbox" 
                    checked={onlyShowShortage} 
                    onChange={e => setOnlyShowShortage(e.target.checked)} 
                    style={{ cursor: 'pointer' }}
                  />
                  <span>只顯示有缺口商品</span>
                </label>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '24px' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f8fafc', color: '#64748b' }}>
                    <th style={{ padding: '8px', textAlign: 'left', fontWeight: 500 }}>商品規格</th>
                    <th style={{ padding: '8px', textAlign: 'center', fontWeight: 500, width: '80px' }}>缺口</th>
                    <th style={{ padding: '8px', textAlign: 'center', fontWeight: 500, width: '80px' }}>數量</th>
                    <th style={{ padding: '8px', textAlign: 'right', fontWeight: 500, width: '120px' }}>{isDaili ? '成本（台幣）' : '實支單價（日幣）'}</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const rows: React.ReactNode[] = [];
                    let hasAnyVisible = false;
                    
                    variants.forEach((v, idx) => {
                      const shortage = getVariantShortageForModal(v);
                      const isHidden = onlyShowShortage && shortage <= 0;
                      if (isHidden) return;
                      
                      hasAnyVisible = true;
                      rows.push(
                        <tr key={v.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                              <div style={{ fontWeight: 600, color: '#1e293b' }}>
                                {getDisplayProductName(v)}
                              </div>
                              <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                                SKU: {v.myacg_item_code}
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: '8px', textAlign: 'center' }}>
                            {shortage > 0 && (
                              <span style={{
                                backgroundColor: '#FEE2E2',
                                color: '#DC2626',
                                border: '1px solid #fecaca',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '12px',
                                fontWeight: 600,
                                whiteSpace: 'nowrap'
                              }}>
                                缺 {shortage}
                              </span>
                            )}
                            {shortage < 0 && (
                              <span style={{
                                backgroundColor: '#EFF6FF',
                                color: '#2563EB',
                                border: '1px solid #bfdbfe',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '12px',
                                fontWeight: 600,
                                whiteSpace: 'nowrap'
                              }}>
                                多買 {Math.abs(shortage)}
                              </span>
                            )}
                            {shortage === 0 && (
                              <span style={{ color: '#94a3b8', fontSize: '12px' }}>-</span>
                            )}
                          </td>
                          <td style={{ padding: '8px', textAlign: 'center' }}>
                            <input className="input" type="number" min="0" value={batchLines[idx]?.quantity || ''} onChange={e => updateBatchLine(idx, 'quantity', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px 8px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px' }} />
                          </td>
                          <td style={{ padding: '8px', textAlign: 'right' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
                              {!isDaili && <span style={{ color: '#64748b' }}>¥</span>}
                              <input className="input" type="number" min="0" value={batchLines[idx]?.cost || ''} onChange={e => updateBatchLine(idx, 'cost', parseInt(e.target.value) || 0)} style={{ width: '80px', padding: '4px 8px', textAlign: 'right', border: '1px solid #cbd5e1', borderRadius: '4px' }} />
                            </div>
                          </td>
                        </tr>
                      );
                    });
                    
                    if (!hasAnyVisible) {
                      return (
                        <tr>
                          <td colSpan={4} style={{ padding: '16px', textAlign: 'center', color: '#64748b' }}>
                            目前無任何缺口商品
                          </td>
                        </tr>
                      );
                    }
                    
                    return rows;
                  })()}
                </tbody>
              </table>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button className="btn btn-outline" style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #cbd5e1' }} onClick={() => setShowBatchModal(false)}>取消</button>
                <button className="btn btn-primary" style={{ padding: '8px 16px', borderRadius: '6px', backgroundColor: '#2563eb', color: '#fff' }} onClick={handleAddBatchSubmit} disabled={!batchForm.name.trim()}>儲存</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div style={{
          position: 'fixed',
          top: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: '#1e293b',
          color: '#fff',
          padding: '12px 24px',
          borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          zIndex: 10000,
          fontSize: '14px',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          pointerEvents: 'none',
          transition: 'all 0.3s ease'
        }}>
          {toastMessage}
        </div>
      )}

      {/* Floating Action Button (FAB) */}
      <button
        onClick={toggleEditMode}
        className="fixed transition-all duration-200"
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          zIndex: 9999,
          height: '42px',
          padding: '0 20px',
          fontWeight: 600,
          fontSize: '14px',
          borderRadius: '9999px',
          border: editMode ? '1px solid #FED7AA' : '1px solid #A7F3D0',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          backgroundColor: editMode ? '#FFEFE6' : '#E6F4EA',
          color: editMode ? '#C2410C' : '#137333',
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          outline: 'none'
        }}
      >
        {editMode ? '✏️ 編輯中' : '🔒 已鎖定'}
      </button>
    </div>
  );
}
