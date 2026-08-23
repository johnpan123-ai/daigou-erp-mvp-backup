import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4295;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const fixtures = JSON.parse(await readFile(
  new URL('./fixtures/closing-date/generalized-retrieval-10.json', import.meta.url),
  'utf8',
));

const vite = spawn(process.execPath, [
  VITE, '--mode', 'next', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], {
  cwd: ROOT,
  env: {
    ...process.env,
    VITE_ENABLE_CLOSING_DATE_WORKBENCH_STORAGE: 'true',
    VITE_ENABLE_CLOSING_DATE_BATCH_GATEWAY: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

for (let attempt = 0; attempt < 80; attempt += 1) {
  if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
  try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
  if (attempt === 79) throw new Error(`Vite start timeout:\n${viteOutput}`);
  await sleep(100);
}

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  const forbiddenRequests = [];
  page.on('request', request => {
    if (/\/api\/catalog|\.supabase\.co\//iu.test(request.url())) forbiddenRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const report = await page.evaluate(async ({ cases }) => {
    const gatewayModule = await import('/src/lib/closingDateBatchGateway.ts');
    const cacheModule = await import('/src/lib/closingDateCatalogBatchCache.ts');
    const repositoryModule = await import('/src/lib/closingDateResolutionSidecarRepository.ts');
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const sizes = [1, 10, 25, 50];
    const databaseNames = [];
    const repositories = [];
    const rows = [];
    const stableStringify = value => JSON.stringify(value, (_key, nested) => {
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
      return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
    });
    const nextBefore = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
    const experimentalBefore = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-experimental-v1');
    const productionBefore = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db');

    const orderedCases = [cases[1], ...cases.filter((_entry, index) => index !== 1)];
    const makeItems = size => Array.from({ length: size }, (_, index) => {
      const fixture = orderedCases[index % orderedCases.length];
      return {
        clientItemId: `${fixture.id}-${index}`,
        erpProductGroupId: `load-group-${size}-${index}`,
        title: fixture.erpTitle,
        updatedAt: '2026-08-23T00:00:00.000Z',
        currentClosingDate: null,
        sourceType: 'proxy',
        proxyAgent: null,
        jan: null,
        modelCode: null,
        verifiedMappings: [],
      };
    });
    const requestFor = (size, run) => ({
      clientBatchId: `load-${size}-${run}-${crypto.randomUUID()}`,
      idempotencyKey: `load-${size}-${run}-${crypto.randomUUID()}`,
      inputHash: `load-input-${size}-${run}`,
      snapshotVersionPreference: 'LATEST',
      ruleVersion: 'closing-date-minus-two-v1',
      items: makeItems(size),
    });

    for (const size of sizes) {
      const databaseName = `daigou-erp-closing-date-sidecar-next-v1-load-${size}-${crypto.randomUUID()}`;
      databaseNames.push(databaseName);
      const baseRepository = repositoryModule.createNextClosingDateResolutionRepository({ databaseName });
      repositories.push(baseRepository);
      const repositoryReads = { pollBatch: 0, pollResults: 0 };
      const repository = new Proxy(baseRepository, {
        get(target, property) {
          const value = target[property];
          if (typeof value !== 'function') return value;
          return (...args) => {
            if (property === 'getResolutionBatch') repositoryReads.pollBatch += 1;
            if (property === 'listResolutionResults') repositoryReads.pollResults += 1;
            return value.apply(target, args);
          };
        },
      });
      const state = {
        calls: [], active: 0, peak: 0,
        supplierListings: { wanrong: 0, dreamlink: 0 },
      };
      const snapshot = {
        version: `load-snapshot-${size}`,
        capturedAt: '2026-08-23T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
      const client = {
        async openSnapshot() { return snapshot; },
        async search(request) {
          state.calls.push({ query: request.query, limit: request.limit });
          state.active += 1;
          state.peak = Math.max(state.peak, state.active);
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 20);
            request.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('cancelled', 'AbortError'));
            }, { once: true });
          });
          state.active -= 1;
          const fixture = orderedCases.find(entry => entry.retrievalQuery.toLocaleLowerCase() === request.query);
          if (!fixture) return { products: [], snapshotVersion: request.snapshotVersion };
          const supplier = fixture.id === 'tactical-bride-awayuki' ? 'dreamlink' : 'wanrong';
          const products = Array.from({ length: fixture.nativeRank - 1 }, (_, index) => ({
            id: `${fixture.id}-noise-${index}`,
            name: `無關候選商品 ${fixture.id} ${index}`,
            catalog: { supplier: { code: 'dreamlink' }, deadlineAt: '2026-09-07T08:00:00.000Z' },
          }));
          products.push({
            id: `${fixture.id}-correct`,
            name: fixture.candidateTitle,
            catalog: { supplier: { code: supplier }, deadlineAt: '2026-09-07T08:00:00.000Z' },
          });
          const returned = products.slice(0, request.limit);
          returned.forEach(product => {
            const code = product.catalog.supplier.code;
            state.supplierListings[code] = (state.supplierListings[code] ?? 0) + 1;
          });
          return { products: returned, snapshotVersion: request.snapshotVersion };
        },
      };
      const queryCache = new cacheModule.CatalogSnapshotQueryCache(client, {
        ttlMs: 60_000,
        maxConcurrency: 6,
      });
      const gateway = gatewayModule.createNextClosingDateBatchGateway({
        repository,
        catalogClient: client,
        queryCache,
        maxItemConcurrency: 6,
      });
      const run = async label => {
        const beforeCalls = state.calls.length;
        const beforeReads = { ...repositoryReads };
        const created = await gateway.createJob(requestFor(size, label));
        let poll;
        do {
          poll = await gateway.pollJob(created.jobId);
          if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(poll.batch.status)) await new Promise(resolve => setTimeout(resolve, 5));
        } while (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(poll.batch.status));
        const calls = state.calls.slice(beforeCalls);
        const byKey = new Map();
        calls.forEach(call => {
          const key = `${call.query}::${call.limit}`;
          byKey.set(key, (byKey.get(key) ?? 0) + 1);
        });
        return {
          metrics: poll.metrics,
          observedUpstreamRequests: calls.length,
          expandedWindowRequests: calls.filter(call => call.limit === 12).length,
          duplicatedUpstreamQueries: [...byKey.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
          maxSameQueryCalls: Math.max(0, ...byKey.values()),
          sidecarPollReads: {
            batches: repositoryReads.pollBatch - beforeReads.pollBatch,
            results: repositoryReads.pollResults - beforeReads.pollResults,
          },
          decisionHash: stableStringify(poll.results.map(result => ({
            product: result.erpProductGroupId,
            classification: result.classification,
            reason: result.classificationReason,
            candidates: result.candidates.map(candidate => ({
              title: candidate.catalogTitle,
              supplier: candidate.source.sourceSupplier,
              rawDeadline: candidate.rawDeadline,
              suggestedClosingDate: candidate.suggestedClosingDate,
              queryHits: candidate.retrieval?.queryHits,
            })),
          }))),
        };
      };
      const cold = await run('cold');
      const warm = await run('warm');
      rows.push({
        size,
        cold,
        warm,
        observedPeakConcurrency: state.peak,
        supplierListings: state.supplierListings,
      });
    }

    const nextAfter = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
    const experimentalAfter = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-experimental-v1');
    const productionAfter = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db');
    repositories.forEach(repository => repository.close());
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.all(databaseNames.map(databaseName => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    })));
    return {
      rows,
      nextUnchanged: stableStringify(nextBefore) === stableStringify(nextAfter),
      experimentalUnchanged: stableStringify(experimentalBefore) === stableStringify(experimentalAfter),
      productionUnchanged: stableStringify(productionBefore) === stableStringify(productionAfter),
    };
  }, { cases: fixtures });

  for (const row of report.rows) {
    assert.equal(row.cold.observedUpstreamRequests, row.cold.metrics.upstreamRequestCount);
    assert.equal(row.warm.observedUpstreamRequests, 0);
    assert.equal(row.warm.metrics.cacheHitRatio, 1);
    assert.equal(row.cold.duplicatedUpstreamQueries, 0);
    assert.ok(row.observedPeakConcurrency <= 6);
    assert.equal(row.cold.decisionHash, row.warm.decisionHash);
  }
  assert.equal(report.nextUnchanged, true);
  assert.equal(report.experimentalUnchanged, true);
  assert.equal(report.productionUnchanged, true);
  assert.deepEqual(forbiddenRequests, []);
  console.log('CLOSING_DATE_WORKBENCH_LOAD_REPORT');
  console.log(JSON.stringify({
    rows: report.rows.map(row => ({
      size: row.size,
      cold: {
        ...row.cold.metrics,
        observedUpstreamRequests: row.cold.observedUpstreamRequests,
        expandedWindowRequests: row.cold.expandedWindowRequests,
        duplicatedUpstreamQueries: row.cold.duplicatedUpstreamQueries,
        maxSameQueryCalls: row.cold.maxSameQueryCalls,
        sidecarPollReads: row.cold.sidecarPollReads,
      },
      warm: {
        ...row.warm.metrics,
        observedUpstreamRequests: row.warm.observedUpstreamRequests,
        expandedWindowRequests: row.warm.expandedWindowRequests,
        sidecarPollReads: row.warm.sidecarPollReads,
      },
      observedPeakConcurrency: row.observedPeakConcurrency,
      decisionsIdentical: row.cold.decisionHash === row.warm.decisionHash,
    })),
    nextUnchanged: report.nextUnchanged,
    experimentalUnchanged: report.experimentalUnchanged,
    productionUnchanged: report.productionUnchanged,
  }, null, 2));
  console.log('PASS 1/10/25/50 deterministic cold/warm Catalog load audit');
  console.log('PASS warm batch uses 0 upstream; decisions and ERP databases unchanged');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
