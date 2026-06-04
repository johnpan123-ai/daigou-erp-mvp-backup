const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function run() {
  const email = 'hippotemp10544@gmail.com';
  const password = 'Password123!';

  console.log(`Logging in temporary user: ${email}...`);
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (signInError) {
    console.error("Sign in failed:", signInError.message);
    return;
  }

  const userId = signInData.user.id;
  console.log("Sign in success. User ID:", userId);

  console.log("=== Profile query ===");
  const { data: profiles, error: profileErr } = await supabase.from('profiles').select('*');
  if (profileErr) console.error("Error profile:", profileErr);
  else console.log("Profiles list:", profiles);

  console.log("=== Product Groups (No Filter) ===");
  const { data: groups, error: err1 } = await supabase.from('product_groups').select('*');
  if (err1) console.error("Error groups:", err1);
  else console.log("Groups:", groups);
}

run();
