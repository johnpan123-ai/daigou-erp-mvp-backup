const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function main() {
  console.log("Testing tables...");
  
  const tables = ['product_groups', 'product_categories', 'product_variants', 'sales_orders', 'sales_order_items'];
  
  for (const table of tables) {
    try {
      const { data, error, count } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true });
        
      if (error) {
        console.log(`Table "${table}": Error ->`, error.message);
      } else {
        console.log(`Table "${table}": Success -> count = ${count}`);
      }
    } catch (e) {
      console.log(`Table "${table}": Exception ->`, e.message);
    }
  }
}

main().catch(console.error);
