import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4246';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SNAPSHOT_PATH = process.env.NEXT_NIGHTLY_SNAPSHOT || 'C:\\Users\\小河馬\\Downloads\\workbench-backup-2026-08-15.json';
if (!existsSync(CHROME_PATH) || !existsSync(SNAPSHOT_PATH)) throw new Error('Chrome or Snapshot is missing');

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'next', '--host', '127.0.0.1', '--port', '4246', '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) return; } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${output}`);
}
const snapshotText = readFileSync(SNAPSHOT_PATH, 'utf8');
const routes = ['/dashboard', '/purchase-records', '/purchasing', '/japan-packages', '/outbound-shipments', '/recent-purchases'];

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'next'));
const page = await context.newPage();
const supabaseRequests = [];
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
page.on('request', request => { if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url()); });
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
  if (message.type() === 'warning') consoleWarnings.push(message.text());
});
page.on('pageerror', error => pageErrors.push(error.message));

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const importStart = performance.now();
  await page.evaluate(async text => {
    const importer = await import('/src/lib/testSnapshotImport.ts');
    const file = new File([text], 'workbench-backup-2026-08-15.json', { type: 'application/json' });
    const candidate = await importer.prepareTestSnapshotFile(file);
    await importer.importTestSnapshot(candidate);
  }, snapshotText);
  const snapshotImportMs = performance.now() - importStart;
  const reloadStart = performance.now();
  await page.reload({ waitUntil: 'networkidle' });
  const reloadMs = performance.now() - reloadStart;

  const measureRoute = async route => {
    const start = performance.now();
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(20);
    return performance.now() - start;
  };
  const routeTimes = {};
  for (const route of routes) routeTimes[route] = await measureRoute(route);
  const purchaseFirstMs = routeTimes['/purchase-records'];

  await page.goto(`${BASE_URL}/purchase-records`, { waitUntil: 'networkidle' });
  const searchInput = page.locator('input[placeholder*="搜尋"]').first();
  const searchStart = performance.now();
  if (await searchInput.count()) {
    for (let index = 0; index < 100; index += 1) await searchInput.fill(index % 2 ? 'Hololive' : 'WeatherPlanet');
    await searchInput.fill('');
  }
  const search100Ms = performance.now() - searchStart;

  const sortSelect = page.locator('select').last();
  const sortOptions = await sortSelect.locator('option').evaluateAll(options => options.map(option => option.value));
  const sortStart = performance.now();
  if (sortOptions.length > 1) {
    for (let index = 0; index < 25; index += 1) await sortSelect.selectOption(sortOptions[index % sortOptions.length]);
  }
  const sort25Ms = performance.now() - sortStart;

  const categoryButton = page.getByRole('button', { name: /Hololive商品/ }).first();
  const categoryStart = performance.now();
  if (await categoryButton.count()) await categoryButton.click();
  const categoryMs = performance.now() - categoryStart;

  const xlsParse = await page.evaluate(async () => {
    const { parseMyAcgFile } = await import('/src/utils/myacgParser.ts');
    const rows = ['<table><tr><th>商品編號</th><th>商品名稱</th><th>規格</th><th>價格</th><th>庫存</th><th>銷售</th></tr>'];
    for (let index = 0; index < 1300; index += 1) rows.push(`<tr><td>BENCH-${index}</td><td>Benchmark ${index}</td><td>Spec ${index}</td><td>100</td><td>10</td><td>1</td></tr>`);
    rows.push('</table>');
    const start = performance.now();
    const parsed = await parseMyAcgFile(new File([rows.join('')], 'nightly.xls'));
    return { ms: performance.now() - start, count: parsed.length };
  });
  assert.equal(xlsParse.count, 1300);

  const memoryBefore = await page.evaluate(() => {
    const value = globalThis.performance?.memory;
    return value ? { usedJSHeapSize: value.usedJSHeapSize, totalJSHeapSize: value.totalJSHeapSize } : null;
  });
  const soakStart = performance.now();
  for (let index = 0; index < 100; index += 1) await measureRoute(routes[index % routes.length]);
  const route100Ms = performance.now() - soakStart;
  const reload30Start = performance.now();
  for (let index = 0; index < 30; index += 1) await page.reload({ waitUntil: 'domcontentloaded' });
  const reload30Ms = performance.now() - reload30Start;
  const memory = await page.evaluate(() => {
    const value = globalThis.performance?.memory;
    return value ? { usedJSHeapSize: value.usedJSHeapSize, totalJSHeapSize: value.totalJSHeapSize } : null;
  });

  assert.deepEqual(supabaseRequests, [], 'Next performance/soak must make zero Production Supabase requests');
  assert.deepEqual(pageErrors, [], 'Next performance/soak must have no page errors');
  console.log(JSON.stringify({
    snapshot: SNAPSHOT_PATH,
    snapshotImportMs,
    reloadMs,
    purchaseFirstMs,
    routeTimes,
    search100Ms,
    sort25Ms,
    categoryMs,
    xlsParseMs: xlsParse.ms,
    xlsRows: xlsParse.count,
    routeCycles: 100,
    route100Ms,
    reloadCycles: 30,
    reload30Ms,
    memoryBefore,
    memoryAfter: memory,
    memoryDelta: memoryBefore && memory ? memory.usedJSHeapSize - memoryBefore.usedJSHeapSize : null,
    consoleErrors,
    consoleWarnings,
    pageErrors,
    productionSupabaseRequests: supabaseRequests.length,
  }, null, 2));
  console.log('PASS Next nightly performance measurement and route/reload soak completed');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
