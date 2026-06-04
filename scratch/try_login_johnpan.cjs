const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const passwords = [
  'johnpan123', 'johnpan', 'john123', 'johnpan12345', 'johnpan123@gmail.com',
  'johnpan123!', 'Johnpan123!', 'JohnPan123!', 'JohnPan123', '12345678', '00000000'
];

async function test() {
  let session = null;
  for (const pw of passwords) {
    try {
      console.log(`Trying password for johnpan123@gmail.com: ${pw}...`);
      const { data, error } = await supabase.auth.signInWithPassword({
        email: 'johnpan123@gmail.com',
        password: pw
      });
      if (!error && data.session) {
        console.log(`Success! Password is: ${pw}`);
        session = data.session;
        break;
      } else if (error) {
        console.log(`  Failed: ${error.message}`);
      }
    } catch (e) {
      console.log("  Exception:", e.message);
    }
  }

  if (!session) {
    console.error("Could not log in!");
    return;
  }
}

test();
