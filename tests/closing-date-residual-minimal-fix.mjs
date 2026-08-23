import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4294;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const vite = spawn(process.execPath, [
  VITE, '--mode', 'next', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (/\/api\/|\.supabase\.co\//iu.test(request.url())) forbiddenRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const report = await page.evaluate(async () => {
    const gateway = await import('/src/lib/closingDateBatchGateway.ts');
    const planner = await import('/src/lib/closingDateCandidateRetrievalV2.ts');
    const snapshot = {
      version: 'residual-minimal-fix-offline',
      capturedAt: '2026-08-23T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const fixtures = [
      {
        id: 'natsume',
        title: 'GSC 黏土人 夏目友人帳 夏目貴志 & 貓咪老師 式神Ver. Basic',
        query: '夏目貴志',
        candidate: '黏土人 夏目貴志＆貓咪老師 式神Ver. Basic',
      },
      {
        id: 'sonic',
        title: 'GSC 驚喜黏土人 音速小子 索尼克×夏特 世代重啟 中盒六入 驚喜零件隨機',
        query: '索尼克',
        candidate: '驚喜黏土人《音速小子》索尼克×夏特 世代重啟',
      },
      {
        id: 'myethos',
        title: 'Myethos Gift+ 崩壞星穹鐵道 白厄 列車環遊記Ver 1/8 1006',
        query: '白厄',
        candidate: '1/8 PVC Gift+系列 崩壞:星穹鐵道 白厄 列車環遊記Ver.',
      },
      {
        id: 'miku',
        title: 'GSC 初音未來 Music & Fire Works Ver 1/7',
        query: '初音未來 Music & Fire Works',
        candidate: '1/7 Character Vocal系列01 初音未來 初音未來 Music &amp; Fire Works Ver.',
      },
    ];
    const analyze = async fixture => {
      const calls = [];
      const candidate = {
        id: `${fixture.id}-candidate`,
        name: fixture.candidate,
        catalog: { supplier: { code: 'wanrong' }, deadlineAt: '2026-09-07T08:00:00.000Z' },
      };
      const conflictingCompoundCandidate = {
        id: 'sonic-conflicting-compound',
        name: '驚喜黏土人《音速小子》索尼克×納克魯斯 世代重啟',
        catalog: { supplier: { code: 'dreamlink' }, deadlineAt: '2026-09-07T08:00:00.000Z' },
      };
      const result = await gateway.createProxyClosingDateBatchAnalyzer()({
        item: {
          clientItemId: fixture.id,
          erpProductGroupId: `group-${fixture.id}`,
          title: fixture.title,
          updatedAt: '2026-08-23T00:00:00.000Z',
          currentClosingDate: null,
          sourceType: 'proxy', proxyAgent: null, jan: null, modelCode: null, verifiedMappings: [],
        },
        batchId: `batch-${fixture.id}`,
        ruleVersion: 'closing-date-minus-two-v1', snapshot, activeMappings: [],
        search: async (query, options) => {
          calls.push({ query, limit: options.limit });
          if (query !== fixture.query) return [];
          return fixture.id === 'sonic' ? [conflictingCompoundCandidate, candidate] : [candidate];
        },
        signal: new AbortController().signal,
        analyzedAt: '2026-08-23T00:00:00.000Z',
      });
      return {
        ...fixture,
        plan: planner.buildClosingDateCandidateRetrievalQueries(fixture.title),
        members: planner.buildClosingDateCompoundMemberQueries(fixture.title),
        calls,
        classification: result.classification,
        candidates: result.candidates.map(item => item.catalogTitle),
      };
    };
    const rows = [];
    for (const fixture of fixtures) rows.push(await analyze(fixture));
    const kangarooTitle = '魂商店限定 SMP 牙吠袋鼠王 大袋鼠+小袋鼠';
    const kangarooCalls = [];
    const kangaroo = await gateway.createProxyClosingDateBatchAnalyzer()({
      item: {
        clientItemId: 'kangaroo', erpProductGroupId: 'group-kangaroo', title: kangarooTitle,
        updatedAt: '2026-08-23T00:00:00.000Z', currentClosingDate: null,
        sourceType: 'proxy', proxyAgent: null, jan: null, modelCode: null, verifiedMappings: [],
      },
      batchId: 'batch-kangaroo', ruleVersion: 'closing-date-minus-two-v1', snapshot,
      activeMappings: [],
      search: async query => {
        kangarooCalls.push(query);
        return query === '牙吠袋鼠' ? [{
          id: 'kangaroo-correct',
          name: 'SMP 百獸戰隊牙吠連者 威力獸 EXTRA 牙吠袋鼠',
          catalog: { supplier: { code: 'wanrong' }, deadlineAt: '2026-09-07T08:00:00.000Z' },
        }] : [];
      },
      signal: new AbortController().signal,
      analyzedAt: '2026-08-23T00:00:00.000Z',
    });
    return { rows, kangaroo: { calls: kangarooCalls, result: kangaroo } };
  });

  for (const row of report.rows) {
    assert.ok([...row.plan, ...row.members].some(query => query.text === row.query), `${row.id}: query missing`);
    assert.ok(row.candidates.includes(row.candidate), `${row.id}: correct candidate missing from Review`);
    assert.equal(row.classification, 'YELLOW', `${row.id}: inferred candidate must remain YELLOW`);
    assert.ok(row.calls.length <= (row.id === 'natsume' || row.id === 'sonic' ? 7 : 6));
    if (row.id === 'sonic') {
      assert.equal(row.candidates.some(title => title.includes('納克魯斯')), false);
    }
    if (row.id === 'miku') {
      assert.equal(row.calls.some(call => /^(?:Music|Ver\.?)$/iu.test(call.query)), false);
    }
  }
  assert.equal(report.kangaroo.result.classification, 'RED');
  assert.equal(report.kangaroo.result.classificationReason, 'NO_CANDIDATE');
  assert.equal(report.kangaroo.calls.includes('牙吠袋鼠'), false);
  assert.deepEqual(forbiddenRequests, []);
  console.log('PASS four residual correct candidates enter YELLOW Review');
  console.log('PASS × compound and tightened prefix propagation preserve exact sets');
  console.log('PASS bounded Ver and English ampersand query remain retrieval-only');
  console.log('PASS SMP kangaroo remains RED with no alias query');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
