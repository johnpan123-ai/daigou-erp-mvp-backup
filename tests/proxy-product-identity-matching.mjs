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
      orangeIdentity,
      orangeQueries,
      orangeScores,
      orangeSelection,
      mutsukiScores,
      mutsukiSelection,
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
  console.log('PASS Production Supabase requests = 0');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
