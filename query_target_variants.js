const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const sessionFilePath = path.join(__dirname, 'last_session.json');

async function main() {
  let refreshToken = "6fxeqwjxy23d"; // Default session key
  
  if (fs.existsSync(sessionFilePath)) {
    try {
      const savedSession = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
      if (savedSession && savedSession.refresh_token) {
        refreshToken = savedSession.refresh_token;
      }
    } catch (e) {
      console.error("Error reading saved session:", e);
    }
  }

  const { data: refreshData, error: refreshErr } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (refreshErr) {
    console.error("Login failed:", refreshErr.message);
    return;
  }

  // Query product variants with SKU starting with GP00363845
  console.log("Querying variants for GP00363845...");
  const { data: variants, error: errVariants } = await supabase
    .from('product_variants')
    .select('*')
    .like('myacg_item_code', 'GP00363845%')
    .is('deleted_at', null);

  if (errVariants) {
    console.error("Error variants:", errVariants);
    return;
  }

  console.log(`Found ${variants.length} variants:`);
  const result = variants.map(v => ({
    id: v.id,
    myacg_item_code: v.myacg_item_code,
    variant_name: v.variant_name,
    raw_variant_name: v.raw_variant_name,
    sort_order: v.sort_order,
    import_sort_index: v.import_sort_index,
    product_category_id: v.product_category_id
  }));

  console.log(JSON.stringify(result, null, 2));

  // Let's also check if there is an inventory table data for GP00363845
  console.log("Querying inventory for GP00363845...");
  const { data: inventory, error: errInventory } = await supabase
    .from('inventory')
    .select('*')
    .like('myacg_item_code', 'GP00363845%');

  if (errInventory) {
    console.error("Error inventory:", errInventory);
  } else {
    console.log(`Found ${inventory.length} inventory items:`);
    console.log(JSON.stringify(inventory.map(i => ({
      myacg_item_code: i.myacg_item_code,
      import_sort_index: i.import_sort_index,
      raw_variant_name: i.raw_variant_name,
      product_title: i.product_title
    })), null, 2));
  }
}

main().catch(console.error);
