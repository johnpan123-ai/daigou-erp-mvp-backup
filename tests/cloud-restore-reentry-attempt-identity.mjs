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
  const recovery = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreRecovery.ts');
  const safeRow = { attempt_id: '1e6a3707-13fd-4000-9281-3a1f3b1a3315', trace_id: 'eec83614-7b05-452d-b6f0-db000295c20c',
    status: 'executing', submitted_at: '2026-09-21T12:58:08Z', expected_epoch: 4,
    effective_fingerprint: 'e'.repeat(64), target_environment: 'staging' };
  assert.equal(recovery.parseCloudRestoreRecoveryRows([safeRow], 'staging')[0].traceId, safeRow.trace_id);
  for (const invalid of [null, [null], [{ ...safeRow, trace_id: null }], [{ ...safeRow, target_environment: 'other' }], [safeRow, safeRow]]) {
    assert.throws(() => recovery.parseCloudRestoreRecoveryRows(invalid, 'staging'));
  }
  assert.doesNotMatch(recovery.CLOUD_RESTORE_RECOVERY_COLUMNS, /actor_key|snapshot|canonical_result/u);
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
      await page.getByTestId('cloud-restore-proof-button').click();
      await page.getByTestId('cloud-restore-proof-summary').waitFor({ timeout: 30_000 });
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

    // Legacy server-only attempt: no full local envelope. Real panel must recover
    // its stored trace via the read boundary, never pair it with a generated trace.
    const legacy = { attemptId: '1e6a3707-13fd-4000-9281-3a1f3b1a3315', traceId: 'eec83614-7b05-452d-b6f0-db000295c20c',
      status: 'executing', submittedAt: '2026-09-21T12:58:08Z', expectedEpoch: 4, effectiveFingerprint: 'e'.repeat(64) };
    await page.evaluate(row => {
      sessionStorage.clear();
      sessionStorage.setItem('erp_cloud_restore_idempotency:legacy', row.attemptId);
      window.__CLOUD_RESTORE_SUBMIT_TEST__.reset();
      window.__CLOUD_RESTORE_SUBMIT_TEST__.setRecovery([row]);
      window.__CLOUD_RESTORE_SUBMIT_TEST__.remount();
    }, legacy);
    await page.getByTestId('cloud-restore-recovered-attempt').waitFor();
    assert.match(await page.getByTestId('cloud-restore-recovered-attempt').innerText(), new RegExp(legacy.traceId));
    assert.equal(await page.getByRole('button', { name: '選擇 JSON 並 Preflight' }).isDisabled(), true);
    let recovered = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(recovered.prepareCalls + recovered.calls + recovered.reconcileCalls, 0);
    await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.remount());
    await page.getByTestId('cloud-restore-recovered-attempt').waitFor();
    await page.getByTestId('cloud-restore-check-outcome').click();
    await page.getByTestId('cloud-restore-new-intent').waitFor();
    recovered = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(recovered.reconcileCalls, 1);
    assert.equal(recovered.prepareCalls + recovered.calls, 0);
    await page.getByTestId('cloud-restore-new-intent').click();
    await page.getByRole('button', { name: '選擇 JSON 並 Preflight' }).waitFor();
    await submit(true);
    const newRun = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(newRun.prepareCalls, 1);
    assert.equal(newRun.calls, 1);
    assert.notEqual(newRun.prepareAttemptIds[0], legacy.attemptId);
    assert.notEqual(newRun.traceIds[0], legacy.traceId);

    await page.evaluate(() => {
      sessionStorage.clear();
      window.__CLOUD_RESTORE_SUBMIT_TEST__.reset();
      window.__CLOUD_RESTORE_SUBMIT_TEST__.setRecovery('error');
      window.__CLOUD_RESTORE_SUBMIT_TEST__.remount();
    });
    await page.getByText('未決還原查詢失敗；新還原已暫停。', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '選擇 JSON 並 Preflight' }).isDisabled(), true);
    const failure = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(failure.prepareCalls + failure.calls + failure.reconcileCalls, 0);
  } finally {
    await browser.close();
  }
} finally {
  fixture.kill('SIGTERM');
}

console.log('PASS Restore re-entry identity: stable attempt/trace envelope, remount outcome-only recovery, completed replay, and terminal rotation');
