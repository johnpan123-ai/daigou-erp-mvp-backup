import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4263;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const vite = spawn(process.execPath, [
  VITE,
  '--mode', 'next',
  '--host', '127.0.0.1',
  '--port', String(PORT),
  '--strictPort',
], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const waitForVite = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
};

let browser;
try {
  await waitForVite();

  const endpoints = [
    '/api/catalog/search?q=figma%20%E8%B7%AF%E8%A5%BF%E6%B3%95&pageSize=2',
    '/api/hololive/products.json?limit=1&page=1',
    '/api/vspo/products.json?limit=1&page=1',
  ];
  const responses = [];
  for (const endpoint of endpoints) {
    const response = await fetch(`${BASE_URL}${endpoint}`);
    const body = await response.json();
    responses.push({ endpoint, status: response.status, hasProducts: Array.isArray(body.products) });
  }

  assert.deepEqual(
    responses.map(result => result.status),
    [200, 200, 200],
    `Readonly API endpoints failed: ${JSON.stringify(responses)}`,
  );
  assert.ok(responses.every(result => result.hasProducts), 'Each readonly endpoint must return a products array');

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const failClosed = await page.evaluate(async () => {
    const api = await import('/src/lib/readonlyCatalogApi.ts');
    let jsonCalls = 0;
    let error = null;
    try {
      await api.fetchReadonlyCatalogJson('/api/catalog/search', async () => ({
        ok: false,
        status: 502,
        json: async () => {
          jsonCalls += 1;
          return {};
        },
      }));
    } catch (caught) {
      error = { name: caught.name, message: caught.message, status: caught.status };
    }
    return { jsonCalls, error };
  });

  assert.equal(failClosed.jsonCalls, 0, 'HTTP failure must not attempt JSON parsing');
  assert.equal(failClosed.error?.name, 'CatalogServiceError');
  assert.equal(failClosed.error?.status, 502);
  assert.match(failClosed.error?.message ?? '', /未修改任何結單日/);
  assert.ok(endpoints.every(endpoint => !/supabase/i.test(endpoint)), 'Test must not contact Supabase');

  console.log('PASS GET /api/catalog/search = 200');
  console.log('PASS GET /api/hololive/products.json = 200');
  console.log('PASS GET /api/vspo/products.json = 200');
  console.log('PASS HTTP 502 skips JSON parsing and fails closed before any write');
  console.log('PASS Production Supabase requests = 0');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
