import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourceUrl = new URL('../functions/catalogProxyRuntime.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
}).outputText;
const runtime = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const {
  DEFAULT_CATALOG_PROXY_TIMEOUT_MS,
  proxyCatalogRequest,
  resolveCatalogProxyTimeoutMs,
} = runtime;

const logs = [];
let successCalls = 0;
const success = await proxyCatalogRequest({
  incoming: new Request('https://erp.test/api/catalog/search?q=safe-query&limit=5', {
    headers: { 'X-Request-ID': 'trace-proxy-1' },
  }),
  upstreamUrl: 'https://catalog.test/api/search?q=safe-query&limit=5',
  timeoutMs: 1_000,
  log: entry => logs.push(entry),
  fetcher: async (_input, init) => {
    successCalls += 1;
    assert.equal(init.headers['X-Request-ID'], 'trace-proxy-1');
    assert.equal(init.signal.aborted, false);
    return Response.json({ products: [{ id: 'p1' }] }, {
      headers: {
        'Server-Timing': 'db;dur=8.0',
        'X-Search-Query-Count': '2',
      },
    });
  },
});
assert.equal(success.status, 200);
assert.equal(successCalls, 1);
assert.deepEqual(await success.json(), { products: [{ id: 'p1' }] });
assert.equal(success.headers.get('X-Request-ID'), 'trace-proxy-1');
assert.equal(success.headers.get('Server-Timing'), 'db;dur=8.0');
assert.equal(success.headers.get('X-Search-Query-Count'), '2');
assert.equal(logs.some(entry => JSON.stringify(entry).includes('safe-query')), false);

let serverFailureCalls = 0;
const serverFailure = await proxyCatalogRequest({
  incoming: new Request('https://erp.test/api/catalog/search?q=failure'),
  upstreamUrl: 'https://catalog.test/api/search?q=failure',
  timeoutMs: 1_000,
  log: () => undefined,
  fetcher: async () => {
    serverFailureCalls += 1;
    return Response.json({ error: { code: 'CATALOG_SEARCH_INTERNAL_ERROR' } }, { status: 500 });
  },
});
assert.equal(serverFailure.status, 500, 'real Catalog 500 must stay 500');
assert.equal(serverFailureCalls, 1, '500 must not be retried');

let timeoutCalls = 0;
let outgoingAborted = false;
const timeout = await proxyCatalogRequest({
  incoming: new Request('https://erp.test/api/catalog/search?q=timeout'),
  upstreamUrl: 'https://catalog.test/api/search?q=timeout',
  timeoutMs: 20,
  log: () => undefined,
  fetcher: async (_input, init) => {
    timeoutCalls += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        outgoingAborted = true;
        reject(init.signal.reason);
      }, { once: true });
    });
  },
});
assert.equal(timeout.status, 504);
assert.equal((await timeout.json()).error.code, 'CATALOG_PROXY_TIMEOUT');
assert.equal(timeoutCalls, 1);
assert.equal(outgoingAborted, true);

let bodySignal;
const bodyHang = await proxyCatalogRequest({
  incoming: new Request('https://erp.test/api/catalog/search?q=body-hang'),
  upstreamUrl: 'https://catalog.test/api/search?q=body-hang',
  timeoutMs: 20,
  log: () => undefined,
  fetcher: async (_input, init) => {
    bodySignal = init.signal;
    return new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
      },
    }), { status: 200 });
  },
});
assert.equal(bodyHang.status, 504, 'body consumption hang must remain inside the deadline');
assert.equal(bodySignal.aborted, true);

const clientController = new AbortController();
const clientRequest = new Request('https://erp.test/api/catalog/search?q=cancel', {
  signal: clientController.signal,
});
let clientSignal;
const clientPromise = proxyCatalogRequest({
  incoming: clientRequest,
  upstreamUrl: 'https://catalog.test/api/search?q=cancel',
  timeoutMs: 1_000,
  log: () => undefined,
  fetcher: async (_input, init) => {
    clientSignal = init.signal;
    if (init.signal.aborted) throw init.signal.reason;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  },
});
clientController.abort();
const clientAbort = await clientPromise;
assert.equal(clientAbort.status, 499);
assert.equal((await clientAbort.json()).error.code, 'CATALOG_PROXY_ABORTED');
assert.equal(clientSignal.aborted, true);

const networkFailure = await proxyCatalogRequest({
  incoming: new Request('https://erp.test/api/catalog/search?q=network'),
  upstreamUrl: 'https://catalog.test/api/search?q=network',
  timeoutMs: 1_000,
  log: () => undefined,
  fetcher: async () => {
    throw new TypeError('connection failed');
  },
});
assert.equal(networkFailure.status, 502);
assert.equal((await networkFailure.json()).error.code, 'CATALOG_PROXY_UPSTREAM_ERROR');

assert.equal(resolveCatalogProxyTimeoutMs(undefined), DEFAULT_CATALOG_PROXY_TIMEOUT_MS);
assert.equal(resolveCatalogProxyTimeoutMs('45000'), 45_000);
assert.equal(resolveCatalogProxyTimeoutMs('bad'), DEFAULT_CATALOG_PROXY_TIMEOUT_MS);
assert.equal(resolveCatalogProxyTimeoutMs('999'), DEFAULT_CATALOG_PROXY_TIMEOUT_MS);
assert.doesNotMatch(source, /retry|backoff/iu);

console.log('Catalog Pages proxy timeout, body timeout, abort propagation, correlation, and no-retry contract: PASS');
