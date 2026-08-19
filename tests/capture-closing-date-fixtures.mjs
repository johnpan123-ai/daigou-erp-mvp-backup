import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/closing-date/dataset.json', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const PORT = 4266;
const baseUrl = `http://127.0.0.1:${PORT}`;
const shouldWrite = process.argv.includes('--write');
const refresh = process.argv.includes('--refresh');
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const dataset = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
const casesToCapture = dataset.cases.filter(testCase => (
  testCase.captureSource !== 'offline-regression-fixture'
  && (refresh || !testCase.catalogResponses?.length)
));
const capturedAt = new Date().toISOString();

const vite = spawn(process.execPath, [VITE, '--mode', 'next', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const waitForVite = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Private current-worktree Vite is still starting.
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
  const productionSupabaseRequests = [];
  page.on('request', request => {
    if (/\.supabase\.(?:co|in)\//iu.test(request.url())) productionSupabaseRequests.push(request.url());
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const captured = await page.evaluate(async input => {
    const matching = await import('/src/lib/proxyProductIdentity.ts');
    const queryCache = new Map();
    let networkRequestCount = 0;
    let cacheHitCount = 0;
    const sanitize = product => ({
      id: product.id ?? null,
      name: product.name ?? product.title ?? null,
      url: product.url ?? null,
      slug: product.slug ?? null,
      sku: product.sku ?? null,
      janCode: product.janCode ?? null,
      manufacturer: product.manufacturer ?? null,
      brand: product.brand ? { name: product.brand.name ?? null } : null,
      catalog: product.catalog
        ? {
          supplier: product.catalog.supplier ? { code: product.catalog.supplier.code ?? null } : null,
          deadlineAt: product.catalog.deadlineAt ?? null,
        }
        : null,
    });
    const search = async query => {
      if (queryCache.has(query)) {
        cacheHitCount += 1;
        return { ...queryCache.get(query), cacheHit: true };
      }
      networkRequestCount += 1;
      const response = await fetch(`/api/catalog/search?q=${encodeURIComponent(query)}&pageSize=8`, { method: 'GET' });
      if (!response.ok) {
        const result = { query, status: response.status, products: [], error: `HTTP ${response.status}` };
        queryCache.set(query, result);
        return { ...result, cacheHit: false };
      }
      const body = await response.json();
      const result = {
        query,
        status: response.status,
        products: Array.isArray(body.products) ? body.products.map(sanitize) : [],
      };
      queryCache.set(query, result);
      return { ...result, cacheHit: false };
    };

    const output = [];
    for (const testCase of input) {
      const identity = matching.normalizeProxyProductIdentity(testCase.erpProduct.title);
      const plannedQueries = matching.buildProxyCatalogQueries(identity);
      const responses = [];
      const candidates = [];
      let stoppedEarly = false;
      for (const query of plannedQueries) {
        const response = await search(query);
        responses.push(response);
        candidates.push(...response.products);
        const selection = matching.selectProxyCatalogCandidate(testCase.erpProduct.title, candidates);
        if (
          matching.isSafeProxyCatalogSelection(testCase.erpProduct.title, selection)
          && selection.candidate.catalog?.deadlineAt
        ) {
          stoppedEarly = responses.length < plannedQueries.length;
          break;
        }
      }
      const selection = matching.selectProxyCatalogCandidate(testCase.erpProduct.title, candidates);
      output.push({
        caseId: testCase.caseId,
        identity,
        plannedQueries,
        responses,
        candidateCount: candidates.length,
        status: selection.status,
        stoppedEarly,
      });
    }
    return { output, networkRequestCount, cacheHitCount };
  }, casesToCapture);

  for (const result of captured.output) {
    const testCase = dataset.cases.find(item => item.caseId === result.caseId);
    testCase.queries = result.plannedQueries;
    testCase.catalogResponses = result.responses.map(({ cacheHit: _cacheHit, ...response }) => response);
    testCase.retrieval = {
      plannedQueryCount: result.plannedQueries.length,
      executedQueryCount: result.responses.length,
      stoppedEarly: result.stoppedEarly,
      candidateCount: result.candidateCount,
      result: result.status,
    };
    testCase.capturedAt = capturedAt;
  }

  const zeroCandidate = captured.output.filter(item => item.candidateCount === 0).length;
  const matched = captured.output.filter(item => item.status === 'match').length;
  const summary = {
    cases: captured.output.length,
    zeroCandidate,
    candidateAvailable: captured.output.length - zeroCandidate,
    matched,
    safeReject: captured.output.length - zeroCandidate - matched,
    executedQueries: captured.output.reduce((sum, item) => sum + item.responses.length, 0),
    averageExecutedQueries: captured.output.length
      ? Number((captured.output.reduce((sum, item) => sum + item.responses.length, 0) / captured.output.length).toFixed(2))
      : 0,
    networkRequestCount: captured.networkRequestCount,
    cacheHitCount: captured.cacheHitCount,
    productionSupabaseRequests: productionSupabaseRequests.length,
  };

  assert.deepEqual(productionSupabaseRequests, [], 'Capture must not contact Production Supabase');
  console.log(`RUNTIME RETRIEVAL SUMMARY ${JSON.stringify(summary)}`);
  if (shouldWrite) {
    await writeFile(FIXTURE_PATH, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');
    console.log(`WROTE ${FIXTURE_PATH}`);
  } else {
    console.log('DRY RUN: fixture file was not written; pass --write to update tests/fixtures only.');
  }
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
