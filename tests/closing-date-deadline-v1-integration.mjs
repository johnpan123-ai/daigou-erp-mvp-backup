import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 4292;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const gatewaySource = readFileSync(new URL('../src/lib/closingDateBatchGateway.ts', import.meta.url), 'utf8');
const cacheSource = readFileSync(new URL('../src/lib/closingDateCatalogBatchCache.ts', import.meta.url), 'utf8');
const purchaseRecordsSource = readFileSync(new URL('../src/pages/PurchaseRecords.tsx', import.meta.url), 'utf8');
assert.match(cacheSource, /\/api\/catalog\/deadlines\?/u);
assert.match(cacheSource, /\/api\/catalog\/deadline-candidates\?/u);
assert.match(purchaseRecordsSource, /\/api\/catalog\/search\?q=.*&limit=8/u);
assert.doesNotMatch(purchaseRecordsSource, /pageSize=8/u);
assert.doesNotMatch(
  `${gatewaySource}\n${cacheSource}`,
  /saveProductGroups|updateProductGroups|supabaseProvider|\.supabase\.co/u,
  'Deadline analysis must remain read-only with respect to ERP ProductGroup data',
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
    try { if ((await fetch(BASE_URL)).ok) return; } catch { /* starting */ }
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
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  const report = await page.evaluate(async () => {
    const gatewayModule = await import('/src/lib/closingDateBatchGateway.ts');
    const cacheModule = await import('/src/lib/closingDateCatalogBatchCache.ts');
    const domain = await import('/src/lib/closingDateResolutionDomain.ts');

    const snapshot = {
      version: 'deadline-v1-fixture',
      capturedAt: '2026-09-25T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const uuidAt = index => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
    const deadlineRecord = (catalogProductId, overrides = {}) => ({
      catalogProductId,
      status: 'MATCHED',
      reason: null,
      productName: `Catalog ${catalogProductId}`,
      catalogId: uuidAt(999),
      supplierCode: 'dreamlink',
      supplierProductId: `SUP-${catalogProductId.slice(-4)}`,
      deadlineAt: '2026-09-18T00:30:00.000Z',
      deadlinePrecision: 'DATETIME',
      deadlineTimezone: 'UTC',
      catalogProductUrl: `https://hippotoycatalog.com/product/${catalogProductId}`,
      sourceUpdatedAt: '2026-09-24T00:00:00.000Z',
      sourceUpdatedAtKind: 'PROVIDER_EXPLICIT',
      catalogStatus: 'AVAILABLE',
      ...overrides,
    });
    const mappingFor = (erpProductGroupId, catalogProductId, supplier = 'dreamlink') => domain.createVerifiedMapping({
      id: `mapping-${erpProductGroupId}`,
      erpProductGroupId,
      source: {
        sourceSupplier: supplier,
        sourceProductId: catalogProductId,
        sourceCatalogId: uuidAt(999),
      },
      verificationMethod: 'MANUAL_TOP3_SELECTION',
      verificationEvidence: {
        catalogProductId,
        catalogId: uuidAt(999),
        supplierCode: supplier,
      },
      sourceTitleAtVerification: `ERP ${erpProductGroupId}`,
      erpTitleFingerprint: `ERP ${erpProductGroupId}`,
      verifiedAt: '2026-09-24T00:00:00.000Z',
      verifiedBy: 'fixture-owner',
    });
    const makeRepository = mappings => {
      const batches = new Map();
      const results = new Map();
      const revoked = [];
      const savedMappings = [];
      return {
        revoked,
        savedMappings,
        async findBatchByIdempotencyKey(key) {
          return [...batches.values()].find(batch => batch.idempotencyKey === key) ?? null;
        },
        async findActiveMappings(ids) {
          const scope = new Set(ids);
          return mappings.filter(mapping => scope.has(mapping.erpProductGroupId) && !mapping.revokedAt);
        },
        async createResolutionJob(batch) {
          batches.set(batch.id, batch);
          return { created: true, batch };
        },
        async updateResolutionJob(batch) { batches.set(batch.id, batch); },
        async appendResolutionResult(batch, result) {
          batches.set(batch.id, batch);
          const entries = results.get(batch.id) ?? [];
          entries.push(result);
          results.set(batch.id, entries);
          return { created: true, result };
        },
        async getResolutionBatch(id) { return batches.get(id) ?? null; },
        async listResolutionResults(id) { return results.get(id) ?? []; },
        async saveVerifiedMapping(mapping) {
          const existingIndex = mappings.findIndex(entry => entry.id === mapping.id);
          if (existingIndex >= 0) mappings.splice(existingIndex, 1, mapping);
          else mappings.push(mapping);
          savedMappings.push(mapping);
        },
        async revokeVerifiedMapping(id, revokedAt, revokedReason) {
          const mapping = mappings.find(entry => entry.id === id);
          if (!mapping) throw new Error(`Missing mapping ${id}`);
          const next = { ...mapping, revokedAt, revokedReason };
          revoked.push(next);
          return next;
        },
      };
    };
    const makeRequest = (id, items) => ({
      clientBatchId: `batch-${id}`,
      idempotencyKey: `key-${id}`,
      inputHash: `hash-${id}`,
      snapshotVersionPreference: 'LATEST',
      ruleVersion: 'closing-date-minus-two-v1',
      items,
    });
    const makeItem = (index, verifiedMappings = []) => ({
      clientItemId: `item-${index}`,
      erpProductGroupId: `group-${index}`,
      title: `ERP Product ${index}`,
      updatedAt: '2026-09-24T00:00:00.000Z',
      currentClosingDate: null,
      sourceType: 'proxy',
      proxyAgent: null,
      jan: null,
      modelCode: null,
      verifiedMappings,
    });

    const batchCalls = [];
    const directClient = {
      async openSnapshot() { return snapshot; },
      async search() { throw new Error('Candidate search must not run for verified direct mappings'); },
      async lookupDeadlines(request) {
        batchCalls.push([...request.catalogProductIds]);
        return {
          schemaVersion: 'deadline-v1',
          results: request.catalogProductIds.map(id => id === uuidAt(51)
            ? deadlineRecord(id, {
              supplierCode: 'wanrong',
              deadlineAt: '2026-09-18T00:30:00+08:00',
              deadlineTimezone: 'Asia/Taipei',
            })
            : deadlineRecord(id)),
          snapshotVersion: request.snapshotVersion,
        };
      },
    };
    const directItems = Array.from({ length: 52 }, (_, index) => {
      const catalogProductId = uuidAt(index < 2 ? 1 : index);
      return makeItem(index, [mappingFor(
        `group-${index}`,
        catalogProductId,
        index === 51 ? 'wanrong' : 'dreamlink',
      )]);
    });
    const directMappings = directItems.flatMap(item => item.verifiedMappings);
    const directRepository = makeRepository(directMappings);
    const directGateway = gatewayModule.createNextClosingDateBatchGateway({
      repository: directRepository,
      catalogClient: directClient,
      maxItemConcurrency: 6,
      maxUpstreamConcurrency: 6,
    });
    const created = await directGateway.createJob(makeRequest('direct-52', directItems));
    const completed = await directGateway.waitForJob(created.jobId);

    const chunkMatrix = {};
    for (const uniqueCount of [50, 51, 100, 101]) {
      const chunkCalls = [];
      let activeChunkRequests = 0;
      let maxActiveChunkRequests = 0;
      const items = Array.from({ length: uniqueCount }, (_, index) => makeItem(
        `chunk-${uniqueCount}-${index}`,
        [mappingFor(`group-chunk-${uniqueCount}-${index}`, uuidAt(2_000 + index))],
      ));
      const repository = makeRepository(items.flatMap(item => item.verifiedMappings));
      const gateway = gatewayModule.createNextClosingDateBatchGateway({
        repository,
        catalogClient: {
          async openSnapshot() { return snapshot; },
          async search() { throw new Error('Chunked direct mappings must not run candidate search'); },
          async lookupDeadlines(request) {
            activeChunkRequests += 1;
            maxActiveChunkRequests = Math.max(maxActiveChunkRequests, activeChunkRequests);
            chunkCalls.push([...request.catalogProductIds]);
            await Promise.resolve();
            activeChunkRequests -= 1;
            return {
              schemaVersion: 'deadline-v1',
              snapshotVersion: request.snapshotVersion,
              results: request.catalogProductIds.map(id => deadlineRecord(id)),
            };
          },
        },
      });
      const job = await gateway.createJob(makeRequest(`chunk-${uniqueCount}`, items));
      const outcome = await gateway.waitForJob(job.jobId);
      chunkMatrix[uniqueCount] = {
        status: outcome.batch.status,
        resultCount: outcome.results.length,
        chunks: chunkCalls.map(call => call.length),
        requestedIds: chunkCalls.flat(),
        maxActiveChunkRequests,
        candidateRequests: outcome.metrics.candidateSearchRequestCount,
      };
    }

    const exactDreamlinkId = uuidAt(3_000);
    const exactWanrongId = uuidAt(3_001);
    const exactItems = [
      {
        ...makeItem('identity-dreamlink', [
          mappingFor('group-identity-dreamlink', exactDreamlinkId, 'dreamlink'),
        ]),
        erpProductGroupId: 'group-identity-dreamlink',
        title: '同名商品 再販版',
        jan: '0012345678905',
      },
      {
        ...makeItem('identity-wanrong', [
          mappingFor('group-identity-wanrong', exactWanrongId, 'wanrong'),
        ]),
        erpProductGroupId: 'group-identity-wanrong',
        title: '同名商品 再販版',
        jan: '0012345678905',
      },
    ];
    const exactRequests = [];
    const exactGateway = gatewayModule.createNextClosingDateBatchGateway({
      repository: makeRepository(exactItems.flatMap(item => item.verifiedMappings)),
      catalogClient: {
        async openSnapshot() { return snapshot; },
        async search() { throw new Error('Exact verified identities must not run candidate search'); },
        async lookupDeadlines(request) {
          exactRequests.push([...request.catalogProductIds]);
          return {
            schemaVersion: 'deadline-v1',
            snapshotVersion: request.snapshotVersion,
            results: request.catalogProductIds.map(id => id === exactDreamlinkId
              ? deadlineRecord(id, {
                productName: '同名商品 再販版',
                supplierCode: 'dreamlink',
                supplierProductId: 'SAME-JAN-DREAMLINK',
                deadlineAt: '2027-01-01T00:30:00.000Z',
                deadlineTimezone: 'UTC',
              })
              : deadlineRecord(id, {
                productName: '同名商品 再販版',
                supplierCode: 'wanrong',
                supplierProductId: 'SAME-JAN-WANRONG',
                deadlineAt: '2026-03-01T00:30:00+08:00',
                deadlineTimezone: 'Asia/Taipei',
              })),
          };
        },
      },
    });
    const exactJob = await exactGateway.createJob(makeRequest('exact-identity', exactItems));
    const exactCompleted = await exactGateway.waitForJob(exactJob.jobId);

    const transitionCatalogProductIds = [uuidAt(4_000), uuidAt(4_001)];
    let transitionCandidateCalls = 0;
    let transitionDirectCalls = 0;
    const transitionRepository = makeRepository([]);
    const transitionClient = {
      async openSnapshot() { return snapshot; },
      async search(request) {
        transitionCandidateCalls += 1;
        return {
          snapshotVersion: request.snapshotVersion,
          products: transitionCatalogProductIds.map((id, index) => ({
            id,
            name: `候選商品 ${index + 1}`,
            supplierProductId: `TRANSITION-${index + 1}`,
            catalog: {
              id: uuidAt(999),
              supplier: { code: index === 0 ? 'dreamlink' : 'wanrong' },
              deadlineAt: index === 0
                ? '2026-10-10T00:30:00.000Z'
                : '2026-10-20T00:30:00+08:00',
            },
          })),
        };
      },
      async lookupDeadlines(request) {
        transitionDirectCalls += 1;
        return {
          schemaVersion: 'deadline-v1',
          snapshotVersion: request.snapshotVersion,
          results: request.catalogProductIds.map(id => deadlineRecord(id, {
            supplierCode: 'wanrong',
            supplierProductId: 'TRANSITION-2',
            deadlineAt: '2026-10-20T00:30:00+08:00',
            deadlineTimezone: 'Asia/Taipei',
          })),
        };
      },
    };
    const transitionItem = {
      ...makeItem('transition'),
      erpProductGroupId: 'group-transition',
      title: '候選商品',
    };
    const firstTransitionGateway = gatewayModule.createNextClosingDateBatchGateway({
      repository: transitionRepository,
      catalogClient: transitionClient,
    });
    const firstTransitionJob = await firstTransitionGateway.createJob(makeRequest(
      'transition-candidate',
      [transitionItem],
    ));
    const firstTransitionCompleted = await firstTransitionGateway.waitForJob(firstTransitionJob.jobId);
    const firstTransitionResult = firstTransitionCompleted.results[0];
    const selectedTransitionCandidate = firstTransitionResult.candidates.find(candidate => (
      candidate.source.sourceProductId === transitionCatalogProductIds[1]
    ));
    if (!selectedTransitionCandidate) throw new Error('Second manual transition candidate missing');
    await transitionRepository.saveVerifiedMapping(mappingFor(
      transitionItem.erpProductGroupId,
      selectedTransitionCandidate.source.sourceProductId,
      selectedTransitionCandidate.source.sourceSupplier,
    ));
    const candidateCallsBeforeSecondAnalysis = transitionCandidateCalls;
    const secondTransitionGateway = gatewayModule.createNextClosingDateBatchGateway({
      repository: transitionRepository,
      catalogClient: transitionClient,
    });
    const secondTransitionJob = await secondTransitionGateway.createJob(makeRequest(
      'transition-direct',
      [transitionItem],
    ));
    const secondTransitionCompleted = await secondTransitionGateway.waitForJob(secondTransitionJob.jobId);

    let legacyComparatorRequests = 0;
    const legacyComparatorClient = {
      async openSnapshot() { return snapshot; },
      async search(request) {
        legacyComparatorRequests += 1;
        return { products: [], snapshotVersion: request.snapshotVersion };
      },
      async lookupDeadlines() { throw new Error('No verified mapping should use direct lookup'); },
    };
    const legacyComparatorGateway = gatewayModule.createNextClosingDateBatchGateway({
      repository: makeRepository([]),
      catalogClient: legacyComparatorClient,
      analyzer: async analysis => {
        await analysis.search(`legacy-${analysis.item.clientItemId}`, { limit: 8 });
        return domain.createResolutionResult({
          id: `${analysis.batchId}:${analysis.item.clientItemId}`,
          batchId: analysis.batchId,
          erpProductGroupId: analysis.item.erpProductGroupId,
          erpTitleAtAnalysis: analysis.item.title,
          productUpdatedAtAtAnalysis: analysis.item.updatedAt,
          closingDateAtAnalysis: analysis.item.currentClosingDate,
          candidates: [],
          ruleVersion: analysis.ruleVersion,
          snapshotVersion: analysis.snapshot.version,
          analyzedAt: analysis.analyzedAt,
        });
      },
    });
    const legacyItems = Array.from({ length: 52 }, (_, index) => makeItem(`legacy-${index}`));
    const legacyCreated = await legacyComparatorGateway.createJob(makeRequest('legacy-comparator', legacyItems));
    const legacyCompleted = await legacyComparatorGateway.waitForJob(legacyCreated.jobId);

    const statusMappings = [
      mappingFor('group-no-deadline', uuidAt(700)),
      mappingFor('group-temporary', uuidAt(701)),
      mappingFor('group-stale', uuidAt(702)),
    ];
    const statusRepository = makeRepository(statusMappings);
    let candidateCalls = 0;
    const statusClient = {
      async openSnapshot() { return snapshot; },
      async lookupDeadlines(request) {
        return {
          schemaVersion: 'deadline-v1',
          snapshotVersion: request.snapshotVersion,
          results: request.catalogProductIds.map(id => {
            if (id === uuidAt(700)) return deadlineRecord(id, {
              status: 'NO_DEADLINE', deadlineAt: null, deadlinePrecision: null, deadlineTimezone: null,
            });
            if (id === uuidAt(701)) return deadlineRecord(id, {
              status: 'TEMPORARY_ERROR', deadlineAt: null, deadlinePrecision: null, deadlineTimezone: null,
            });
            return deadlineRecord(id, {
              status: 'NOT_FOUND', productName: null, catalogId: null, supplierCode: null,
              supplierProductId: null, deadlineAt: null, deadlinePrecision: null,
              deadlineTimezone: null, catalogProductUrl: null, sourceUpdatedAt: null,
              sourceUpdatedAtKind: null, catalogStatus: null,
            });
          }),
        };
      },
      async search(request) {
        candidateCalls += 1;
        return {
          snapshotVersion: request.snapshotVersion,
          products: [{
            id: uuidAt(703),
            name: 'GSC 黏土人 空條承太郎',
            supplierProductId: 'REPLACEMENT-1',
            catalog: {
              id: uuidAt(999),
              supplier: { code: 'dreamlink' },
              deadlineAt: '2026-09-18T00:30:00.000Z',
            },
          }],
        };
      },
    };
    const statusGateway = gatewayModule.createNextClosingDateBatchGateway({
      repository: statusRepository,
      catalogClient: statusClient,
    });
    const statusItems = ['no-deadline', 'temporary', 'stale'].map((name, index) => ({
      ...makeItem(name),
      erpProductGroupId: `group-${name}`,
      ...(name === 'stale' ? { title: '代理版 GSC 黏土人 空條承太郎' } : {}),
      verifiedMappings: [statusMappings[index]],
    }));
    const statusCreated = await statusGateway.createJob(makeRequest('statuses', statusItems));
    const statusCompleted = await statusGateway.waitForJob(statusCreated.jobId);

    const conflictQueries = [];
    const conflictGateway = gatewayModule.createNextClosingDateBatchGateway({
      repository: makeRepository([]),
      catalogClient: {
        async openSnapshot() { return snapshot; },
        async search(request) {
          conflictQueries.push(request.query);
          return {
            snapshotVersion: request.snapshotVersion,
            products: [{
              id: uuidAt(5_000),
              name: 'NIKKE 勝利女神 索達：閃亮兔女郎 1/4 PVC',
              catalog: {
                id: uuidAt(999), supplier: { code: 'dreamlink' },
                deadlineAt: '2026-10-10T00:00:00.000Z',
              },
            }],
          };
        },
      },
    });
    const conflictJob = await conflictGateway.createJob(makeRequest('product-type-conflict', [{
      ...makeItem('figma-soda'), title: 'figma 710 NIKKE 索達：閃亮兔女郎',
    }]));
    const conflictResult = (await conflictGateway.waitForJob(conflictJob.jobId)).results[0];

    let mixedActive = 0;
    let mixedPeak = 0;
    const observeMixedRequest = async () => {
      mixedActive += 1;
      mixedPeak = Math.max(mixedPeak, mixedActive);
      await new Promise(resolve => setTimeout(resolve, 25));
      mixedActive -= 1;
    };
    const mixedMapping = mappingFor('group-mixed-direct', uuidAt(6_000));
    const mixedGateway = gatewayModule.createNextClosingDateBatchGateway({
      repository: makeRepository([mixedMapping]),
      maxItemConcurrency: 6,
      maxUpstreamConcurrency: 6,
      catalogClient: {
        async openSnapshot() { return snapshot; },
        async search(request) {
          await observeMixedRequest();
          return { products: [], snapshotVersion: request.snapshotVersion };
        },
        async lookupDeadlines(request) {
          await observeMixedRequest();
          return {
            schemaVersion: 'deadline-v1', snapshotVersion: request.snapshotVersion,
            results: request.catalogProductIds.map(id => deadlineRecord(id)),
          };
        },
      },
      analyzer: async analysis => {
        await analysis.search(analysis.item.clientItemId, { limit: 5 });
        return domain.createResolutionResult({
          id: analysis.batchId + ':' + analysis.item.clientItemId,
          batchId: analysis.batchId,
          erpProductGroupId: analysis.item.erpProductGroupId,
          erpTitleAtAnalysis: analysis.item.title,
          productUpdatedAtAtAnalysis: analysis.item.updatedAt,
          closingDateAtAnalysis: analysis.item.currentClosingDate,
          candidates: [], ruleVersion: analysis.ruleVersion,
          snapshotVersion: analysis.snapshot.version, analyzedAt: analysis.analyzedAt,
        });
      },
    });
    const mixedSearchJob = await mixedGateway.createJob(makeRequest('mixed-candidate',
      Array.from({ length: 6 }, (_, index) => makeItem('mixed-' + index))));
    const mixedDirectJob = await mixedGateway.createJob(makeRequest('mixed-direct', [
      makeItem('mixed-direct', [mixedMapping]),
    ]));
    await Promise.all([
      mixedGateway.waitForJob(mixedSearchJob.jobId), mixedGateway.waitForJob(mixedDirectJob.jobId),
    ]);

    const fetchCalls = [];
    const httpClient = cacheModule.createReadonlyCatalogHttpClient({
      fetcher: async input => {
        const url = String(input);
        fetchCalls.push(url);
        if (url.includes('/deadline-candidates')) {
          return new Response(JSON.stringify({
            schemaVersion: 'deadline-v1',
            status: 'AMBIGUOUS',
            reason: 'MULTIPLE_CANDIDATES',
            query: 'same query',
            candidates: [uuidAt(800), uuidAt(801)].map((id, index) => ({
              catalogProductId: id,
              productName: `Candidate ${index + 1}`,
              catalogId: uuidAt(999),
              supplierCode: index === 0 ? 'dreamlink' : 'wanrong',
              supplierProductId: `SUP-${index + 1}`,
              deadlineAt: index === 0
                ? '2026-09-18T00:30:00.000Z'
                : '2026-09-18T00:30:00+08:00',
              sourceUpdatedAt: '2026-09-24T00:00:00.000Z',
              matchEvidence: { originalName: `Candidate ${index + 1}`, brandName: null, catalogName: 'Fixture' },
            })),
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ schemaVersion: 'deadline-v1', results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const candidateResponse = await httpClient.search({
      query: 'same query',
      catalogId: uuidAt(999),
      limit: 8,
      snapshotVersion: snapshot.version,
    });
    let temporaryCalls = 0;
    const temporaryCache = new cacheModule.CatalogDeadlineDirectCache({
      async openSnapshot() { return snapshot; },
      async search() { return { products: [], snapshotVersion: snapshot.version }; },
      async lookupDeadlines(request) {
        temporaryCalls += 1;
        return {
          schemaVersion: 'deadline-v1',
          snapshotVersion: request.snapshotVersion,
          results: request.catalogProductIds.map(id => deadlineRecord(id, {
            status: 'TEMPORARY_ERROR', deadlineAt: null, deadlinePrecision: null, deadlineTimezone: null,
          })),
        };
      },
    });
    await temporaryCache.lookup({ snapshot, catalogProductIds: [uuidAt(900)] });
    await temporaryCache.lookup({ snapshot, catalogProductIds: [uuidAt(900)] });

    let resolveShared;
    let sharedUnderlyingAborts = 0;
    const sharedCache = new cacheModule.CatalogDeadlineDirectCache({
      async openSnapshot() { return snapshot; },
      async search() { return { products: [], snapshotVersion: snapshot.version }; },
      async lookupDeadlines(request) {
        return new Promise((resolve, reject) => {
          resolveShared = () => resolve({
            schemaVersion: 'deadline-v1',
            snapshotVersion: request.snapshotVersion,
            results: request.catalogProductIds.map(id => deadlineRecord(id)),
          });
          request.signal?.addEventListener('abort', () => {
            sharedUnderlyingAborts += 1;
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      },
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstShared = sharedCache.lookup({
      snapshot, catalogProductIds: [uuidAt(901)], signal: firstController.signal,
    }).then(() => 'resolved', error => error.name);
    const secondShared = sharedCache.lookup({
      snapshot, catalogProductIds: [uuidAt(901)], signal: secondController.signal,
    });
    await Promise.resolve();
    firstController.abort();
    resolveShared();
    const firstSharedOutcome = await firstShared;
    const secondSharedOutcome = await secondShared;

    let allCancelledUnderlyingAbort = false;
    const allCancelledCache = new cacheModule.CatalogDeadlineDirectCache({
      async openSnapshot() { return snapshot; },
      async search() { return { products: [], snapshotVersion: snapshot.version }; },
      async lookupDeadlines(request) {
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            allCancelledUnderlyingAbort = true;
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      },
    });
    const cancelA = new AbortController();
    const cancelB = new AbortController();
    const cancelledA = allCancelledCache.lookup({
      snapshot, catalogProductIds: [uuidAt(902)], signal: cancelA.signal,
    }).catch(error => error.name);
    const cancelledB = allCancelledCache.lookup({
      snapshot, catalogProductIds: [uuidAt(902)], signal: cancelB.signal,
    }).catch(error => error.name);
    await Promise.resolve();
    cancelA.abort();
    cancelB.abort();
    await Promise.all([cancelledA, cancelledB]);

    return {
      mixedPeak,
      productTypeConflict: {
        queries: conflictQueries,
        classification: conflictResult.classification,
        applyEligibleCount: conflictResult.candidates.length,
        rejectedReasons: conflictResult.rejectedCandidates.flatMap(candidate => candidate.rejectReasons),
      },
      direct: {
        status: completed.batch.status,
        resultCount: completed.results.length,
        classifications: completed.results.map(result => result.classification),
        suggestedDates: [...new Set(completed.results.map(result => result.candidates[0]?.suggestedClosingDate))],
        dateByGroup: Object.fromEntries(completed.results.map(result => [
          result.erpProductGroupId,
          result.candidates[0]?.suggestedClosingDate,
        ])),
        batchSizes: batchCalls.map(call => call.length),
        uniqueIds: new Set(batchCalls.flat()).size,
        metrics: completed.metrics,
      },
      chunkMatrix,
      exactIdentity: {
        requestedIds: exactRequests.flat(),
        results: Object.fromEntries(exactCompleted.results.map(result => [
          result.erpProductGroupId,
          {
            catalogProductId: result.candidates[0]?.source.sourceProductId,
            supplier: result.candidates[0]?.source.sourceSupplier,
            suggestedClosingDate: result.candidates[0]?.suggestedClosingDate,
          },
        ])),
      },
      candidateToDirect: {
        firstClassification: firstTransitionResult.classification,
        firstCandidateCount: firstTransitionResult.candidates.length,
        selectedCatalogProductId: selectedTransitionCandidate.source.sourceProductId,
        savedMappingCount: transitionRepository.savedMappings.length,
        candidateCallsBeforeSecondAnalysis,
        candidateCallsAfterSecondAnalysis: transitionCandidateCalls,
        directCallsAfterSecondAnalysis: transitionDirectCalls,
        secondLookupStatus: secondTransitionCompleted.results[0]?.catalogLookupStatus,
        secondCatalogProductId: secondTransitionCompleted.results[0]
          ?.candidates[0]?.source.sourceProductId,
      },
      requestComparison: {
        datasetItems: 52,
        legacyNameSearchRequests: legacyComparatorRequests,
        legacyMetrics: legacyCompleted.metrics,
        directBatchRequests: completed.metrics.directBatchRequestCount,
        directCandidateRequests: completed.metrics.candidateSearchRequestCount,
        directTotalTimeMs: completed.metrics.totalTimeMs,
      },
      statuses: Object.fromEntries(statusCompleted.results.map(result => [result.erpProductGroupId, {
        lookup: result.catalogLookupStatus,
        classification: result.classification,
        reason: result.classificationReason,
        serviceError: result.serviceError?.retryable ?? null,
      }])),
      revoked: statusRepository.revoked.map(mapping => mapping.erpProductGroupId),
      candidateCalls,
      candidateHttp: {
        count: candidateResponse.products.length,
        url: fetchCalls[0],
        skus: candidateResponse.products.map(candidate => candidate.sku ?? null),
        supplierProductIds: candidateResponse.products.map(candidate => candidate.supplierProductId),
      },
      dates: {
        dreamlink: completed.results.find(result => result.erpProductGroupId === 'group-0')
          ?.candidates[0]?.suggestedClosingDate,
        wanrong: completed.results.find(result => result.erpProductGroupId === 'group-51')
          ?.candidates[0]?.suggestedClosingDate,
      },
      temporaryCalls,
      cancellation: {
        firstSharedOutcome,
        secondSharedSource: secondSharedOutcome.entries[0]?.source,
        sharedUnderlyingAborts,
        allCancelledUnderlyingAbort,
      },
    };
  });

  assert.ok(report.mixedPeak <= 6, 'Direct + candidate requests must share the configured cap; actual=' + report.mixedPeak);
  assert.equal(report.productTypeConflict.classification, 'RED');
  assert.equal(report.productTypeConflict.applyEligibleCount, 0);
  assert.ok(report.productTypeConflict.rejectedReasons.includes('PRODUCT_TYPE_CONFLICT'));
  assert.equal(report.direct.status, 'COMPLETED');
  assert.equal(report.direct.resultCount, 52);
  assert.ok(report.direct.classifications.every(value => value === 'GREEN'));
  assert.deepEqual(report.direct.batchSizes, [50, 1]);
  assert.equal(report.direct.uniqueIds, 51);
  assert.deepEqual(report.direct.suggestedDates, ['2026-09-16']);
  assert.equal(report.direct.metrics.directLookupItemCount, 52);
  assert.equal(report.direct.metrics.directUniqueProductCount, 51);
  assert.equal(report.direct.metrics.directBatchRequestCount, 2);
  assert.equal(report.direct.metrics.candidateSearchRequestCount, 0);
  assert.deepEqual(report.chunkMatrix['50'].chunks, [50]);
  assert.deepEqual(report.chunkMatrix['51'].chunks, [50, 1]);
  assert.deepEqual(report.chunkMatrix['100'].chunks, [50, 50]);
  assert.deepEqual(report.chunkMatrix['101'].chunks, [50, 50, 1]);
  for (const uniqueCount of [50, 51, 100, 101]) {
    const matrixEntry = report.chunkMatrix[String(uniqueCount)];
    assert.equal(matrixEntry.status, 'COMPLETED');
    assert.equal(matrixEntry.resultCount, uniqueCount);
    assert.equal(new Set(matrixEntry.requestedIds).size, uniqueCount);
    assert.equal(matrixEntry.candidateRequests, 0);
    assert.equal(matrixEntry.maxActiveChunkRequests, 1, 'Direct chunks must execute within a bound');
  }
  assert.deepEqual(report.exactIdentity.requestedIds, [
    '00000000-0000-4000-8000-000000000bb8',
    '00000000-0000-4000-8000-000000000bb9',
  ]);
  assert.deepEqual(report.exactIdentity.results['group-identity-dreamlink'], {
    catalogProductId: '00000000-0000-4000-8000-000000000bb8',
    supplier: 'dreamlink',
    suggestedClosingDate: '2026-12-30',
  });
  assert.deepEqual(report.exactIdentity.results['group-identity-wanrong'], {
    catalogProductId: '00000000-0000-4000-8000-000000000bb9',
    supplier: 'wanrong',
    suggestedClosingDate: '2026-02-27',
  });
  assert.equal(report.candidateToDirect.firstClassification, 'YELLOW');
  assert.ok(report.candidateToDirect.firstCandidateCount >= 2);
  assert.equal(report.candidateToDirect.selectedCatalogProductId, '00000000-0000-4000-8000-000000000fa1');
  assert.equal(report.candidateToDirect.savedMappingCount, 1);
  assert.ok(report.candidateToDirect.candidateCallsBeforeSecondAnalysis > 0);
  assert.equal(
    report.candidateToDirect.candidateCallsAfterSecondAnalysis,
    report.candidateToDirect.candidateCallsBeforeSecondAnalysis,
    'A manually verified mapping must suppress candidate search on the next analysis',
  );
  assert.equal(report.candidateToDirect.directCallsAfterSecondAnalysis, 1);
  assert.equal(report.candidateToDirect.secondLookupStatus, 'DIRECT_MATCHED');
  assert.equal(report.candidateToDirect.secondCatalogProductId, '00000000-0000-4000-8000-000000000fa1');
  assert.equal(report.requestComparison.legacyNameSearchRequests, 52);
  assert.equal(report.requestComparison.legacyMetrics.candidateSearchRequestCount, 52);
  assert.equal(report.requestComparison.directBatchRequests, 2);
  assert.equal(report.statuses['group-no-deadline'].lookup, 'DIRECT_NO_DEADLINE');
  assert.equal(report.statuses['group-no-deadline'].reason, 'MISSING_DEADLINE');
  assert.equal(report.statuses['group-temporary'].lookup, 'DIRECT_TEMPORARY_ERROR');
  assert.equal(report.statuses['group-temporary'].serviceError, true);
  assert.equal(report.statuses['group-stale'].lookup, 'STALE_MAPPING');
  assert.notEqual(report.statuses['group-stale'].classification, 'GREEN');
  assert.deepEqual(report.revoked, ['group-stale']);
  assert.ok(report.candidateCalls > 0, 'NOT_FOUND must fall back to candidate lookup');
  assert.equal(report.candidateHttp.count, 2);
  assert.match(report.candidateHttp.url, /\/api\/catalog\/deadline-candidates\?/u);
  assert.match(report.candidateHttp.url, /limit=8/u);
  assert.match(report.candidateHttp.url, /catalogId=/u);
  assert.deepEqual(report.candidateHttp.skus, [null, null]);
  assert.deepEqual(report.candidateHttp.supplierProductIds, ['SUP-1', 'SUP-2']);
  assert.deepEqual(report.dates, { dreamlink: '2026-09-16', wanrong: '2026-09-16' });
  assert.equal(report.temporaryCalls, 2, 'TEMPORARY_ERROR must never become a fresh cache hit');
  assert.equal(report.cancellation.firstSharedOutcome, 'AbortError');
  assert.equal(report.cancellation.secondSharedSource, 'SINGLE_FLIGHT');
  assert.equal(report.cancellation.sharedUnderlyingAborts, 0);
  assert.equal(report.cancellation.allCancelledUnderlyingAbort, true);

  console.log(JSON.stringify({
    status: 'PASS',
    mixedPeak: report.mixedPeak,
    productTypeConflict: report.productTypeConflict,
    directBatch: {
      erpItems: 52,
      uniqueCatalogProducts: 51,
      requests: report.direct.batchSizes.length,
      chunks: report.direct.batchSizes,
      candidateRequests: report.direct.metrics.candidateSearchRequestCount,
    },
    chunkMatrix: report.chunkMatrix,
    exactIdentity: report.exactIdentity,
    candidateToDirect: report.candidateToDirect,
    requestComparison: report.requestComparison,
    statuses: report.statuses,
    dates: report.dates,
    temporaryErrorCached: false,
    cancellationIsolation: report.cancellation,
    productGroupWrites: 0,
  }, null, 2));
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
