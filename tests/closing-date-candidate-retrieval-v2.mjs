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
      kangaroo: '魂商店 萬代 SMP 百獸戰隊 牙吠連者 牙吠袋鼠',
      reliable: '代理版 角川 KDcolle 狼與辛香料 赫蘿 原作版 無比例模型',
      unresolved: '代理版 無比例 約23公分',
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
      const queryCalls = [];
      const result = await gatewayModule.createProxyClosingDateBatchAnalyzer()({
        item: makeItem(key, title),
        batchId: `batch-${key}`,
        ruleVersion: 'closing-date-minus-two-v1',
        snapshot,
        activeMappings: [],
        search: async (query, options) => {
          queries.push(query);
          queryCalls.push({ query, limit: options?.limit ?? null });
          return resolver(query, options);
        },
        signal: new AbortController().signal,
        analyzedAt: '2026-08-21T00:00:00.000Z',
      });
      return { queries, queryCalls, result };
    };
    const louise = await analyze('louise', titles.louise, query => (
      query === '露易絲' ? [louiseCandidate] : []
    ));
    const sophia = await analyze('sophia', titles.sophia, query => (
      query === '希琳' ? sophiaCandidates : []
    ));
    const omaneko = await analyze('omaneko', titles.omaneko, () => []);
    const smpCandidate = {
      id: 'smp-peacock-cobra-wanrong',
      name: 'SMP 百獸戰隊牙吠連者 威力獸 EXTRA 牙吠孔雀＆牙吠眼鏡蛇',
      janCode: '4570117926228',
      catalog: { supplier: { code: 'wanrong' }, deadlineAt: '2026-09-07T08:00:00.000Z' },
    };
    const smp = await analyze('smp', titles.smp, query => (
      query === '牙吠孔雀' || query === '牙吠眼鏡蛇' ? [smpCandidate] : []
    ));
    const kangarooCandidate = {
      id: 'smp-kangaroo-wanrong',
      name: 'SMP 百獸戰隊牙吠連者 威力獸 EXTRA 牙吠袋鼠',
      janCode: '4570117926259',
      catalog: { supplier: { code: 'wanrong' }, deadlineAt: '2026-09-07T08:00:00.000Z' },
    };
    const kangaroo = await analyze('kangaroo', titles.kangaroo, query => (
      query === '牙吠袋鼠' ? [kangarooCandidate] : []
    ));
    const unrelatedFamilyCandidate = index => ({
      id: `unrelated-family-${index}`,
      name: `S.H.Figuarts 假面騎士 無關商品 ${index}`,
      catalog: { supplier: { code: 'dreamlink' }, deadlineAt: '2026-09-30T00:00:00.000Z' },
    });
    const familyProducts = Array.from({ length: 12 }, (_, index) => (
      index === 10 ? smpCandidate : unrelatedFamilyCandidate(index + 1)
    ));
    const familyFallback = await analyze('smp-family', titles.smp, query => (
      query === '牙吠' ? familyProducts : []
    ));
    const retrievedButRejected = await analyze('smp-rejected', titles.smp, query => (
      query === '牙吠孔雀' ? [unrelatedFamilyCandidate(3)] : []
    ));
    const unreliableProgressive = await analyze(
      'unreliable-progressive',
      titles.sophia,
      () => sophiaCandidates,
    );
    const reliableCandidates = ['wanrong-a', 'dreamlink-b', 'dreamlink-c'].map((id, index) => ({
      id,
      name: 'KDcolle 狼與辛香料 赫蘿 原作版 無比例模型',
      catalog: {
        supplier: { code: index === 0 ? 'wanrong' : 'dreamlink' },
        deadlineAt: '2026-09-07T00:00:00.000Z',
      },
    }));
    const reliableProgressive = await analyze(
      'reliable-progressive',
      titles.reliable,
      () => reliableCandidates,
    );
    const repeatedEvidence = await analyze(
      'repeated-evidence',
      titles.louise,
      () => [louiseCandidate],
    );

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
          products: request.query === '希琳' ? sophiaCandidates : [],
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
        ['一般版', '再販', 'figma', 'POP UP PARADE', 'SMP', '1/7', '約23公分', '約', '限定']
          .map(query => [query, planner.isLowInformationCatalogQuery(query)]),
      ),
      louise,
      sophia,
      omaneko,
      smp,
      kangaroo,
      familyFallback,
      retrievedButRejected,
      familyPlanner: {
        members: planner.buildClosingDateCompoundMemberQueries(titles.smp),
        family: planner.buildClosingDateFamilyStemFallbackQuery(titles.smp),
        blocked: [
          '代理版 PLA & PLA',
          '代理版 PVC & PVC',
          '代理版 無比例 & 無比例',
          '代理版 限定 & 限定',
          '代理版 組裝模型 & 組裝模型',
          '代理版 & & &',
        ].map(title => planner.buildClosingDateFamilyStemFallbackQuery(title)),
      },
      unreliableProgressive,
      reliableProgressive,
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
  for (const generic of ['一般版', '再販', 'figma', 'POP UP PARADE', 'SMP', '1/7', '約23公分', '約', '限定']) {
    assert.equal(report.lowInformationQueries[generic], true, `${generic} must remain a blocked bare query`);
  }
  assert.ok(report.plans.louise.some(query => query.text === '露易絲'));
  assert.ok(report.plans.sophia.some(query => query.text.includes('索菲亞 F 希琳')));
  assert.ok(report.plans.sophia.some(query => query.text === '希琳'));
  assert.equal(report.plans.omaneko.some(query => query.text === 'PLA'), false);
  assert.deepEqual(report.plans.unresolved, [], 'low-information subject fallback must fail closed');

  assert.deepEqual(report.louise.result.candidates.map(candidate => candidate.catalogTitle), [
    '露易絲 20th Anniversary non scale model',
  ]);
  assert.equal(report.louise.result.candidates[0].retrieval.queryHits[0].nativeRank, 1);
  assert.deepEqual(report.sophia.result.candidates.map(candidate => candidate.catalogTitle), [
    '1/9 索菲亞·F·希琳 碧藍兔子Ver. 包膠可動公仔',
    '1/9 可動 索菲亞·F·希琳 碧藍兔子Ver.',
  ]);
  assert.deepEqual(
    report.sophia.result.candidates.map(candidate => candidate.retrieval.queryHits[0].nativeRank),
    [2, 3],
  );
  assert.equal(report.omaneko.queries.includes('PLA'), false);
  assert.equal(report.smp.queries.includes('魂商店 &'), false);
  assert.deepEqual(report.familyPlanner.members.map(query => query.text), ['牙吠孔雀', '牙吠眼鏡蛇']);
  assert.equal(report.familyPlanner.family.text, '牙吠');
  assert.equal(report.familyPlanner.family.limit, 12);
  assert.deepEqual(report.familyPlanner.blocked, [null, null, null, null, null, null]);
  assert.deepEqual(report.smp.result.candidates.map(candidate => candidate.catalogTitle), [
    'SMP 百獸戰隊牙吠連者 威力獸 EXTRA 牙吠孔雀＆牙吠眼鏡蛇',
  ]);
  assert.equal(report.smp.result.classification, 'YELLOW');
  assert.equal(report.smp.queries.includes('牙吠'), false, 'member hit must skip family fallback');
  assert.deepEqual(report.smp.queryCalls.slice(-2), [
    { query: '牙吠孔雀', limit: 5 },
    { query: '牙吠眼鏡蛇', limit: 5 },
  ]);
  assert.deepEqual(report.kangaroo.result.candidates.map(candidate => candidate.catalogTitle), [
    'SMP 百獸戰隊牙吠連者 威力獸 EXTRA 牙吠袋鼠',
  ]);
  assert.ok(report.kangaroo.queryCalls.some(call => call.query === '牙吠袋鼠' && call.limit === 5));
  assert.equal(report.familyFallback.queryCalls.at(-1).query, '牙吠');
  assert.equal(report.familyFallback.queryCalls.at(-1).limit, 12);
  assert.deepEqual(report.familyFallback.result.candidates.map(candidate => candidate.catalogTitle), [
    'SMP 百獸戰隊牙吠連者 威力獸 EXTRA 牙吠孔雀＆牙吠眼鏡蛇',
  ]);
  assert.equal(report.familyFallback.result.candidates[0].retrieval.queryHits[0].nativeRank, 11);
  assert.equal(report.familyFallback.result.classification, 'YELLOW');
  assert.equal(report.retrievedButRejected.result.classification, 'RED');
  assert.equal(report.retrievedButRejected.result.classificationReason, 'RETRIEVED_BUT_REJECTED');
  assert.equal(report.retrievedButRejected.queries.includes('牙吠'), false);
  assert.equal(report.omaneko.result.classificationReason, 'NO_CANDIDATE');
  assert.equal(
    report.unreliableProgressive.queries.length,
    report.plans.sophia.length,
    'three raw but unverified candidates must not trigger progressive stop',
  );
  assert.deepEqual(
    report.unreliableProgressive.result.candidates.map(candidate => candidate.catalogTitle),
    report.sophia.result.candidates.map(candidate => candidate.catalogTitle),
  );
  assert.equal(report.reliableProgressive.queries.length, 1);
  assert.equal(report.reliableProgressive.result.candidates.length, 3);
  assert.equal(report.repeatedEvidence.result.candidates.length, 1);
  assert.equal(
    report.repeatedEvidence.result.candidates[0].retrieval.queryHits.length,
    report.plans.louise.length,
  );
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
    smp: {
      executedQueries: report.smp.queryCalls,
      top3: report.smp.result.candidates.map(candidate => candidate.catalogTitle),
      classification: report.smp.result.classification,
    },
    familyFallback: {
      executedQueries: report.familyFallback.queryCalls,
      top3: report.familyFallback.result.candidates.map(candidate => ({
        title: candidate.catalogTitle,
        nativeRank: candidate.retrieval.queryHits[0].nativeRank,
      })),
    },
    progressive: {
      unsafeExecutedQueries: report.unreliableProgressive.queries,
      reliableExecutedQueries: report.reliableProgressive.queries,
      safeTop3: report.reliableProgressive.result.candidates.map(candidate => candidate.catalogTitle),
    },
    repeatedEvidence: {
      executedQueries: report.repeatedEvidence.queries,
      queryHits: report.repeatedEvidence.result.candidates[0].retrieval.queryHits,
    },
  }, null, 2));
  console.log('PASS Catalog API uses limit=5, never pageSize');
  console.log('PASS high-information query planner blocks generic PLA / 無比例 / 魂商店 & / & fallbacks');
  console.log('PASS compound member search uses limit=5, preserves native #1, and skips family fallback after a raw hit');
  console.log('PASS one family-stem fallback uses limit=12; unrelated native #3 is rejected while correct native #11 remains YELLOW');
  console.log('PASS NO_CANDIDATE and RETRIEVED_BUT_REJECTED remain distinct fail-closed outcomes');
  console.log('PASS progressive search ignores raw conflicts and stops only after a reliable native Top 3');
  console.log('PASS native rank and multi-query evidence survive dedupe, Top 3, and Sidecar round-trip');
  console.log('PASS zero-confidence candidates are never reordered by source UUID');
  console.log('PASS Production Supabase requests = 0; Next/Production ERP DB unchanged');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
