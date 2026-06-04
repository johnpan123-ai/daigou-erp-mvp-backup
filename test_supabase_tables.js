const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: 'C:/Users/小河馬/.gemini/antigravity/scratch/daigou-erp-mvp/.env' });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function test() {
  const tables = [
    'product_groups',
    'product_categories',
    'product_variants',
    'purchase_batches',
    'purchase_batch_items',
    'private_orders',
    'private_order_items',
    'sales_orders',
    'sales_order_items'
  ];

  console.log("Checking tables in Supabase...");
  for (const table of tables) {
    const { data, error } = await supabase.from(table).select('id').limit(1);
    if (error) {
      console.log(`- ${table}: Error -> ${error.message} (${error.code})`);
    } else {
      console.log(`- ${table}: Success -> found ${data.length} rows (limit 1)`);
    }
  }
}

test().catch(console.error);
