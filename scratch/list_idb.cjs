const fs = require('fs');
const path = require('path');
const playwright = require('playwright');

async function checkPort(port) {
  console.log(`Checking port ${port}...`);
  const mockProfileDir = path.join(
    process.env.USERPROFILE,
    '.gemini',
    'antigravity',
    'scratch',
    `mock_profile_${port}`
  );

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

  const mockIdbDest = path.join(
    mockProfileDir,
    'Default',
    'IndexedDB',
    `http_localhost_${port}.indexeddb.leveldb`
  );

  if (!fs.existsSync(chromeIdbDir)) {
    console.log(`Port ${port} IndexedDB directory not found`);
    return;
  }

  if (!fs.existsSync(mockIdbDest)) {
    fs.mkdirSync(mockIdbDest, { recursive: true });
  }

  const files = fs.readdirSync(chromeIdbDir);
  for (const f of files) {
    const src = path.join(chromeIdbDir, f);
    const dest = path.join(mockIdbDest, f);
    try {
      const stat = fs.statSync(src);
      if (stat.isFile()) fs.copyFileSync(src, dest);
    } catch (e) {}
  }

  const context = await playwright.chromium.launchPersistentContext(mockProfileDir, {
    headless: true
  });
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

  const dbs = await page.evaluate(async () => {
    if (indexedDB.databases) {
      return await indexedDB.databases();
    }
    return "indexedDB.databases() not supported";
  });

  console.log(`Databases for port ${port}:`, dbs);
  await context.close();
}

async function run() {
  await checkPort('5174');
  await checkPort('5180');
}

run().catch(console.error);
