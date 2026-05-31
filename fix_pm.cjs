const fs = require('fs');

const orig = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');
const lines = orig.split('\n');

const importTarget = lines.findIndex(l => l.includes('import { ChevronRight'));
lines[importTarget] = lines[importTarget].replace('}', ', AlertTriangle, Package, CheckSquare, RefreshCw, ShoppingCart, DollarSign }');

const loadDataStartIdx = lines.findIndex(l => l.includes('  const loadData = async () => {'));
const returnIdx = lines.findIndex((l, i) => i > 400 && l.includes('  return ('));

// Find where groupedVariants is defined in funcsContent to slice it out
const groupVarIdx = lines.findIndex((l, i) => i > loadDataStartIdx && l.includes('  const groupedVariants'));

const beforeLoadData = lines.slice(0, loadDataStartIdx).join('\n');

const stateAdditions = `
  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const [salesOrderItems, setSalesOrderItems] = useState<any[]>([]);
  const [filterMode, setFilterMode] = useState<'all' | 'abnormal'>('all');
  const [sortMode, setSortMode] = useState<'catalog' | 'shortage'>('catalog');
`;

const loadDataContent = `  const loadData = async () => {
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

    const allSO = await db.getSalesOrders();
    const allSOI = await db.getSalesOrderItems();
    const groupVariantCodes = new Set(groupVars.map(v => v.myacg_item_code));
    const groupSOI = allSOI.filter(i => groupVariantCodes.has(i.myacg_item_code));
    const groupSOIds = new Set(groupSOI.map(i => i.order_id));
    const groupSO = allSO.filter(o => groupSOIds.has(o.id));

    setSalesOrders(groupSO);
    setSalesOrderItems(groupSOI);
  };
`;

const funcStart = lines.findIndex((l, i) => i > loadDataStartIdx && l.includes('  const handleUpdatePlatformDemand'));
// Only take up to groupVarIdx, skip the rest of KPI calculation in the original code
const funcsContent = lines.slice(funcStart, groupVarIdx > 0 ? groupVarIdx : returnIdx).join('\n');

const kpiContent = `
  // KPI Calculations
  let totalShortage = 0;
  let totalExcess = 0;
  let totalPurchased = 0;
  let totalDemand = 0;

  variants.forEach(v => {
    const myacgDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
    const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
    
    const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
    const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);

    const vTotalDemand = myacgDemand + wacaDemand + privateDemand;
    totalDemand += vTotalDemand;

    const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
    const vPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);
    totalPurchased += vPurchased;
    
    const needToBuy = Math.max(vTotalDemand - vPurchased, 0);
    const excessBuy = Math.max(vPurchased - vTotalDemand, 0);

    totalShortage += needToBuy;
    totalExcess += excessBuy;
  });

  const validSO = salesOrders.filter(o => {
    const soItems = salesOrderItems.filter(i => i.order_id === o.id);
    return soItems.some(i => i.order_status !== '已取消' && i.order_status !== 'CANCELED');
  });
  const totalOrdersCount = validSO.length;

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

  // Grouping Variants by Category or Single Item
  const groupedVariants: Record<string, ProductVariant[]> = {};
  variants.forEach(v => {
    let groupKey = '';
    if (v.product_category_id) {
      const cat = categoryMap.get(v.product_category_id);
      groupKey = cat ? cat.title : \`__single__\${v.id}\`;
    } else {
      groupKey = \`__single__\${v.id}\`;
    }
    
    if (!groupedVariants[groupKey]) groupedVariants[groupKey] = [];
    groupedVariants[groupKey].push(v);
  });

  Object.values(groupedVariants).forEach(groupItems => {
    groupItems.sort((a, b) => {
      const aSort = a.sort_order ?? 9999;
      const bSort = b.sort_order ?? 9999;
      if (aSort !== bSort) return aSort - bSort;
      return (a.myacg_item_code || '').localeCompare(b.myacg_item_code || '');
    });
  });

  let sortedGroupEntries = Object.entries(groupedVariants).sort(([titleA, itemsA], [titleB, itemsB]) => {
    let sortA = 9999;
    let sortB = 9999;

    const catA = itemsA[0]?.product_category_id ? categoryMap.get(itemsA[0].product_category_id) : null;
    const catB = itemsB[0]?.product_category_id ? categoryMap.get(itemsB[0].product_category_id) : null;

    if (catA) sortA = catA.sort_order ?? 9999;
    else if (itemsA[0]) sortA = itemsA[0].sort_order ?? 9999;

    if (catB) sortB = catB.sort_order ?? 9999;
    else if (itemsB[0]) sortB = itemsB[0].sort_order ?? 9999;

    if (sortA !== sortB) return sortA - sortB;

    return titleA.localeCompare(titleB);
  });

  if (sortMode === 'shortage') {
    sortedGroupEntries = sortedGroupEntries.sort(([, itemsA], [, itemsB]) => {
      const getShortage = (items) => items.reduce((sum, v) => {
        const myacgDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
        const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
        const privateDemand = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
        const totalPurchased = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
        return sum + Math.max((myacgDemand + wacaDemand + privateDemand) - totalPurchased, 0);
      }, 0);
      return getShortage(itemsB) - getShortage(itemsA);
    });
  }
`;

const updatePm2Code = fs.readFileSync('update_pm2.cjs', 'utf8');
const jsxContent = updatePm2Code.split('const jsxContent = `')[1].split('`;')[0];

const finalFileContent = beforeLoadData + '\n' + stateAdditions + loadDataContent + funcsContent + '\n' + kpiContent + jsxContent;
fs.writeFileSync('src/pages/PurchaseManagement.tsx', finalFileContent, 'utf8');
console.log('PurchaseManagement.tsx patched successfully');
