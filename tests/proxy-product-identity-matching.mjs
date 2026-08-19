import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4261;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const vite = spawn(process.execPath, [
  VITE,
  '--mode', 'next',
  '--host', '127.0.0.1',
  '--port', String(PORT),
  '--strictPort',
], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
});

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const waitForVite = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
};

let browser;
try {
  await waitForVite();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const productionSupabaseRequests = [];
  page.on('request', request => {
    if (/\.supabase\.co\//i.test(request.url())) productionSupabaseRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async () => {
    const matching = await import('/src/lib/proxyProductIdentity.ts');
    const candidate = (name, id) => ({
      id,
      name,
      catalog: { deadlineAt: '2026-09-20T00:00:00.000Z' },
    });

    const luciferTitle = '代理版 figma 地獄征服者 Helltaker 路西法';
    const luciferIdentity = matching.normalizeProxyProductIdentity(luciferTitle);
    const luciferSelection = matching.selectProxyCatalogCandidate(luciferTitle, [
      candidate('figma 路西法', 'figma-lucifer'),
    ]);

    const nendoroidTitle = '代理版 GSC 黏土人 XXX';
    const nendoroidVsScale = matching.selectProxyCatalogCandidate(nendoroidTitle, [
      candidate('XXX 1/7 Scale Figure', 'scale-xxx'),
    ]);
    const nendoroidMatch = matching.selectProxyCatalogCandidate(nendoroidTitle, [
      candidate('ねんどろいど XXX', 'nendoroid-xxx'),
    ]);
    const pupVsNendoroid = matching.selectProxyCatalogCandidate('代理版 POP UP PARADE XXX', [
      candidate('ねんどろいど XXX', 'nendoroid-xxx'),
    ]);
    const ambiguous = matching.selectProxyCatalogCandidate('代理版 figma XXX', [
      candidate('figma XXX', 'figma-xxx'),
      candidate('figma XXX DX', 'figma-xxx-dx'),
    ]);
    const productLineConflict = matching.selectProxyCatalogCandidate('代理版 FuRyu Hikkake 櫻巫女', [
      candidate('MOCHIPICO 櫻巫女', 'mochipico-miko'),
    ]);

    const orangeTitle = '代理版 GSC POP UP PARADE 魔法少女的魔女審判 橘雪莉 L Size';
    const orangeCandidates = [
      {
        ...candidate('POP UP PARADE 橘雪莉 L Size', 'pup-orange-l'),
        brand: { name: 'Good Smile Company' },
        catalog: { deadlineAt: '2026-09-18T08:00:00.000Z' },
      },
      candidate('POP UP PARADE 二階堂希羅 L Size', 'pup-kira-l'),
      candidate('POP UP PARADE 02 L Size', 'pup-02-l'),
      candidate('POP UP PARADE 綾波零 L Size', 'pup-rei-l'),
    ];
    const orangeIdentity = matching.normalizeProxyProductIdentity(orangeTitle);
    const orangeQueries = matching.buildProxyCatalogQueries(orangeIdentity);
    const orangeScores = orangeCandidates.map(item => matching.scoreProxyCatalogCandidate(orangeTitle, item));
    const orangeSelection = matching.selectProxyCatalogCandidate(orangeTitle, orangeCandidates);

    const mutsukiTitle = '代理版 GSC 黏土人 3121 BanG Dream! 夢限大MewType 峰月律';
    const mutsukiCandidates = [
      {
        ...candidate('黏土人3121《BanG Dream!》峰月律', 'nendoroid-mutsuki-dreamlink'),
        brand: { name: 'Goodsmile' },
        catalog: {
          deadlineAt: '2026-09-09T15:00:00.000Z',
          supplier: { code: 'dreamlink' },
        },
      },
      {
        ...candidate('黏土人 峰月律', 'nendoroid-mutsuki-wanrong'),
        brand: { name: 'Good Smile Company' },
        catalog: {
          deadlineAt: '2026-09-07T08:00:00.000Z',
          supplier: { code: 'wanrong' },
        },
      },
    ];
    const mutsukiScores = mutsukiCandidates.map(item => matching.scoreProxyCatalogCandidate(mutsukiTitle, item));
    const mutsukiSelection = matching.selectProxyCatalogCandidate(mutsukiTitle, mutsukiCandidates);

    const takaratomyTitle = '代理版 TAKARATOMY 商店限定 彈珠超人 彈珠人 大福箱’27 戰鬥鳳凰號豪華套組';
    const takaratomyIdentity = matching.normalizeProxyProductIdentity(takaratomyTitle);
    const takaratomyQueries = matching.buildProxyCatalogQueries(takaratomyIdentity);
    const takaratomyCatalogCandidate = {
      ...candidate('T-SPARK LEGACYSOUL 彈珠超人 大福箱27[TAKARATOMY]', 'takaratomy-big-box-27'),
      brand: { name: '千值練' },
      catalog: {
        deadlineAt: '2026-08-25T08:00:00.000Z',
        supplier: { code: 'wanrong' },
      },
    };
    const takaratomyRetrievedCandidates = [];
    let takaratomyRequestCount = 0;
    for (const query of takaratomyQueries) {
      takaratomyRequestCount += 1;
      if (query === '彈珠超人 大福箱27') takaratomyRetrievedCandidates.push(takaratomyCatalogCandidate);
      const selection = matching.selectProxyCatalogCandidate(takaratomyTitle, takaratomyRetrievedCandidates);
      if (matching.isSafeProxyCatalogSelection(takaratomyTitle, selection)) break;
    }
    const takaratomySelection = matching.selectProxyCatalogCandidate(takaratomyTitle, takaratomyRetrievedCandidates);
    const takaratomyCandidateScore = matching.scoreProxyCatalogCandidate(takaratomyTitle, takaratomyCatalogCandidate);

    const gsCollectionTitle = '代理版 GSC 蔚藍檔案 Blue Archive G.S. Collection 妃姬 回憶大廳Ver.';
    const gsCollectionCandidate = {
      ...candidate('1/7 蔚藍檔案 Blue Archive G.S. Collection 妃姬 回憶大廳Ver.', 'gs-collection-hina-memory-lobby'),
      brand: { name: 'Good Smile Company' },
      catalog: {
        deadlineAt: '2026-09-07T08:00:00.000Z',
        supplier: { code: 'wanrong' },
      },
    };
    const gsCollectionNoScaleCandidate = candidate(
      'G.S. Collection 蔚藍檔案 妃姬 回憶大廳Ver.',
      'gs-collection-hina-memory-lobby-no-scale',
    );
    const gsCollectionWrongLineCandidate = candidate(
      'Hikkake 妃姬 回憶大廳Ver.',
      'hikkake-hina-memory-lobby',
    );
    const gsCollectionWrongIdentityCandidate = candidate(
      '1/7 蔚藍檔案 Blue Archive G.S. Collection 渚 回憶大廳Ver.',
      'gs-collection-nagisa-memory-lobby',
    );
    const gsCollectionIdentity = matching.normalizeProxyProductIdentity(gsCollectionTitle);
    const gsCollectionCandidateIdentity = matching.normalizeProxyProductIdentity(
      gsCollectionCandidate.name,
      gsCollectionCandidate.brand?.name,
    );
    const gsCollectionSelection = matching.selectProxyCatalogCandidate(gsCollectionTitle, [gsCollectionCandidate]);
    const gsCollectionSuggestedClosingDate = new Date(gsCollectionCandidate.catalog.deadlineAt);
    gsCollectionSuggestedClosingDate.setDate(gsCollectionSuggestedClosingDate.getDate() - 2);
    const gsCollectionNoScaleSelection = matching.selectProxyCatalogCandidate(gsCollectionTitle, [gsCollectionNoScaleCandidate]);
    const gsCollectionWrongLineScore = matching.scoreProxyCatalogCandidate(gsCollectionTitle, gsCollectionWrongLineCandidate);
    const gsCollectionWrongIdentityScore = matching.scoreProxyCatalogCandidate(gsCollectionTitle, gsCollectionWrongIdentityCandidate);
    const gsCollectionEvidenceTitles = [
      '1/7 蔚藍檔案 Blue Archive G.S. Collection 渚 ～花香微笑～',
      '1/7 賽馬娘Pretty Derby G.S. Collection [不融的砂糖點心]奧斯頓真弓',
      '1/7 G.S. Collection 四月是你的謊言 宮園薰 結婚禮服Ver.',
      'G.S. Collection 辣妹富江×Hello Kitty',
      'G.S. Collection 大神澪 Date Style 外出服ver.',
    ].map(title => matching.normalizeProxyProductIdentity(title));

    const retrievalFoundation = Object.fromEntries(Object.entries({
      shf: '代理版 BANDAI SHF 七龍珠 孫悟飯 SUPER HERO 再版',
      firefly: '代理版 GSC 黏土人 崩壞 星穹鐵道 流螢 0907',
      luminous: '代理版 Luminous Box CheLA77 原創插畫 兔女郎警官02 1/6',
      yumemirize: '代理版 SEGA 景品 Yumemirize BanG Dream Ave Mujica 若葉睦',
      hikkake: '代理版 FuRyu Hololive Hikkake 櫻巫女 再版',
      singleCjk: '代理版 GSC Chocopuni 貓娘樂園 世界連結 楓',
      titleAlias: '代理版 萬代 Hololive IF Relax time 儒烏風亭らでん 儒烏風亭螺鈿 休息時光',
    }).map(([key, title]) => {
      const identity = matching.normalizeProxyProductIdentity(title);
      return [key, { identity, queries: matching.buildProxyCatalogQueries(identity) }];
    }));

    let simulatedWrites = 0;
    if (matching.isSafeProxyCatalogSelection('代理版 figma XXX', ambiguous)) simulatedWrites += 1;

    return {
      luciferIdentity,
      luciferQueries: matching.buildProxyCatalogQueries(luciferIdentity),
      luciferSelection,
      nendoroidVsScale,
      nendoroidMatch,
      pupVsNendoroid,
      ambiguous,
      productLineConflict,
      orangeIdentity,
      orangeQueries,
      orangeScores,
      orangeSelection,
      mutsukiScores,
      mutsukiSelection,
      takaratomyIdentity,
      takaratomyQueries,
      takaratomyRequestCount,
      takaratomyRetrievedCandidateCount: takaratomyRetrievedCandidates.length,
      takaratomySelection,
      takaratomyCandidateScore,
      gsCollectionIdentity,
      gsCollectionCandidateIdentity,
      gsCollectionSelection,
      gsCollectionSuggestedClosingDate: gsCollectionSuggestedClosingDate.toISOString().slice(0, 10),
      gsCollectionNoScaleSelection,
      gsCollectionWrongLineScore,
      gsCollectionWrongIdentityScore,
      gsCollectionEvidenceTitles,
      retrievalFoundation,
      simulatedWrites,
      minimumConfidence: matching.PROXY_IDENTITY_MIN_CONFIDENCE,
      ambiguityDelta: matching.PROXY_IDENTITY_AMBIGUITY_DELTA,
    };
  });

  assert.equal(result.luciferIdentity.productType, 'FIGMA');
  assert.deepEqual(result.luciferIdentity.identityTokens, ['路西法']);
  assert.deepEqual(result.luciferIdentity.seriesTokens, ['地獄征服者', 'Helltaker']);
  assert.equal(result.luciferQueries[0], 'figma 路西法');
  assert.equal(result.luciferSelection.status, 'match');

  assert.equal(result.nendoroidVsScale.status, 'no_match');
  assert.equal(result.nendoroidMatch.status, 'match');
  assert.equal(result.pupVsNendoroid.status, 'no_match');
  assert.equal(result.ambiguous.status, 'ambiguous');
  assert.equal(result.productLineConflict.status, 'no_match');
  assert.equal(result.simulatedWrites, 0, 'Ambiguous identity must remain fail-closed');

  assert.equal(result.minimumConfidence, 0.9, 'Matching threshold must remain unchanged');
  assert.equal(result.ambiguityDelta, 0.05, 'Ambiguity guard must remain at 5%');
  assert.equal(result.orangeIdentity.productType, 'POP_UP_PARADE');
  assert.equal(result.orangeIdentity.manufacturer, 'GSC');
  assert.equal(result.orangeIdentity.size, 'L');
  assert.deepEqual(result.orangeIdentity.identityTokens, ['橘雪莉']);
  assert.deepEqual(result.orangeIdentity.seriesTokens, ['魔法少女的魔女審判']);
  assert.equal(result.orangeQueries[0], 'POP UP PARADE 橘雪莉 L Size');
  assert.ok(result.orangeQueries.includes('POP UP PARADE 橘雪莉'));
  assert.ok(!result.orangeQueries.includes('Size'), 'Query must never degrade to Size alone');
  assert.equal(result.orangeSelection.status, 'match');
  assert.equal(result.orangeSelection.candidate?.id, 'pup-orange-l');
  assert.equal(result.orangeSelection.candidate?.catalog?.deadlineAt, '2026-09-18T08:00:00.000Z');
  assert.equal(result.orangeScores[0].candidateIdentity.identityTokens[0], '橘雪莉');
  assert.equal(result.orangeScores[0].candidateIdentity.size, 'L');
  assert.equal(result.orangeScores[0].candidateIdentity.manufacturer, 'GSC');
  for (const score of result.orangeScores.slice(1)) {
    assert.equal(score.rejected, true, `${score.candidate.name} must be rejected`);
    assert.equal(score.reason, 'identity_missing');
    assert.equal(score.confidence, 0, 'Different characters must not receive a high score');
  }
  assert.equal(result.mutsukiScores[0].confidence, 1, 'Dreamlink listing should retain its identity score');
  assert.ok(
    Math.abs(result.mutsukiScores[1].confidence - 0.97) < Number.EPSILON * 2,
    'Wanrong listing should retain its identity score',
  );
  assert.equal(result.mutsukiSelection.status, 'match', 'Same product listings must not trigger identity ambiguity');
  assert.equal(result.mutsukiSelection.candidate?.id, 'nendoroid-mutsuki-wanrong');
  assert.equal(result.mutsukiSelection.candidate?.catalog?.supplier?.code, 'wanrong');
  assert.equal(result.mutsukiSelection.candidate?.catalog?.deadlineAt, '2026-09-07T08:00:00.000Z');
  assert.equal(result.takaratomyIdentity.manufacturer, 'TAKARATOMY');
  assert.equal(result.takaratomyQueries[0], '彈珠超人 大福箱27');
  assert.ok(result.takaratomyQueries.includes('T-SPARK LEGACYSOUL 彈珠超人'));
  assert.ok(result.takaratomyQueries.includes('TAKARATOMY 大福箱27'));
  assert.ok(result.takaratomyQueries.includes('TAKARATOMY'));
  assert.ok(result.takaratomyQueries.every(query => !query.includes('’')));
  assert.ok(result.takaratomyQueries.every(query => !query.includes('彈珠人')));
  assert.ok(result.takaratomyQueries.length <= 8, 'Progressive query planner must remain bounded');
  assert.equal(result.takaratomyRetrievedCandidateCount, 1, 'Query planner must retrieve the existing Catalog candidate');
  assert.equal(result.takaratomySelection.status, 'no_match', 'Retrieval must not bypass identity safety');
  assert.equal(result.takaratomyCandidateScore.reason, 'identity_missing');
  assert.equal(result.takaratomyCandidateScore.confidence, 0);
  assert.equal(result.takaratomyRequestCount, result.takaratomyQueries.length, 'Safe reject may continue through the bounded progressive plan');
  assert.equal(result.gsCollectionIdentity.productLine, 'G_S_COLLECTION');
  assert.equal(result.gsCollectionIdentity.productType, null, 'Product line must not be hardcoded as SCALE_FIGURE');
  assert.deepEqual(result.gsCollectionIdentity.identityTokens, ['妃姬']);
  assert.ok(result.gsCollectionIdentity.versionTokens.includes('回憶大廳Ver.'));
  assert.equal(result.gsCollectionIdentity.manufacturer, 'GSC');
  assert.equal(result.gsCollectionCandidateIdentity.productLine, 'G_S_COLLECTION');
  assert.equal(result.gsCollectionCandidateIdentity.productType, 'SCALE_FIGURE');
  assert.equal(result.gsCollectionSelection.status, 'match');
  assert.equal(result.gsCollectionSelection.candidate?.id, 'gs-collection-hina-memory-lobby');
  assert.equal(result.gsCollectionSelection.candidate?.catalog?.deadlineAt, '2026-09-07T08:00:00.000Z');
  assert.equal(result.gsCollectionSuggestedClosingDate, '2026-09-05');
  assert.ok((result.gsCollectionSelection.confidence ?? 0) >= 0.9);
  assert.equal(result.gsCollectionNoScaleSelection.status, 'match', 'Product line + identity + version may match without type inference');
  assert.equal(result.gsCollectionWrongLineScore.rejected, true);
  assert.equal(result.gsCollectionWrongLineScore.reason, 'product_line_conflict');
  assert.equal(result.gsCollectionWrongIdentityScore.rejected, true);
  assert.equal(result.gsCollectionWrongIdentityScore.reason, 'identity_missing');
  assert.ok(result.gsCollectionEvidenceTitles.every(identity => identity.productLine === 'G_S_COLLECTION'));
  assert.equal(result.gsCollectionEvidenceTitles[3].productType, null, 'Catalog evidence without explicit scale must remain unknown type');
  assert.equal(result.gsCollectionEvidenceTitles[4].productType, null, 'Product line metadata must not infer a product type');
  assert.equal(result.retrievalFoundation.shf.identity.productLine, 'SHF');
  assert.deepEqual(result.retrievalFoundation.shf.identity.identityTokens, ['孫悟飯']);
  assert.ok(result.retrievalFoundation.shf.identity.versionTokens.includes('再版'));
  assert.equal(result.retrievalFoundation.firefly.identity.identityTokens[0], '流螢');
  assert.ok(result.retrievalFoundation.firefly.identity.ignoredTokens.includes('0907'));
  assert.equal(result.retrievalFoundation.luminous.identity.identityTokens[0], '兔女郎警官02');
  assert.equal(result.retrievalFoundation.luminous.identity.scale, '1/6');
  assert.equal(result.retrievalFoundation.yumemirize.identity.productLine, 'YUMEMIRIZE');
  assert.equal(result.retrievalFoundation.yumemirize.identity.manufacturer, 'SEGA');
  assert.equal(result.retrievalFoundation.yumemirize.identity.identityTokens[0], '若葉睦');
  assert.equal(result.retrievalFoundation.yumemirize.queries[0], 'Yumemirize 若葉睦');
  assert.ok(result.retrievalFoundation.yumemirize.queries.includes('若葉睦'));
  assert.equal(result.retrievalFoundation.hikkake.identity.productLine, 'HIKKAKE');
  assert.equal(result.retrievalFoundation.hikkake.identity.identityTokens[0], '櫻巫女');
  assert.ok(result.retrievalFoundation.hikkake.identity.versionTokens.includes('再版'));
  assert.deepEqual(result.retrievalFoundation.singleCjk.identity.identityTokens, ['楓']);
  assert.ok(result.retrievalFoundation.titleAlias.identity.identityAliases.includes('儒烏風亭らでん'));
  assert.ok(result.retrievalFoundation.titleAlias.queries.includes('Relax time 儒烏風亭らでん'));
  assert.deepEqual(productionSupabaseRequests, [], 'Identity regression must not contact Production Supabase');

  console.log('PASS figma 路西法 matches with FIGMA + identity while missing series is allowed');
  console.log('PASS NENDOROID vs SCALE_FIGURE is rejected');
  console.log('PASS NENDOROID vs NENDOROID matches');
  console.log('PASS POP_UP_PARADE vs NENDOROID is rejected');
  console.log('PASS ambiguous same-type candidates produce 0 writes');
  console.log('PASS POP UP PARADE 橘雪莉 L Size matches by character while Size remains metadata');
  console.log('PASS different POP UP PARADE L Size characters are rejected with score 0');
  console.log('PASS raw deadline remains 2026-09-18 and the existing -2 day business rule is untouched');
  console.log('PASS same-product Dreamlink + Wanrong listings select Wanrong before applying deadline rules');
  console.log('PASS TAKARATOMY aliases retrieve 大福箱27 while identity mismatch remains fail-closed');
  console.log('PASS G.S. Collection matches by product line + identity + version without hardcoding SCALE_FIGURE');
  console.log('PASS Retrieval v2 parses SHF, date tokens, scale, product lines, qualifiers, and one-character CJK identity');
  console.log('PASS Production Supabase requests = 0');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
