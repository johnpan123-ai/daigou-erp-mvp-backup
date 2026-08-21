import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 4284;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'next', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try { if ((await fetch(BASE_URL)).ok) return; } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error(`Vite start timeout:\n${viteOutput}`);
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await context.newPage();
  const supabaseRequests = [];
  page.on('request', request => {
    if (/\.supabase\.co\//iu.test(request.url())) supabaseRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  const report = await page.evaluate(async () => {
    const domain = await import('/src/lib/closingDateResolutionDomain.ts');
    const repositoryModule = await import('/src/lib/closingDateResolutionSidecarRepository.ts');
    const gatewayModule = await import('/src/lib/closingDateBatchGateway.ts');
    const cacheModule = await import('/src/lib/closingDateCatalogBatchCache.ts');
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const databaseNames = [];
    const repositories = [];
    const stableStringify = value => JSON.stringify(value, (_key, nested) => {
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
      return Object.fromEntries(
        Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)),
      );
    });
    const deleteDatabase = databaseName => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`Delete blocked: ${databaseName}`));
    });
    const registerDatabase = label => {
      const name = `daigou-erp-closing-date-sidecar-next-v1-perf-${label}-${crypto.randomUUID()}`;
      databaseNames.push(name);
      return name;
    };
    const nextBefore = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
    const productionBefore = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db');

    const queryPlan = item => {
      const index = Number(item.clientItemId.split('-').at(-1));
      const scope = item.title.split(':')[0].toLocaleLowerCase();
      return [
        `${scope}-common`,
        `${scope}-supplier-${index % 2}`,
        `${scope}-line-${index % 5}`,
        `${scope}-series-${index % 10}`,
        `${scope}-subject-${index}`,
        ...(index % 2 === 0 ? [`${scope}-model-${index}`] : []),
      ];
    };
    const analyzer = async analysis => {
      for (const query of queryPlan(analysis.item)) await analysis.search(query);
      return domain.createResolutionResult({
        id: `${analysis.batchId}:${analysis.item.clientItemId}`,
        batchId: analysis.batchId,
        erpProductGroupId: analysis.item.erpProductGroupId,
        erpTitleAtAnalysis: analysis.item.title,
        candidates: [{
          id: `${analysis.batchId}:candidate:${analysis.item.clientItemId}`,
          source: {
            sourceSupplier: 'wanrong',
            sourceProductId: `source-${analysis.item.clientItemId}`,
            sourceCatalogId: analysis.snapshot.version,
          },
          catalogTitle: `Catalog ${analysis.item.title}`,
          rawDeadline: '2026-09-18',
          suggestedClosingDate: '2026-09-16',
          ruleVersion: analysis.ruleVersion,
          snapshotVersion: analysis.snapshot.version,
          confidence: 1,
          matchMethod: 'PARSER_INFERRED',
        }],
        ruleVersion: analysis.ruleVersion,
        snapshotVersion: analysis.snapshot.version,
        analyzedAt: analysis.analyzedAt,
      });
    };
    const makeRequest = (size, run) => ({
      clientBatchId: `perf-${size}-${run}`,
      idempotencyKey: `perf-idempotency-${size}-${run}`,
      inputHash: `perf-input-${size}-${run}`,
      snapshotVersionPreference: 'LATEST',
      ruleVersion: 'closing-date-minus-two-v1',
      items: Array.from({ length: size }, (_, index) => ({
        clientItemId: `item-${index}`,
        erpProductGroupId: `perf-group-${size}-${index}`,
        title: `BENCH-${size}: Product ${index}`,
        sourceType: 'proxy',
        verifiedMappings: [],
      })),
    });

    const rows = [];
    for (const size of [10, 50, 100]) {
      const state = { active: 0, peak: 0, upstreamRequests: 0 };
      const client = {
        async openSnapshot() {
          return {
            version: `performance-snapshot-${size}`,
            capturedAt: '2026-08-21T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
          };
        },
        async search(request) {
          state.upstreamRequests += 1;
          state.active += 1;
          state.peak = Math.max(state.peak, state.active);
          await new Promise(resolve => setTimeout(resolve, 15));
          state.active -= 1;
          return { products: [], snapshotVersion: request.snapshotVersion };
        },
      };
      const repository = repositoryModule.createNextClosingDateResolutionRepository({
        databaseName: registerDatabase(String(size)),
      });
      repositories.push(repository);
      const queryCache = new cacheModule.CatalogSnapshotQueryCache(client, {
        ttlMs: 60_000,
        maxConcurrency: 6,
      });
      const gateway = gatewayModule.createNextClosingDateBatchGateway({
        repository,
        catalogClient: client,
        queryCache,
        analyzer,
        maxItemConcurrency: 8,
      });
      const coldCreated = await gateway.createJob(makeRequest(size, 'cold'));
      const cold = await gateway.waitForJob(coldCreated.jobId);
      const requestsAfterCold = state.upstreamRequests;
      const warmCreated = await gateway.createJob(makeRequest(size, 'warm'));
      const warm = await gateway.waitForJob(warmCreated.jobId);
      const warmUpstreamRequests = state.upstreamRequests - requestsAfterCold;
      rows.push({
        size,
        cold: cold.metrics,
        warm: warm.metrics,
        observedUpstreamRequests: {
          cold: requestsAfterCold,
          warm: warmUpstreamRequests,
        },
        observedPeakConcurrency: state.peak,
        persisted: await repository.getStoreCounts(),
      });
    }

    const nextAfter = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
    const productionAfter = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db');
    repositories.forEach(repository => repository.close());
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.all(databaseNames.map(deleteDatabase));
    return {
      mode: 'deterministic-local-readonly-upstream-15ms',
      maxUpstreamConcurrency: 6,
      maxItemConcurrency: 8,
      rows,
      nextUnchanged: stableStringify(nextBefore) === stableStringify(nextAfter),
      productionUnchanged: stableStringify(productionBefore) === stableStringify(productionAfter),
    };
  });

  for (const row of report.rows) {
    const expectedLogicalQueries = row.size * 5 + Math.ceil(row.size / 2);
    assert.equal(row.cold.logicalQueryCount, expectedLogicalQueries);
    assert.equal(row.warm.logicalQueryCount, expectedLogicalQueries);
    assert.equal(row.cold.upstreamRequestCount, row.observedUpstreamRequests.cold);
    assert.equal(row.observedUpstreamRequests.warm, 0);
    assert.equal(row.warm.upstreamRequestCount, 0);
    assert.equal(row.warm.cacheHitCount, expectedLogicalQueries);
    assert.equal(row.warm.cacheHitRatio, 1);
    assert.ok(row.cold.dedupeRatio > 0);
    assert.ok(row.cold.upstreamRequestCount < row.cold.logicalQueryCount);
    assert.ok(row.cold.maxUpstreamConcurrency <= report.maxUpstreamConcurrency);
    assert.ok(row.observedPeakConcurrency <= report.maxUpstreamConcurrency);
    assert.ok(row.warm.totalTimeMs < row.cold.totalTimeMs);
    assert.equal(row.persisted.closing_date_resolution_batches, 2);
    assert.equal(row.persisted.closing_date_resolution_results, row.size * 2);
    assert.equal(row.persisted.closing_date_resolution_candidates, row.size * 2);
    assert.equal(row.cold.serviceErrorCount, 0);
    assert.equal(row.warm.serviceErrorCount, 0);
    assert.equal(row.cold.cancellationCount, 0);
    assert.equal(row.warm.cancellationCount, 0);
  }
  assert.equal(report.nextUnchanged, true);
  assert.equal(report.productionUnchanged, true);
  assert.deepEqual(supabaseRequests, []);

  console.log('PERFORMANCE_REPORT');
  console.log(JSON.stringify(report, null, 2));
  console.log('PASS 10/50/100 cold/warm Batch Gateway performance measurements');
  console.log('PASS warm cache performs 0 upstream requests');
  console.log('PASS Production Supabase requests = 0; ERP DB checksums unchanged');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
