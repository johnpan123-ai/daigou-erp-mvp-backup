const fs = require('fs');
const path = require('path');
const playwright = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const port = '5173';
console.log(`Using port ${port} for integration test.`);

const chromeLsDir = path.join(
  process.env.USERPROFILE,
  'AppData',
  'Local',
  'Google',
  'Chrome',
  'User Data',
  'Default',
  'Local Storage',
  'leveldb'
);

const mockProfileDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  `mock_profile_test_${port}`
);

const mockLsDest = path.join(
  mockProfileDir,
  'Default',
  'Local Storage',
  'leveldb'
);

if (!fs.existsSync(mockLsDest)) {
  fs.mkdirSync(mockLsDest, { recursive: true });
}

// Copy Local Storage LevelDB files to mock profile
const files = fs.readdirSync(chromeLsDir);
for (const f of files) {
  const src = path.join(chromeLsDir, f);
  const dest = path.join(mockLsDest, f);
  try {
    const stat = fs.statSync(src);
    if (stat.isFile()) {
      fs.copyFileSync(src, dest);
    }
  } catch (e) {}
}

const supabaseUrl = 'https://twzpqyesbtnfxdkorluf.supabase.co/';
const supabaseAnonKey = 'sb_publishable_ni9W6dRspdwWqikkfRuUHw_JiN04Veq';
const supabase = createClient(supabaseUrl, supabaseAnonKey);
const refreshToken = "uqwbhwllk7a4";

async function run() {
  console.log("Logging in to Supabase to clear any existing Hololive test data...");
  const { data: refreshData, error: refreshErr } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (refreshErr) {
    console.error("Login failed:", refreshErr.message);
    return;
  }
  const email = refreshData.user.email;
  console.log(`Logged in as: ${email}`);

  // Fresh session details to pass to browser
  const sessionString = JSON.stringify(refreshData.session);

  // Delete test Hololive group from Supabase if it exists
  const groupId = "55674068-ad12-4a53-b998-2949807d9d96"; // Hololive group ID on port 5173
  console.log(`Deleting group ${groupId} from Supabase...`);
  await supabase.from('product_groups').delete().eq('id', groupId);

  console.log("Launching browser...");
  const context = await playwright.chromium.launchPersistentContext(mockProfileDir, {
    headless: true
  });

  const page = await context.newPage();

  page.on('console', msg => {
    console.log(`[BROWSER CONSOLE] ${msg.text()}`);
  });

  console.log(`Navigating to http://localhost:${port}/ ...`);
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  console.log("Injecting active authenticated session and setting provider mode to cloud...");
  await page.evaluate(({ sessionStr }) => {
    localStorage.setItem('sb-twzpqyesbtnfxdkorluf-auth-token', sessionStr);
    localStorage.setItem('erp_provider_mode', 'cloud');
  }, { sessionStr: sessionString });

  // Reload page to apply session changes
  console.log("Reloading page to apply changes...");
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  console.log("Running createPurchaseRecordFromInventory on Hololive items inside page context...");
  const evalResult = await page.evaluate(async (gid) => {
    try {
      const module = await import('/src/providers/dataProvider.ts');
      const provider = module.dataProvider;
      
      console.log("Current provider mode is:", localStorage.getItem('erp_provider_mode'));
      console.log("Running createPurchaseRecordFromInventory for GP00363343_2...");
      
      await provider.createPurchaseRecordFromInventory(['GP00363343_2']);
      console.log("createPurchaseRecordFromInventory completed!");
      return { success: true };
    } catch (e) {
      console.error("Error in browser context:", e);
      return { success: false, error: e.message };
    }
  }, groupId);

  console.log("Evaluation result:", evalResult);

  // Wait a bit for async pushes to finish
  console.log("Waiting 5 seconds for pushes to finish...");
  await page.waitForTimeout(5000);

  await context.close();

  // Verify Supabase contents
  console.log("\nVerifying Supabase database tables for Hololive...");
  const { data: dbGroups } = await supabase.from('product_groups').select('*').eq('id', groupId);
  console.log(`Hololive Groups in Supabase:`, JSON.stringify(dbGroups, null, 2));

  const { data: dbCats } = await supabase.from('product_categories').select('*').eq('product_group_id', groupId);
  console.log(`Hololive Categories in Supabase:`, JSON.stringify(dbCats, null, 2));

  const { data: dbVars } = await supabase.from('product_variants').select('*').eq('product_group_id', groupId);
  console.log(`Hololive Variants in Supabase count: ${dbVars ? dbVars.length : 0}`);
  if (dbVars && dbVars.length > 0) {
    console.log(`Sample Hololive Variant:`, JSON.stringify(dbVars[0], null, 2));
  }
}

run().catch(console.error);
