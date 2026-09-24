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
      directError,
      jsonCalls,
    };
  });

  assert.deepEqual(result.timeout, { name: 'ClosingDateCatalogGatewayError', code: 'CATALOG_TIMEOUT', status: 504 });
  assert.deepEqual(result.service500, { name: 'ClosingDateCatalogGatewayError', code: 'CATALOG_SERVICE_ERROR', status: 500 });
  assert.deepEqual(result.service502, { name: 'ClosingDateCatalogGatewayError', code: 'CATALOG_SERVICE_ERROR', status: 502 });
  assert.equal(result.abortName, 'AbortError');
  assert.equal(result.cacheSignalMatches, true, 'cache must propagate the consumer signal to the actual upstream request');
  assert.deepEqual(result.directError, { category: 'TIMEOUT', status: 504 });
  assert.equal(result.jsonCalls, 0, 'timeout must fail closed without parsing an empty candidate response');
  console.log('Catalog TIMEOUT / SERVICE_ERROR / ABORTED mapping and fail-closed signal propagation: PASS');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
