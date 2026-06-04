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
  console.log("Logged in as:", refreshData.user.email);

  const { data: groups, error: groupsErr } = await supabase.from('product_groups').select('*').limit(50);
  if (groupsErr) {
    console.error("Failed to query product_groups:", groupsErr);
    return;
  }

  console.log(`Fetched ${groups.length} product groups from Supabase:`);
  groups.forEach(g => {
    console.log(`- ID: ${g.id}, Title: ${g.title}, ListingType: ${g.listing_type}, CreatedAt: ${g.created_at}`);
  });
}

run().catch(console.error);
