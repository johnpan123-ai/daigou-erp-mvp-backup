const { ClassicLevel } = require('classic-level');
const path = require('path');

const dbPath = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch\\leveldb_temp';

function getBaseSku(code) {
  if (!code) return '';
  const clean = code.trim().toUpperCase();
  const parts = clean.split('_');
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
    return parts.slice(0, -1).join('_');
  }
  return clean;
}

// 1. Original (Bugged) logic
function calculateOriginal(variantCode, salesOrderItems) {
  const cleanCode = variantCode.trim().toUpperCase();
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
  return orderDemand;
}

// 2. Corrected logic
function calculateCorrected(variantCode, salesOrderItems) {
  const cleanCode = variantCode.trim().toUpperCase();
  const baseVariant = getBaseSku(cleanCode);
  let orderDemand = 0;
  
  for (const item of salesOrderItems) {
    if (item.order_status && item.order_status.includes('已取消')) continue;
    const itemCode = item.myacg_item_code.trim().toUpperCase();
    const baseItem = getBaseSku(itemCode);
    if (
      itemCode === cleanCode ||
      (baseItem === baseVariant && (itemCode === baseItem || cleanCode === baseVariant))
    ) {
      orderDemand += item.quantity;
    }
  }
  return orderDemand;
}

async function main() {
  const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  let salesOrderItems = [];
  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      if (keyStr.includes('erp_import_batches') && keyStr.includes('localhost:5173')) {
        const valSlice = valBuf.slice(1);
        const batches = JSON.parse(valSlice.toString('utf16le'));
        batches.forEach(batch => {
          const items = batch.details?.newOrderItems || [];
          salesOrderItems.push(...items);
        });
      }
    }
  } catch(e) {
    console.error(e);
  } finally {
    await db.close();
  }

  console.log(`Loaded ${salesOrderItems.length} sales order items from import batches.`);
  
  const targetCode = 'GP00361307_6'; // 應援毛巾 雪花ラミィ
  console.log(`\n=== Testing variant: ${targetCode} ===`);
  
  const oldVal = calculateOriginal(targetCode, salesOrderItems);
  const newVal = calculateCorrected(targetCode, salesOrderItems);
  
  console.log(`Original calculated demand (Before Fix): ${oldVal}`);
  console.log(`Corrected calculated demand (After Fix): ${newVal}`);
  
  console.log(`\nDetailed items contributing to Original (Before Fix):`);
  salesOrderItems.forEach(item => {
    const itemCode = item.myacg_item_code.trim().toUpperCase();
    const baseItem = getBaseSku(itemCode);
    const baseVariant = getBaseSku(targetCode);
    if (
      itemCode === targetCode ||
      (baseItem === baseVariant && (itemCode === baseItem || targetCode === baseVariant)) ||
      (baseItem === baseVariant)
    ) {
      console.log(`  - SKU: ${item.myacg_item_code} | name: ${item.variant_name} | qty: ${item.quantity} | order_id: ${item.order_id}`);
    }
  });

  console.log(`\nDetailed items contributing to Corrected (After Fix):`);
  let countCorrected = 0;
  salesOrderItems.forEach(item => {
    const itemCode = item.myacg_item_code.trim().toUpperCase();
    const baseItem = getBaseSku(itemCode);
    const baseVariant = getBaseSku(targetCode);
    if (
      itemCode === targetCode ||
      (baseItem === baseVariant && (itemCode === baseItem || targetCode === baseVariant))
    ) {
      countCorrected++;
      console.log(`  - SKU: ${item.myacg_item_code} | name: ${item.variant_name} | qty: ${item.quantity} | order_id: ${item.order_id}`);
    }
  });
  if (countCorrected === 0) {
    console.log("  (No order items matched with corrected logic)");
  }
}

main().catch(console.error);
