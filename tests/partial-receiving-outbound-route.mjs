import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.PARTIAL_RECEIVING_ROUTE_TEST_PORT || '4291';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FIXTURE_URL = `${BASE_URL}/tests/fixtures/cloud-p0-2-react-harness.html`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.goto(
      `${FIXTURE_URL}?route=${encodeURIComponent('/japan-packages/jp-react-1')}&partialReceiving=1`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
    await page.getByText('React Japan Package A', { exact: false }).first().waitFor();

    const itemCheckboxes = page.locator('.checklist-item-row input[type="checkbox"]');
    await assert.doesNotReject(() => itemCheckboxes.nth(0).waitFor());
    assert.equal(await itemCheckboxes.count(), 2, 'The real receiving route must render both Package items');
    await itemCheckboxes.nth(0).click();
    await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().japanPackageTransactionCalls === 1);
    await page.waitForFunction(() => {
      const harness = window.__P0_REACT_HARNESS__;
      return harness.server.japanPackages[0].status === 'arrived'
        && harness.server.japanPackageItems[0].checked === true
        && harness.server.japanPackageItems[1].checked === false;
    });

    await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/outbound-shipments/out-react-1'));
    await page.getByText('倉庫商品池 (1 項可出庫)', { exact: false }).waitFor();
    await page.getByText('Hololive Active', { exact: true }).last().click();
    assert.equal(await page.getByText('SKU-HOLO', { exact: true }).count(), 1);
    assert.equal(await page.getByText('SKU-HOLO-B', { exact: true }).count(), 0);

    const beforeCatchUp = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot());
    await page.evaluate(() => window.__P0_REACT_HARNESS__.remoteReceiving('jpi-react-2', true));
    await page.getByText('倉庫商品池 (2 項可出庫)', { exact: false }).waitFor();
    assert.equal(await page.getByText('SKU-HOLO', { exact: true }).count(), 1);
    assert.equal(await page.getByText('SKU-HOLO-B', { exact: true }).count(), 1);
    let snapshot = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot());
    assert.equal(await page.evaluate(() => window.__P0_REACT_HARNESS__.server.japanPackages[0].status), 'confirmed');
    assert.ok(snapshot.metrics.targetedRefreshes > beforeCatchUp.metrics.targetedRefreshes);
    assert.equal(snapshot.metrics.fullPulls, 0);

    await page.evaluate(() => window.__P0_REACT_HARNESS__.remoteReceiving('jpi-react-1', false));
    await page.getByText('倉庫商品池 (1 項可出庫)', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.__P0_REACT_HARNESS__.server.japanPackages[0].status), 'arrived');
    assert.equal(await page.getByText('SKU-HOLO', { exact: true }).count(), 0);
    assert.equal(await page.getByText('SKU-HOLO-B', { exact: true }).count(), 1);
    snapshot = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot());
    assert.equal(snapshot.metrics.fullPulls, 0);

    console.log('PASS registered -> partial receiving -> arrived through the real JapanPackageDetail route');
    console.log('PASS mounted OutboundShipmentDetail exposes only checked Package items');
    console.log('PASS targeted Realtime/catch-up adds B, then removes unchecked A without a full pull');
  } finally {
    await context.close();
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}
