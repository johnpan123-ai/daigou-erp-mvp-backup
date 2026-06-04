const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing environment variables!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function run() {
  console.log("=== Product Groups ===");
  const { data: groups, error: err1 } = await supabase.from('product_groups').select('*').is('deleted_at', null);
  if (err1) console.error(err1);
  else console.log(JSON.stringify(groups, null, 2));

  console.log("=== Product Categories ===");
  const { data: categories, error: err2 } = await supabase.from('product_categories').select('*').is('deleted_at', null);
  if (err2) console.error(err2);
  else console.log(JSON.stringify(categories, null, 2));

  console.log("=== Product Variants ===");
  const { data: variants, error: err3 } = await supabase.from('product_variants').select('*').is('deleted_at', null);
  if (err3) console.error(err3);
  else console.log(JSON.stringify(variants, null, 2));
}

run();
