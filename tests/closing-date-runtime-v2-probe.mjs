import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE_URL = process.env.NEXT_FIELD_TEST_URL ?? 'http://127.0.0.1:4192';
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const cases = [
  {
    id: 'kdcolle-holo-original',
    title: '代理版 角川 KDcolle 狼與辛香料 原作版 赫蘿 無比例模型',
    expectedTitle: /赫蘿.*原作版.*無比例模型/u,
    expectedDecision: 'V2_PILOT',
  },
  {
    id: 'kdcolle-shana-original',
    title: '代理版 角川 KDcolle 灼眼的夏娜 夏娜 原作版 無比例 全高約15公分',
    expectedTitle: /夏娜.*原作版.*無比例模型/u,
    expectedDecision: 'V2_PILOT',
  },
  {
    id: 'kadokawa-holo-dx',
    title: '代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 DX Ver.',
    expectedTitle: /PLASTIC MODEL SERIES.*赫蘿 DX Ver\./iu,
    expectedDecision: 'V2_PILOT',
  },
  {
    id: 'kadokawa-holo-regular-missing-version',
    title: '代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 一般版',
    expectedTitle: /PLASTIC MODEL SERIES.*赫蘿$/iu,
    expectedDecision: 'V2_PILOT',
    expectedRawDate: '2026-09-07',
    expectedClosingDate: '2026-09-05',
  },
  {
    id: 'apex-yixuan',
    title: '代理版 APEX 1/7 絕區零 儀玄 獨步滄溟Ver 附特典',
    expectedTitle: /儀玄.*獨步滄溟/iu,
    expectedDecision: 'V2_PILOT',
    expectedRawDate: '2026-10-11',
    expectedClosingDate: '2026-10-09',
  },
  {
    id: 'chouzou-star-platinum',
    title: '代理版 超像可動 JOJO的奇妙冒險第三部 星塵遠征軍 白金之星',
    safeUnresolved: true,
  },
  {
    id: 'chouzou-jotaro-ver2',
    title: '代理版 超像可動 JOJO 星塵遠征軍 空條承太郎 Ver. 2',
    expectedTitle: /超像可動.*空條承太郎.*ver\.?\s*2/iu,
    expectedDecision: 'V2_PILOT',
  },
  {
    id: 'takaratomy-unverified-alias',
    title: '代理版 TAKARATOMY 商店限定 彈珠超人 彈珠人 大福箱’27 戰鬥鳳凰號豪華套組',
    safeUnresolved: true,
  },
  {
    id: 'smp-unverified-product-set',
    title: '萬代 盒玩 SMP 百獸戰隊 牙吠連者 巨大化 牙吠獅 & 牙吠象',
    safeUnresolved: true,
  },
  {
    id: 'omaneko-unverified-catalog',
    title: '代理版 小人物繪舘青島社KP 04R獸娘KEMO PLA Omaneko貓君 組裝模型',
    safeUnresolved: true,
  },
];

let browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const supabaseRequests = [];
  page.on('request', request => {
    if (/\.supabase\.co\//iu.test(request.url())) supabaseRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async ({ inputs, baseUrl }) => {
    const v1 = await import('/src/lib/proxyProductIdentity.ts');
    const planner = await import('/src/lib/proxyProductIdentityQueryV2.ts');
    const pilot = await import('/src/lib/proxyProductIdentityPilot.ts');
    const cache = new Map();
    let networkRequests = 0;
    const search = async query => {
      if (!cache.has(query)) {
        networkRequests += 1;
        cache.set(query, fetch(`${baseUrl}/api/catalog/search?q=${encodeURIComponent(query)}&pageSize=8`).then(async response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        }));
      }
      return cache.get(query);
    };
    const formatDate = raw => {
      if (!raw) return null;
      const date = new Date(raw);
      date.setDate(date.getDate() - 2);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    };
    const rows = [];
    for (const input of inputs) {
      const v1Queries = v1.buildProxyCatalogQueries(v1.normalizeProxyProductIdentity(input.title));
      const v2Queries = planner.buildProxyCatalogQueriesV2(input.title).filter(query => !v1Queries.includes(query));
      const candidates = [];
      const executed = [];
      const v1Executed = [];
      const v2Executed = [];
      let v1Selection = v1.selectProxyCatalogCandidate(input.title, candidates);
      let resolution = pilot.resolveProxyCatalogDecision('next', input.title, candidates, v1Selection);
      for (const query of v1Queries) {
        executed.push(query);
        v1Executed.push(query);
        const data = await search(query);
        candidates.push(...(data.products || []));
        v1Selection = v1.selectProxyCatalogCandidate(input.title, candidates);
        resolution = pilot.resolveProxyCatalogDecision('next', input.title, candidates, v1Selection);
        if (resolution.match?.decisionSource === 'V1' && resolution.match.candidate.catalog?.deadlineAt) break;
      }
      if (!resolution.match) {
        for (const query of v2Queries) {
          executed.push(query);
          v2Executed.push(query);
          const data = await search(query);
          candidates.push(...(data.products || []));
          v1Selection = v1.selectProxyCatalogCandidate(input.title, candidates);
          resolution = pilot.resolveProxyCatalogDecision('next', input.title, candidates, v1Selection);
          const supplier = resolution.match?.candidate.catalog?.supplier?.code?.toLocaleLowerCase();
          if (resolution.match?.decisionSource === 'V1' || supplier === 'wanrong') break;
        }
      }
      const match = resolution.match;
      rows.push({
        id: input.id,
        executed,
        v1ExecutedCount: v1Executed.length,
        v2ExecutedCount: v2Executed.length,
        candidateCount: candidates.length,
        decision: match?.decisionSource ?? resolution.pilotSelection?.status ?? v1Selection.status,
        selected: match?.candidate.name ?? null,
        supplier: match?.candidate.catalog?.supplier?.code ?? null,
        rawDeadline: match?.candidate.catalog?.deadlineAt ?? null,
        closingDate: formatDate(match?.candidate.catalog?.deadlineAt),
        confidence: match?.confidence ?? resolution.pilotSelection?.confidence ?? v1Selection.confidence,
      });
    }
    const beforeUniqueRequests = new Set(rows.flatMap(row => row.executed.slice(0, row.v1ExecutedCount))).size;
    return { rows, networkRequests, beforeUniqueRequests };
  }, { inputs: cases, baseUrl: BASE_URL });

  for (const testCase of cases) {
    const row = result.rows.find(item => item.id === testCase.id);
    assert.ok(row, `${testCase.id}: missing runtime result`);
    if (testCase.safeUnresolved) {
      assert.equal(row.selected, null, `${testCase.id}: version-less ERP title must remain fail-closed`);
      continue;
    }
    assert.equal(row.decision, testCase.expectedDecision, `${testCase.id}: unexpected decision source`);
    assert.match(row.selected ?? '', testCase.expectedTitle, `${testCase.id}: wrong Catalog product`);
    assert.ok(row.rawDeadline, `${testCase.id}: selected Catalog product must have a deadline`);
    if (testCase.expectedRawDate) assert.ok(row.rawDeadline.startsWith(testCase.expectedRawDate));
    if (testCase.expectedClosingDate) assert.equal(row.closingDate, testCase.expectedClosingDate);
  }
  assert.deepEqual(supabaseRequests, [], 'Real runtime probe must issue 0 Production Supabase requests');
  assert.ok(
    result.networkRequests - result.beforeUniqueRequests <= cases.length * 2,
    'Structured fallback introduced an excessive number of Catalog requests',
  );

  console.table(result.rows);
  console.log(`RUNTIME_NETWORK_REQUESTS before_v1_unique=${result.beforeUniqueRequests} after_with_v2_unique=${result.networkRequests}`);
  console.log('PASS 4192 real Catalog runtime probe; false positives = 0');
  console.log('PASS Production Supabase request = 0; DB write operation = 0');
} finally {
  if (browser) await browser.close();
}
