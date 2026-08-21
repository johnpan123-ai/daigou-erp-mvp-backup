import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:4192';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { if ((await fetch(BASE_URL)).ok) return; } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error('Next Field Test server is not available at http://127.0.0.1:4192');
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  const page = await browser.newPage();
  const supabaseRequests = [];
  page.on('request', request => {
    if (/\.supabase\.co\//iu.test(request.url())) supabaseRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  const report = await page.evaluate(async () => {
    const gateway = await import('/src/lib/closingDateBatchGateway.ts');
    const cacheModule = await import('/src/lib/closingDateCatalogBatchCache.ts');
    const v1 = await import('/src/lib/proxyProductIdentity.ts');
    const legacyV2 = await import('/src/lib/proxyProductIdentityQueryV2.ts');
    const domain = await import('/src/lib/closingDateResolutionDomain.ts');
    const pilot = await import('/src/lib/proxyProductIdentityPilot.ts');
    const cases = [
      {
        key: 'louise',
        title: '代理版 角川 KDcolle 零之使魔 露易絲 20th 20週年紀念版 無比例 約23公分',
      },
      {
        key: 'sophia',
        title: '第四季 代理版 核金重構 1/9 包膠可動 索菲亞 F 希琳 碧藍兔子 附特典',
      },
      {
        key: 'omaneko',
        title: '代理版 小人物繪舘青島社KP 04R獸娘KEMO PLA Omaneko貓君 組裝模型',
      },
      {
        key: 'smp',
        title: '魂商店 萬代 SMP 牙吠孔雀王 & 牙吠眼鏡蛇王',
      },
    ];
    const snapshot = {
      version: 'live-catalog-native-search',
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    const supplier = candidate => candidate.catalog?.supplier?.code?.trim().toLocaleLowerCase() || 'unknown';
    const sourceId = candidate => String(candidate.id ?? candidate.sku ?? candidate.slug ?? candidate.url ?? '').trim();
    const keyFor = candidate => JSON.stringify([supplier(candidate), sourceId(candidate)]);
    const fetchProducts = async (query, parameter) => {
      const response = await fetch(`/api/catalog/search?q=${encodeURIComponent(query)}&${parameter}`);
      if (!response.ok) throw new Error(`Catalog ${response.status}: ${query}`);
      const payload = await response.json();
      return Array.isArray(payload.products) ? payload.products : [];
    };
    const toOldResult = (title, batchId, candidates) => {
      const selection = v1.selectProxyCatalogCandidate(title, candidates);
      const decision = pilot.resolveProxyCatalogDecision('next', title, candidates, selection);
      const selected = decision.match?.candidate ?? null;
      const selectedConfidence = decision.match?.confidence ?? 0;
      const domainCandidates = candidates.flatMap(candidate => {
        const id = sourceId(candidate);
        if (!id) return [];
        const v1Score = v1.scoreProxyCatalogCandidate(title, candidate);
        const v2Score = pilot.scoreProxyCatalogCandidateV2Pilot(title, candidate);
        const selectedCandidate = candidate === selected;
        const rawDeadline = candidate.catalog?.deadlineAt ?? null;
        const deadline = rawDeadline ? new Date(rawDeadline) : null;
        if (deadline && Number.isFinite(deadline.getTime())) deadline.setUTCDate(deadline.getUTCDate() - 2);
        return [{
          id: `${batchId}:${supplier(candidate)}:${id}`,
          source: { sourceSupplier: supplier(candidate), sourceProductId: id, sourceCatalogId: snapshot.version },
          catalogTitle: candidate.name || '(untitled)',
          catalogUrl: candidate.url ?? null,
          rawDeadline,
          suggestedClosingDate: deadline && Number.isFinite(deadline.getTime()) ? deadline.toISOString().slice(0, 10) : null,
          ruleVersion: 'closing-date-minus-two-v1',
          snapshotVersion: snapshot.version,
          confidence: selectedCandidate
            ? selectedConfidence
            : Math.max(v1Score.rejected ? 0 : v1Score.confidence, v2Score.rejected ? 0 : v2Score.confidence),
          matchMethod: selectedCandidate ? 'PARSER_INFERRED' : 'UNVERIFIED',
        }];
      });
      return domain.createResolutionResult({
        id: `${batchId}:result`, batchId, erpProductGroupId: batchId,
        erpTitleAtAnalysis: title, candidates: domainCandidates,
        ruleVersion: 'closing-date-minus-two-v1', snapshotVersion: snapshot.version,
        analyzedAt: snapshot.capturedAt,
      });
    };

    const rows = [];
    for (const sample of cases) {
      const oldQueries = Array.from(new Set([
        ...v1.buildProxyCatalogQueries(v1.normalizeProxyProductIdentity(sample.title)),
        ...legacyV2.buildProxyCatalogQueriesV2(sample.title),
      ]));
      const oldMap = new Map();
      const oldResponses = [];
      for (const query of oldQueries) {
        try {
          const products = await fetchProducts(query, 'pageSize=8');
          oldResponses.push({ query, count: products.length });
          for (const product of products) if (!oldMap.has(keyFor(product))) oldMap.set(keyFor(product), product);
        } catch (error) {
          oldResponses.push({
            query,
            count: 0,
            serviceError: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const oldResult = toOldResult(sample.title, `old-${sample.key}`, [...oldMap.values()]);

      const newResponses = [];
      const newPool = new Set();
      const newResult = await gateway.createProxyClosingDateBatchAnalyzer()({
        item: {
          clientItemId: sample.key, erpProductGroupId: `group-${sample.key}`, title: sample.title,
          updatedAt: null, currentClosingDate: null, sourceType: 'proxy', proxyAgent: null,
          jan: null, modelCode: null, verifiedMappings: [],
        },
        batchId: `new-${sample.key}`,
        ruleVersion: 'closing-date-minus-two-v1',
        snapshot,
        activeMappings: [],
        search: async query => {
          try {
            const products = await fetchProducts(query, 'limit=5');
            products.forEach(product => newPool.add(keyFor(product)));
            newResponses.push({ query, count: products.length });
            return products;
          } catch (error) {
            newResponses.push({
              query,
              count: 0,
              serviceError: error instanceof Error ? error.message : String(error),
            });
            throw new cacheModule.ClosingDateCatalogGatewayError({
              code: 'LIVE_CATALOG_SERVICE_ERROR',
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
              cause: error,
            });
          }
        },
        signal: new AbortController().signal,
        analyzedAt: snapshot.capturedAt,
      });
      rows.push({
        key: sample.key,
        before: {
          queryCount: oldQueries.length,
          candidatePoolSize: oldMap.size,
          responses: oldResponses,
          top3: oldResult.candidates.map(candidate => candidate.catalogTitle),
        },
        after: {
          queryCount: newResponses.length,
          candidatePoolSize: newPool.size,
          responses: newResponses,
          top3: newResult.candidates.map(candidate => ({
            title: candidate.catalogTitle,
            nativeEvidence: candidate.retrieval?.queryHits ?? [],
          })),
        },
      });
    }
    return rows;
  });

  console.log('LIVE_CATALOG_BEFORE_AFTER_REPORT');
  console.log(JSON.stringify(report, null, 2));

  const louise = report.find(row => row.key === 'louise');
  const sophia = report.find(row => row.key === 'sophia');
  const omaneko = report.find(row => row.key === 'omaneko');
  const smp = report.find(row => row.key === 'smp');
  assert.deepEqual(louise.after.top3.map(candidate => candidate.title), [
    '露易絲 20th Anniversary non scale model',
  ]);
  assert.deepEqual(sophia.after.top3.map(candidate => candidate.title), [
    '1/6 PVC 兔女郎服裝計畫 索菲亞· F· 希琳 機甲修女 亮色特別版',
    '1/9 索菲亞·F·希琳 碧藍兔子Ver. 包膠可動公仔',
    '1/9 可動 索菲亞·F·希琳 碧藍兔子Ver.',
  ]);
  assert.equal(omaneko.after.responses.some(response => response.query === 'PLA'), false);
  assert.equal(smp.after.responses.some(response => response.query === '魂商店 &' || response.query === '&'), false);
  assert.deepEqual(supabaseRequests, []);

  console.log('PASS Louise native search yields only the correct product in Workbench Top 3');
  console.log('PASS Sophia native 1/6 -> Wanrong 1/9 -> Dreamlink 1/9 order is preserved');
  console.log('PASS Omaneko and SMP never execute generic PLA / 魂商店 & / & queries');
  console.log('PASS Production Supabase requests = 0; live comparison is Catalog GET only');
} finally {
  await browser?.close();
}
