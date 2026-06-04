const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const passwords = ['123456', 'password', 'hippo123', 'hippo1234', 'hippoowner', 'owner123', 'hippo+owner'];

async function test() {
  let session = null;
  for (const pw of passwords) {
    try {
      console.log(`Trying password: ${pw}...`);
      const { data, error } = await supabase.auth.signInWithPassword({
        email: 'hippo+owner@example.com',
        password: pw
      });
      if (!error && data.session) {
        console.log(`Success! Password is: ${pw}`);
        session = data.session;
        break;
      }
    } catch (e) {}
  }

  if (!session) {
    console.error("Could not log in!");
    return;
  }

  console.log("=== Product Groups ===");
  const { data: groups } = await supabase.from('product_groups').select('*');
  console.log(groups);

  console.log("=== Product Categories ===");
  const { data: categories } = await supabase.from('product_categories').select('*');
  console.log(categories);

  console.log("=== Product Variants ===");
  const { data: variants } = await supabase.from('product_variants').select('*');
  console.log(variants);
}

test();
