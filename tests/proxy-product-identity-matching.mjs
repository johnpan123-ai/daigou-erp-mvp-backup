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
      simulatedWrites,
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
  assert.deepEqual(productionSupabaseRequests, [], 'Identity regression must not contact Production Supabase');

  console.log('PASS figma 路西法 matches with FIGMA + identity while missing series is allowed');
  console.log('PASS NENDOROID vs SCALE_FIGURE is rejected');
  console.log('PASS NENDOROID vs NENDOROID matches');
  console.log('PASS POP_UP_PARADE vs NENDOROID is rejected');
  console.log('PASS ambiguous same-type candidates produce 0 writes');
  console.log('PASS Production Supabase requests = 0');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
