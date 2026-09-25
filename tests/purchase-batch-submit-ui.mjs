import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.PURCHASE_BATCH_SUBMIT_TEST_PORT || '4276';
const BASE_URL = `http://127.0.0.1:${PORT}/tests/fixtures/purchase-batch-submit.html`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--config', 'tests/fixtures/purchase-batch-submit-vite.config.mjs',
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const openModal = async (context, scenario, fillQuantity = true) => {
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  await page.goto(`${BASE_URL}?scenario=${scenario}`, { waitUntil: 'networkidle' });
  await page.getByText('F2 Real UI Group', { exact: true }).click();
  await page.getByRole('button', { name: '新增採購批次' }).click();
  const modal = page.locator('#purchase-batch-modal');
  await modal.locator('input[placeholder*="留空"]').fill('FT-REAL-UI');
  if (fillQuantity) await modal.locator('input[inputmode="numeric"]').first().fill('1');
  return { page, modal, dialogs };
};

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    {
      const page = await context.newPage();
      await page.goto(`${BASE_URL}?scenario=convergence`, { waitUntil: 'networkidle' });
      await page.getByText('F2 Stale Cache Group', { exact: true }).waitFor();
      const before = await page.evaluate(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot());
      await page.evaluate(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.releaseConvergence());
      await page.getByText('F2 Authoritative Group', { exact: true }).waitFor();
      assert.equal(await page.getByText('F2 Stale Cache Group', { exact: true }).count(), 0);
      const after = await page.evaluate(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot());
      assert.ok(after.groupReadCalls > before.groupReadCalls, 'Mounted Purchasing must re-read after authoritative cache convergence');
      assert.equal(after.saveCalls, 0);
      assert.equal(after.rpcCalls, 0);
      assert.equal(page.url().includes('/purchase-records/'), false);
      await page.close();
    }

    {
      const { page, modal } = await openModal(context, 'success');
      await modal.getByRole('button', { name: '儲存', exact: true }).click();
      await page.waitForFunction(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot().rpcCalls === 1);
      const result = await page.evaluate(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot());
      assert.equal(result.saveCalls, 1);
      assert.equal(result.rpcCalls, 1);
      assert.equal(result.command.batch.product_group_id, '60000000-0000-4000-8000-000000000001');
      assert.equal(result.command.items.length, 1);
      assert.equal(result.command.items[0].product_variant_id, '60000000-0000-4000-8000-000000000002');
      assert.equal(result.command.items[0].quantity, 1);
      assert.equal(result.variantWriteCalls, 0);
      assert.equal(await modal.count(), 0, 'Success may close only after the transaction boundary resolves');
      assert.equal(page.url().includes('/purchase-records/'), false);
      await page.close();
    }

    {
      const { page, modal } = await openModal(context, 'stale');
      await modal.getByRole('button', { name: '儲存', exact: true }).click();
      await page.waitForFunction(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot().saveCalls === 1);
      const result = await page.evaluate(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot());
      assert.equal(result.rpcCalls, 0);
      assert.equal(await modal.count(), 1, 'A pre-RPC stale guard rejection must preserve the modal and draft');
      assert.equal(await modal.locator('input[placeholder*="留空"]').inputValue(), 'FT-REAL-UI');
      assert.equal(await modal.locator('input[inputmode="numeric"]').first().inputValue(), '1');
      await page.close();
    }

    {
      const { page, modal } = await openModal(context, 'readiness');
      await modal.getByRole('button', { name: '儲存', exact: true }).click();
      await page.waitForFunction(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot().saveCalls === 1);
      const result = await page.evaluate(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot());
      assert.equal(result.rpcCalls, 0);
      assert.match(await page.getByTestId('purchase-batch-submit-status').textContent(), /本次尚未送出/u);
      assert.equal(await modal.count(), 1);
      await page.close();
    }

    {
      const { page, modal } = await openModal(context, 'pending');
      const save = modal.getByRole('button', { name: '儲存', exact: true });
      const total = page.getByTestId('purchase-batch-total');
      const statusSlot = page.getByTestId('purchase-batch-submit-status');
      const before = {
        total: await total.boundingBox(),
        status: await statusSlot.boundingBox(),
        save: await save.boundingBox(),
        scrollTop: await modal.evaluate(element => element.scrollTop),
      };
      await save.dblclick();
      await page.waitForFunction(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot().rpcCalls === 1);
      const pendingSave = modal.getByRole('button', { name: '儲存中…', exact: true });
      const during = {
        total: await total.boundingBox(),
        status: await statusSlot.boundingBox(),
        save: await pendingSave.boundingBox(),
        scrollTop: await modal.evaluate(element => element.scrollTop),
      };
      assert.ok(before.total && before.status && before.save && during.total && during.status && during.save);
      assert.ok(Math.abs(during.total.y - before.total.y) <= 1, 'Purchasing total moved while save was pending');
      assert.equal(during.status.height, before.status.height, 'Purchasing status slot changed height');
      assert.equal(during.save.height, before.save.height, 'Purchasing save button changed height');
      assert.equal(during.scrollTop, before.scrollTop, 'Purchasing modal scrolled while save was pending');
      let result = await page.evaluate(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot());
      assert.equal(result.saveCalls, 1);
      assert.equal(result.rpcCalls, 1);
      assert.equal(new Set(result.idempotencyKeys).size, 1);
      await page.evaluate(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.releasePending());
      await page.waitForFunction(() => !document.querySelector('#purchase-batch-modal'));
      result = await page.evaluate(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot());
      assert.equal(result.batches.length, 1);
      assert.equal(result.items.length, 1);
      await page.close();
    }

    {
      const { page, modal } = await openModal(context, 'server-rejected');
      await modal.getByRole('button', { name: '儲存', exact: true }).click();
      await page.waitForFunction(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot().rpcCalls === 1);
      assert.match(await page.getByTestId('purchase-batch-submit-status').textContent(), /伺服器已拒絕/u);
      assert.equal(await modal.count(), 1);
      assert.equal(await modal.getByRole('button', { name: '儲存', exact: true }).isEnabled(), true);
      await page.close();
    }

    {
      const { page, modal } = await openModal(context, 'conflict');
      await modal.getByRole('button', { name: '儲存', exact: true }).click();
      await page.waitForFunction(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot().rpcCalls === 1);
      assert.match(await page.getByTestId('purchase-batch-submit-status').textContent(), /其他裝置更新/u);
      assert.equal(await modal.count(), 1);
      assert.equal(await modal.locator('input[placeholder*="留空"]').inputValue(), 'FT-REAL-UI');
      assert.equal(await modal.locator('input[inputmode="numeric"]').first().inputValue(), '1');
      await page.close();
    }

    {
      const { page, modal } = await openModal(context, 'unknown');
      await modal.getByRole('button', { name: '儲存', exact: true }).click();
      await page.waitForFunction(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot().rpcCalls === 1);
      const status = await page.getByTestId('purchase-batch-submit-status').textContent();
      assert.match(status, /結果待查證/u);
      assert.doesNotMatch(status, /UNSAFE|URL|password/u);
      assert.equal(await modal.getByRole('button', { name: '儲存', exact: true }).isDisabled(), true);
      const result = await page.evaluate(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot());
      assert.equal(result.rpcCalls, 1);
      assert.equal(new Set(result.idempotencyKeys).size, 1);
      await page.close();
    }

    {
      const { page, modal } = await openModal(context, 'postcommit');
      await modal.getByRole('button', { name: '儲存', exact: true }).click();
      await page.waitForFunction(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot().rpcCalls === 1);
      assert.match(await page.getByTestId('purchase-batch-submit-status').textContent(), /已提交.*同步尚未完成/u);
      assert.equal(await modal.count(), 1);
      assert.equal(await modal.getByRole('button', { name: '儲存', exact: true }).isDisabled(), true);
      const result = await page.evaluate(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot());
      assert.equal(result.batches.length, 1, 'A valid Server success remains authoritative when local refresh fails');
      assert.equal(result.rpcCalls, 1);
      await page.close();
    }

    {
      const { page, modal } = await openModal(context, 'success', false);
      await modal.getByRole('button', { name: '儲存', exact: true }).click();
      await sleep(50);
      const result = await page.evaluate(() => window.__PURCHASE_BATCH_SUBMIT_TEST__.snapshot());
      assert.equal(result.rpcCalls, 0);
      await page.getByTestId('purchase-batch-submit-status').waitFor();
      await page.close();
    }

    console.log('PASS real Purchasing parent and PurchaseBatchModal dispatch one valid atomic command');
    console.log('PASS mounted Purchasing replaces stale cache after authoritative convergence without remount or write');
    console.log('PASS pre-RPC stale rejection and invalid lines preserve the draft with explicit status');
    console.log('PASS readiness rejection, double-click, unknown-result, server rejection, and post-commit sync-pending boundaries');
  } finally {
    await context.close();
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}
