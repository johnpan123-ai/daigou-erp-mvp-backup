const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const refreshToken = "uqwbhwllk7a4";

async function run() {
  console.log("Refreshing session using refresh token...");
  const { data: refreshData, error: refreshErr } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  
  if (refreshErr) {
    console.error("Refresh session failed:", refreshErr.message);
    return;
  }
  
  const user = refreshData.user;
  console.log("Logged in user:", user.email);

  console.log("\n=== Supabase: product_groups ===");
  const { data: groups, error: err1 } = await supabase.from('product_groups').select('*');
  if (err1) console.error(err1);
  else console.log(JSON.stringify(groups, null, 2));

  console.log("\n=== Supabase: product_categories ===");
  const { data: categories, error: err2 } = await supabase.from('product_categories').select('*');
  if (err2) console.error(err2);
  else console.log(JSON.stringify(categories, null, 2));

  console.log("\n=== Supabase: product_variants ===");
  const { data: variants, error: err3 } = await supabase.from('product_variants').select('*');
  if (err3) console.error(err3);
  else {
    console.log(`Total variants in Supabase: ${variants.length}`);
    const hololive = variants.filter(v => v.product_title && v.product_title.includes('Hololive'));
    console.log("Hololive variants in Supabase:", JSON.stringify(hololive, null, 2));
  }
}

run().catch(console.error);
