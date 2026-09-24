import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4297;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const vite = spawn(process.execPath, [
  VITE,
  '--mode', 'next',
  '--host', '127.0.0.1',
  '--port', String(PORT),
  '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const waitForVite = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {
      // Still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
};

let browser;
try {
  await waitForVite();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const api = await import('/src/lib/readonlyCatalogApi.ts');
    const cacheModule = await import('/src/lib/closingDateCatalogBatchCache.ts');

    const classify = async (status) => {
      const client = cacheModule.createReadonlyCatalogHttpClient({
        fetcher: async () => new Response('{}', { status }),
      });
      try {
        await client.search({
          query: 'fixture',
          limit: 5,
          snapshotVersion: 'snapshot-v1',
        });
        return null;
      } catch (error) {
        return { name: error.name, code: error.code, status: error.status };
      }
    };

    const abortController = new AbortController();
    const abortedClient = cacheModule.createReadonlyCatalogHttpClient({
      fetcher: async (_input, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      }),
    });
    const abortedPromise = abortedClient.search({
      query: 'fixture',
      limit: 5,
      snapshotVersion: 'snapshot-v1',
      signal: abortController.signal,
    }).catch(error => error.name);
    abortController.abort();

    let cacheSignalMatches = false;
    const cacheController = new AbortController();
    const cache = new cacheModule.CatalogSnapshotQueryCache({
      async openSnapshot() {
        return { version: 'snapshot-v1', capturedAt: '2026-09-24T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' };
      },
      async search(request) {
        cacheSignalMatches = request.signal === cacheController.signal;
        return { products: [], snapshotVersion: request.snapshotVersion };
      },
    });
    await cache.lookup({
      snapshot: { version: 'snapshot-v1', capturedAt: '2026-09-24T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
      query: 'fixture',
      signal: cacheController.signal,
    });

    const snapshot = {
      version: 'snapshot-shared',
      capturedAt: '2026-09-24T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    let sharedResolve;
    let sharedSignal;
    let sharedCalls = 0;
    const sharedCache = new cacheModule.CatalogSnapshotQueryCache({
      async openSnapshot() { return snapshot; },
      async search(request) {
        sharedCalls += 1;
        sharedSignal = request.signal;
        return new Promise((resolve, reject) => {
          sharedResolve = resolve;
          request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        });
      },
    });
    const consumerA = new AbortController();
    const consumerB = new AbortController();
    const sharedA = sharedCache.lookup({ snapshot, query: 'shared', signal: consumerA.signal })
      .then(() => 'resolved', error => error.name);
    const sharedB = sharedCache.lookup({ snapshot, query: 'shared', signal: consumerB.signal });
    await Promise.resolve();
    consumerA.abort();
    sharedResolve({ products: [{ id: 'kept-for-b' }], snapshotVersion: snapshot.version });
    const sharedAOutcome = await sharedA;
    const sharedBResult = await sharedB;

    let allCancelCalls = 0;
    let allCancelUnderlyingAborted = false;
    const allCancelCache = new cacheModule.CatalogSnapshotQueryCache({
      async openSnapshot() { return snapshot; },
      async search(request) {
        allCancelCalls += 1;
        if (allCancelCalls > 1) {
          return { products: [{ id: 'replacement' }], snapshotVersion: request.snapshotVersion };
        }
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            allCancelUnderlyingAborted = true;
            reject(request.signal.reason);
          }, { once: true });
        });
      },
    });
    const allCancelA = new AbortController();
    const allCancelB = new AbortController();
    const cancelledA = allCancelCache.lookup({ snapshot, query: 'all-cancel', signal: allCancelA.signal })
      .then(() => 'resolved', error => error.name);
    const cancelledB = allCancelCache.lookup({ snapshot, query: 'all-cancel', signal: allCancelB.signal })
      .then(() => 'resolved', error => error.name);
    await Promise.resolve();
    allCancelA.abort();
    allCancelB.abort();
    const cancelledOutcomes = await Promise.all([cancelledA, cancelledB]);
    const replacement = await allCancelCache.lookup({ snapshot, query: 'all-cancel' });

    let jsonCalls = 0;
    let directError;
    try {
      await api.fetchReadonlyCatalogJson('/api/catalog/search', async () => ({
        ok: false,
        status: 504,
        json: async () => { jsonCalls += 1; return {}; },
      }));
    } catch (error) {
      directError = { category: error.category, status: error.status };
    }

    return {
      timeout: await classify(504),
      service500: await classify(500),
      service502: await classify(502),
      abortName: await abortedPromise,
      cacheSignalMatches,
      sharedIsolation: {
        calls: sharedCalls,
        firstConsumer: sharedAOutcome,
        secondProducts: sharedBResult.response.products,
        underlyingAborted: sharedSignal?.aborted ?? null,
      },
      allCancel: {
        calls: allCancelCalls,
        outcomes: cancelledOutcomes,
        underlyingAborted: allCancelUnderlyingAborted,
        replacementProducts: replacement.response.products,
      },
      directError,
      jsonCalls,
    };
  });

  assert.deepEqual(result.timeout, { name: 'ClosingDateCatalogGatewayError', code: 'CATALOG_TIMEOUT', status: 504 });
  assert.deepEqual(result.service500, { name: 'ClosingDateCatalogGatewayError', code: 'CATALOG_SERVICE_ERROR', status: 500 });
  assert.deepEqual(result.service502, { name: 'ClosingDateCatalogGatewayError', code: 'CATALOG_SERVICE_ERROR', status: 502 });
  assert.equal(result.abortName, 'AbortError');
  assert.equal(result.cacheSignalMatches, false, 'shared cache must not permanently bind the upstream request to the first consumer signal');
  assert.deepEqual(result.sharedIsolation, {
    calls: 1,
    firstConsumer: 'AbortError',
    secondProducts: [{ id: 'kept-for-b' }],
    underlyingAborted: false,
  }, 'one cancelled consumer must not abort the shared request while another consumer remains');
  assert.deepEqual(result.allCancel, {
    calls: 2,
    outcomes: ['AbortError', 'AbortError'],
    underlyingAborted: true,
    replacementProducts: [{ id: 'replacement' }],
  }, 'all consumers cancelling must retire the entry and allow the next request to start');
  assert.deepEqual(result.directError, { category: 'TIMEOUT', status: 504 });
  assert.equal(result.jsonCalls, 0, 'timeout must fail closed without parsing an empty candidate response');
  console.log('Catalog TIMEOUT / SERVICE_ERROR / ABORTED mapping and fail-closed signal propagation: PASS');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
