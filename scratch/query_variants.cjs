const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);
const refreshToken = "uqwbhwllk7a4";

async function run() {
  console.log("Logging in to Supabase...");
  const { data: refreshData, error: refreshErr } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (refreshErr) {
    console.error("Login failed:", refreshErr.message);
    return;
  }

  const { data: categories, error: catsErr } = await supabase.from('product_categories').select('*');
  console.log(`Fetched ${categories ? categories.length : 0} categories:`, JSON.stringify(categories, null, 2));

  const { data: variants, error: varsErr } = await supabase.from('product_variants').select('*');
  console.log(`Fetched ${variants ? variants.length : 0} variants:`, JSON.stringify(variants, null, 2));
}

run().catch(console.error);
