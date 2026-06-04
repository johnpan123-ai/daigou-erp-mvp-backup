const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function main() {
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

  // Sort them by myacg_item_code naturally
  result.sort((a, b) => {
    const aNum = parseInt(a.myacg_item_code.split('_')[1] || '0');
    const bNum = parseInt(b.myacg_item_code.split('_')[1] || '0');
    return aNum - bNum;
  });

  console.log(JSON.stringify(result, null, 2));

  // Query inventory table
  console.log("Querying inventory for GP00363845...");
  const { data: inventory, error: errInventory } = await supabase
    .from('inventory')
    .select('*')
    .like('myacg_item_code', 'GP00363845%');

  if (errInventory) {
    console.error("Error inventory:", errInventory);
  } else {
    const sortedInv = inventory.map(i => ({
      myacg_item_code: i.myacg_item_code,
      import_sort_index: i.import_sort_index,
      raw_variant_name: i.raw_variant_name,
      product_title: i.product_title
    })).sort((a, b) => {
      const aNum = parseInt(a.myacg_item_code.split('_')[1] || '0');
      const bNum = parseInt(b.myacg_item_code.split('_')[1] || '0');
      return aNum - bNum;
    });
    console.log(`Found ${inventory.length} inventory items:`);
    console.log(JSON.stringify(sortedInv, null, 2));
  }
}

main().catch(console.error);
