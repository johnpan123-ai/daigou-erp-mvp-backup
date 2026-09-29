import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { CANONICAL_ERP2_TARGET } from '../scripts/promotion-safety.mjs';
import { loadProductContracts } from '../tools/pre-adoption-recovery/productContracts.mjs';
import {
  REAL_BROWSER_ATTACHMENT_METHOD,
  assertRealBrowserAttachment,
  exportDeadlineSidecarFromCdp,
  exportDeadlineSidecarFromPage,
} from '../tools/pre-adoption-recovery/realBrowserDeadlineExporter.mjs';

const target = CANONICAL_ERP2_TARGET;
const cloudflareProof = {
  accountId: target.accountId,
  project: target.project,
  domain: target.domain,
};

assert.throws(
  () => assertRealBrowserAttachment({ method: 'ISOLATED_BROWSER_EVALUATE', endpoint: 'http://127.0.0.1:9222' }),
  /ISOLATED_CONTEXT_REJECTED/u,
);
assert.throws(
  () => assertRealBrowserAttachment({ method: REAL_BROWSER_ATTACHMENT_METHOD, endpoint: 'http://192.168.0.2:9222' }),
  /CDP_ENDPOINT_NOT_LOOPBACK/u,
);
console.log('PASS isolated browser evaluate and non-loopback CDP endpoints fail closed');

const contracts = await loadProductContracts();
const temporaryRoot = await mkdtemp(join(tmpdir(), 'erp2-deadline-real-origin-'));
const output = join(temporaryRoot, 'erp2-deadline-durable-recovery.json');
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(error => (error ? reject(error) : resolve(address.port)));
  });
});
const endpoint = `http://127.0.0.1:${port}`;
const chromeProcess = spawn(chromium.executablePath(), [
  '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
  `--user-data-dir=${join(temporaryRoot, 'profile')}`, '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', 'about:blank',
], { stdio: 'ignore', windowsHide: true });
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const response = await fetch(`${endpoint}/json/version`);
    if (response.ok) break;
  } catch { /* Retry until the isolated fixture browser exposes CDP. */ }
  if (attempt === 99) throw new Error('FIXTURE_CDP_START_TIMEOUT');
  await delay(50);
}
const browser = await chromium.connectOverCDP(endpoint);
try {
  const [context] = browser.contexts();
  const page = await context.newPage();
  const systemInformation = {
    'Environment Role': 'STAGING / 測試雲端',
    'Cloudflare Project': target.project,
    'Supabase Project': target.supabaseProject,
    'Public Fingerprint': target.publicFingerprint,
  };
  const systemRows = Object.entries(systemInformation)
    .map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`)
    .join('');
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/erp-build-identity.json') {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><section aria-label="系統資訊"><dl>${systemRows}</dl></section>`,
    });
  });
  await page.goto(`https://${target.domain}/settings`);
  await page.evaluate(({ databaseName, stores }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      for (const store of Object.values(stores)) request.result.createObjectStore(store, { keyPath: 'id' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(Object.values(stores), 'readwrite');
      tx.objectStore(stores.deadlineVerifiedMappings).put({
        id: 'mapping-fixture', source: 'fixture-only',
      });
      tx.objectStore(stores.deadlineApplyBatches).put({
        id: 'batch-fixture', source: 'fixture-only',
      });
      tx.objectStore(stores.deadlineApplyItems).put({
        id: 'item-fixture', applyBatchId: 'batch-fixture', source: 'fixture-only',
      });
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

  const result = await exportDeadlineSidecarFromCdp({
    cdpUrl: endpoint, contracts, cloudflareProof, output,
  });
  assert.equal(result.result, 'PASS');
  assert.equal(result.totalRows, 3);
  assert.equal(chromeProcess.exitCode, null, 'exporter must disconnect without terminating Chrome');
  assert.deepEqual(await page.evaluate(() => window.__deadlineTransactionModes), ['readonly']);
  const payload = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(contracts.deadlineStoreNames).sort());
  console.log('PASS connectOverCDP exports only durable Deadline stores through a readonly real-origin transaction');

  const isolatedPage = {
    evaluate: async () => ({
      hostname: target.domain,
      origin: `https://${target.domain}`,
      indexedDBAvailable: false,
      systemInformation,
      manifest: null,
    }),
  };
  await assert.rejects(() => exportDeadlineSidecarFromPage({
    page: isolatedPage,
    contracts,
    cloudflareProof,
    output: join(temporaryRoot, 'isolated.json'),
    attachment: { method: REAL_BROWSER_ATTACHMENT_METHOD, endpoint: 'http://127.0.0.1:9222' },
  }), /REAL_ERP2_ORIGIN_CONTEXT_REQUIRED/u);
  console.log('PASS an isolated evaluator with no origin IndexedDB cannot be treated as a real ERP2 page context');

} finally {
  chromeProcess.kill();
  await Promise.race([
    new Promise(resolve => chromeProcess.once('exit', resolve)),
    delay(2_000),
  ]);
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  result: 'PASS',
  realOriginRequired: true,
  isolatedEvaluateRejected: true,
  transactionMode: 'readonly',
  liveMutation: 0,
}));
