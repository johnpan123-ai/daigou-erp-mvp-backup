import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT = process.env.CLOUD_RESTORE_REALISTIC_SNAPSHOT
  || 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-20-114903.json';
assert(existsSync(SNAPSHOT), `Missing fixed Restore fixture: ${SNAPSHOT}`);
const PORT = process.env.CLOUD_RESTORE_UNKNOWN_TEST_PORT || '4266';
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--config', 'tests/fixtures/cloud-atomic-restore-vite.config.mjs', '--mode', 'experimental',
  '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  const url = `http://127.0.0.1:${PORT}/tests/fixtures/cloud-atomic-restore.html`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await sleep(250);
    if (attempt === 79) throw new Error(output);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    const runUntilUnknown = async behavior => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('staging-cloud-restore-harness').waitFor();
      await page.evaluate(next => {
        window.__CLOUD_RESTORE_SUBMIT_TEST__.reset();
        window.__CLOUD_RESTORE_SUBMIT_TEST__.setBehavior(next);
        window.__CLOUD_RESTORE_CONNECTIVITY_TEST__.fresh(1);
      }, behavior);
      await page.locator('input[type=file]').setInputFiles(SNAPSHOT);
      await page.getByTestId('cloud-restore-preflight').waitFor({ timeout: 30_000 });
      await page.getByTestId('cloud-restore-proof-button').click();
      await page.getByTestId('cloud-restore-proof-summary').waitFor({ timeout: 30_000 });
      await page.getByTestId('cloud-restore-confirmation').fill('OVERWRITE CLOUD DATA');
      await page.getByTestId('cloud-restore-submit').click();
      await page.getByTestId('cloud-restore-final-submit').click();
      await page.getByTestId('cloud-restore-check-outcome').waitFor();
      assert.match(await page.getByTestId('cloud-restore-status').innerText(), /待確認|待查證/u);
      let snapshot = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
      assert.equal(snapshot.prepareCalls, 1);
      assert.equal(snapshot.calls, 1);
      assert.equal(snapshot.reconcileCalls, 0);
      return snapshot;
    };

    await runUntilUnknown('lost-response-success');
    let snapshot = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    const unresolvedIdentity = {
      attemptId: snapshot.idempotencyKeys[0],
      traceId: snapshot.traceIds[0],
    };
    await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.remount());
    await page.getByTestId('cloud-restore-check-outcome').waitFor();
    snapshot = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(snapshot.prepareCalls, 1, 'Remount must not PREPARE an unresolved attempt again');
    assert.equal(snapshot.calls, 1, 'Remount must not EXECUTE an unresolved attempt again');
    await page.getByTestId('cloud-restore-check-outcome').click();
    await page.getByTestId('cloud-restore-result').waitFor();
    assert.match(await page.getByTestId('cloud-restore-status').innerText(), /Cloud Restore 完成/u);
    snapshot = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(snapshot.calls, 1, 'Outcome reconciliation must not dispatch Restore again');
    assert.equal(snapshot.reconcileCalls, 1);
    assert.deepEqual(
      { attemptId: snapshot.idempotencyKeys[0], traceId: snapshot.traceIds[0] },
      unresolvedIdentity,
      'Outcome reconciliation must retain the original attempt/trace envelope',
    );

    await runUntilUnknown('lost-response-failure');
    await page.getByTestId('cloud-restore-check-outcome').click();
    await page.getByTestId('cloud-restore-status').getByText(/已確認本次未提交/u).waitFor();
    await page.getByTestId('cloud-restore-check-outcome').waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('cloud-restore-submit').isDisabled(), true);
    snapshot = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(snapshot.calls, 1, 'Confirmed rollback must not auto-retry Restore');
    assert.equal(snapshot.reconcileCalls, 1);
  } finally {
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}

console.log('PASS real React unknown-success reconciliation: completed evidence renders success with one Restore dispatch');
console.log('PASS real React unknown-rollback reconciliation: explicit not-committed state stays locked with one Restore dispatch');
