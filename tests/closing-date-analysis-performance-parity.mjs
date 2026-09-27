import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 4324;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CORE_TEST_CHROME
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'next', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
for (let attempt = 0; attempt < 80; attempt += 1) {
  if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
  try {
    if ((await fetch(BASE_URL)).ok) break;
  } catch {
    // Vite is still starting.
  }
  if (attempt === 79) throw new Error(`Vite start timeout:\n${viteOutput}`);
  await sleep(100);
}

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  const forbiddenRequests = [];
  page.on('request', request => {
    if (/supabase\.co|\/api\/catalog\//iu.test(request.url())) forbiddenRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  const report = await page.evaluate(async () => {
    const gateway = await import('/src/lib/closingDateBatchGateway.ts');
    const cache = await import('/src/lib/closingDateCatalogBatchCache.ts');
    const planner = await import('/src/lib/closingDateCandidateRetrievalV2.ts');
    const replayTitles = [
      '預購 27年03月 代理版 GSC 黏土人 3059 Monster Hunter 魔物獵人 火龍 雄火龍',
      '預購 27年05月 代理版 QuesQ SWAV 原畫 Tactical Bride 淡雪 1/7',
      '預購 27年01月 代理版 GSC 組裝模型 PLAMATEA 繪師toridamono MX醬 約16公分',
      '超像可動 TV動畫 JOJO的奇妙冒險 星塵遠征軍 空條承太郎 Ver.2',
      'GSC 黏土人 蔚藍檔案 空崎陽奈（禮服）Basic',
    ];
    const plannedTitles = replayTitles.map(title => ({
      title,
      plan: planner.buildClosingDateCandidateRetrievalQueries(title),
    }));
    const replay = plannedTitles.find(entry => entry.plan.length >= 4);
    if (!replay) {
      throw new Error(`Expected at least four independent queries, got ${plannedTitles.map(entry => entry.plan.length).join('/')}`);
    }
    const { title, plan } = replay;
    const targetQuery = plan.at(-1).text;
    const snapshot = {
      version: 'closing-date-performance-parity-replay-v1',
      capturedAt: '2026-09-24T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const baseItem = {
      clientItemId: 'parity-item',
      erpProductGroupId: 'parity-group',
      title,
      updatedAt: '2026-09-24T00:00:00.000Z',
      currentClosingDate: null,
      sourceType: 'proxy',
      proxyAgent: null,
      jan: null,
      modelCode: null,
      verifiedMappings: [],
    };
    const candidate = (id, deadlineAt) => ({
      id,
      name: '超像可動《JOJO的奇妙冒險 星塵遠征軍》空條承太郎 Ver.2',
      sku: `JOTARO-${id}`,
      catalog: { supplier: { code: id === 'second' ? 'dreamlink' : 'wanrong' }, deadlineAt },
    });
    const cases = [
      {
        name: 'multiple-candidates',
        response: query => query === targetQuery
          ? [
              candidate('first', '2026-10-10T08:00:00.000Z'),
              candidate('second', '2026-10-20T08:00:00.000Z'),
            ]
          : [],
      },
      {
        name: 'single-candidate',
        response: query => query === targetQuery
          ? [candidate('single', '2026-11-11T08:00:00.000Z')]
          : [],
      },
      {
        name: 'source-failure',
        response: () => new cache.ClosingDateCatalogGatewayError({
          code: 'CATALOG_SERVICE_ERROR',
          message: 'isolated replay failure',
          retryable: true,
          status: 503,
        }),
      },
    ];
    const stable = value => JSON.stringify(value, (_key, nested) => {
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
      return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
    });
    const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
    const summarize = runs => ({
      totalMedianMs: median(runs.map(run => run.totalMs)),
      totalRangeMs: [Math.min(...runs.map(run => run.totalMs)), Math.max(...runs.map(run => run.totalMs))],
      preparationMedianMs: median(runs.map(run => run.preparationMs)),
      upstreamWaitMedianMs: median(runs.map(run => run.upstreamWaitMs)),
      parseRankingMedianMs: median(runs.map(run => run.parseRankingMs)),
      calls: runs[0].calls,
      peakConcurrency: Math.max(...runs.map(run => run.peakConcurrency)),
      candidateCount: runs[0].candidateCount,
      candidateIds: runs[0].candidateIds,
      resultHash: runs[0].resultHash,
    });
    const execute = async (testCase, maxParallelQueries) => {
      const calls = [];
      let active = 0;
      let peakConcurrency = 0;
      let firstRequestStartedAt = null;
      let lastRequestFinishedAt = null;
      const startedAt = performance.now();
      const result = await gateway.createProxyClosingDateBatchAnalyzer({ maxParallelQueries })({
        item: baseItem,
        batchId: 'parity-batch',
        ruleVersion: 'closing-date-minus-two-v1',
        snapshot,
        activeMappings: [],
        search: async (query, options) => {
          const requestStartedAt = performance.now();
          firstRequestStartedAt ??= requestStartedAt;
          active += 1;
          peakConcurrency = Math.max(peakConcurrency, active);
          await new Promise(resolve => setTimeout(resolve, 120));
          active -= 1;
          lastRequestFinishedAt = Math.max(lastRequestFinishedAt ?? 0, performance.now());
          calls.push({ query, limit: options.limit });
          const response = testCase.response(query);
          if (response instanceof Error) throw response;
          return response;
        },
        signal: new AbortController().signal,
        analyzedAt: '2026-09-24T00:00:00.000Z',
      });
      const finishedAt = performance.now();
      return {
        totalMs: finishedAt - startedAt,
        preparationMs: (firstRequestStartedAt ?? finishedAt) - startedAt,
        upstreamWaitMs: (lastRequestFinishedAt ?? finishedAt) - (firstRequestStartedAt ?? startedAt),
        parseRankingMs: finishedAt - (lastRequestFinishedAt ?? finishedAt),
        calls: calls.length,
        peakConcurrency,
        candidateCount: result.candidates.length,
        candidateIds: result.candidates.map(entry => entry.source.sourceProductId),
        resultHash: stable(result),
      };
    };

    const rows = [];
    for (const testCase of cases) {
      await execute(testCase, 1);
      await execute(testCase, 4);
      const sequentialRuns = [];
      const parallelRuns = [];
      for (let run = 0; run < 5; run += 1) {
        sequentialRuns.push(await execute(testCase, 1));
        parallelRuns.push(await execute(testCase, 4));
      }
      const sequential = summarize(sequentialRuns);
      const parallel = summarize(parallelRuns);
      rows.push({
        case: testCase.name,
        plannedQueries: plan.length,
        nextBaseline: sequential,
        cloudBefore: sequential,
        cloudAfter: parallel,
        resultsIdentical: sequential.resultHash === parallel.resultHash,
      });
    }
    return { queryPlan: plan, targetQuery, rows };
  });

  for (const row of report.rows) {
    assert.equal(row.resultsIdentical, true, `${row.case}: candidate decision changed`);
    assert.equal(row.cloudAfter.calls, row.cloudBefore.calls, `${row.case}: request count changed`);
    assert.ok(row.cloudAfter.calls <= 6, `${row.case}: non-compound request budget exceeded`);
    assert.ok(row.cloudAfter.peakConcurrency <= 4, `${row.case}: per-item concurrency exceeded`);
    assert.ok(
      row.cloudAfter.totalMedianMs < row.cloudBefore.totalMedianMs * 0.65,
      `${row.case}: bounded parallel scheduling did not materially reduce replay time`,
    );
  }
  const multiple = report.rows.find(row => row.case === 'multiple-candidates');
  const single = report.rows.find(row => row.case === 'single-candidate');
  const failure = report.rows.find(row => row.case === 'source-failure');
  assert.equal(multiple.cloudAfter.candidateCount, 2);
  assert.deepEqual(multiple.cloudAfter.candidateIds, ['first', 'second']);
  assert.equal(single.cloudAfter.candidateCount, 1);
  assert.equal(failure.cloudAfter.candidateCount, 0);
  assert.deepEqual(forbiddenRequests, []);

  console.log('CLOSING_DATE_ANALYSIS_PERFORMANCE_PARITY_REPORT');
  console.log(JSON.stringify(report, null, 2));
  console.log('PASS 5-run median/range for multi, single, and source-failure replay');
  console.log('PASS query count, candidate ordering/decision, and request budget unchanged');
  console.log('PASS isolated replay issued no Supabase or live Catalog requests');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
