import { calculateFinalMyacgDemand } from '../src/lib/db.js';

// Recreate the functions from Dashboard_backup.tsx exactly as they are defined there
const getTestContext = (groups, variants, inventory, salesOrderItems, categories, batchItems, privateOrderItems) => {
  const checkIsProxyProduct = (g) => {
    if (!g) return false;
    if (g.listing_type === '代理版') return true;
    if (g.source_type === '代理版') return true;

    const variantsList = variants || [];
    const inventoryList = inventory || [];

    const groupVars = variantsList.filter(v => v && v.product_group_id === g.id);
    const hasProxySku = groupVars.some(v => {
      if (!v || !v.myacg_item_code) return false;
      const invItem = inventoryList.find(i => i && i.myacg_item_code === v.myacg_item_code);
      return invItem?.listing_type === '代理版';
    });
    if (hasProxySku) return true;

    const keywords = [
      '代理版', '代理', 'gsc', 'good smile', 'max factory', 'furyu', '景品', 'sega', 'bandai', 'kotobukiya'
    ];

    const matchText = (text) => {
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

  const normalizeForMatch = (text) => {
    if (!text || typeof text !== 'string') return '';
    return text.toLowerCase().replace(/[\s!\uff01\?\uff1f\-_\(\)\uff08\uff09\.\*,]/g, '');
  };

  const isProxyProduct = (g) => checkIsProxyProduct(g);
  
  const isHololiveProduct = (g) => {
    if (!g) return false;
    if (isProxyProduct(g)) return false;
    const titleNorm = normalizeForMatch(g.title);
    const normTitleNorm = normalizeForMatch(g.normalized_title);
    return titleNorm.includes('hololive') || normTitleNorm.includes('hololive');
  };

  const isVspoProduct = (g) => {
    if (!g) return false;
    if (isProxyProduct(g)) return false;
    const titleNorm = normalizeForMatch(g.title);
    const normTitleNorm = normalizeForMatch(g.normalized_title);
    return titleNorm.includes('vspo') || titleNorm.includes('ぶいすぽ') || 
           normTitleNorm.includes('vspo') || normTitleNorm.includes('ぶいすぽ');
  };

  const isOtherProduct = (g) => {
    if (!g) return false;
    return !isProxyProduct(g) && !isHololiveProduct(g) && !isVspoProduct(g);
  };

  const getGroupDemandAndPurchased = (groupId) => {
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
        throw err; // rethrow to fail the test
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

  const getRemainingDays = (closingDate) => {
    if (!closingDate) return { text: '-', days: 999 };
    const todayStr = new Date().toISOString().split('T')[0];
    const todayTime = new Date(todayStr).getTime();
    const closingTime = new Date(closingDate).getTime();
    const diffDays = Math.ceil((closingTime - todayTime) / (1000 * 60 * 60 * 24));
    return {
      text: diffDays < 0 ? '已過期' : `剩 ${diffDays} 天`,
      days: diffDays
    };
  };

  const runStats = () => {
    const todayStr = new Date().toISOString().split('T')[0];
    const groupsList = groups || [];
    let activeCount = 0;
    let unorderedCount = 0;
    let urgent7Count = 0;
    let urgent3Count = 0;
    let closedCount = 0;

    groupsList.forEach(g => {
      if (!g) return;
      const isActive = !g.closing_date || g.closing_date >= todayStr;
      const details = getGroupDemandAndPurchased(g.id);

      if (isActive) {
        activeCount++;
        if (details.demand > 0 && details.purchased === 0) {
          unorderedCount++;
        }
        if (g.closing_date) {
          const { days } = getRemainingDays(g.closing_date);
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
  };

  const runCategoryCounts = () => {
    const groupsList = groups || [];
    return {
      all: groupsList.length,
      hololive: groupsList.filter(isHololiveProduct).length,
      vspo: groupsList.filter(isVspoProduct).length,
      proxy: groupsList.filter(isProxyProduct).length,
      other: groupsList.filter(isOtherProduct).length,
    };
  };

  return { runStats, runCategoryCounts };
};

// Now test with edge case data
const groups = [
  { id: "g1", title: "Item 1", closing_date: "2026-06-10" },
  { id: "g2", title: 12345, closing_date: "2026-06-12" } // Title is numeric
];

const variants = [
  { id: "v1", product_group_id: "g1", myacg_item_code: "SKU001", variant_name: "Red" },
  { id: "v2", product_group_id: "g2", myacg_item_code: "12345", variant_name: "Green" },
  { id: "v3", product_group_id: "g1", myacg_item_code: undefined, variant_name: "Blue" } // Undefined SKU code
];

const salesOrderItems = [
  { id: "so1", order_id: "o1", myacg_item_code: "SKU001", quantity: 2 },
  { id: "so2", order_id: "o1", myacg_item_code: undefined, quantity: 1 } // Undefined SKU on order item
];

const inventory = [];
const categories = [];
const batchItems = [];
const privateOrderItems = [];

try {
  console.log("Initializing test context...");
  const ctx = getTestContext(groups, variants, inventory, salesOrderItems, categories, batchItems, privateOrderItems);
  
  console.log("Running stats useMemo calculation...");
  const stats = ctx.runStats();
  console.log("Stats calculated successfully:", stats);
  
  console.log("Running categoryCounts useMemo calculation...");
  const catCounts = ctx.runCategoryCounts();
  console.log("Category counts calculated successfully:", catCounts);
  
  console.log("All calculations succeeded without throwing errors!");
} catch (err) {
  console.error("Test threw an exception:", err);
}
