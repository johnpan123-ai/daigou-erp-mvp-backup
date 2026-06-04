const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function test() {
  const email = `hippo_test_${Date.now()}@gmail.com`;
  const password = 'Password123!';
  console.log(`Trying signup for: ${email}...`);
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password
    });
    if (error) {
      console.error("Signup failed:", error.message);
    } else {
      console.log("Signup success! User:", data.user ? data.user.email : 'null');
      console.log("Session:", data.session ? 'created' : 'null');
    }
  } catch (e) {
    console.error("Exception:", e.message);
  }
}

test();
