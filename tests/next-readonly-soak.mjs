import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4251';
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SNAPSHOT = process.env.NEXT_NIGHTLY_SNAPSHOT
  ?? 'C:\\Users\\小河馬\\Downloads\\workbench-backup-2026-08-15.json';
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const routes = ['/dashboard', '/purchase-records', '/purchasing', '/japan-packages', '/outbound-shipments', '/recent-purchases'];

if (!existsSync(CHROME) || !existsSync(SNAPSHOT)) throw new Error('Chrome or Snapshot is missing');
const snapshotText = readFileSync(SNAPSHOT, 'utf8');
const stable = value => JSON.stringify(value, (_key, nested) => {
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
  return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
});
const vite = spawn(process.execPath, [VITE, '--mode', 'next', '--host', '127.0.0.1', '--port', '4251', '--strictPort', '--configLoader', 'runner'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) return; } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${output}`);
}
async function rawSnapshot(page, databaseName) {
  return page.evaluate(async name => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot(name);
  }, databaseName);
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'next'));
const page = await context.newPage();
const supabaseRequests = [];
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
page.on('request', request => { if (/\.supabase\.co\//i.test(request.url())) supabaseRequests.push(request.url()); });
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
  if (message.type() === 'warning') consoleWarnings.push(message.text());
});
page.on('pageerror', error => pageErrors.push(error.message));

try {
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
  await page.evaluate(async text => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const importer = await import('/src/lib/testSnapshotImport.ts');
    await environment.clearTestSandboxData();
    const file = new File([text], 'workbench-backup-2026-08-15.json', { type: 'application/json' });
    const candidate = await importer.prepareTestSnapshotFile(file);
    await importer.importTestSnapshot(candidate);
  }, snapshotText);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.dataProvider));

  const baseline = await rawSnapshot(page, 'daigou-erp-db-next-v1');
  const baselineSerialized = stable(baseline);
  const observed = [];
  const measure = async (label, operation) => {
    const start = performance.now();
    await operation();
    const after = await rawSnapshot(page, 'daigou-erp-db-next-v1');
    assert.equal(stable(after), baselineSerialized, `read-only operation changed Test DB: ${label}`);
    observed.push({ label, ms: Number((performance.now() - start).toFixed(2)) });
  };

  for (let round = 1; round <= 10; round += 1) {
    for (const route of routes) {
      await measure(`round-${round}:${route}`, async () => {
        await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(20);
        if (route === '/purchase-records') {
          const search = page.locator('input[placeholder*="搜尋"]').first();
          if (await search.count()) {
            await search.fill('VSPO');
            await search.fill('');
          }
        }
        if (route === '/recent-purchases') {
          const dateButton = page.getByRole('button', { name: /今天|昨天|最近 7 天|最近 30 天/ }).first();
          if (await dateButton.count()) await dateButton.click();
        }
      });
    }
    await measure(`round-${round}:reload`, async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(20);
    });
  }

  assert.deepEqual(supabaseRequests, [], 'Next read-only soak must make zero Production Supabase requests');
  assert.deepEqual(pageErrors, [], 'Next read-only soak must have no page errors');
  const final = await rawSnapshot(page, 'daigou-erp-db-next-v1');
  assert.equal(stable(final), baselineSerialized, 'final Test DB differs from baseline');
  console.log(JSON.stringify({
    database: 'daigou-erp-db-next-v1',
    rounds: 10,
    routeVisits: 60,
    reloads: 10,
    baselineCollections: Object.fromEntries(Object.entries(baseline).map(([key, value]) => [key, Array.isArray(value) ? value.length : null])),
    checksumUnchanged: true,
    productionSupabaseRequests: 0,
    consoleErrors,
    consoleWarnings,
    pageErrors,
    observedOperations: observed.length,
  }, null, 2));
  console.log('PASS Next read-only route/F5 soak preserved Test DB checksum and zero Supabase requests');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
