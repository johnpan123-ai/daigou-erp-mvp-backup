import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 4287;
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
const waitForServer = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try { if ((await fetch(BASE_URL)).ok) return; } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error(`Vite start timeout:\n${viteOutput}`);
};

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
    const gatewayModule = await import('/src/lib/closingDateBatchGateway.ts');
    const cacheModule = await import('/src/lib/closingDateCatalogBatchCache.ts');
    const repositoryModule = await import('/src/lib/closingDateResolutionSidecarRepository.ts');
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const stableStringify = value => JSON.stringify(value, (_key, nested) => {
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
      return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
    });
    const nextBefore = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
    const productionBefore = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db');
    const databaseNames = [];
    const repositories = [];
    const rows = [];

    const makeItem = (size, index) => {
      const fixtureIndex = index % 10;
      return {
        clientItemId: `item-${size}-${index}`,
        erpProductGroupId: `group-${size}-${index}`,
        title: `代理版 角川 KDcolle 測試作品${fixtureIndex} 測試角色${fixtureIndex} 原作版 無比例 約15公分`,
        updatedAt: '2026-08-21T00:00:00.000Z',
        currentClosingDate: null,
        sourceType: 'proxy',
        proxyAgent: null,
        jan: null,
        modelCode: null,
        verifiedMappings: [],
      };
    };
    const makeRequest = (size, run) => ({
      clientBatchId: `retrieval-v2-perf-${size}-${run}`,
      idempotencyKey: `retrieval-v2-perf-${size}-${run}`,
      inputHash: `retrieval-v2-perf-input-${size}-${run}`,
      snapshotVersionPreference: 'LATEST',
      ruleVersion: 'closing-date-minus-two-v1',
      items: Array.from({ length: size }, (_, index) => makeItem(size, index)),
    });

    for (const size of [10, 50, 100]) {
      const databaseName = `daigou-erp-closing-date-sidecar-next-v1-retrieval-perf-${size}-${crypto.randomUUID()}`;
      databaseNames.push(databaseName);
      const repository = repositoryModule.createNextClosingDateResolutionRepository({ databaseName });
      repositories.push(repository);
      const state = { requests: 0, active: 0, peak: 0, limits: [] };
      const client = {
        async openSnapshot() {
          return {
            version: `retrieval-v2-perf-snapshot-${size}`,
            capturedAt: '2026-08-21T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
          };
        },
        async search(request) {
          state.requests += 1;
          state.limits.push(request.limit);
          state.active += 1;
          state.peak = Math.max(state.peak, state.active);
          await new Promise(resolve => setTimeout(resolve, 15));
          state.active -= 1;
          const match = request.query.match(/^測試角色(\d+)$/u);
          return {
            products: match ? [{
              id: `catalog-character-${match[1]}`,
              name: `KDcolle 測試作品${match[1]} 測試角色${match[1]} 原作版 無比例模型`,
              catalog: {
                supplier: { code: 'wanrong' },
                deadlineAt: '2026-09-18T00:00:00.000Z',
              },
            }] : [],
            snapshotVersion: request.snapshotVersion,
          };
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
        maxItemConcurrency: 8,
      });
      const coldCreated = await gateway.createJob(makeRequest(size, 'cold'));
      const cold = await gateway.waitForJob(coldCreated.jobId);
      const requestsAfterCold = state.requests;
      const warmCreated = await gateway.createJob(makeRequest(size, 'warm'));
      const warm = await gateway.waitForJob(warmCreated.jobId);
      rows.push({
        size,
        cold: cold.metrics,
        warm: warm.metrics,
        observedRequests: { cold: requestsAfterCold, warm: state.requests - requestsAfterCold },
        observedPeakConcurrency: state.peak,
        requestLimits: Array.from(new Set(state.limits)),
      });
    }

    const nextAfter = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
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
      productionUnchanged: stableStringify(productionBefore) === stableStringify(productionAfter),
    };
  });

  for (const row of report.rows) {
    assert.ok(row.cold.logicalQueryCount <= row.size * 4);
    assert.ok(row.cold.upstreamRequestCount <= 40, '10 unique titles may create at most 4 native queries each');
    assert.equal(row.observedRequests.cold, row.cold.upstreamRequestCount);
    assert.equal(row.observedRequests.warm, 0);
    assert.equal(row.warm.upstreamRequestCount, 0);
    assert.equal(row.warm.cacheHitRatio, 1);
    assert.ok(row.observedPeakConcurrency <= 6);
    assert.deepEqual(row.requestLimits, [5]);
    assert.equal(row.cold.serviceErrorCount, 0);
    assert.equal(row.warm.serviceErrorCount, 0);
  }
  assert.equal(report.nextUnchanged, true);
  assert.equal(report.productionUnchanged, true);
  assert.deepEqual(supabaseRequests, []);

  console.log('CANDIDATE_RETRIEVAL_V2_PERFORMANCE_REPORT');
  console.log(JSON.stringify(report, null, 2));
  console.log('PASS 10/50/100 cold and warm Candidate Retrieval v2 performance');
  console.log('PASS each query uses native limit=5 and warm runs use 0 upstream requests');
  console.log('PASS Production Supabase requests = 0; Next/Production ERP DB unchanged');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
