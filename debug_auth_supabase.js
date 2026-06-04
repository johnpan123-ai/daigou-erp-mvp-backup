import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

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

  log("Attempting to sign up/sign in a debug user on Supabase...");
  const email = `debug_${Date.now()}@example.com`;
  const password = 'Password123!';

  // Try to sign up a temp user
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password
  });

  if (authError) {
    log(`Sign up failed: ${authError.message}. Trying sign in...`);
    // Try sign in with a default or just log error
  } else {
    log(`Sign up successful for user: ${authData.user?.email}`);
  }

  // Double check current session
  const { data: { session } } = await supabase.auth.getSession();
  log(`Session authenticated: ${!!session}`);

  log("Querying sales_orders...");
  const { data: salesOrders, error: errOrders } = await supabase
    .from('sales_orders')
    .select('*');

  if (errOrders) {
    log(`Error fetching sales_orders: ${JSON.stringify(errOrders)}`);
  } else {
    log(`sales_orders count: ${salesOrders.length}`);
  }

  log("Querying sales_order_items...");
  const { data: salesOrderItems, error: errItems } = await supabase
    .from('sales_order_items')
    .select('*');

  if (errItems) {
    log(`Error fetching sales_order_items: ${JSON.stringify(errItems)}`);
  } else {
    log(`sales_order_items count: ${salesOrderItems.length}`);
  }

  log("Querying product_variants...");
  const { data: productVariants, error: errVariants } = await supabase
    .from('product_variants')
    .select('*');

  if (errVariants) {
    log(`Error fetching product_variants: ${JSON.stringify(errVariants)}`);
  } else {
    log(`product_variants count: ${productVariants.length}`);
  }

  if (salesOrderItems && salesOrderItems.length > 0) {
    const targetSku = 'GP00361307';
    log(`\n=== Analyzing SKU in Supabase: ${targetSku} ===`);

    const matchedVariants = (productVariants || []).filter(v => 
      v.myacg_item_code && v.myacg_item_code.trim().toUpperCase().includes(targetSku)
    );
    log("\n--- Product Variants in Supabase ---");
    log(JSON.stringify(matchedVariants, null, 2));

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
    for (const o of (salesOrders || [])) {
      orderMap[o.id] = o;
    }

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
  }

  fs.writeFileSync(reportPath, logContent, 'utf8');
  log(`Report written to ${reportPath}`);
}

main().catch(console.error);
