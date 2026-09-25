import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.AGENCY_ORDER_QUANTITY_PORT || '4297';
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

for (let attempt = 0; attempt < 80; attempt += 1) {
  if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
  try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
  if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
  await sleep(250);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

try {
  const context = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1366, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
  await page.goto(
    `${FIXTURE_URL}?route=${encodeURIComponent('/purchase-records')}&proxyDemand=1`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
  await page.getByRole('button', { name: /代理版商品/ }).click();
  await page.getByTestId('purchase-records-edit-mode-toggle').click();

  const inputA = page.getByTestId('proxy-purchased-quantity-g-proxy');
  const inputB = page.getByTestId('proxy-purchased-quantity-g-proxy-b');
  await inputA.waitFor();
  await inputB.waitFor();

  const snapshot = () => page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot());
  const serverVariant = id => page.evaluate(variantId => structuredClone(
    window.__P0_REACT_HARNESS__.server.productVariants.find(row => row.id === variantId),
  ), id);
  const waitForCalls = count => page.waitForFunction(expected => (
    window.__P0_REACT_HARNESS__.snapshot().variantPatchCalls.length === expected
  ), count);
  const cancelDraft = async (input, expectedCalls) => {
    await input.press('Escape');
    await page.waitForTimeout(30);
    assert.equal((await snapshot()).variantPatchCalls.length, expectedCalls, 'Escape dispatched a cancelled draft');
  };

  // True route + true input: Enter funnels through blur exactly once and sends
  // only the changed business field. Server-owned metadata is read back from
  // the acknowledged canonical row, not supplied by the client patch.
  assert.equal(await inputA.inputValue(), '2');
  assert.equal(await inputB.inputValue(), '6');
  await inputA.fill('8');
  await inputA.press('Enter');
  await waitForCalls(1);
  await page.waitForTimeout(30);
  assert.deepEqual((await snapshot()).variantPatchCalls[0], {
    id: 'v-proxy', patch: { purchased_manual_adjustment: 8 },
  });
  assert.equal(await inputA.inputValue(), '8');
  const canonicalEight = await serverVariant('v-proxy');
  assert.equal(canonicalEight.purchased_manual_adjustment, 8);
  assert.equal(canonicalEight.version, 8);
  assert.equal(canonicalEight.updated_at, '2026-09-23T00:00:01.000Z');
  assert.equal((await serverVariant('v-proxy-b')).purchased_manual_adjustment, 6, 'Saving A rewrote B');

  // Existing input rules remain intact: zero, a positive integer, clearing,
  // and non-digit input all use the established digits-only / empty-as-zero semantics.
  for (const [typed, expectedPatch, expectedDisplay, callCount] of [
    ['0', 0, '2', 2],
    ['13', 13, '13', 3],
    ['', 0, '2', 4],
    ['abc', 0, '2', 5],
  ]) {
    await inputA.fill(typed);
    await inputA.blur();
    await waitForCalls(callCount);
    assert.deepEqual((await snapshot()).variantPatchCalls.at(-1).patch, {
      purchased_manual_adjustment: expectedPatch,
    });
    assert.equal(await inputA.inputValue(), expectedDisplay);
  }

  // Slow acknowledgement keeps the page mounted and the exact input pending.
  // Repeated blur/Enter events cannot dispatch the same draft twice.
  await page.evaluate(() => window.__P0_REACT_HARNESS__.holdNextVariantPatch());
  await inputA.fill('9');
  await inputA.press('Enter');
  await page.waitForFunction(() => window.__P0_REACT_HARNESS__.snapshot().variantPatchHeld === true);
  assert.equal(await inputA.isDisabled(), true);
  assert.equal(await page.getByText('GSC Proxy Active', { exact: false }).first().isVisible(), true);
  assert.equal(await page.getByText('載入中', { exact: false }).count(), 0);
  await inputA.evaluate(element => {
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await page.waitForTimeout(30);
  assert.equal((await snapshot()).variantPatchCalls.length, 6, 'Pending draft dispatched more than once');
  await page.evaluate(() => window.__P0_REACT_HARNESS__.releaseVariantPatch());
  await page.waitForFunction(() => !document.querySelector('[data-testid="proxy-purchased-quantity-g-proxy"]')?.disabled);
  assert.equal(await inputA.inputValue(), '9');

  // Server rejection, CAS conflict, and UNKNOWN each preserve the draft and
  // never auto-retry. Explicit Escape cancellation does not accidentally save.
  for (const [message, typed, expectedCalls] of [
    ['simulated server rejection', '10', 7],
    ['CLOUD_FIELD_CONFLICT', '11', 8],
    ['CLOUD_MUTATION_OUTCOME_UNKNOWN', '12', 9],
  ]) {
    await page.evaluate(failure => window.__P0_REACT_HARNESS__.failNextVariantPatch(failure), message);
    await inputA.fill(typed);
    await inputA.blur();
    await waitForCalls(expectedCalls);
    await page.waitForFunction(testId => !document.querySelector(`[data-testid="${testId}"]`)?.disabled, 'proxy-purchased-quantity-g-proxy');
    assert.equal(await inputA.inputValue(), typed, `${message} discarded the user's draft`);
    assert.equal((await serverVariant('v-proxy')).purchased_manual_adjustment, 9, `${message} changed authoritative state`);
    await cancelDraft(inputA, expectedCalls);
    assert.equal(await inputA.inputValue(), '9');
  }

  assert.equal(dialogs.length, 3);
  assert.ok(dialogs.every(message => message.includes('本次輸入仍保留在畫面上')));
  assert.equal((await serverVariant('v-proxy-b')).purchased_manual_adjustment, 6);

  console.log('PASS real Purchase Records agency-order input sends purchased_manual_adjustment only');
  console.log('PASS canonical version/updated_at remain server-owned while CAS business baseline is preserved');
  console.log('PASS zero/positive/empty/invalid input retain existing quantity semantics');
  console.log('PASS pending dedupe, rejection/CAS/UNKNOWN draft retention, cancellation, and A/B isolation');
  console.log('PASS quantity save keeps mounted content visible without full-page loading');
  await context.close();
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
