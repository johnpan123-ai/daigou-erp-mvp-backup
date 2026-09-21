import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT = process.env.CLOUD_RESTORE_REENTRY_SNAPSHOT
  || 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-21-125752.json';
assert(existsSync(SNAPSHOT), `Missing Restore re-entry fixture: ${SNAPSHOT}`);
const snapshotBytes = readFileSync(SNAPSHOT);
const snapshotDocument = JSON.parse(snapshotBytes.toString('utf8'));
assert.equal(snapshotDocument.manifest.resourceCount, 15);
assert.equal(snapshotDocument.manifest.totalRows, 17_776);
assert.equal(snapshotDocument.manifest.snapshotFingerprint, 'e07dea2e3725e933b0deb58bf71e5b24a21c957f04b09a2c0ce27755718bbf02');
assert.equal(createHash('sha256').update(snapshotBytes).digest('hex'), '5a8e33d49da3d731cf4d876476a6eb341acadf7aa50abf3f971dbab6fc1dfaa6');

const memoryStorage = new Map();
globalThis.sessionStorage = {
  get length() { return memoryStorage.size; },
  getItem: key => memoryStorage.get(key) ?? null,
  setItem: (key, value) => { memoryStorage.set(String(key), String(value)); },
  removeItem: key => { memoryStorage.delete(key); },
  key: index => [...memoryStorage.keys()][index] ?? null,
  clear: () => memoryStorage.clear(),
};

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const identity = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreSubmit.ts');
  const fingerprintA = 'a'.repeat(64);
  const fingerprintB = 'b'.repeat(64);
  const first = identity.readOrCreateCloudRestoreIntentIdentity(fingerprintA, new Map());
  const sameMounted = identity.readOrCreateCloudRestoreIntentIdentity(fingerprintA, new Map([[fingerprintA, first]]));
  const sameRemounted = identity.readOrCreateCloudRestoreIntentIdentity(fingerprintA, new Map());
  assert.deepEqual(sameMounted, first, 'Mounted intent must retain the full attempt/trace envelope');
  assert.deepEqual(sameRemounted, first, 'Remounted intent must retain the full attempt/trace envelope');

  sessionStorage.setItem(`erp_cloud_restore_idempotency:${fingerprintB}`, first.attemptId);
  const second = identity.readOrCreateCloudRestoreIntentIdentity(fingerprintB, new Map());
  assert.notEqual(second.attemptId, first.attemptId, 'Legacy attempt-only storage must not be paired with a new trace');
  assert.notEqual(second.traceId, first.traceId, 'A new candidate must receive a new trace with its new attempt');

  identity.persistCloudRestoreUnresolvedAttempt({ attemptId: first.attemptId, traceId: first.traceId });
  assert.deepEqual(identity.readCloudRestoreUnresolvedAttempt(), {
    attemptId: first.attemptId,
    traceId: first.traceId,
  });
  identity.retireCloudRestoreIntentIdentity(first, new Map([[fingerprintA, first]]));
  identity.clearCloudRestoreUnresolvedAttempt();
  assert.equal(identity.readCloudRestoreUnresolvedAttempt(), null);
  const afterNotCommitted = identity.readOrCreateCloudRestoreIntentIdentity(fingerprintA, new Map());
  assert.notEqual(afterNotCommitted.attemptId, first.attemptId, 'Confirmed not-committed intent must rotate both identity fields');
  assert.notEqual(afterNotCommitted.traceId, first.traceId, 'Confirmed not-committed intent must rotate both identity fields');
} finally {
  await vite.close();
}

const PORT = process.env.CLOUD_RESTORE_REENTRY_TEST_PORT || '4271';
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fixture = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--config', 'tests/fixtures/cloud-atomic-restore-vite.config.mjs', '--mode', 'experimental',
  '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
fixture.stdout.on('data', chunk => { output += String(chunk); });
fixture.stderr.on('data', chunk => { output += String(chunk); });
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
      sessionStorage.clear();
      window.__CLOUD_RESTORE_SUBMIT_TEST__.reset();
      window.__CLOUD_RESTORE_SUBMIT_TEST__.setBehavior('success');
      window.__CLOUD_RESTORE_CONNECTIVITY_TEST__.fresh(1);
    });
    const submit = async (doubleSubmit = false) => {
      await page.locator('input[type=file]').setInputFiles(SNAPSHOT);
      await page.getByTestId('cloud-restore-preflight').waitFor({ timeout: 30_000 });
      await page.getByTestId('cloud-restore-confirmation').fill('OVERWRITE CLOUD DATA');
      await page.getByTestId('cloud-restore-submit').click();
      if (doubleSubmit) {
        await page.evaluate(() => {
          const form = document.querySelector('[data-testid="cloud-restore-final-confirmation"] form');
          form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
      } else {
        await page.getByTestId('cloud-restore-final-submit').click();
      }
      await page.getByTestId('cloud-restore-result').waitFor();
    };

    await submit(true);
    const firstRun = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(firstRun.prepareCalls, 1, 'Double submit must PREPARE one stable intent');
    assert.equal(firstRun.calls, 1, 'Double submit must dispatch the destructive RPC at most once');
    assert.equal(firstRun.candidates[0].fingerprint, snapshotDocument.manifest.snapshotFingerprint);
    const firstEnvelope = { attemptId: firstRun.idempotencyKeys[0], traceId: firstRun.traceIds[0] };

    await page.evaluate(() => {
      window.__CLOUD_RESTORE_SUBMIT_TEST__.reset();
      window.__CLOUD_RESTORE_SUBMIT_TEST__.setBehavior('completed-replay');
      window.__CLOUD_RESTORE_CONNECTIVITY_TEST__.fresh(1);
      window.__CLOUD_RESTORE_SUBMIT_TEST__.remount();
    });
    await page.getByTestId('cloud-restore-access').waitFor();
    await submit();
    const replay = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(replay.prepareCalls, 1, 'Completed replay may PREPARE the exact same envelope once');
    assert.equal(replay.calls, 0, 'Completed replay must not EXECUTE Restore again');
    assert.deepEqual(
      { attemptId: replay.prepareAttemptIds[0], traceId: replay.traceIds[0] },
      firstEnvelope,
      'Completed same-candidate replay must use the exact original envelope',
    );
  } finally {
    await browser.close();
  }
} finally {
  fixture.kill('SIGTERM');
}

console.log('PASS Restore re-entry identity: stable attempt/trace envelope, remount outcome-only recovery, completed replay, and terminal rotation');
