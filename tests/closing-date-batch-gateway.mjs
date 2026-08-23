import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 4283;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const gatewaySource = readFileSync(new URL('../src/lib/closingDateBatchGateway.ts', import.meta.url), 'utf8');
const cacheSource = readFileSync(new URL('../src/lib/closingDateCatalogBatchCache.ts', import.meta.url), 'utf8');
assert.doesNotMatch(
  `${gatewaySource}\n${cacheSource}`,
  /saveProductGroups|dataProvider|supabaseProvider|createClient\s*\(|\.supabase\.co|from\(['"]\.\/db['"]\)/u,
  'Batch Gateway must not access ERP Provider, main DB, or Supabase',
);
assert.doesNotMatch(
  gatewaySource,
  /closing_date\s*[:=]/u,
  'Batch Gateway must not write ProductGroup.closing_date',
);

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

  const testResult = await page.evaluate(async () => {
    const domain = await import('/src/lib/closingDateResolutionDomain.ts');
    const repositoryModule = await import('/src/lib/closingDateResolutionSidecarRepository.ts');
    const gatewayModule = await import('/src/lib/closingDateBatchGateway.ts');
    const cacheModule = await import('/src/lib/closingDateCatalogBatchCache.ts');
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const stableStringify = value => JSON.stringify(value, (_key, nested) => {
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
      return Object.fromEntries(
        Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)),
      );
    });
    const databasePrefix = 'daigou-erp-closing-date-sidecar-next-v1-gateway-test-';
    const databaseNames = [];
    const repositories = [];
    const deleteDatabase = databaseName => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`Delete blocked: ${databaseName}`));
    });
    const registerDatabase = label => {
      const name = `${databasePrefix}${label}-${crypto.randomUUID()}`;
      databaseNames.push(name);
      return name;
    };
    const nextBefore = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
    const productionBefore = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db');

    const fakeState = {
      active: 0,
      peak: 0,
      requests: [],
      snapshotOpens: 0,
      snapshotVersion: 'fixture-snapshot-v1',
      delayMs: 12,
      failService: false,
    };
    const fakeClient = {
      async openSnapshot(preference) {
        fakeState.snapshotOpens += 1;
        return {
          version: preference === 'LATEST' ? fakeState.snapshotVersion : preference,
          capturedAt: '2026-08-21T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
        };
      },
      async search(request) {
        fakeState.requests.push(request.query);
        fakeState.active += 1;
        fakeState.peak = Math.max(fakeState.peak, fakeState.active);
        await new Promise(resolve => setTimeout(resolve, fakeState.delayMs));
        fakeState.active -= 1;
        if (fakeState.failService && request.query === 'service-query') {
          throw new cacheModule.ClosingDateCatalogGatewayError({
            code: 'UPSTREAM_503',
            message: 'Simulated read-only Catalog outage',
            retryable: true,
            status: 503,
          });
        }
        if (request.query.includes('路西法')) {
          return {
            products: [{
              id: 'lucifer-wanrong',
              name: 'figma 路西法',
              catalog: {
                supplier: { code: 'wanrong' },
                deadlineAt: '2026-09-18T08:00:00.000Z',
              },
            }],
            snapshotVersion: request.snapshotVersion,
          };
        }
        if (request.query.includes('露易絲')) {
          return {
            products: [{
              id: 'louise-wanrong',
              name: '露易絲 20th Anniversary non scale model',
              jan: '4550687084382',
              catalog: {
                supplier: { code: 'wanrong' },
                deadlineAt: '2026-09-18T08:00:00.000Z',
              },
            }],
            snapshotVersion: request.snapshotVersion,
          };
        }
        return { products: [], snapshotVersion: request.snapshotVersion };
      },
    };

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
      if (analysis.item.title.startsWith('SERVICE')) {
        await analysis.search('service-query');
      } else {
        for (const query of queryPlan(analysis.item)) await analysis.search(query);
      }
      const source = {
        sourceSupplier: 'wanrong',
        sourceProductId: `source-${analysis.item.clientItemId}`,
        sourceCatalogId: analysis.snapshot.version,
      };
      return domain.createResolutionResult({
        id: `${analysis.batchId}:${analysis.item.clientItemId}`,
        batchId: analysis.batchId,
        erpProductGroupId: analysis.item.erpProductGroupId,
        erpTitleAtAnalysis: analysis.item.title,
        productUpdatedAtAtAnalysis: analysis.item.updatedAt,
        closingDateAtAnalysis: analysis.item.currentClosingDate,
        candidates: [{
          id: `${analysis.batchId}:candidate:${analysis.item.clientItemId}`,
          source,
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
    const makeRequest = (scope, size) => ({
      clientBatchId: `batch-${scope}`,
      idempotencyKey: `idempotency-${scope}`,
      inputHash: `input-${scope}-${size}`,
      snapshotVersionPreference: 'LATEST',
      ruleVersion: 'closing-date-minus-two-v1',
      items: Array.from({ length: size }, (_, index) => ({
        clientItemId: `item-${index}`,
        erpProductGroupId: `group-${scope}-${index}`,
        title: `${scope.toUpperCase()}: Product ${index}`,
        updatedAt: '2026-08-21T00:00:00.000Z',
        currentClosingDate: index % 2 === 0 ? '2026-08-30' : null,
        sourceType: 'proxy',
        proxyAgent: null,
        jan: null,
        modelCode: null,
        verifiedMappings: [],
      })),
    });

    let nonNextRejected = false;
    try {
      gatewayModule.assertNextClosingDateBatchGatewayAccess('experimental', true);
    } catch (error) {
      nonNextRejected = error?.name === 'ClosingDateBatchGatewayUnavailableError';
    }

    const primaryRepository = repositoryModule.createNextClosingDateResolutionRepository({
      databaseName: registerDatabase('primary'),
    });
    repositories.push(primaryRepository);
    const queryCache = new cacheModule.CatalogSnapshotQueryCache(fakeClient, {
      ttlMs: 60_000,
      maxConcurrency: 4,
    });
    const gateway = gatewayModule.createNextClosingDateBatchGateway({
      repository: primaryRepository,
      catalogClient: fakeClient,
      queryCache,
      analyzer,
      maxItemConcurrency: 6,
    });

    const initialCounts = await primaryRepository.getStoreCounts();
    const request = makeRequest('cold', 10);
    const created = await gateway.createJob(request);
    const firstPoll = await gateway.pollJob(created.jobId);
    const completed = await gateway.waitForJob(created.jobId);
    const countsAfterComplete = await primaryRepository.getStoreCounts();
    const snapshotOpensBeforeDuplicate = fakeState.snapshotOpens;
    fakeState.snapshotVersion = 'fixture-snapshot-v2';
    const duplicate = await gateway.createJob(request);
    const duplicateDidNotOpenNewSnapshot = fakeState.snapshotOpens === snapshotOpensBeforeDuplicate;
    const countsAfterDuplicate = await primaryRepository.getStoreCounts();
    const storedResults = await primaryRepository.listResolutionResults(created.jobId);

    const defaultGateway = gatewayModule.createNextClosingDateBatchGateway({
      repository: primaryRepository,
      catalogClient: fakeClient,
      queryCache,
      maxItemConcurrency: 2,
    });
    const defaultRequest = {
      ...makeRequest('default', 1),
      items: [{
        ...makeRequest('default', 1).items[0],
        title: '代理版 角川 KDcolle 零之使魔 露易絲 20th 20週年紀念版 無比例 約23公分',
      }],
    };
    const defaultCreated = await defaultGateway.createJob(defaultRequest);
    const defaultCompleted = await defaultGateway.waitForJob(defaultCreated.jobId);

    let partialServiceCallCount = 0;
    const partialServiceResult = await gatewayModule.createProxyClosingDateBatchAnalyzer()({
      item: {
        ...makeRequest('partial-service', 1).items[0],
        title: '代理版 角川 KDcolle 零之使魔 露易絲 20th 20週年紀念版 無比例 約23公分',
      },
      batchId: 'partial-service-batch',
      ruleVersion: 'closing-date-minus-two-v1',
      snapshot: {
        version: 'fixture-snapshot-v2',
        capturedAt: '2026-08-21T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      activeMappings: [],
      search: async () => {
        partialServiceCallCount += 1;
        if (partialServiceCallCount === 1) {
          throw new cacheModule.ClosingDateCatalogGatewayError({
            code: 'UPSTREAM_503',
            message: 'Partial Catalog outage',
            retryable: true,
            status: 503,
          });
        }
        return [{
          id: 'partial-louise-wanrong',
          name: '露易絲 20th Anniversary non scale model',
          catalog: {
            supplier: { code: 'wanrong' },
            deadlineAt: '2026-09-18T08:00:00.000Z',
          },
        }];
      },
      signal: new AbortController().signal,
      analyzedAt: '2026-08-21T00:00:00.000Z',
    });

    fakeState.delayMs = 30;
    const cancelRequest = makeRequest('cancel', 40);
    const requestsBeforeCancelJob = fakeState.requests.length;
    const cancelCreated = await gateway.createJob(cancelRequest);
    let runningPoll = await gateway.pollJob(cancelCreated.jobId);
    for (let attempt = 0; attempt < 30 && runningPoll.batch.status === 'QUEUED'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2));
      runningPoll = await gateway.pollJob(cancelCreated.jobId);
    }
    await new Promise(resolve => setTimeout(resolve, 8));
    const cancelResponse = await gateway.cancelJob(cancelCreated.jobId);
    const requestsWhenCancelled = fakeState.requests.length;
    const cancelled = await gateway.waitForJob(cancelCreated.jobId);
    await new Promise(resolve => setTimeout(resolve, 80));
    const requestsAfterCancellationSettled = fakeState.requests.length;

    fakeState.delayMs = 5;
    fakeState.failService = true;
    const serviceRequest = {
      ...makeRequest('service', 1),
      items: [{ ...makeRequest('service', 1).items[0], title: 'SERVICE Product' }],
    };
    const serviceCreated = await gateway.createJob(serviceRequest);
    const serviceFailed = await gateway.waitForJob(serviceCreated.jobId);
    fakeState.failService = false;
    const retryResponse = await gateway.retryJob(serviceCreated.jobId);
    const retryCompleted = await gateway.waitForJob(retryResponse.jobId);

    const readFailureRepository = repositoryModule.createNextClosingDateResolutionRepository({
      databaseName: registerDatabase('read-failure'),
    });
    repositories.push(readFailureRepository);
    readFailureRepository.findActiveMappings = async () => {
      throw new Error('FORCED_MAPPING_READ_FAULT');
    };
    const readFailureGateway = gatewayModule.createNextClosingDateBatchGateway({
      repository: readFailureRepository,
      catalogClient: fakeClient,
      analyzer,
      maxItemConcurrency: 1,
    });
    let readDependencyFailureRejected = false;
    try {
      await readFailureGateway.createJob(makeRequest('read-failure', 1));
    } catch (error) {
      readDependencyFailureRejected = error?.message === 'FORCED_MAPPING_READ_FAULT';
    }
    const readFailureCounts = await readFailureRepository.getStoreCounts();

    const faultRepository = repositoryModule.createNextClosingDateResolutionRepository({
      databaseName: registerDatabase('fault'),
      faultInjector: point => {
        if (point === 'AFTER_CANDIDATE_WRITE') throw new Error('FORCED_CANDIDATE_FAULT');
      },
    });
    repositories.push(faultRepository);
    const faultGateway = gatewayModule.createNextClosingDateBatchGateway({
      repository: faultRepository,
      catalogClient: fakeClient,
      analyzer,
      maxItemConcurrency: 1,
    });
    const faultCreated = await faultGateway.createJob(makeRequest('fault', 1));
    const faultCompleted = await faultGateway.waitForJob(faultCreated.jobId);
    const faultCounts = await faultRepository.getStoreCounts();

    const cacheSnapshot = {
      version: 'cache-window-fixture',
      capturedAt: '2026-08-21T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const supersetState = { requests: 0 };
    const supersetCache = new cacheModule.CatalogSnapshotQueryCache({
      async openSnapshot() { return cacheSnapshot; },
      async search(request) {
        supersetState.requests += 1;
        return {
          products: Array.from({ length: request.limit }, (_, index) => ({
            id: `superset-${index + 1}`,
            name: `Superset ${index + 1}`,
          })),
          snapshotVersion: request.snapshotVersion,
        };
      },
    }, { ttlMs: 60_000, maxConcurrency: 1 });
    const largerWindow = await supersetCache.lookup({
      snapshot: cacheSnapshot,
      query: 'Shared Window',
      limit: 12,
    });
    const reusedSmallerWindow = await supersetCache.lookup({
      snapshot: cacheSnapshot,
      query: 'shared   window',
      limit: 5,
    });

    let releaseQueuedProbe;
    const cancellationGateState = { requests: 0 };
    const cancellationGateCache = new cacheModule.CatalogSnapshotQueryCache({
      async openSnapshot() { return cacheSnapshot; },
      async search(request) {
        cancellationGateState.requests += 1;
        await new Promise(resolve => { releaseQueuedProbe = resolve; });
        return { products: [], snapshotVersion: request.snapshotVersion };
      },
    }, { ttlMs: 60_000, maxConcurrency: 1 });
    const activeLookup = cancellationGateCache.lookup({
      snapshot: cacheSnapshot,
      query: 'active request',
      limit: 5,
    });
    while (cancellationGateState.requests === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const queuedController = new AbortController();
    const queuedLookup = cancellationGateCache.lookup({
      snapshot: cacheSnapshot,
      query: 'cancel queued request',
      limit: 5,
      signal: queuedController.signal,
    }).then(() => null, error => error?.name ?? 'UNKNOWN');
    queuedController.abort();
    releaseQueuedProbe();
    await activeLookup;
    const queuedAbortName = await queuedLookup;
    await new Promise(resolve => setTimeout(resolve, 0));

    const nextAfter = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
    const productionAfter = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db');
    repositories.forEach(repository => repository.close());
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.all(databaseNames.map(deleteDatabase));

    return {
      feature: {
        undefinedIsOff: gatewayModule.parseClosingDateBatchGatewayFeatureFlag(undefined),
        enabledInTest: gatewayModule.isClosingDateBatchGatewayFeatureEnabled(),
        nonNextRejected,
      },
      initialCounts,
      created,
      firstPollStatus: firstPoll.batch.status,
      completed,
      countsAfterComplete,
      duplicate,
      duplicateDidNotOpenNewSnapshot,
      countsAfterDuplicate,
      storedResults,
      defaultCompleted,
      partialServiceResult,
      cancellation: {
        cancelResponse,
        cancelled,
        requestsBeforeCancelJob,
        requestsWhenCancelled,
        requestsAfterCancellationSettled,
      },
      service: {
        serviceFailed,
        retryResponse,
        retryCompleted,
      },
      readFailure: {
        rejected: readDependencyFailureRejected,
        counts: readFailureCounts,
      },
      fault: {
        completed: faultCompleted,
        counts: faultCounts,
      },
      cacheWindowReuse: {
        requests: supersetState.requests,
        largerSource: largerWindow.source,
        smallerSource: reusedSmallerWindow.source,
        smallerCount: reusedSmallerWindow.response.products.length,
      },
      queuedCancellation: {
        requests: cancellationGateState.requests,
        abortName: queuedAbortName,
      },
      fakePeakConcurrency: fakeState.peak,
      nextUnchanged: stableStringify(nextBefore) === stableStringify(nextAfter),
      productionUnchanged: stableStringify(productionBefore) === stableStringify(productionAfter),
    };
  });

  assert.deepEqual(testResult.feature, {
    undefinedIsOff: false,
    enabledInTest: true,
    nonNextRejected: true,
  });
  assert.equal(Object.values(testResult.initialCounts).every(count => count === 0), true);
  assert.equal(testResult.created.status, 'QUEUED');
  assert.ok(['QUEUED', 'RUNNING'].includes(testResult.firstPollStatus));
  assert.equal(testResult.completed.batch.status, 'COMPLETED');
  assert.equal(testResult.completed.batch.progress.completedCount, 10);
  assert.equal(testResult.completed.batch.progress.yellowCount, 10);
  assert.equal(testResult.completed.results.length, 10);
  assert.equal(testResult.completed.metrics.logicalQueryCount, 55);
  assert.ok(testResult.completed.metrics.upstreamRequestCount < 55);
  assert.ok(testResult.completed.metrics.dedupeRatio > 0);
  assert.ok(testResult.completed.metrics.maxUpstreamConcurrency <= 4);
  assert.deepEqual(testResult.storedResults, testResult.completed.results);
  assert.equal(testResult.countsAfterComplete.closing_date_resolution_batches, 1);
  assert.equal(testResult.countsAfterComplete.closing_date_resolution_results, 10);
  assert.equal(testResult.countsAfterComplete.closing_date_resolution_candidates, 10);
  assert.equal(testResult.duplicate.jobId, testResult.created.jobId);
  assert.equal(testResult.duplicateDidNotOpenNewSnapshot, true);
  assert.deepEqual(testResult.countsAfterDuplicate, testResult.countsAfterComplete);

  assert.equal(testResult.defaultCompleted.batch.status, 'COMPLETED');
  assert.equal(testResult.defaultCompleted.results[0].classification, 'YELLOW');
  assert.equal(testResult.defaultCompleted.results[0].rawDeadline, '2026-09-18T08:00:00.000Z');
  assert.equal(testResult.defaultCompleted.results[0].suggestedClosingDate, '2026-09-16');
  assert.equal(testResult.partialServiceResult.classification, 'RED');
  assert.equal(testResult.partialServiceResult.classificationReason, 'SERVICE_ERROR');
  assert.equal(testResult.partialServiceResult.serviceError?.retryable, true);
  assert.ok(testResult.partialServiceResult.candidates.length > 0);

  assert.equal(testResult.cancellation.cancelResponse.status, 'CANCELLING');
  assert.equal(testResult.cancellation.cancelled.batch.status, 'CANCELLED');
  assert.ok(testResult.cancellation.cancelled.results.length < 40);
  assert.equal(
    testResult.cancellation.requestsAfterCancellationSettled,
    testResult.cancellation.requestsWhenCancelled,
  );
  assert.equal(testResult.cancellation.cancelled.metrics.cancellationCount, 1);

  assert.equal(testResult.service.serviceFailed.batch.status, 'COMPLETED');
  assert.equal(testResult.service.serviceFailed.batch.progress.retryableServiceErrorCount, 1);
  assert.equal(testResult.service.serviceFailed.results[0].classification, 'RED');
  assert.equal(testResult.service.retryResponse.attempt, 2);
  assert.equal(testResult.service.retryCompleted.batch.status, 'COMPLETED');
  assert.equal(testResult.service.retryCompleted.results[0].classification, 'YELLOW');

  assert.equal(testResult.readFailure.rejected, true);
  assert.equal(Object.values(testResult.readFailure.counts).every(count => count === 0), true);

  assert.equal(testResult.fault.completed.batch.status, 'FAILED');
  assert.equal(testResult.fault.completed.batch.progress.completedCount, 0);
  assert.equal(testResult.fault.counts.closing_date_resolution_batches, 1);
  assert.equal(testResult.fault.counts.closing_date_resolution_results, 0);
  assert.equal(testResult.fault.counts.closing_date_resolution_candidates, 0);
  assert.ok(testResult.fakePeakConcurrency <= 4);
  assert.deepEqual(testResult.cacheWindowReuse, {
    requests: 1,
    largerSource: 'UPSTREAM',
    smallerSource: 'CACHE',
    smallerCount: 5,
  });
  assert.deepEqual(testResult.queuedCancellation, {
    requests: 1,
    abortName: 'AbortError',
  });
  assert.equal(testResult.nextUnchanged, true);
  assert.equal(testResult.productionUnchanged, true);
  assert.deepEqual(supabaseRequests, []);

  console.log('CONTROL_REPORT');
  console.log(JSON.stringify({
    idempotency: {
      sameJobIdAfterSnapshotRollover: testResult.duplicate.jobId === testResult.created.jobId,
      secondSnapshotOpen: !testResult.duplicateDidNotOpenNewSnapshot,
      batchCount: testResult.countsAfterDuplicate.closing_date_resolution_batches,
    },
    cancellation: {
      status: testResult.cancellation.cancelled.batch.status,
      completedCount: testResult.cancellation.cancelled.batch.progress.completedCount,
      totalCount: testResult.cancellation.cancelled.batch.progress.totalCount,
      requestsAtCancel: testResult.cancellation.requestsWhenCancelled
        - testResult.cancellation.requestsBeforeCancelJob,
      requestsAfterSettled: testResult.cancellation.requestsAfterCancellationSettled
        - testResult.cancellation.requestsBeforeCancelJob,
      cancellationCount: testResult.cancellation.cancelled.metrics.cancellationCount,
    },
    serviceError: {
      classification: testResult.service.serviceFailed.results[0].classification,
      retryableCount: testResult.service.serviceFailed.batch.progress.retryableServiceErrorCount,
      retryAttempt: testResult.service.retryResponse.attempt,
      retryStatus: testResult.service.retryCompleted.batch.status,
      retryClassification: testResult.service.retryCompleted.results[0].classification,
      partialCandidateFailureClassification: testResult.partialServiceResult.classification,
    },
    readDependencyFailure: {
      rejected: testResult.readFailure.rejected,
      allSidecarStoresEmpty: Object.values(testResult.readFailure.counts)
        .every(count => count === 0),
    },
    atomicFault: {
      status: testResult.fault.completed.batch.status,
      completedCount: testResult.fault.completed.batch.progress.completedCount,
      resultRows: testResult.fault.counts.closing_date_resolution_results,
      candidateRows: testResult.fault.counts.closing_date_resolution_candidates,
    },
  }, null, 2));
  console.log('PASS Next-only feature gate and polling job lifecycle');
  console.log('PASS query dedupe, single-flight, TTL cache, and limited concurrency');
  console.log('PASS larger cached native window safely serves smaller limit without another upstream request');
  console.log('PASS cancelled queued lookup never starts a new upstream request');
  console.log('PASS cancellation stops new work and retry re-runs only retryable service errors');
  console.log('PASS Result/Candidate progress writes persist only in Sidecar Storage');
  console.log('PASS injected result persistence fault leaves 0 partial Result/Candidate writes');
  console.log('PASS current matching stays YELLOW and never applies ProductGroup.closing_date');
  console.log('PASS Production Supabase requests = 0; Next/Production ERP DB unchanged');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
