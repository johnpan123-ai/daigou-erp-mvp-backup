import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4293;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const fixtures = JSON.parse(await readFile(
  new URL('./fixtures/closing-date/generalized-retrieval-10.json', import.meta.url),
  'utf8',
));

const vite = spawn(process.execPath, [
  VITE, '--mode', 'next', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
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
    if (/\.supabase\.co\//iu.test(request.url())) forbiddenRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const report = await page.evaluate(async cases => {
    const planner = await import('/src/lib/closingDateCandidateRetrievalV2.ts');
    const gateway = await import('/src/lib/closingDateBatchGateway.ts');
    const snapshot = {
      version: 'generalized-retrieval-offline-v1',
      capturedAt: '2026-08-23T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const makeCandidate = (testCase, index, correct) => ({
      id: correct ? `${testCase.id}-correct` : `${testCase.id}-noise-${index}`,
      name: correct ? testCase.candidateTitle : `無關候選商品 ${index}`,
      catalog: {
        supplier: { code: correct && testCase.id !== 'tactical-bride-awayuki' ? 'wanrong' : 'dreamlink' },
        deadlineAt: '2026-09-07T08:00:00.000Z',
      },
    });
    const results = [];
    for (const testCase of cases) {
      const plan = planner.buildClosingDateCandidateRetrievalQueries(testCase.erpTitle);
      const memberPlan = planner.buildClosingDateCompoundMemberQueries(testCase.erpTitle);
      const calls = [];
      const result = await gateway.createProxyClosingDateBatchAnalyzer()({
        item: {
          clientItemId: testCase.id,
          erpProductGroupId: `group-${testCase.id}`,
          title: testCase.erpTitle,
          updatedAt: '2026-08-23T00:00:00.000Z',
          currentClosingDate: null,
          sourceType: 'proxy',
          proxyAgent: null,
          jan: null,
          modelCode: null,
          verifiedMappings: [],
        },
        batchId: `batch-${testCase.id}`,
        ruleVersion: 'closing-date-minus-two-v1',
        snapshot,
        activeMappings: [],
        search: async (query, options) => {
          calls.push({ query, limit: options.limit });
          if (query !== testCase.retrievalQuery) return [];
          const native = Array.from({ length: testCase.nativeRank - 1 }, (_, index) => (
            makeCandidate(testCase, index + 1, false)
          ));
          native.push(makeCandidate(testCase, testCase.nativeRank, true));
          return native.slice(0, options.limit);
        },
        signal: new AbortController().signal,
        analyzedAt: '2026-08-23T00:00:00.000Z',
      });
      const correct = result.candidates.find(candidate => candidate.catalogTitle === testCase.candidateTitle);
      results.push({
        id: testCase.id,
        plan,
        memberPlan,
        calls,
        classification: result.classification,
        classificationReason: result.classificationReason,
        correct,
        falseGreen: result.classification === 'GREEN',
        expandedCount: calls.filter(call => call.limit === planner.CLOSING_DATE_EXPANDED_NATIVE_LIMIT).length,
      });
    }
    const omaneko = await gateway.createProxyClosingDateBatchAnalyzer()({
      item: {
        clientItemId: 'omaneko', erpProductGroupId: 'group-omaneko',
        title: '代理版 小人物繪舘青島社KP 04R獸娘KEMO PLA Omaneko貓君 組裝模型',
        updatedAt: '2026-08-23T00:00:00.000Z', currentClosingDate: null,
        sourceType: 'proxy', proxyAgent: null, jan: null, modelCode: null, verifiedMappings: [],
      },
      batchId: 'batch-omaneko', ruleVersion: 'closing-date-minus-two-v1', snapshot,
      activeMappings: [], search: async () => [], signal: new AbortController().signal,
      analyzedAt: '2026-08-23T00:00:00.000Z',
    });
    return { results, omaneko };
  }, fixtures);

  assert.equal(report.results.length, 10);
  for (const [index, entry] of report.results.entries()) {
    const fixture = fixtures[index];
    assert.ok(
      [...entry.plan, ...entry.memberPlan].some(query => query.text === fixture.retrievalQuery),
      `${fixture.id}: expected high-information query ${fixture.retrievalQuery}`,
    );
    assert.ok(entry.correct, `${fixture.id}: correct Catalog candidate must enter Review`);
    assert.equal(entry.classification, 'YELLOW', `${fixture.id}: inferred candidate must remain YELLOW`);
    assert.equal(entry.falseGreen, false, `${fixture.id}: parser/fuzzy evidence must not become GREEN`);
    assert.ok(entry.calls.length <= (fixture.compound ? 7 : 6), `${fixture.id}: request budget exceeded`);
    assert.ok(entry.expandedCount <= 1, `${fixture.id}: expanded window used more than once`);
    const nativeHit = entry.correct.retrieval.queryHits.find(hit => hit.queryText === fixture.retrievalQuery);
    assert.equal(nativeHit?.nativeRank, fixture.nativeRank, `${fixture.id}: Catalog native rank must be preserved`);
  }
  assert.equal(report.omaneko.classification, 'RED');
  assert.equal(report.omaneko.classificationReason, 'NO_CANDIDATE');
  assert.equal(forbiddenRequests.length, 0, 'Offline retrieval fixtures must never contact Supabase');

  console.log('PASS 10/10 generalized Failure Dataset candidates enter YELLOW Review');
  console.log('PASS non-Compound <= 6; Compound <= 7; expanded window <= 1');
  console.log('PASS Native Rank preserved; inferred 100% never becomes GREEN');
  console.log('PASS Omaneko remains RED / NO_CANDIDATE');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
