import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SETTINGS = readFileSync(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../src/components/CloudAtomicRestorePanel.tsx', import.meta.url), 'utf8');
const PORT = process.env.POST_RESTORE_UI_TEST_PORT || '4264';
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

assert.match(SETTINGS, /SettingsCountLoadGate/u, 'Settings must use the latest-request-wins count loader');
assert.match(SETTINGS, /getProductVariants\(\{ raw: true \}\)/u, 'Settings statistics must count the raw authoritative Variant collection');
assert.match(SETTINGS, /onAuthoritativeRefreshComplete=\{loadCounts\}/u, 'Settings must join the Restore completion path');
assert.match(PANEL, /await onAuthoritativeRefreshComplete\(restored\.restoreEpoch\)/u, 'Panel must await same-page convergence');
assert.match(PANEL, /if \(!syncPending\)[\s\S]+cloud-restore-completed/u, 'Completion notification must follow successful convergence');

const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' });
let document;
try {
  const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const { SettingsCountLoadGate } = await vite.ssrLoadModule('/src/pages/settingsCountLoadGate.ts');
  const gate = new SettingsCountLoadGate();
  let releaseOld;
  const committed = [];
  const oldCounts = { productGroups: 705, productCategories: 390, productVariants: 3254 };
  const freshCounts = { productGroups: 705, productCategories: 390, productVariants: 3461 };
  const old = gate.run(() => new Promise(resolve => { releaseOld = () => resolve(oldCounts); }), value => committed.push(value));
  const fresh = gate.run(async () => freshCounts, value => committed.push(value));
  assert.equal(await fresh, true);
  releaseOld();
  assert.equal(await old, false);
  assert.deepEqual(committed, [freshCounts], 'A late stale query must not overwrite the newer Settings result');
  gate.invalidate();
  const data = Object.fromEntries(domain.CLOUD_RESTORE_TABLES.map(([resource]) => [resource, []]));
  const prepared = await domain.buildCloudRestoreManifest(data);
  document = { schemaVersion: 'cloud-erp-snapshot-v1', sourceEnvironment: 'fixture', data, manifest: prepared.manifest };
} finally {
  await vite.close();
}

const processVite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--config', 'tests/fixtures/post-restore-settings-convergence-vite.config.mjs',
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
processVite.stdout.on('data', chunk => { output += String(chunk); });
processVite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const url = `http://127.0.0.1:${PORT}/tests/fixtures/post-restore-settings-convergence.html`;
const COUNT_SELECTOR = '.kpi-grid > .card:first-child .font-semibold';
const OLD_COUNTS = '5517 筆|705 筆|390 筆|3254 筆|0 筆|0 筆';
const NEW_COUNTS = '5517 筆|847 筆|663 筆|4939 筆|1 筆|2 筆';
const VARIANT_AUTHORITATIVE_COUNTS = '5517 筆|705 筆|390 筆|3461 筆|0 筆|0 筆';
const ALL_AUTHORITATIVE_COUNTS = '6000 筆|706 筆|391 筆|3462 筆|3 筆|4 筆';

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await sleep(250);
    if (attempt === 79) throw new Error(output);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    const open = async behavior => {
      await page.goto(`${url}?behavior=${encodeURIComponent(behavior)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => Boolean(window.__POST_RESTORE_SETTINGS_TEST__));
      await page.waitForFunction(selector => document.querySelectorAll(selector).length === 6, COUNT_SELECTOR);
      await page.waitForFunction(({ selector, expected }) => [...document.querySelectorAll(selector)].map(node => node.textContent).join('|') === expected, { selector: COUNT_SELECTOR, expected: OLD_COUNTS });
    };
    const submit = async (duplicate = false) => {
      await page.locator('[data-testid="cloud-atomic-restore"] input[type=file]').setInputFiles({
        name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)),
      });
      try {
        await page.getByTestId('cloud-restore-preflight').waitFor({ timeout: 10_000 });
      } catch {
        throw new Error(`Fixture preflight failed: ${await page.getByTestId('cloud-restore-status').innerText()}`);
      }
      if (duplicate) {
        await page.getByTestId('cloud-restore-confirm').evaluate(button => { button.click(); button.click(); });
      } else {
        await page.getByTestId('cloud-restore-confirm').click();
      }
      await page.getByTestId('cloud-restore-result').waitFor();
    };

    await open('success');
    await submit(true);
    await page.waitForFunction(({ selector, expected }) => [...document.querySelectorAll(selector)].map(node => node.textContent).join('|') === expected, { selector: COUNT_SELECTOR, expected: NEW_COUNTS });
    assert.match(await page.getByTestId('cloud-restore-status').innerText(), /還原完成/u);
    assert.deepEqual(await page.evaluate(() => window.__POST_RESTORE_SETTINGS_TEST__.snapshot()), {
      restoreCalls: 1, countGetterCalls: 12, completionEvents: 1, dataset: 'restored', readStatus: 'fresh-online',
    });
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('cloud-restore-completed', { detail: { restoreEpoch: 2 } }));
      window.dispatchEvent(new CustomEvent('cloud-restore-completed', { detail: { restoreEpoch: 2 } }));
    });
    await sleep(100);
    assert.deepEqual(await page.evaluate(() => window.__POST_RESTORE_SETTINGS_TEST__.snapshot()), {
      restoreCalls: 1, countGetterCalls: 12, completionEvents: 3, dataset: 'restored', readStatus: 'fresh-online',
    }, 'Repeated same-epoch notifications must not cause Settings rereads or another Restore');

    await open('bootstrap-variant-convergence');
    await page.waitForFunction(() => window.__POST_RESTORE_SETTINGS_TEST__.snapshot().countGetterCalls === 6);
    const draft = '保留中的未儲存設定草稿';
    await page.getByPlaceholder('請輸入新密碼').fill(draft);
    await page.waitForFunction(() => window.__POST_RESTORE_SETTINGS_TEST__.snapshot().readStatus === 'stale-cache', undefined, { timeout: 5_000 });
    assert.equal(
      await page.locator(COUNT_SELECTOR).allTextContents().then(values => values.join('|')),
      OLD_COUNTS,
      'The mounted Settings page may show the fallback cache at the four-second boundary',
    );
    await page.evaluate(() => window.__POST_RESTORE_SETTINGS_TEST__.completeBootstrap());
    await page.waitForFunction(({ selector, expected }) => [...document.querySelectorAll(selector)].map(node => node.textContent).join('|') === expected, { selector: COUNT_SELECTOR, expected: VARIANT_AUTHORITATIVE_COUNTS });
    assert.deepEqual(await page.evaluate(() => window.__POST_RESTORE_SETTINGS_TEST__.snapshot()), {
      restoreCalls: 0, countGetterCalls: 12, completionEvents: 0, dataset: 'variant-authoritative', readStatus: 'fresh-online',
    }, 'Mounted Settings must replace the deduped fallback count with the raw authoritative Variant count');
    assert.equal(await page.getByPlaceholder('請輸入新密碼').inputValue(), draft, 'Background convergence must preserve an unsaved draft');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('cloud-reconnect-diagnostic', { detail: { event: 'complete' } })));
    await sleep(100);
    assert.equal(await page.getByPlaceholder('請輸入新密碼').inputValue(), draft, 'An unrelated realtime diagnostic must not clear the draft');
    assert.equal((await page.evaluate(() => window.__POST_RESTORE_SETTINGS_TEST__.snapshot())).countGetterCalls, 12, 'An unrelated realtime diagnostic must not reread Settings');

    await open('bootstrap-all-convergence');
    await page.waitForFunction(() => window.__POST_RESTORE_SETTINGS_TEST__.snapshot().countGetterCalls === 6);
    await page.evaluate(() => window.__POST_RESTORE_SETTINGS_TEST__.completeBootstrap());
    await page.waitForFunction(({ selector, expected }) => [...document.querySelectorAll(selector)].map(node => node.textContent).join('|') === expected, { selector: COUNT_SELECTOR, expected: ALL_AUTHORITATIVE_COUNTS });
    assert.deepEqual(await page.evaluate(() => window.__POST_RESTORE_SETTINGS_TEST__.snapshot()), {
      restoreCalls: 0, countGetterCalls: 12, completionEvents: 0, dataset: 'all-authoritative', readStatus: 'fresh-online',
    }, 'Every mounted Settings statistic must converge after the late authoritative commit');

    await open('count-read-failure');
    await submit();
    assert.match(await page.getByTestId('cloud-restore-result').innerText(), /畫面正在同步最新資料，請勿再次還原/u);
    assert.equal(await page.getByTestId('cloud-restore-result').count(), 1, 'Server success must remain visible');
    assert.deepEqual(await page.evaluate(() => window.__POST_RESTORE_SETTINGS_TEST__.snapshot()), {
      restoreCalls: 1, countGetterCalls: 12, completionEvents: 0, dataset: 'failure', readStatus: 'fresh-online',
    });
    assert.equal(await page.getByTestId('cloud-restore-confirm').count(), 0, 'A successful Restore may not become dispatchable after UI sync failure');

    await page.evaluate(() => window.__POST_RESTORE_SETTINGS_TEST__.unmount());
    assert.equal(await page.locator('[data-testid="cloud-atomic-restore"]').count(), 0, 'Unmount must remove the live component tree');
  } finally {
    await browser.close();
  }
} finally {
  processVite.kill();
}

console.log('PASS post-Restore Settings converges without reload; sync failure preserves success and never re-dispatches Restore');
