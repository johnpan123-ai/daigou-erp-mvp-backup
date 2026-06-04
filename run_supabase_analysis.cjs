const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function main() {
  console.log(`Logging in to Supabase...`);
  const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
    email: 'hippotemp10544@gmail.com',
    password: 'Password123!'
  });
  
  if (signInErr) {
    console.error("Supabase login failed:", signInErr.message);
    return;
  }

  console.log(`Logged in successfully as: ${signInData.user.email}`);

  // Fetch sales_orders
  console.log("Fetching sales_orders...");
  const { data: salesOrders, error: errOrders } = await supabase
    .from('sales_orders')
    .select('*')
    .is('deleted_at', null);

  if (errOrders) {
    console.error("Error fetching sales_orders:", errOrders);
    return;
  }
  console.log(`Fetched ${salesOrders.length} sales_orders`);

  // Fetch sales_order_items
  console.log("Fetching sales_order_items...");
  const { data: salesOrderItems, error: errItems } = await supabase
    .from('sales_order_items')
    .select('*')
    .is('deleted_at', null);

  if (errItems) {
    console.error("Error fetching sales_order_items:", errItems);
    return;
  }
  console.log(`Fetched ${salesOrderItems.length} sales_order_items`);

  // Fetch product_variants
  console.log("Fetching product_variants...");
  const { data: productVariants, error: errVariants } = await supabase
    .from('product_variants')
    .select('*')
    .is('deleted_at', null);

  if (errVariants) {
    console.error("Error fetching product_variants:", errVariants);
    return;
  }
  console.log(`Fetched ${productVariants.length} product_variants`);

  // Run analysis for SKU GP00361307
  const targetSku = 'GP00361307';
  console.log(`Running demand calculation analysis for SKU: ${targetSku}...`);

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

  // Filter sales order items that map to this base SKU
  const matchedOrderItems = [];
  let sumAll = 0;
  let sumNonCancelled = 0;

  for (const item of salesOrderItems) {
    const itemCode = item.myacg_item_code ? item.myacg_item_code.trim().toUpperCase() : '';
    const baseItem = getBaseSku(itemCode);
    const order = orderMap[item.order_id] || {};

    const isExactMatch = itemCode === cleanTargetSku;
    const isBaseMatch = baseItem === baseVariant;

    if (isExactMatch || isBaseMatch) {
      const isCancelled = item.order_status && item.order_status.includes('已取消');
      sumAll += item.quantity || 0;
      if (!isCancelled) {
        sumNonCancelled += item.quantity || 0;
      }
      matchedOrderItems.push({
        id: item.id,
        order_id: item.order_id,
        order_number: order.order_number || 'UNKNOWN',
        platform: order.platform || 'UNKNOWN',
        buyer_name: order.buyer_name || 'UNKNOWN',
        myacg_item_code: item.myacg_item_code,
        product_name: item.product_name || 'UNKNOWN',
        variant_name: item.variant_name || 'UNKNOWN',
        quantity: item.quantity,
        price: item.price,
        amount: item.amount,
        order_status: item.order_status || 'UNKNOWN',
        isCancelled: !!isCancelled,
        matchingReason: isExactMatch ? 'Exact Match' : 'Base SKU Match'
      });
    }
  }

  // Filter product variants for this SKU in Supabase
  const matchedVariants = productVariants.filter(v => 
    v.myacg_item_code && getBaseSku(v.myacg_item_code) === baseVariant
  );

  const analysisResult = {
    targetSku,
    baseVariant,
    totalSalesOrderItemsCount: salesOrderItems.length,
    totalSalesOrdersCount: salesOrders.length,
    matchingOrderItems: matchedOrderItems,
    sumAll,
    sumNonCancelled,
    variantsInSupabase: matchedVariants.map(v => ({
      id: v.id,
      myacg_item_code: v.myacg_item_code,
      product_title: v.product_title,
      variant_name: v.variant_name,
      myacg_auto_quantity: v.myacg_auto_quantity,
      effective_myacg_quantity: v.effective_myacg_quantity,
      myacg_manual_adjustment: v.myacg_manual_adjustment
    }))
  };

  fs.writeFileSync(path.join(__dirname, 'towel_analysis.json'), JSON.stringify(analysisResult, null, 2), 'utf8');
  console.log("Analysis results written to towel_analysis.json successfully!");
  console.log(`Total matching items quantity: ${sumAll} (all), ${sumNonCancelled} (excluding cancelled)`);
}

main().catch(console.error);
