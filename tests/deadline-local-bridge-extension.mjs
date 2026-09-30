import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { CANONICAL_ERP2_TARGET } from '../scripts/promotion-safety.mjs';
import { runDeadlineLocalBridge } from '../tools/pre-adoption-recovery/deadlineLocalBridgeServer.mjs';
import { loadProductContracts } from '../tools/pre-adoption-recovery/productContracts.mjs';

const root = resolve('.');
const contracts = await loadProductContracts(root);
const target = CANONICAL_ERP2_TARGET;
const temporaryRoot = await mkdtemp(join(tmpdir(), 'erp2-deadline-extension-e2e-'));
const output = join(temporaryRoot, 'erp2-deadline-durable-recovery.json');
const extensionRoot = resolve(root, 'tools/pre-adoption-recovery/deadline-local-bridge-extension');
const fixture = {
  deadlineVerifiedMappings: [{ id: 'mapping-extension-e2e', mapping: { verified: true } }],
  deadlineApplyBatches: [{ id: 'batch-extension-e2e', result: 'PASS' }],
  deadlineApplyItems: [{ id: 'item-extension-e2e', applyBatchId: 'batch-extension-e2e' }],
};

const receiver = runDeadlineLocalBridge({
  output, contracts,
  cloudflareProof: { accountId: target.accountId, project: target.project, domain: target.domain },
  expected: target, timeoutMs: 30_000,
});
const context = await chromium.launchPersistentContext(join(temporaryRoot, 'profile'), {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
});
try {
  const page = await context.newPage();
  const systemInformation = {
    'Environment Role': 'STAGING / 測試雲端',
    'Cloudflare Project': target.project,
    'Supabase Project': target.supabaseProject,
    'Public Fingerprint': target.publicFingerprint,
  };
  const systemRows = Object.entries(systemInformation)
    .map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join('');
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== target.domain) { await route.continue(); return; }
    if (url.pathname === '/erp-build-identity.json') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>SPA fallback</p>' });
      return;
    }
    const instrumentation = url.pathname === '/settings'
      ? `<script>window.__deadlineTransactionModes=[];const original=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(names,mode,options){window.__deadlineTransactionModes.push(mode??'readonly');return original.call(this,names,mode,options);};setTimeout(()=>document.body.insertAdjacentHTML('beforeend',${JSON.stringify(`<section aria-label="系統資訊"><dl>${systemRows}</dl></section>`)}),250);</script>`
      : '';
    await route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><body>${instrumentation}${url.pathname === '/settings' ? '' : `<section aria-label="系統資訊"><dl>${systemRows}</dl></section>`}</body>`,
    });
  });
  await page.goto(`https://${target.domain}/bootstrap`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ databaseName, stores, data }) => new Promise((resolveRequest, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      for (const store of Object.values(stores)) request.result.createObjectStore(store, { keyPath: 'id' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(Object.values(stores), 'readwrite');
      for (const [key, store] of Object.entries(stores)) {
        for (const row of data[key]) tx.objectStore(store).put(row);
      }
      tx.oncomplete = () => { db.close(); resolveRequest(); };
      tx.onerror = () => reject(tx.error);
    };
  }), { databaseName: contracts.deadlineDatabaseName, stores: contracts.deadlineStoreNames, data: fixture });
  await page.goto(`https://${target.domain}/settings`, { waitUntil: 'domcontentloaded' });
  const result = await receiver;
  assert.equal(result.result, 'PASS');
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), fixture);
  assert.deepEqual(await page.evaluate(() => window.__deadlineTransactionModes), ['readonly']);
  console.log('PASS real MV3 MAIN world -> isolated content -> service worker -> loopback file bridge');
} finally {
  await context.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  result: 'PASS', mainWorld: true, isolatedContent: true, serviceWorker: true,
  loopbackFile: true, transactionMode: 'readonly', liveMutation: 0,
}));
