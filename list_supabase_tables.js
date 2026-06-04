import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function main() {
  const { data, error } = await supabase.rpc('get_my_role'); // Test simple RPC
  console.log("RPC get_my_role test:", { data, error });

  // Let's try to query some public table we know exists, like product_groups
  const { data: groups, error: errGroups } = await supabase.from('product_groups').select('id').limit(1);
  console.log("Query product_groups test:", { count: groups ? groups.length : 0, error: errGroups });

  // Let's query public.product_variants
  const { data: variants, error: errVariants } = await supabase.from('product_variants').select('id').limit(1);
  console.log("Query product_variants test:", { count: variants ? variants.length : 0, error: errVariants });
}

main().catch(console.error);
