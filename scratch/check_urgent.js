import { ClassicLevel } from 'classic-level';
import path from 'path';

const tempDir = path.join(
  process.env.USERPROFILE || '',
  '.gemini',
  'antigravity',
  'scratch',
  'leveldb_temp'
);

async function run() {
  const db = new ClassicLevel(tempDir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  let groups = [];
  let variants = [];
  let inventory = [];
  let salesOrderItems = [];
  let batchItems = [];
  let privateOrderItems = [];
  let categories = [];

  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      const valSlice = valBuf.slice(1);
      let parsedVal = null;
      try {
        parsedVal = JSON.parse(valSlice.toString('utf16le'));
      } catch (e) {
        try {
          parsedVal = JSON.parse(valSlice.toString('utf8'));
        } catch (e2) {}
      }

      if (parsedVal) {
        if (keyStr.includes('erp_product_groups')) groups = parsedVal;
        if (keyStr.includes('erp_product_variants')) variants = parsedVal;
        if (keyStr.includes('erp_inventory')) inventory = parsedVal;
        if (keyStr.includes('erp_sales_order_items')) salesOrderItems = parsedVal;
        if (keyStr.includes('erp_purchase_batch_items')) batchItems = parsedVal;
        if (keyStr.includes('erp_private_order_items')) privateOrderItems = parsedVal;
        if (keyStr.includes('erp_product_categories')) categories = parsedVal;
      }
    }
  } finally {
    await db.close();
  }

  console.log(`Loaded from DB: groups=${groups.length}, variants=${variants.length}, inventory=${inventory.length}`);

  const today = '2026-05-31';

  function calculateFinalMyacgDemand(myacgItemCode, inventoryList, salesOrderItemsList) {
    if (!myacgItemCode) return 0;
    const inv = inventoryList.find(i => i.myacg_item_code === myacgItemCode);
    if (!inv) return 0;
    
    // Sum of quantities in sales order items matching code
    const soldQty = salesOrderItemsList
      .filter(item => item.myacg_item_code === myacgItemCode)
      .reduce((sum, item) => sum + (item.quantity || 0), 0);
      
    return soldQty;
  }

  function getGroupDemandAndPurchased(groupId) {
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
  }

  function getTargetClosingDate(g) {
    if (g.purchase_date && g.purchase_date.trim() !== '') {
      return { date: g.purchase_date.trim(), type: 'purchase' };
    }
    if (g.closing_date && g.closing_date.trim() !== '') {
      return { date: g.closing_date.trim(), type: 'closing' };
    }
    return null;
  }

  function parseDateStr(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function getRemainingDays(dateStr) {
    const diffTime = parseDateStr(dateStr).getTime() - parseDateStr(today).getTime();
    return Math.round(diffTime / (1000 * 60 * 60 * 24));
  }

  const eligibleList = [];
  groups.forEach(g => {
    const target = getTargetClosingDate(g);
    if (!target) return;
    const { gap } = getGroupDemandAndPurchased(g.id);
    const days = getRemainingDays(target.date);
    const isEligible = (days >= 0 && days <= 7) || (days < 0 && gap > 0);
    
    if (isEligible) {
      eligibleList.push({
        title: g.title,
        targetDate: target.date,
        targetType: target.type,
        gap,
        diffDays: days
      });
    }
  });

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

  console.log('\n--- Top 10 sorted urgent items ---');
  eligibleList.slice(0, 10).forEach((item, idx) => {
    console.log(`${idx + 1}. [${item.targetType === 'purchase' ? '購買結單' : '官方結單'}] Date: ${item.targetDate} (${item.diffDays}d) | Gap: ${item.gap} | Name: ${item.title}`);
  });
}

run();
