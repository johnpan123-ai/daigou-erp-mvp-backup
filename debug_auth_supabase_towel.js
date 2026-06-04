import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const refreshToken = 'uqwbhwllk7a4';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const reportPath = 'C:/Users/小河馬/.gemini/antigravity/scratch/debug_supabase_report.txt';

async function main() {
  let logContent = "";
  function log(msg) {
    logContent += msg + "\n";
    console.log(msg);
  }

  log("Attempting to login to Supabase using refresh_token...");
  const { data: refreshData, error: refreshErr } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (refreshErr) {
    log(`Login failed: ${refreshErr.message}`);
    return;
  }
  
  log(`Login successful! Logged in as: ${refreshData.user?.email}`);

  // Fetch sales_orders
  log("Querying sales_orders from Supabase...");
  const { data: salesOrders, error: errOrders } = await supabase
    .from('sales_orders')
    .select('*')
    .is('deleted_at', null);

  if (errOrders) {
    log(`Error fetching sales_orders: ${JSON.stringify(errOrders)}`);
    return;
  }
  log(`sales_orders count: ${salesOrders.length}`);

  // Fetch sales_order_items
  log("Querying sales_order_items from Supabase...");
  const { data: salesOrderItems, error: errItems } = await supabase
    .from('sales_order_items')
    .select('*')
    .is('deleted_at', null);

  if (errItems) {
    log(`Error fetching sales_order_items: ${JSON.stringify(errItems)}`);
    return;
  }
  log(`sales_order_items count: ${salesOrderItems.length}`);

  // Fetch product_variants
  log("Querying product_variants from Supabase...");
  const { data: productVariants, error: errVariants } = await supabase
    .from('product_variants')
    .select('*')
    .is('deleted_at', null);

  if (errVariants) {
    log(`Error fetching product_variants: ${JSON.stringify(errVariants)}`);
    return;
  }
  log(`product_variants count: ${productVariants.length}`);

  // Fetch inventory
  log("Querying inventory from Local/Chrome since it is not synced, or checking if it exists in Supabase...");
  const { data: inventory, error: errInventory } = await supabase
    .from('inventory')
    .select('*');
  let finalInventory = inventory || [];
  if (errInventory) {
    log(`Supabase inventory query error: ${errInventory.message}. Trying erp_inventory...`);
    const { data: erpInv, error: errErpInv } = await supabase.from('erp_inventory').select('*');
    if (!errErpInv) finalInventory = erpInv || [];
  }
  log(`inventory count in Supabase: ${finalInventory.length}`);

  const targetSku = 'GP00361307';
  log(`\n=== Analyzing SKU in Supabase: ${targetSku} ===`);

  // Product variants
  const matchedVariants = productVariants.filter(v => 
    v.myacg_item_code && v.myacg_item_code.trim().toUpperCase().includes(targetSku)
  );
  log("\n--- Product Variants in Supabase ---");
  log(JSON.stringify(matchedVariants, null, 2));

  // Base SKU helper
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

  const orderMap = {};
  for (const o of salesOrders) {
    orderMap[o.id] = o;
  }

  // Find matching sales order items
  const matchedOrderItems = [];
  let sumQuantity = 0;

  for (const item of salesOrderItems) {
    const itemCode = item.myacg_item_code ? item.myacg_item_code.trim().toUpperCase() : '';
    const baseItem = getBaseSku(itemCode);
    const order = orderMap[item.order_id] || {};
    
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

  log("\n--- Matching Sales Order Items in Supabase ---");
  log(JSON.stringify(matchedOrderItems, null, 2));
  log(`\nTotal Quantity from non-cancelled matching items: ${sumQuantity}`);

  // Duplicate analysis
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

  // Breakdown of towel variants sharing GP00361307
  log("\n--- Breakdown of all variants sharing base SKU: GP00361307 ---");
  const towelVariants = productVariants.filter(v => v.myacg_item_code && getBaseSku(v.myacg_item_code) === 'GP00361307');
  towelVariants.forEach(v => {
    log(`Variant: ${v.myacg_item_code} | Spec: ${v.variant_name} | MyACG Auto Qty: ${v.myacg_auto_quantity} | Effective MyACG: ${v.effective_myacg_quantity}`);
  });

  fs.writeFileSync(reportPath, logContent, 'utf8');
  log(`\nReport successfully written to ${reportPath}`);
}

main().catch(console.error);
