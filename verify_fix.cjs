const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { ClassicLevel } = require('classic-level');

// Let's implement the updated getSoldQty helper
const getSoldQty = (rowData) => {
  const normKeys = Object.keys(rowData).map(k => ({
    original: k,
    normalized: k.replace(/[\s\u00a0\u200b\/]+/g, '')
  }));
  const keys = [
    '已售', '已售數量', '售出數量', '售出', '銷售', '銷售數量', 
    '總銷售數量', '總銷售已售數量', '總銷售'
  ];
  for (const k of keys) {
    const match = normKeys.find(nk => nk.normalized === k);
    if (match) {
      const val = rowData[match.original];
      if (val !== undefined && val !== null && val !== '') {
        return parseInt(String(val).replace(/[^0-9]/g, '') || '0', 10);
      }
    }
  }
  return 0;
};

const getAvailableQty = (rowData) => {
  const normKeys = Object.keys(rowData).map(k => ({
    original: k,
    normalized: k.replace(/[\s\u00a0\u200b\/]+/g, '')
  }));
  const keys = ['庫存', '庫存數量', '可用數量', '剩餘數量', '庫存可用數量', '可用'];
  for (const k of keys) {
    const match = normKeys.find(nk => nk.normalized === k);
    if (match) {
      const val = rowData[match.original];
      if (val !== undefined && val !== null && val !== '') {
        return parseInt(String(val).replace(/[^0-9]/g, '') || '0', 10);
      }
    }
  }
  return 0;
};

const getDemandQty = (rowData) => {
  const normKeys = Object.keys(rowData).map(k => ({
    original: k,
    normalized: k.replace(/[\s\u00a0\u200b\/]+/g, '')
  }));
  const keys = ['需求', '需求數量', '買動漫需求', '平台需求'];
  for (const k of keys) {
    const match = normKeys.find(nk => nk.normalized === k);
    if (match) {
      const val = rowData[match.original];
      if (val !== undefined && val !== null && val !== '') {
        return parseInt(String(val).replace(/[^0-9]/g, '') || '0', 10);
      }
    }
  }
  return 0;
};

const getValueByKeys = (rowData, keys) => {
  const normKeys = Object.keys(rowData).map(k => ({
    original: k,
    normalized: k.replace(/[\s\u00a0\u200b\/]+/g, '')
  }));
  const cleanKeys = keys.map(k => k.replace(/[\s\u00a0\u200b\/]+/g, ''));
  for (const cleanKey of cleanKeys) {
    const match = normKeys.find(nk => nk.normalized === cleanKey);
    if (match) {
      const val = rowData[match.original];
      if (val !== undefined && val !== null && val !== '') {
        return String(val).trim();
      }
    }
  }
  return '';
};

const codeKeys = ['商品編號', '商品代碼', '商品序號', '商品代號', '商品ID', 'SKU'];
const titleKeys = ['商品名稱', '名稱', '標題'];
const specKeys = ['規格項目', '規格', '項目', '規格項目'];
const typeKeys = ['商品種類', '種類', '商品類型', '類型'];
const priceKeys = ['價格', '單價', '售價', '價格單價'];
const listedKeys = ['刊登時間', '上架時間', '刊登日期'];

const downloadsDir = path.join(process.env.USERPROFILE, 'Downloads');
const file = path.join(downloadsDir, '399375_2026-05-30.xls');

console.log("Reading download file:", file);
const workbook = XLSX.readFile(file);
const firstSheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[firstSheetName];
const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

const targetSku = 'G07073119';
const matchedRow = jsonData.find(row => JSON.stringify(row).includes(targetSku));

if (!matchedRow) {
  console.error("SKU G07073119 not found in excel file!");
  process.exit(1);
}

// Map key row values
const rowData = {};
for (const key of Object.keys(matchedRow)) {
  const normKey = String(key).replace(/[\s\u00a0\u200b]+/g, ' ').trim();
  rowData[normKey] = matchedRow[key];
}

console.log("Found row in Excel for Miko:");
console.log(JSON.stringify(rowData, null, 2));

const parsedSoldQty = getSoldQty(rowData);
const parsedAvailableQty = getAvailableQty(rowData);
const parsedDemandQty = getDemandQty(rowData);

console.log("\n================ PARSED RESULTS ================");
console.log(`Parsed myacg_sold_quantity: ${parsedSoldQty}`);
console.log(`Parsed myacg_available_quantity: ${parsedAvailableQty}`);
console.log(`Parsed myacg_demand_quantity: ${parsedDemandQty}`);

// Open copied leveldb database
const tempDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  'leveldb_temp'
);

// We will query leveldb to verify calculateFinalMyacgDemand outcome
async function runDatabaseCheck() {
  const db = new ClassicLevel(tempDir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  const data = {};
  
  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      const targetKeys = [
        'erp_inventory',
        'erp_product_variants',
        'erp_sales_order_items',
        'erp_purchase_batch_items',
        'erp_private_order_items'
      ];
      
      for (const tKey of targetKeys) {
        if (keyStr.includes(tKey)) {
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
            data[tKey] = parsedVal;
          }
        }
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    await db.close();
  }
  
  const inventory = data['erp_inventory'] || [];
  const variants = data['erp_product_variants'] || [];
  const salesOrderItems = data['erp_sales_order_items'] || [];
  const batchItems = data['erp_purchase_batch_items'] || [];
  const privateOrderItems = data['erp_private_order_items'] || [];
  
  // Find G07073119 variant
  const variant = variants.find(v => v.myacg_item_code.trim().toUpperCase() === targetSku);
  
  // Update inventory record for G07073119 with new parsed value
  const matchedInvItem = inventory.find(i => i.myacg_item_code.trim().toUpperCase() === targetSku);
  if (matchedInvItem) {
    matchedInvItem.myacg_sold_quantity = parsedSoldQty;
    matchedInvItem.myacg_available_quantity = parsedAvailableQty;
    matchedInvItem.myacg_demand_quantity = parsedDemandQty;
    console.log("\nSimulated DB Update: InventoryItem updated successfully.");
  }
  
  // Compute calculateFinalMyacgDemand using the updated inventory
  const getBaseSku = (code) => {
    if (!code) return '';
    const clean = code.trim().toUpperCase();
    const parts = clean.split('_');
    if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
      return parts.slice(0, -1).join('_');
    }
    return clean;
  };
  
  const findMatchingInventoryItem = (variantCode, invList) => {
    if (!variantCode) return undefined;
    const cleanCode = variantCode.trim().toUpperCase();
    let matched = invList.find(i => i.myacg_item_code.trim().toUpperCase() === cleanCode);
    if (matched) return matched;
    const baseVariant = getBaseSku(cleanCode);
    matched = invList.find(i => {
      const iCode = i.myacg_item_code.trim().toUpperCase();
      const baseI = getBaseSku(iCode);
      return baseI === baseVariant && (iCode === baseI || cleanCode === baseVariant);
    });
    if (matched) return matched;
    return invList.find(i => {
      const iCode = i.myacg_item_code.trim().toUpperCase();
      return getBaseSku(iCode) === baseVariant;
    });
  };
  
  const calculateFinalMyacgDemand = (variantCode, invList, soiList) => {
    const invItem = findMatchingInventoryItem(variantCode, invList);
    const inventoryDemand = invItem ? (invItem.myacg_sold_quantity ?? invItem.myacg_demand_quantity) : undefined;
    
    const cleanCode = variantCode.trim().toUpperCase();
    const baseVariant = getBaseSku(cleanCode);
    let orderDemand = 0;
    
    for (const item of soiList) {
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
    
    return inventoryDemand != null && inventoryDemand > 0 ? inventoryDemand : orderDemand;
  };
  
  const finalMyacgDemand = calculateFinalMyacgDemand(targetSku, inventory, salesOrderItems);
  
  let orderDemand = 0;
  const cleanCode = targetSku.trim().toUpperCase();
  const baseVariant = getBaseSku(cleanCode);
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
  
  console.log("\n================ SIMULATED STATE AFTER FIX ================");
  console.log(`InventoryItem.myacg_sold_quantity: ${matchedInvItem ? matchedInvItem.myacg_sold_quantity : 'not found'}`);
  console.log(`orderDemand: ${orderDemand}`);
  console.log(`finalMyacgDemand: ${finalMyacgDemand}`);
  
  if (variant) {
    const myacgDemand = finalMyacgDemand + (variant.myacg_manual_adjustment || 0);
    const wacaDemand = (variant.waca_auto_quantity || 0) + (variant.waca_manual_adjustment || 0);
    const privateDemand = privateOrderItems.filter(poi => poi.product_variant_id === variant.id).reduce((sum, item) => sum + item.quantity, 0);
    const totalDemand = myacgDemand + wacaDemand + privateDemand;
    const purchased = batchItems.filter(pbi => pbi.product_variant_id === variant.id).reduce((sum, item) => sum + item.quantity, 0);
    const shortage = Math.max(totalDemand - purchased, 0);
    
    console.log(`totalDemand: ${totalDemand} (myacg: ${myacgDemand} + waca: ${wacaDemand} + private: ${privateDemand})`);
    console.log(`purchased: ${purchased}`);
    console.log(`shortage: ${shortage}`);
  }
}

runDatabaseCheck().catch(console.error);
