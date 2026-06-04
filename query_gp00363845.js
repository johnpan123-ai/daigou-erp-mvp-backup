import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function main() {
  const { data: allVariants, error: errVariants } = await supabase
    .from('product_variants')
    .select('*')
    .limit(5);
    
  if (errVariants) {
    console.error('Error fetching variants:', errVariants);
    return;
  }
  console.log("Total count from limit(5):", allVariants?.length);
  console.log(allVariants);
}
main();
