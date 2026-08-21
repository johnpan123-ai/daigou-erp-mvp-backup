import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 4286;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const retrievalSource = readFileSync(
  new URL('../src/lib/closingDateCandidateRetrievalV2.ts', import.meta.url),
  'utf8',
);
assert.doesNotMatch(
  retrievalSource,
  /saveProductGroups|dataProvider|indexedDB|supabase|closing_date\s*[:=]/u,
  'Candidate Retrieval v2 must remain read-only and independent of ERP storage',
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
    const planner = await import('/src/lib/closingDateCandidateRetrievalV2.ts');
    const gatewayModule = await import('/src/lib/closingDateBatchGateway.ts');
    const cacheModule = await import('/src/lib/closingDateCatalogBatchCache.ts');
    const repositoryModule = await import('/src/lib/closingDateResolutionSidecarRepository.ts');
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const domain = await import('/src/lib/closingDateResolutionDomain.ts');
    const titles = {
      louise: '代理版 角川 KDcolle 零之使魔 露易絲 20th 20週年紀念版 無比例 約23公分',
      sophia: '第四季 代理版 核金重構 1/9 包膠可動 索菲亞 F 希琳 碧藍兔子 附特典',
      omaneko: '代理版 小人物繪舘青島社KP 04R獸娘KEMO PLA Omaneko貓君 組裝模型',
      smp: '魂商店 萬代 SMP 牙吠孔雀王 & 牙吠眼鏡蛇王',
    };
    const plans = Object.fromEntries(Object.entries(titles).map(([key, title]) => [
      key,
      planner.buildClosingDateCandidateRetrievalQueries(title),
    ]));
    const snapshot = {
      version: 'catalog-native-v2-fixture',
      capturedAt: '2026-08-21T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const makeItem = (key, title) => ({
      clientItemId: key,
      erpProductGroupId: `group-${key}`,
      title,
      updatedAt: '2026-08-21T00:00:00.000Z',
      currentClosingDate: null,
      sourceType: 'proxy',
      proxyAgent: null,
      jan: null,
      modelCode: null,
      verifiedMappings: [],
    });
    const louiseCandidate = {
      id: 'louise-wanrong',
      name: '露易絲 20th Anniversary non scale model',
      url: 'https://catalog.test/louise',
      catalog: { supplier: { code: 'wanrong' }, deadlineAt: '2026-09-07T00:00:00.000Z' },
    };
    const sophiaCandidates = [
      {
        id: 'sophia-1-6-dreamlink',
        name: '1/6 PVC 兔女郎服裝計畫 索菲亞· F· 希琳 機甲修女 亮色特別版',
        catalog: { supplier: { code: 'dreamlink' }, deadlineAt: '2026-09-10T00:00:00.000Z' },
      },
      {
        id: 'sophia-1-9-wanrong',
        name: '1/9 索菲亞·F·希琳 碧藍兔子Ver. 包膠可動公仔',
        catalog: { supplier: { code: 'wanrong' }, deadlineAt: '2026-09-08T00:00:00.000Z' },
      },
      {
        id: 'sophia-1-9-dreamlink',
        name: '1/9 可動 索菲亞·F·希琳 碧藍兔子Ver.',
        catalog: { supplier: { code: 'dreamlink' }, deadlineAt: '2026-09-09T00:00:00.000Z' },
      },
    ];
    const analyze = async (key, title, resolver) => {
      const queries = [];
      const result = await gatewayModule.createProxyClosingDateBatchAnalyzer()({
        item: makeItem(key, title),
        batchId: `batch-${key}`,
        ruleVersion: 'closing-date-minus-two-v1',
        snapshot,
        activeMappings: [],
        search: async query => {
          queries.push(query);
          return resolver(query);
        },
        signal: new AbortController().signal,
        analyzedAt: '2026-08-21T00:00:00.000Z',
      });
      return { queries, result };
    };
    const louise = await analyze('louise', titles.louise, query => (
      query === '露易絲' ? [louiseCandidate] : []
    ));
    const sophia = await analyze('sophia', titles.sophia, query => (
      query === '索菲亞 F 希琳' ? sophiaCandidates : []
    ));
    const omaneko = await analyze('omaneko', titles.omaneko, () => []);
    const smp = await analyze('smp', titles.smp, () => []);
    const progressive = await analyze('progressive', titles.sophia, () => sophiaCandidates);
    const repeatedEvidence = await analyze('repeated-evidence', titles.omaneko, () => [{
      id: 'omaneko-dreamlink',
      name: 'KEMO PLA おまねこ',
      catalog: { supplier: { code: 'dreamlink' }, deadlineAt: null },
    }]);

    let capturedUrl = '';
    const httpClient = cacheModule.createReadonlyCatalogHttpClient({
      fetcher: async input => {
        capturedUrl = String(input);
        return new Response(JSON.stringify({ products: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await httpClient.search({
      query: '露易絲',
      limit: planner.CLOSING_DATE_CATALOG_NATIVE_LIMIT,
      snapshotVersion: snapshot.version,
    });

    const zeroConfidenceRanked = domain.rankTopThreeCandidates([
      {
        id: 'native-1',
        source: { sourceSupplier: 'dreamlink', sourceProductId: 'uuid-z' },
        catalogTitle: 'Native Rank 1',
        ruleVersion: 'rule', snapshotVersion: 'snapshot', confidence: 0, matchMethod: 'UNVERIFIED',
        retrieval: {
          strategy: 'CATALOG_NATIVE_SEARCH_V2', firstSeenOrder: 1,
          queryHits: [{ queryText: 'subject', queryPriority: 4, queryKind: 'SUBJECT', nativeRank: 1, sourceSupplier: 'dreamlink', sourceProductId: 'uuid-z' }],
        },
      },
      {
        id: 'native-3',
        source: { sourceSupplier: 'dreamlink', sourceProductId: 'uuid-a' },
        catalogTitle: 'Native Rank 3',
        ruleVersion: 'rule', snapshotVersion: 'snapshot', confidence: 0, matchMethod: 'UNVERIFIED',
        retrieval: {
          strategy: 'CATALOG_NATIVE_SEARCH_V2', firstSeenOrder: 3,
          queryHits: [{ queryText: 'subject', queryPriority: 4, queryKind: 'SUBJECT', nativeRank: 3, sourceSupplier: 'dreamlink', sourceProductId: 'uuid-a' }],
        },
      },
      {
        id: 'native-2',
        source: { sourceSupplier: 'wanrong', sourceProductId: 'uuid-m' },
        catalogTitle: 'Native Rank 2',
        ruleVersion: 'rule', snapshotVersion: 'snapshot', confidence: 0, matchMethod: 'UNVERIFIED',
        retrieval: {
          strategy: 'CATALOG_NATIVE_SEARCH_V2', firstSeenOrder: 2,
          queryHits: [{ queryText: 'subject', queryPriority: 4, queryKind: 'SUBJECT', nativeRank: 2, sourceSupplier: 'wanrong', sourceProductId: 'uuid-m' }],
        },
      },
    ]).map(candidate => candidate.id);

    const databaseName = `daigou-erp-closing-date-sidecar-next-v1-retrieval-${crypto.randomUUID()}`;
    const repository = repositoryModule.createNextClosingDateResolutionRepository({ databaseName });
    const nextBefore = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
    const productionBefore = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db');
    const fakeClient = {
      async openSnapshot() { return snapshot; },
      async search(request) {
        return {
          products: request.query === '索菲亞 F 希琳' ? sophiaCandidates : [],
          snapshotVersion: request.snapshotVersion,
        };
      },
    };
    const gateway = gatewayModule.createNextClosingDateBatchGateway({
      repository,
      catalogClient: fakeClient,
      maxItemConcurrency: 1,
    });
    const created = await gateway.createJob({
      clientBatchId: 'retrieval-sidecar-roundtrip',
      idempotencyKey: 'retrieval-sidecar-roundtrip-v1',
      inputHash: 'retrieval-sidecar-roundtrip-input',
      snapshotVersionPreference: 'LATEST',
      ruleVersion: 'closing-date-minus-two-v1',
      items: [makeItem('sophia-roundtrip', titles.sophia)],
    });
    const completed = await gateway.waitForJob(created.jobId);
    const stored = await repository.listResolutionResults(created.jobId);
    const nextAfter = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db-next-v1');
    const productionAfter = await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db');
    repository.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    return {
      plans,
      lowInformationQueries: Object.fromEntries(
        ['一般版', '再販', 'figma', 'POP UP PARADE', 'SMP', '1/7', '約23公分']
          .map(query => [query, planner.isLowInformationCatalogQuery(query)]),
      ),
      louise,
      sophia,
      omaneko,
      smp,
      progressive,
      repeatedEvidence,
      capturedUrl,
      zeroConfidenceRanked,
      roundtrip: {
        completed: completed.results,
        stored,
      },
      nextUnchanged: JSON.stringify(nextBefore) === JSON.stringify(nextAfter),
      productionUnchanged: JSON.stringify(productionBefore) === JSON.stringify(productionAfter),
    };
  });

  const allQueries = Object.values(report.plans).flat().map(query => query.text);
  assert.equal(Object.values(report.plans).every(queries => queries.length <= 4), true);
  assert.equal(allQueries.includes('PLA'), false);
  assert.equal(allQueries.includes('無比例'), false);
  assert.equal(allQueries.includes('魂商店 &'), false);
  assert.equal(allQueries.includes('&'), false);
  for (const generic of ['一般版', '再販', 'figma', 'POP UP PARADE', 'SMP', '1/7', '約23公分']) {
    assert.equal(report.lowInformationQueries[generic], true, `${generic} must remain a blocked bare query`);
  }
  assert.ok(report.plans.louise.some(query => query.text === '露易絲'));
  assert.ok(report.plans.sophia.some(query => query.text === '索菲亞 F 希琳'));
  assert.equal(report.plans.omaneko.some(query => query.text === 'PLA'), false);

  assert.deepEqual(report.louise.result.candidates.map(candidate => candidate.catalogTitle), [
    '露易絲 20th Anniversary non scale model',
  ]);
  assert.equal(report.louise.result.candidates[0].retrieval.queryHits[0].nativeRank, 1);
  assert.deepEqual(report.sophia.result.candidates.map(candidate => candidate.catalogTitle), [
    '1/6 PVC 兔女郎服裝計畫 索菲亞· F· 希琳 機甲修女 亮色特別版',
    '1/9 索菲亞·F·希琳 碧藍兔子Ver. 包膠可動公仔',
    '1/9 可動 索菲亞·F·希琳 碧藍兔子Ver.',
  ]);
  assert.deepEqual(
    report.sophia.result.candidates.map(candidate => candidate.retrieval.queryHits[0].nativeRank),
    [1, 2, 3],
  );
  assert.equal(report.omaneko.queries.includes('PLA'), false);
  assert.equal(report.smp.queries.includes('魂商店 &'), false);
  assert.equal(report.progressive.queries.length, 1);
  assert.deepEqual(
    report.progressive.result.candidates.map(candidate => candidate.catalogTitle),
    report.sophia.result.candidates.map(candidate => candidate.catalogTitle),
  );
  assert.equal(report.repeatedEvidence.result.candidates.length, 1);
  assert.equal(report.repeatedEvidence.result.candidates[0].retrieval.queryHits.length, 2);
  assert.match(report.capturedUrl, /[?&]limit=5(?:&|$)/u);
  assert.doesNotMatch(report.capturedUrl, /[?&]pageSize=/u);
  assert.deepEqual(report.zeroConfidenceRanked, ['native-1', 'native-2', 'native-3']);
  assert.deepEqual(report.roundtrip.stored, report.roundtrip.completed);
  assert.ok(report.roundtrip.stored[0].candidates.every(candidate => candidate.retrieval?.queryHits.length > 0));
  assert.equal(report.nextUnchanged, true);
  assert.equal(report.productionUnchanged, true);
  assert.deepEqual(supabaseRequests, []);

  console.log('CANDIDATE_RETRIEVAL_V2_REPORT');
  console.log(JSON.stringify({
    queryPlans: report.plans,
    louise: {
      executedQueries: report.louise.queries,
      top3: report.louise.result.candidates.map(candidate => candidate.catalogTitle),
    },
    sophia: {
      executedQueries: report.sophia.queries,
      top3: report.sophia.result.candidates.map(candidate => ({
        title: candidate.catalogTitle,
        nativeRank: candidate.retrieval.queryHits[0].nativeRank,
      })),
      recommendedCandidateId: report.sophia.result.recommendedCandidateId,
    },
    omaneko: { executedQueries: report.omaneko.queries, candidateCount: report.omaneko.result.candidates.length },
    smp: { executedQueries: report.smp.queries, candidateCount: report.smp.result.candidates.length },
    progressive: {
      executedQueries: report.progressive.queries,
      top3: report.progressive.result.candidates.map(candidate => candidate.catalogTitle),
    },
    repeatedEvidence: {
      executedQueries: report.repeatedEvidence.queries,
      queryHits: report.repeatedEvidence.result.candidates[0].retrieval.queryHits,
    },
  }, null, 2));
  console.log('PASS Catalog API uses limit=5, never pageSize');
  console.log('PASS high-information query planner blocks generic PLA / 無比例 / 魂商店 & / & fallbacks');
  console.log('PASS progressive search stops after a high-information query yields a reliable native Top 3');
  console.log('PASS native rank and multi-query evidence survive dedupe, Top 3, and Sidecar round-trip');
  console.log('PASS zero-confidence candidates are never reordered by source UUID');
  console.log('PASS Production Supabase requests = 0; Next/Production ERP DB unchanged');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
