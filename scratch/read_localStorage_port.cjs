const fs = require('fs');
const path = require('path');
const playwright = require('playwright');

const port = process.argv[2] || '5180';
console.log(`Target port to read localStorage: ${port}`);

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
  `mock_profile_ls_${port}`
);

const mockLsDest = path.join(
  mockProfileDir,
  'Default',
  'Local Storage',
  'leveldb'
);

if (!fs.existsSync(chromeLsDir)) {
  console.error(`Chrome Local Storage directory does not exist: ${chromeLsDir}`);
  process.exit(1);
}

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
  } catch (e) {
    console.warn(`Could not copy ${f}:`, e.message);
  }
}

async function run() {
  console.log(`Launching Playwright with mock profile for port ${port}...`);
  const context = await playwright.chromium.launchPersistentContext(mockProfileDir, {
    headless: true
  });

  const page = await context.newPage();
  
  // Intercept requests to mock localhost port
  await page.route(`http://localhost:${port}/`, route => {
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>Mock Page</body></html>'
    });
  });

  console.log(`Navigating to http://localhost:${port}/...`);
  try {
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 5000 });
  } catch (err) {
    console.warn(`Navigation error (continuing anyway):`, err.message);
  }

  // Brief pause to stabilize page load
  await page.waitForTimeout(1000);

  console.log("Reading localStorage inside page context...");
  const data = await page.evaluate(() => {
    const res = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      res[key] = localStorage.getItem(key);
    }
    return res;
  });

  console.log("LocalStorage keys found:", Object.keys(data));
  
  // Inspect specific ERP keys
  const keys = ['erp_provider_mode', 'erp_product_groups', 'erp_product_categories', 'erp_product_variants'];
  keys.forEach(k => {
    if (data[k]) {
      console.log(`\n=== Key: ${k} ===`);
      try {
        const parsed = JSON.parse(data[k]);
        console.log(`Count/Type: ${Array.isArray(parsed) ? parsed.length + ' items' : typeof parsed}`);
        if (k === 'erp_product_variants') {
          const hololive = parsed.filter(v => 
            (v.product_title && v.product_title.includes('Hololive')) || 
            (v.variant_name && v.variant_name.includes('Hololive'))
          );
          console.log("Matched Hololive variants in localStorage:", JSON.stringify(hololive, null, 2));
        } else if (k === 'erp_product_groups') {
          const hololive = parsed.filter(g => g.title && g.title.includes('Hololive'));
          console.log("Matched Hololive groups in localStorage:", JSON.stringify(hololive, null, 2));
        } else if (k === 'erp_product_categories') {
          console.log("Categories in localStorage:", JSON.stringify(parsed, null, 2));
        } else {
          console.log(parsed);
        }
      } catch (e) {
        console.log(data[k]);
      }
    } else {
      console.log(`\n=== Key: ${k} (Not Found) ===`);
    }
  });

  await context.close();
}

run().catch(console.error);
