const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

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
  console.log("Logged in successfully.");

  // Let's get one variant from Supabase
  const { data: variants, error: varsErr } = await supabase.from('product_variants').select('*').limit(1);
  if (varsErr || !variants || variants.length === 0) {
    console.error("No variants found in Supabase:", varsErr);
    return;
  }

  const targetVar = variants[0];
  console.log(`\nInitial variant from Supabase:`);
  console.log(`  ID: ${targetVar.id}`);
  console.log(`  SKU: ${targetVar.myacg_item_code}`);
  console.log(`  myacg_manual_adjustment: ${targetVar.myacg_manual_adjustment}`);

  // Simulate updating myacg_manual_adjustment to 3
  const nextVal = 3;
  console.log(`\nUpdating myacg_manual_adjustment to ${nextVal}...`);
  
  const { error: updateErr } = await supabase
    .from('product_variants')
    .upsert({
      ...targetVar,
      myacg_manual_adjustment: nextVal
    });

  if (updateErr) {
    console.error("Update failed:", updateErr);
    return;
  }
  console.log("Upserted successfully.");

  // Verify Supabase has the updated value
  const { data: verifiedVars } = await supabase.from('product_variants').select('*').eq('id', targetVar.id);
  console.log(`\nVerified value in Supabase:`);
  console.log(`  myacg_manual_adjustment: ${verifiedVars[0].myacg_manual_adjustment}`);

  // Restore the original value (or keep it as 3 for verification, we can set it back to original)
  console.log(`\nRestoring original value of ${targetVar.myacg_manual_adjustment}...`);
  await supabase.from('product_variants').upsert(targetVar);
  console.log("Restored.");
}

run().catch(console.error);
