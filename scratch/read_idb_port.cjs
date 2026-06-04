const fs = require('fs');
const path = require('path');
const playwright = require('playwright');

const port = process.argv[2] || '5180';
console.log(`Target port to read IndexedDB: ${port}`);

const chromeIdbDir = path.join(
  process.env.USERPROFILE,
  'AppData',
  'Local',
  'Google',
  'Chrome',
  'User Data',
  'Default',
  'IndexedDB',
  `http_localhost_${port}.indexeddb.leveldb`
);

const mockProfileDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  `mock_profile_${port}`
);

const mockIdbDest = path.join(
  mockProfileDir,
  'Default',
  'IndexedDB',
  `http_localhost_${port}.indexeddb.leveldb`
);

if (!fs.existsSync(chromeIdbDir)) {
  console.error(`Chrome IndexedDB directory for port ${port} does not exist: ${chromeIdbDir}`);
  process.exit(1);
}

if (!fs.existsSync(mockIdbDest)) {
  fs.mkdirSync(mockIdbDest, { recursive: true });
}

// Copy IndexedDB files to mock profile
const files = fs.readdirSync(chromeIdbDir);
for (const f of files) {
  const src = path.join(chromeIdbDir, f);
  const dest = path.join(mockIdbDest, f);
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
      body: '<html><body>Mock Origin Page</body></html>'
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

  console.log("Reading IndexedDB 'daigou_erp_db' inside page context...");
  const data = await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('daigou_erp_db');
      request.onerror = (err) => {
        reject(new Error("Failed to open DB: " + err.target.error));
      };
      request.onsuccess = (event) => {
        const db = event.target.result;
        const stores = Array.from(db.objectStoreNames);
        const results = { stores };
        
        let pending = stores.length;
        if (pending === 0) {
          resolve(results);
          return;
        }
        
        const tx = db.transaction(stores, 'readonly');
        stores.forEach(storeName => {
          const store = tx.objectStore(storeName);
          const req = store.getAll();
          req.onsuccess = (ev) => {
            results[storeName] = ev.target.result;
            pending--;
            if (pending === 0) {
              resolve(results);
            }
          };
          req.onerror = () => {
            pending--;
            if (pending === 0) {
              resolve(results);
            }
          };
        });
      };
    });
  });

  console.log("IndexedDB stores found:", data.stores);
  
  if (data.product_groups) {
    console.log(`\n=== Product Groups (Local IndexedDB - Port ${port}) ===`);
    console.log(JSON.stringify(data.product_groups, null, 2));
  }
  if (data.product_categories) {
    console.log(`\n=== Product Categories (Local IndexedDB - Port ${port}) ===`);
    console.log(JSON.stringify(data.product_categories, null, 2));
  }
  if (data.product_variants) {
    console.log(`\n=== Product Variants (Local IndexedDB - Port ${port}) ===`);
    const matched = data.product_variants.filter(v => 
      (v.product_title && v.product_title.includes('Hololive')) || 
      (v.variant_name && v.variant_name.includes('Hololive'))
    );
    console.log("Matched Hololive variants:", JSON.stringify(matched, null, 2));
    console.log(`Total variants count: ${data.product_variants.length}`);
  }

  await context.close();
}

run().catch(console.error);
