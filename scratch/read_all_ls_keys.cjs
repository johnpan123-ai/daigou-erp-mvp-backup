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
  const data73 = await getLocalStorage('5173');
  if (data73) {
    console.log("=== Port 5173 Keys ===");
    console.log(Object.keys(data73));
    const authKey = Object.keys(data73).find(k => k.includes('auth-token'));
    if (authKey) {
      console.log(`Auth key found: ${authKey}`);
      const val = JSON.parse(data73[authKey]);
      console.log(`Email: ${val?.user?.email}`);
      console.log(`Expires at: ${new Date(val?.expires_at * 1000).toISOString()}`);
      console.log(`JWT: ${val?.access_token?.substring(0, 30)}...`);
    }
  }

  const data74 = await getLocalStorage('5174');
  if (data74) {
    console.log("\n=== Port 5174 Keys ===");
    console.log(Object.keys(data74));
    const authKey = Object.keys(data74).find(k => k.includes('auth-token'));
    if (authKey) {
      console.log(`Auth key found: ${authKey}`);
      const val = JSON.parse(data74[authKey]);
      console.log(`Email: ${val?.user?.email}`);
      console.log(`Expires at: ${new Date(val?.expires_at * 1000).toISOString()}`);
      console.log(`JWT: ${val?.access_token?.substring(0, 30)}...`);
    }
  }
}

run().catch(console.error);
