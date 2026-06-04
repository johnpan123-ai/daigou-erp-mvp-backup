const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const refreshToken = "uqwbhwllk7a4";

// Hololive group to insert
const group = {
  id: "83c3add1-b3c9-47c5-a099-2714acace468",
  local_id: "83c3add1-b3c9-47c5-a099-2714acace468",
  title: "【小河馬日本代購】預購 26年12月 Hololive 1期生 1st Generation Anniversary Parade Celestial週年系列商品",
  listing_type: "一般預購",
  priority: "Medium"
};

// Hololive categories
const categories = [
  {
    id: "a74a785d-c769-4b5c-b55f-03aaa990ead5",
    local_id: "a74a785d-c769-4b5c-b55f-03aaa990ead5",
    product_group_id: "83c3add1-b3c9-47c5-a099-2714acace468",
    title: "壓克力立牌",
    sort_order: 0
  }
];

// Hololive variants
const variants = [
  {
    id: "d3481d28-c6f2-4722-a112-c1463a7c6ae2",
    local_id: "d3481d28-c6f2-4722-a112-c1463a7c6ae2",
    product_group_id: "83c3add1-b3c9-47c5-a099-2714acace468",
    product_category_id: "a74a785d-c769-4b5c-b55f-03aaa990ead5",
    myacg_item_code: "GP00363343_2",
    product_title: "【小河馬日本代購】預購 26年12月 Hololive 1期生 1st Generation Anniversary Parade Celestial週年系列商品",
    variant_name: "アキ・ローゼンタール"
  }
];

async function run() {
  console.log("Logging in...");
  const { data: refreshData, error: refreshErr } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (refreshErr) {
    console.error("Login failed:", refreshErr.message);
    return;
  }

  // Scenario 1: Upsert variant directly (without group or category existing in Supabase)
  console.log("\n--- Scenario 1: Upserting variant directly (parent group and category missing in Supabase) ---");
  const { error: errVar } = await supabase.from('product_variants').upsert(variants);
  if (errVar) {
    console.log("Upsert variant failed with expected error:");
    console.log(JSON.stringify(errVar, null, 2));
  } else {
    console.log("Upsert variant succeeded unexpectedly!");
  }

  // Scenario 2: Upsert group, then variant (without category existing in Supabase)
  console.log("\n--- Scenario 2: Upserting group, then variant (category missing in Supabase) ---");
  const { error: errGroup } = await supabase.from('product_groups').upsert([group]);
  if (errGroup) {
    console.error("Upsert group failed:", errGroup.message);
    return;
  }
  console.log("Upsert group succeeded.");

  const { error: errVar2 } = await supabase.from('product_variants').upsert(variants);
  if (errVar2) {
    console.log("Upsert variant failed with expected error:");
    console.log(JSON.stringify(errVar2, null, 2));
  } else {
    console.log("Upsert variant succeeded unexpectedly!");
  }

  // Clean up group
  console.log("\nCleaning up inserted group...");
  await supabase.from('product_groups').delete().eq('id', group.id);
}

run().catch(console.error);
