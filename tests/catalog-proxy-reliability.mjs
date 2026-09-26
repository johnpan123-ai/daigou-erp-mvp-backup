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
  CATALOG_WORKER_ORIGIN,
  DEFAULT_CATALOG_PROXY_TIMEOUT_MS,
  proxyCatalogRequest,
  resolveCatalogUpstreamPath,
  resolveCatalogUpstreamUrl,
  resolveCatalogProxyTimeoutMs,
} = runtime;

const productIdA = '11111111-1111-4111-8111-111111111111';
const productIdB = '22222222-2222-4222-8222-222222222222';
const catalogId = '33333333-3333-4333-8333-333333333333';
const upstreamCases = [
  {
    browserUrl: 'https://erp.example/api/catalog/deadline-candidates?q=test&limit=5',
    path: ['deadline-candidates'],
    expected: `${CATALOG_WORKER_ORIGIN}/api/catalog/deadline-candidates?q=test&limit=5`,
  },
  {
    browserUrl: `https://erp.example/api/catalog/deadline?catalogProductId=${productIdA}`,
    path: ['deadline'],
    expected: `${CATALOG_WORKER_ORIGIN}/api/catalog/deadline?catalogProductId=${productIdA}`,
  },
  {
    browserUrl: `https://erp.example/api/catalog/deadlines?catalogProductId=${productIdA}&catalogProductId=${productIdB}`,
    path: ['deadlines'],
    expected: `${CATALOG_WORKER_ORIGIN}/api/catalog/deadlines?catalogProductId=${productIdA}&catalogProductId=${productIdB}`,
  },
  {
    browserUrl: `https://erp.example/api/catalog/deadline-candidates?q=${encodeURIComponent('超像可動 空條承太郎')}&limit=5&catalogId=${catalogId}`,
    path: ['deadline-candidates'],
    expected: `${CATALOG_WORKER_ORIGIN}/api/catalog/deadline-candidates?q=${encodeURIComponent('超像可動 空條承太郎')}&limit=5&catalogId=${catalogId}`,
  },
  {
    browserUrl: 'https://erp.example/api/catalog/search?q=test&limit=8',
    path: ['search'],
    expected: `${CATALOG_WORKER_ORIGIN}/api/search?q=test&limit=8`,
  },
  {
    browserUrl: 'https://erp.example/api/catalog/catalog/deadline-candidates?q=test&limit=1',
    path: ['catalog', 'deadline-candidates'],
    expected: `${CATALOG_WORKER_ORIGIN}/api/catalog/deadline-candidates?q=test&limit=1`,
  },
];

for (const testCase of upstreamCases) {
  const browserUrl = new URL(testCase.browserUrl);
  const expectedUrl = new URL(testCase.expected);
  assert.equal(
    resolveCatalogUpstreamUrl(testCase.browserUrl, testCase.path),
    testCase.expected,
  );
  assert.equal(
    `${resolveCatalogUpstreamPath(testCase.path)}${browserUrl.search}`,
    `${expectedUrl.pathname}${expectedUrl.search}`,
  );
}

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

for (const path of ['deadline', 'deadlines', 'deadline-candidates']) {
  const incomingUrl = `https://erp.test/api/catalog/${path}?q=safe`;
  const response = await proxyCatalogRequest({
    incoming: new Request(incomingUrl),
    upstreamUrl: resolveCatalogUpstreamUrl(incomingUrl, [path]),
    timeoutMs: 1_000,
    log: () => undefined,
    fetcher: async input => Response.json({ path: String(input) }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).path, `${CATALOG_WORKER_ORIGIN}/api/catalog/${path}?q=safe`);
}

for (const status of [400, 404, 429, 503]) {
  const response = await proxyCatalogRequest({
    incoming: new Request(`https://erp.test/api/catalog/deadline?status=${status}`),
    upstreamUrl: `https://catalog.test/api/deadline?status=${status}`,
    timeoutMs: 1_000,
    log: () => undefined,
    fetcher: async () => Response.json({ error: { code: `UPSTREAM_${status}` } }, { status }),
  });
  assert.equal(response.status, status, `Catalog ${status} must be preserved`);
  assert.equal((await response.json()).error.code, `UPSTREAM_${status}`);
}

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
