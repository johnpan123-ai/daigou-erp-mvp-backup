import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

// Parse .env manually
const envContent = fs.readFileSync('.env', 'utf8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim();
      envVars[key] = val;
    }
  }
});

const supabaseUrl = envVars.VITE_SUPABASE_URL;
const supabaseAnonKey = envVars.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function check() {
  try {
    // 1. sales_order_items 總筆數
    const { count, error: countErr } = await supabase
      .from('sales_order_items')
      .select('*', { count: 'exact', head: true });

    if (countErr) {
      console.log('Error counting items:', countErr.message);
    } else {
      console.log('Total sales_order_items count in Supabase:', count);
    }

    // 2. Query orders for the item code
    const { data: items, error: itemsErr } = await supabase
      .from('sales_order_items')
      .select('*, sales_orders(order_number, platform, buyer_name)')
      .eq('myacg_item_code', 'GP00361307');

    if (itemsErr) {
      console.log('Error querying items by code:', itemsErr.message);
      return;
    }

    console.log('\nMatching sales_order_items for GP00361307:');
    console.log(JSON.stringify(items, null, 2));

    // Calculate the total quantity
    let totalQty = 0;
    let nonCancelledQty = 0;
    for (const item of items) {
      totalQty += item.quantity;
      if (!item.order_status || !item.order_status.includes('已取消')) {
        nonCancelledQty += item.quantity;
      }
    }
    console.log(`\nSummary:`);
    console.log(`Total Quantity including cancelled: ${totalQty}`);
    console.log(`Total Quantity excluding cancelled: ${nonCancelledQty}`);

  } catch (err) {
    console.error('Exception:', err);
  }
}

check();
