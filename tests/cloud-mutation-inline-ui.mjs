import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://127.0.0.1:4399';
const group = '10000000-0000-4000-8000-000000000001';
const path = `${origin}/tests/fixtures/cloud-mutation-field-contract.html?id=${group}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging', '--host', '127.0.0.1', '--port', '4399', '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VITE_DEPLOYMENT_ENV: 'staging',
    VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co', VITE_SUPABASE_ANON_KEY: 'isolated-test-public-key' } });
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    if (i === 99) throw new Error('Isolated server unavailable');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  for (const currency of ['JPY', 'TWD']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = []; let cloudRequests = 0;
    page.on('pageerror', error => errors.push(error.message));
    await context.route(/https:\/\/.*\.supabase\.co\//u, route => { cloudRequests++; return route.abort(); });
    page.on('dialog', dialog => void dialog.dismiss());
    await page.goto(`${path}&currency=${currency}`);
    await page.waitForFunction(() => Boolean(window.fieldContractFixture));
    // Route identity is resolved through useParams, as in the real detail page.
    const price = page.locator('input[placeholder="-"]').first();
    await price.waitFor();
    const costField = currency === 'JPY' ? 'default_jpy_cost' : 'default_twd_cost';
    for (const value of ['4500', '4600']) {
      await price.fill(value); await price.press('Enter');
      await page.waitForFunction(([field, expected]) => window.fieldContractFixture.snapshot().variant[field] === expected, [costField, Number(value)]);
      assert.equal(await price.inputValue(), value);
      const call = (await page.evaluate(() => window.fieldContractFixture.snapshot())).calls.at(-1);
      assert.deepEqual(call.p_operations[0].changes, { [costField]: Number(value) });
      assert.deepEqual(Object.keys(call.p_operations[0].expected), [costField]);
    }
    // Return to the isolated entry point to simulate fresh application bootstrap;
    // its authoritative server double survives, not the production cost draft.
    await page.goto(`${path}&currency=${currency}`); await price.waitFor();
    assert.equal(await price.inputValue(), '4600', 'Fresh bootstrap must use the saved authoritative cost');
    await page.evaluate(() => window.fieldContractFixture.failNext());
    await price.fill('9900'); await price.press('Enter');
    await page.waitForFunction(() => window.fieldContractFixture.snapshot().calls.length === 1);
    await page.waitForFunction(field => window.fieldContractFixture.snapshot().variant[field] !== 9900, costField);
    await page.getByText('儲存失敗，雲端資料未變更。', { exact: true }).first().waitFor();
    assert.equal(await price.inputValue(), '4600', 'Failed save must roll back its input');
    const storage = await page.evaluate(() => ({ jpy: localStorage.getItem('variant_default_jpy_costs'), twd: localStorage.getItem('variant_default_twd_costs') }));
    assert.ok(!JSON.stringify(storage).includes('9900'), 'Failed save persisted optimistic cost');
    await page.goto(`${path}&currency=${currency}`); await price.waitFor();
    await page.evaluate(() => window.fieldContractFixture.failReadAfterCommit());
    await price.fill('4800'); await price.press('Enter');
    await page.getByText('已儲存至雲端，但資料讀回尚未完成。請同步後確認，勿重複提交。', { exact: true }).first().waitFor();
    assert.equal((await page.evaluate(() => window.fieldContractFixture.snapshot())).variant[costField], 4800);
    await page.goto(`${path}&currency=${currency}`); await price.waitFor();
    assert.equal(await price.inputValue(), '4800', 'Reload reconciles a committed write even if its initial readback failed');
    assert.equal(errors.length, 0, errors.join('\n')); assert.equal(cloudRequests, 0);
    await context.close();
  }
  console.log('PASS real JPY/TWD inline UI -> facade -> Cloud provider -> minimal RPC -> targeted readback; second save; failure rollback; no live requests');
} finally { await browser?.close(); vite.kill(); }
