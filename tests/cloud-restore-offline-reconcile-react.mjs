import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = process.env.CLOUD_RESTORE_OFFLINE_TEST_PORT || '4286';
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
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('staging-cloud-restore-harness').waitFor();
    await page.evaluate(() => {
      window.__RESTORE_TEST_ONLINE__ = true;
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        get: () => window.__RESTORE_TEST_ONLINE__,
      });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
    });

    const runWakeScenario = async trigger => {
      const row = {
        attemptId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        status: 'prepared',
        submittedAt: '2026-09-26T00:00:00.000Z',
        expectedEpoch: 7,
        effectiveFingerprint: 'e'.repeat(64),
      };
      await page.evaluate(value => {
        sessionStorage.clear();
        window.__RESTORE_TEST_ONLINE__ = false;
        window.dispatchEvent(new Event('offline'));
        window.__CLOUD_RESTORE_SUBMIT_TEST__.reset();
        window.__CLOUD_RESTORE_SUBMIT_TEST__.setRecovery([value]);
        window.__CLOUD_RESTORE_SUBMIT_TEST__.remount();
      }, row);
      await sleep(150);
      let snapshot = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
      assert.equal(snapshot.reconcileCalls, 0, `${trigger}: offline state must not reconcile`);
      assert.equal(snapshot.prepareCalls + snapshot.calls, 0, `${trigger}: recovery must never create or execute a Restore`);

      await page.evaluate(kind => {
        window.__RESTORE_TEST_ONLINE__ = true;
        if (kind === 'remount') window.__CLOUD_RESTORE_SUBMIT_TEST__.remount();
        else if (kind === 'visibilitychange') document.dispatchEvent(new Event('visibilitychange'));
        else window.dispatchEvent(new Event(kind));
      }, trigger);
      await page.waitForFunction(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot().reconcileCalls === 1);
      await page.getByTestId('cloud-restore-new-intent').waitFor();
      snapshot = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
      assert.equal(snapshot.prepareCalls, 0, `${trigger}: recovery must not PREPARE`);
      assert.equal(snapshot.calls, 0, `${trigger}: recovery must not EXECUTE`);
      assert.equal(snapshot.reconcileCalls, 1, `${trigger}: exactly one evidence check closes the attempt`);
      assert(snapshot.recoveryLookupCalls >= 1, `${trigger}: server recovery boundary must be read`);
    };

    for (const trigger of ['online', 'focus', 'visibilitychange', 'remount']) {
      await runWakeScenario(trigger);
    }

    await page.evaluate(() => {
      window.__RESTORE_TEST_ONLINE__ = true;
      window.dispatchEvent(new Event('online'));
      window.__CLOUD_RESTORE_SUBMIT_TEST__.reset();
      window.__CLOUD_RESTORE_SUBMIT_TEST__.setBehavior('timeout');
      window.__CLOUD_RESTORE_SUBMIT_TEST__.setRecovery([{
        attemptId: crypto.randomUUID(), traceId: crypto.randomUUID(), status: 'prepared',
        submittedAt: '2026-09-26T00:00:00.000Z', expectedEpoch: 7, effectiveFingerprint: 'f'.repeat(64),
      }]);
      window.__CLOUD_RESTORE_SUBMIT_TEST__.remount();
    });
    await page.waitForFunction(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot().reconcileCalls === 1);
    await page.evaluate(() => window.__CLOUD_RESTORE_CONNECTIVITY_TEST__.fresh(8));
    await page.waitForFunction(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot().reconcileCalls === 2);
    await sleep(1_150);
    const bounded = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(bounded.reconcileCalls, 2, 'Manual authoritative freshness may wake a bounded second evidence check, never polling');
    assert.equal(bounded.prepareCalls + bounded.calls, 0, 'Manual refresh recovery must never submit Restore work');
  } finally {
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}

console.log('PASS real React offline recovery: online, focus, visibility, and remount reconcile the same durable attempt without PREPARE/EXECUTE');
console.log('PASS real React bounded recovery: manual authoritative freshness performs at most the second evidence check and never retries Restore');
