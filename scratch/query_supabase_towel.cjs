const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function run() {
  console.log("Querying Supabase for GP00361307 variants...");
  const { data: variants, error } = await supabase
    .from('product_variants')
    .select('*')
    .ilike('myacg_item_code', '%GP00361307%');
    
  if (error) {
    console.error("Error:", error);
  } else {
    console.log(`Found ${variants.length} matching variants:`);
    variants.forEach(v => {
      console.log(`- id: ${v.id} | SKU: ${v.myacg_item_code} | name: ${v.variant_name} | auto: ${v.myacg_auto_quantity} | eff: ${v.effective_myacg_quantity}`);
    });
  }
}

run();
