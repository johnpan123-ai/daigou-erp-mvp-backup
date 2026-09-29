import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { CANONICAL_ERP2_TARGET, buildManifestIdentity } from '../scripts/promotion-safety.mjs';
import {
  assertCanonicalDeadlineCloudflareProof,
  assertCanonicalDeadlineRuntimeIdentity,
  buildDeadlineSidecarReadScript,
} from '../tools/pre-adoption-recovery/deadlineSidecarReadScript.mjs';
import { loadProductContracts } from '../tools/pre-adoption-recovery/productContracts.mjs';

const target = CANONICAL_ERP2_TARGET;
const cloudflareProof = Object.freeze({
  accountId: target.accountId,
  project: target.project,
  domain: target.domain,
});
const systemInformation = (runtimeLabel, overrides = {}) => ({
  'Environment Role': runtimeLabel,
  'Cloudflare Project': target.project,
  'Supabase Project': target.supabaseProject,
  'Public Fingerprint': target.publicFingerprint,
  ...overrides,
});
const manifest = (runtimeMarker, overrides = {}) => {
  const evidence = {
    schemaVersion: 2,
    source: { head: 'a'.repeat(40) },
    target: {
      role: target.role,
      accountId: target.accountId,
      project: target.project,
      runtimeMarker,
      supabaseProject: target.supabaseProject,
      publicFingerprint: target.publicFingerprint,
      ...overrides,
    },
    build: { timestamp: '2026-09-29T00:00:00.000Z', mode: 'staging' },
    files: [],
  };
  return { ...evidence, identity: buildManifestIdentity(evidence) };
};
const identityInput = ({ runtimeLabel = 'STAGING', systemOverrides = {}, candidate = null, hostname = target.domain } = {}) => ({
  hostname,
  cloudflareProof,
  systemInformation: systemInformation(runtimeLabel, systemOverrides),
  manifest: candidate,
});
const blocks = (input, code) => assert.throws(
  () => assertCanonicalDeadlineRuntimeIdentity(input, target),
  new RegExp(`DEADLINE_RECOVERY_IDENTITY_FAILED_CLOSED:${code}`, 'u'),
);

assert.doesNotThrow(() => assertCanonicalDeadlineCloudflareProof(cloudflareProof, target));
assert.doesNotThrow(() => assertCanonicalDeadlineRuntimeIdentity(identityInput({ runtimeLabel: 'STAGING' }), target));
assert.doesNotThrow(() => assertCanonicalDeadlineRuntimeIdentity(identityInput({
  runtimeLabel: 'PRODUCTION', candidate: manifest('PRODUCTION'),
}), target));
assert.throws(() => assertCanonicalDeadlineCloudflareProof({ ...cloudflareProof, accountId: 'wrong-account' }, target),
  /CLOUDFLARE_ACCOUNT_MISMATCH/u);
blocks(identityInput({ systemOverrides: { 'Cloudflare Project': 'wrong-project' } }), 'PAGES_PROJECT_MISMATCH');
blocks(identityInput({ systemOverrides: { 'Supabase Project': 'wrong-project-ref' } }), 'SUPABASE_PROJECT_MISMATCH');
blocks(identityInput({ systemOverrides: { 'Public Fingerprint': 'WRONG' } }), 'PUBLIC_FINGERPRINT_MISMATCH');
blocks(identityInput({ runtimeLabel: 'PRODUCTION', systemOverrides: { 'Cloudflare Project': 'wrong-project' } }),
  'PAGES_PROJECT_MISMATCH');
blocks(identityInput({ hostname: 'wrong.pages.dev' }), 'PAGES_DOMAIN_MISMATCH');
console.log('PASS canonical ERP2 identity is authoritative; STAGING/PRODUCTION labels are informational');

const contracts = await loadProductContracts();
const script = buildDeadlineSidecarReadScript(contracts, { cloudflareProof });
assert.match(script, /erp-build-identity\.json/u);
assert.match(script, /credentials: 'same-origin'/u);
assert.match(script, /cache: 'no-store'/u);
assert.match(script, /SYSTEM_INFORMATION_REQUIRED/u);
assert.match(script, /MANIFEST_IDENTITY_MISMATCH/u);
assert.match(script, /transaction\(Object\.values\(stores\), 'readonly'\)/u);
assert.match(script, /indexedDB\.databases\(\)/u);
assert.match(script, /request\.onupgradeneeded/u);
assert.doesNotMatch(script, /readwrite|\.put\(|\.add\(|\.delete\(|\.clear\(/u);

const browser = await chromium.launch({ headless: true });
try {
  const runCase = async ({
    runtimeLabel = 'STAGING',
    systemOverrides = {},
    manifestOverrides = {},
    manifestAvailable = false,
    seed = true,
  } = {}) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const displayed = systemInformation(runtimeLabel, systemOverrides);
    const servedManifest = manifest(runtimeLabel, manifestOverrides);
    const systemRows = Object.entries(displayed)
      .map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`)
      .join('');
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/erp-build-identity.json' && manifestAvailable) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(servedManifest) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><section aria-label="系統資訊"><dl>${systemRows}</dl></section>`,
      });
    });
    await page.goto(`https://${target.domain}/settings`);
    if (seed) {
      await page.evaluate(({ databaseName, stores }) => new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          for (const store of Object.values(stores)) request.result.createObjectStore(store, { keyPath: 'id' });
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(Object.values(stores), 'readwrite');
          Object.values(stores).forEach((store, index) => tx.objectStore(store).put({
            id: `fixture-${index}`, secretValue: 'DO_NOT_LOG_ROW',
          }));
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      }), { databaseName: contracts.deadlineDatabaseName, stores: contracts.deadlineStoreNames });
      await page.evaluate(() => {
        window.__deadlineTransactionModes = [];
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function transaction(storeNames, mode, options) {
          window.__deadlineTransactionModes.push(mode ?? 'readonly');
          return original.call(this, storeNames, mode, options);
        };
      });
    }
    return { context, page };
  };

  for (const candidate of [
    { runtimeLabel: 'STAGING', manifestAvailable: false },
    { runtimeLabel: 'PRODUCTION', manifestAvailable: true },
  ]) {
    const { context, page } = await runCase(candidate);
    assert.equal(await page.locator('[aria-label="系統資訊"] dt').count(), 4,
      `unexpected fixture page: ${await page.content()}`);
    const messages = [];
    page.on('console', message => messages.push(message.text()));
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(script),
    ]);
    const payload = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.deepEqual(Object.keys(payload).sort(), Object.keys(contracts.deadlineStoreNames).sort());
    assert.deepEqual(await page.evaluate(() => window.__deadlineTransactionModes), ['readonly']);
    assert.equal(messages.some(message => message.includes('DO_NOT_LOG_ROW')), false);
    await context.close();
  }
  console.log('PASS current pre-manifest STAGING and future manifest PRODUCTION runtimes export using readonly data access');

  for (const [systemOverrides, code] of [
    [{ 'Cloudflare Project': 'wrong-project' }, 'PAGES_PROJECT_MISMATCH'],
    [{ 'Supabase Project': 'wrong-project-ref' }, 'SUPABASE_PROJECT_MISMATCH'],
    [{ 'Public Fingerprint': 'WRONG' }, 'PUBLIC_FINGERPRINT_MISMATCH'],
  ]) {
    const { context, page } = await runCase({ runtimeLabel: 'PRODUCTION', systemOverrides });
    await assert.rejects(() => page.evaluate(script), new RegExp(code, 'u'));
    await context.close();
  }
  const manifestMismatch = await runCase({
    runtimeLabel: 'PRODUCTION', manifestAvailable: true, manifestOverrides: { project: 'wrong-project' },
  });
  await assert.rejects(() => manifestMismatch.page.evaluate(script), /PAGES_PROJECT_MISMATCH/u);
  await manifestMismatch.context.close();
  console.log('PASS wrong runtime or manifest target fields fail closed even when the UI label says PRODUCTION');

  const { context, page } = await runCase({ runtimeLabel: 'STAGING', seed: false });
  await assert.rejects(() => page.evaluate(script), /DEADLINE_SIDECAR_DATABASE_MISSING/u);
  assert.equal((await page.evaluate(() => indexedDB.databases())).some(row => (
    row.name === contracts.deadlineDatabaseName
  )), false);
  await context.close();
  console.log('PASS missing Deadline database fails without creating it');
} finally {
  await browser.close();
}

console.log(JSON.stringify({
  result: 'PASS',
  canonicalIdentity: 'PASS',
  currentPreManifestRuntime: 'PASS',
  wrongTargetFailClosed: 'PASS',
  readonlyDeadlineExport: 'PASS',
  liveMutation: 0,
}));
