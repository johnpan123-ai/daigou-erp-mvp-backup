import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE_URL = 'http://127.0.0.1:4254';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const vite = spawn(process.execPath, [VITE, '--mode', 'next', '--host', '127.0.0.1', '--port', '4254', '--strictPort'], {
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

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const { allocatePurchaseBatchFreight, roundJpyUnitCost } = await import('/src/lib/purchaseBatchFreightAllocation.ts');
    const lines = [
      { key: 'A', quantity: 2, unitCost: 4446 },
      { key: 'B', quantity: 1, unitCost: 6875 },
      { key: 'C', quantity: 0, unitCost: 3000 },
      { key: 'D', quantity: 2, unitCost: 0 },
    ];
    const first = allocatePurchaseBatchFreight(1000, lines);
    const second = allocatePurchaseBatchFreight(1000, lines);
    return {
      first,
      repeatDeterministic: JSON.stringify(first) === JSON.stringify(second),
      rounded: [roundJpyUnitCost(13533.3), roundJpyUnitCost(13533.5), roundJpyUnitCost(13533.8)],
      invalidFreight: (() => { try { allocatePurchaseBatchFreight(0, lines); return false; } catch { return true; } })(),
      noEligible: (() => { try { allocatePurchaseBatchFreight(1, [{ key: 'C', quantity: 0, unitCost: 3000 }]); return false; } catch { return true; } })(),
    };
  });
  assert.deepEqual(result.first.allocations.map(row => row.key), ['A', 'B']);
  assert.ok(result.first.allocations.every(row => Number.isInteger(row.newUnitCost)));
  assert.equal(result.repeatDeterministic, true);
  assert.deepEqual(result.rounded, [13533, 13534, 13534]);
  assert.equal(result.invalidFreight, true);
  assert.equal(result.noEligible, true);
  console.log(JSON.stringify(result, null, 2));
  console.log('PASS freight allocation eligibility, whole-yen rounding, deterministic repeat, and invalid-input guards');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
