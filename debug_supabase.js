import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const reportPath = 'C:/Users/小河馬/.gemini/antigravity/scratch/debug_supabase_report.txt';

async function main() {
  let logContent = "";
  function log(msg) {
    logContent += msg + "\n";
    console.log(msg);
  }

  log("Connecting to Supabase...");

  // 1. Fetch sales_orders
  const { data: salesOrders, error: errOrders } = await supabase
    .from('sales_orders')
    .select('*');
  if (errOrders) {
    log(`Error fetching sales_orders: ${JSON.stringify(errOrders)}`);
    return;
  }

  // 2. Fetch sales_order_items
  const { data: salesOrderItems, error: errItems } = await supabase
    .from('sales_order_items')
    .select('*');
  if (errItems) {
    log(`Error fetching sales_order_items: ${JSON.stringify(errItems)}`);
    return;
  }

  // 3. Fetch product_variants
  const { data: productVariants, error: errVariants } = await supabase
    .from('product_variants')
    .select('*');
  if (errVariants) {
    log(`Error fetching product_variants: ${JSON.stringify(errVariants)}`);
    return;
  }

  // 4. Fetch inventory
  const { data: inventory, error: errInventory } = await supabase
    .from('inventory')
    .select('*');
  let finalInventory = inventory;
  if (errInventory) {
    log(`Warning/Error fetching inventory: ${JSON.stringify(errInventory)}`);
    // Note: some tables might be named differently, let's verify if 'inventory' or 'erp_inventory' is used
    log("Trying 'erp_inventory'...");
    const { data: erpInv, error: errErpInv } = await supabase
      .from('erp_inventory')
      .select('*');
    if (errErpInv) {
      log(`Error fetching erp_inventory: ${JSON.stringify(errErpInv)}`);
    } else {
      finalInventory = erpInv;
    }
  }

  log("\n=== Supabase Database Statistics ===");
  log(`sales_orders count: ${salesOrders ? salesOrders.length : 0}`);
  log(`sales_order_items count: ${salesOrderItems ? salesOrderItems.length : 0}`);
  log(`product_variants count: ${productVariants ? productVariants.length : 0}`);
  log(`inventory count: ${finalInventory ? finalInventory.length : 0}`);

  const targetSku = 'GP00361307';
  log(`\n=== Analyzing SKU: ${targetSku} ===`);

  // Target item is 應援毛巾. Let's find related variants
  const matchedVariants = (productVariants || []).filter(v => 
    v.myacg_item_code && v.myacg_item_code.trim().toUpperCase().includes(targetSku)
  );

  log("\n--- Product Variants in Supabase ---");
  log(JSON.stringify(matchedVariants, null, 2));

  // Find related inventory items
  const matchedInventory = (finalInventory || []).filter(i => 
    i.myacg_item_code && i.myacg_item_code.trim().toUpperCase().includes(targetSku)
  );
  log("\n--- Inventory Items in Supabase ---");
  log(JSON.stringify(matchedInventory, null, 2));

  // Base SKU Helper
  const getBaseSku = (code) => {
    if (!code) return '';
    const clean = code.trim().toUpperCase();
    const parts = clean.split('_');
    if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
      return parts.slice(0, -1).join('_');
    }
    return clean;
  };

  const cleanTargetSku = targetSku.trim().toUpperCase();
  const baseVariant = getBaseSku(cleanTargetSku);

  // Map order id to order
  const orderMap = {};
  for (const o of (salesOrders || [])) {
    orderMap[o.id] = o;
  }

  // Check sales_order_items
  const matchedOrderItems = [];
  let sumQuantity = 0;

  for (const item of (salesOrderItems || [])) {
    const itemCode = item.myacg_item_code ? item.myacg_item_code.trim().toUpperCase() : '';
    const baseItem = getBaseSku(itemCode);
    const order = orderMap[item.order_id] || {};
    
    // Condition for match
    const isExactMatch = itemCode === cleanTargetSku;
    const isBaseMatch = baseItem === baseVariant;
    
    if (isExactMatch || isBaseMatch) {
      const isCancelled = item.order_status && item.order_status.includes('已取消');
      if (!isCancelled) {
        sumQuantity += item.quantity || 0;
      }
      matchedOrderItems.push({
        id: item.id,
        order_id: item.order_id,
        order_number: order.order_number || 'UNKNOWN',
        myacg_item_code: item.myacg_item_code,
        variant_name: item.variant_name || item.product_name || 'UNKNOWN',
        quantity: item.quantity,
        order_status: item.order_status || 'UNKNOWN',
        isCancelled: !!isCancelled,
        matchingReason: isExactMatch ? 'Exact Match' : 'Base SKU Match'
      });
    }
  }

  log("\n--- Matching Sales Order Items ---");
  log(JSON.stringify(matchedOrderItems, null, 2));
  log(`\nTotal Quantity from non-cancelled matching items: ${sumQuantity}`);

  // Duplicate analysis by order_number + item_code
  const orderNumberCounts = {};
  const duplicateOrders = [];
  for (const item of matchedOrderItems) {
    if (item.isCancelled) continue;
    const key = `${item.order_number}_${item.myacg_item_code}`;
    orderNumberCounts[key] = (orderNumberCounts[key] || 0) + 1;
    if (orderNumberCounts[key] > 1) {
      duplicateOrders.push(item);
    }
  }

  if (duplicateOrders.length > 0) {
    log("\n--- Detection: Potential Duplicate Import ---");
    log("Found multiple order items with the same order_number + item_code:");
    log(JSON.stringify(duplicateOrders, null, 2));
  } else {
    log("\n--- Detection: No duplicates within matched items by (order_number + item_code) ---");
  }

  // Check how 57 was obtained:
  log("\n--- Step-by-Step Calculation to 57 ---");
  log(`Is there a matched variant? ${matchedVariants.length > 0 ? 'Yes' : 'No'}`);
  matchedVariants.forEach(v => {
    log(`Variant Code: ${v.myacg_item_code} | Title: ${v.product_title} | Spec: ${v.variant_name}`);
    log(`  Manual Adjustment: ${v.myacg_manual_adjustment || 0}`);
    log(`  Effective Myacg Quantity in DB: ${v.effective_myacg_quantity}`);
    log(`  Myacg Auto Quantity in DB: ${v.myacg_auto_quantity}`);
    log(`  Waca Auto Quantity: ${v.waca_auto_quantity}`);
  });

  // Specifically check for '應援毛巾' variants.
  // There could be multiple variants sharing GP00361307 like:
  // GP00361307_6 (應援毛巾 雪花ラミィ), GP00361307_7 (應援毛巾 桃鈴ねね), etc.
  log("\n--- Breakdown of all variants sharing base SKU: GP00361307 ---");
  const towelVariants = (productVariants || []).filter(v => 
    v.myacg_item_code && getBaseSku(v.myacg_item_code) === 'GP00361307'
  );
  towelVariants.forEach(v => {
    log(`Variant: ${v.myacg_item_code} | Spec: ${v.variant_name} | MyACG Auto Qty: ${v.myacg_auto_quantity}`);
  });

  fs.writeFileSync(reportPath, logContent, 'utf8');
  log(`\nReport successfully written to ${reportPath}`);
}

main().catch(console.error);
