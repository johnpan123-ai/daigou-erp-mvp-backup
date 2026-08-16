import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || 'C:\\Users\\小河馬\\Downloads\\workbench-backup-2026-08-15.json';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const servers = [{ mode: 'next', port: 4222 }, { mode: 'experimental', port: 4223 }];
if (!existsSync(SNAPSHOT_PATH) || !existsSync(CHROME_PATH)) throw new Error('Snapshot or Chrome is missing');
const bytes = [...await readFile(SNAPSHOT_PATH)];
const fileName = SNAPSHOT_PATH.split(/[\\/]/).at(-1);
const children = servers.map(({ mode, port }) => spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', mode, '--host', '127.0.0.1', '--port', String(port), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }));
const output = children.map(() => '');
children.forEach((child, index) => {
  child.stdout.on('data', chunk => { output[index] += String(chunk); });
  child.stderr.on('data', chunk => { output[index] += String(chunk); });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer(port, child, index) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(output[index]);
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`Server start timeout: ${output[index]}`);
}
const stop = () => children.forEach(child => child.kill('SIGTERM'));
process.on('exit', stop);

let browser;
try {
  await Promise.all(servers.map((server, index) => waitForServer(server.port, children[index], index)));
  browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  const results = [];
  for (const server of servers) {
    const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
    const page = await context.newPage();
    const cloudRequests = [];
    page.on('request', request => { if (/supabase\.co/i.test(request.url())) cloudRequests.push(request.url()); });

    const snapshotImportMs = await (async () => {
      await page.goto(`http://127.0.0.1:${server.port}/settings`, { waitUntil: 'networkidle' });
      const started = performance.now();
      const result = await page.evaluate(async ({ bytes: inputBytes, name }) => {
        const importer = await import('/src/lib/testSnapshotImport.ts');
        const candidate = await importer.prepareTestSnapshotFile(new File([new Uint8Array(inputBytes)], name));
        return importer.importTestSnapshot(candidate);
      }, { bytes, name: fileName });
      assert.equal(result.productionIndexedDbUnchanged, true);
      assert.equal(result.productionLocalStorageUnchanged, true);
      return performance.now() - started;
    })();

    const measurePage = async path => {
      const started = performance.now();
      await page.goto(`http://127.0.0.1:${server.port}${path}`, { waitUntil: 'networkidle' });
      await page.getByText('C108', { exact: false }).first().waitFor();
      return performance.now() - started;
    };
    const purchaseFirstMs = await measurePage('/purchase-records');
    const reloadStarted = performance.now();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('C108', { exact: false }).first().waitFor();
    const purchaseReloadMs = performance.now() - reloadStarted;

    const searchInput = page.locator('input[placeholder*="搜尋"]').first();
    assert.equal(await searchInput.count(), 1, `${server.mode} search input missing`);
    const searchStarted = performance.now();
    for (let index = 0; index < 100; index += 1) await searchInput.fill(index % 2 ? 'Hololive' : 'WeatherPlanet');
    await searchInput.fill('');
    const search100Ms = performance.now() - searchStarted;

    const sortSelects = page.locator('select');
    const sortSelect = sortSelects.last();
    const sortOptions = await sortSelect.locator('option').evaluateAll(options => options.map(option => option.value));
    assert.ok(sortOptions.length >= 2, `${server.mode} sort options missing`);
    const sortStarted = performance.now();
    for (let index = 0; index < 25; index += 1) await sortSelect.selectOption(sortOptions[index % sortOptions.length]);
    const sort25Ms = performance.now() - sortStarted;

    const categoryButton = page.getByRole('button', { name: /Hololive商品/ }).first();
    assert.equal(await categoryButton.count(), 1, `${server.mode} category tab missing`);
    const categoryStarted = performance.now();
    await categoryButton.click();
    await page.waitForTimeout(50);
    const categoryMs = performance.now() - categoryStarted;

    const xlsParseMs = await page.evaluate(async () => {
      const { parseMyAcgFile } = await import('/src/utils/myacgParser.ts');
      const rows = ['<table><tr><th>商品編號</th><th>商品名稱</th><th>規格</th><th>價格</th><th>庫存</th><th>銷售</th></tr>'];
      for (let index = 0; index < 1300; index += 1) rows.push(`<tr><td>BENCH-${index}</td><td>Benchmark product ${index}</td><td>Spec ${index}</td><td>100</td><td>10</td><td>1</td></tr>`);
      rows.push('</table>');
      const started = performance.now();
      const parsed = await parseMyAcgFile(new File([rows.join('')], 'sandbox-performance.xls', { type: 'application/vnd.ms-excel' }));
      return { ms: performance.now() - started, count: parsed.length };
    });
    assert.equal(xlsParseMs.count, 1300);
    results.push({ mode: server.mode, snapshotImportMs, purchaseFirstMs, purchaseReloadMs, search100Ms, sort25Ms, categoryMs, xlsParseMs: xlsParseMs.ms, cloudRequests: cloudRequests.length });
    await context.close();
  }
  console.log(JSON.stringify({ snapshot: fileName, results }, null, 2));
  console.log('PASS identical Snapshot performance baseline completed in both isolated Sandboxes');
} finally {
  if (browser) await browser.close();
  stop();
}
