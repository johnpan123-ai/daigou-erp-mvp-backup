const fs = require('fs');
const path = require('path');
const playwright = require('playwright');

async function getLocalStorage(port) {
  const mockProfileDir = path.join(
    process.env.USERPROFILE,
    '.gemini',
    'antigravity',
    'scratch',
    `mock_profile_ls_${port}`
  );
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
  const mockLsDest = path.join(mockProfileDir, 'Default', 'Local Storage', 'leveldb');

  if (!fs.existsSync(chromeLsDir)) return null;
  if (!fs.existsSync(mockLsDest)) fs.mkdirSync(mockLsDest, { recursive: true });

  const files = fs.readdirSync(chromeLsDir);
  for (const f of files) {
    const src = path.join(chromeLsDir, f);
    const dest = path.join(mockLsDest, f);
    try {
      const stat = fs.statSync(src);
      if (stat.isFile()) fs.copyFileSync(src, dest);
    } catch (e) {}
  }

  const context = await playwright.chromium.launchPersistentContext(mockProfileDir, { headless: true });
  const page = await context.newPage();

  await page.route(`http://localhost:${port}/`, route => {
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>Mock Page</body></html>'
    });
  });

  try {
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 5000 });
  } catch (err) {}

  await page.waitForTimeout(1000);

  const data = await page.evaluate(() => {
    const res = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      res[key] = localStorage.getItem(key);
    }
    return res;
  });

  await context.close();
  return data;
}

async function run() {
  const ports = ['5173', '5174', '5180'];
  for (const port of ports) {
    console.log(`\n=================== PORT ${port} ===================`);
    const data = await getLocalStorage(port);
    if (!data) {
      console.log("No localStorage directory");
      continue;
    }
    const mode = data.erp_provider_mode;
    console.log(`Provider Mode: ${mode}`);

    const groups = data.erp_product_groups ? JSON.parse(data.erp_product_groups) : [];
    const categories = data.erp_product_categories ? JSON.parse(data.erp_product_categories) : [];
    const variants = data.erp_product_variants ? JSON.parse(data.erp_product_variants) : [];

    console.log(`Groups count: ${groups.length}`);
    console.log(`Categories count: ${categories.length}`);
    console.log(`Variants count: ${variants.length}`);

    // Print Hololive groups
    const holoGroups = groups.filter(g => g.title && g.title.includes('Hololive'));
    console.log(`Hololive groups found: ${holoGroups.length}`);
    holoGroups.forEach(g => {
      console.log(`  - Group ID: ${g.id}, Title: ${g.title}`);
    });

    // Print Hololive categories matching those groups
    const holoGroupIds = holoGroups.map(g => g.id);
    const holoCategories = categories.filter(c => holoGroupIds.includes(c.product_group_id));
    console.log(`Hololive categories found: ${holoCategories.length}`);
    holoCategories.forEach(c => {
      console.log(`  - Category ID: ${c.id}, Group ID: ${c.product_group_id}, Title: ${c.title}`);
    });

    // Print Hololive variants matching those groups
    const holoVariants = variants.filter(v => holoGroupIds.includes(v.product_group_id));
    console.log(`Hololive variants found: ${holoVariants.length}`);
    if (holoVariants.length > 0) {
      console.log(`  - Sample Variant ID: ${holoVariants[0].id}, Group ID: ${holoVariants[0].product_group_id}, Category ID: ${holoVariants[0].product_category_id}, Title: ${holoVariants[0].product_title}, Name: ${holoVariants[0].variant_name}`);
      const categoryMissing = holoVariants.filter(v => !v.product_category_id || !categories.some(c => c.id === v.product_category_id));
      console.log(`  - Variants with missing or invalid Category ID: ${categoryMissing.length}`);
    }
  }
}

run().catch(console.error);
