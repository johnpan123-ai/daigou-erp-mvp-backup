import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4266;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/closing-date/dataset.json', import.meta.url));
const SHADOW_SOURCE_PATH = fileURLToPath(new URL('../src/lib/proxyProductIdentityShadow.ts', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
const shadowSource = await readFile(SHADOW_SOURCE_PATH, 'utf8');
assert.equal(fixture.cases.length, 44, 'Shadow equivalence gate must cover the fixed 44-case evaluation');
assert.doesNotMatch(shadowSource, /dataProvider|indexedDB|saveProductGroups|fetch\s*\(/u, 'Shadow helper must remain pure and write-free');

const vite = spawn(process.execPath, [VITE, '--mode', 'next', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
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
  const forbiddenRequests = [];
  page.on('request', request => {
    if (/\/api\/|\.supabase\.co\//i.test(request.url())) forbiddenRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async (input) => {
    const matching = await import('/src/lib/proxyProductIdentity.ts');
    const shadow = await import('/src/lib/proxyProductIdentityShadow.ts');
    const summarizeSelection = (selection) => {
      const selected = selection.status === 'match' ? selection.candidate : null;
      const rawDeadline = selected?.catalog?.deadlineAt ?? null;
      let closingDate = null;
      if (rawDeadline) {
        const date = new Date(rawDeadline);
        date.setDate(date.getDate() - 2);
        closingDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      }
      return {
        decision: selection.status,
        selectedCandidate: selected?.id ?? selected?.url ?? selected?.slug ?? null,
        score: selection.confidence,
        supplier: selected?.catalog?.supplier?.code ?? null,
        rawDeadline,
        closingDate,
      };
    };
    const behavior = input.cases.map(testCase => {
      const candidates = testCase.catalogResponses.flatMap(response => response.products || []);
      const beforeQueries = matching.buildProxyCatalogQueries(
        matching.normalizeProxyProductIdentity(testCase.erpProduct.title),
      );
      const before = summarizeSelection(matching.selectProxyCatalogCandidate(testCase.erpProduct.title, candidates));

      const sourceV1 = matching.normalizeProxyProductIdentity(testCase.erpProduct.title);
      const sourceShadow = shadow.createProxyIdentityShadowDiagnostic(testCase.erpProduct.title, sourceV1);
      const candidateShadows = candidates.map(candidate => {
        const candidateV1 = matching.normalizeProxyProductIdentity(
          candidate.name || '',
          candidate.manufacturer || candidate.brand?.name || '',
        );
        const candidateShadow = shadow.createProxyIdentityShadowDiagnostic(
          candidate.name || '',
          candidateV1,
          candidate.manufacturer || candidate.brand?.name || '',
        );
        return shadow.compareProxyIdentityShadows(sourceShadow, candidateShadow);
      });

      const afterQueries = matching.buildProxyCatalogQueries(
        matching.normalizeProxyProductIdentity(testCase.erpProduct.title),
      );
      const after = summarizeSelection(matching.selectProxyCatalogCandidate(testCase.erpProduct.title, candidates));
      return { caseId: testCase.caseId, before, after, beforeQueries, afterQueries, candidateShadows };
    });

    const specialTitles = {
      kdcolleHolo: '代理版 角川 KDcolle 狼與辛香料 原作版 赫蘿 無比例模型',
      kdcolleShana: '代理版 角川 KDcolle 灼眼的夏娜 夏娜 原作版 無比例 全高約15公分',
      plamateaMash: '代理版 PLAMATEA FGO Shielder/瑪修 [奧特瑙斯] 黑槍版',
      apexCandidate: '1/7 PVC 絕區零 儀玄·獨步滄溟 Ver.',
      redHood: '代理版 26年第四季 和模線 勝利女神：妮姬 小紅帽 1/12 組裝模型',
      smpCompound: '魂商店 萬代 SMP 牙吠孔雀王 & 牙吠眼鏡蛇王',
      takaratomySource: '代理版 TAKARATOMY 商店限定 彈珠超人 彈珠人 大福箱’27 戰鬥鳳凰號豪華套組',
      takaratomyCandidate: 'T-SPARK LEGACYSOUL 彈珠超人 大福箱27[TAKARATOMY]',
      smpAliasSource: '萬代 盒玩 SMP 百獸戰隊 牙吠連者 巨大化 牙吠獅 & 牙吠象',
      smpAliasCandidate: 'SMP 百獸戰隊牙吠連者 威力獸 EXTRA 牙吠海龜＆牙吠海象',
    };
    const diagnostics = Object.fromEntries(Object.entries(specialTitles).map(([key, title]) => {
      const v1 = matching.normalizeProxyProductIdentity(title);
      return [key, shadow.createProxyIdentityShadowDiagnostic(title, v1)];
    }));
    const comparisons = {
      takaratomy: shadow.compareProxyIdentityShadows(diagnostics.takaratomySource, diagnostics.takaratomyCandidate),
      smpAlias: shadow.compareProxyIdentityShadows(diagnostics.smpAliasSource, diagnostics.smpAliasCandidate),
    };
    const modeGate = Object.fromEntries(
      ['cloud', 'fallback', 'local', 'test', 'next', 'experimental'].map(mode => [mode, shadow.canUseProxyIdentityShadow(mode)]),
    );
    return { behavior, diagnostics, comparisons, modeGate };
  }, fixture);

  for (const testCase of result.behavior) {
    assert.deepEqual(testCase.after, testCase.before, `${testCase.caseId}: v1 decision payload changed after shadow parse`);
    assert.deepEqual(testCase.afterQueries, testCase.beforeQueries, `${testCase.caseId}: Query Planner changed after shadow parse`);
  }
  assert.deepEqual(result.modeGate, {
    cloud: false,
    fallback: false,
    local: false,
    test: false,
    next: true,
    experimental: false,
  }, 'Shadow diagnostics must be Next-only');

  assert.ok(result.diagnostics.kdcolleHolo.disagreements.includes('IDENTITY_DISAGREEMENT'));
  assert.deepEqual(result.diagnostics.kdcolleHolo.v2.subjects, ['赫蘿']);
  assert.ok(result.diagnostics.kdcolleShana.disagreements.includes('DIMENSION_AS_V1_IDENTITY'));
  assert.deepEqual(result.diagnostics.kdcolleShana.v2.subjects, ['夏娜']);
  assert.ok(result.diagnostics.plamateaMash.disagreements.includes('VERSION_AS_V1_IDENTITY'));
  assert.deepEqual(result.diagnostics.plamateaMash.v2.subjects, ['瑪修']);
  assert.deepEqual(result.diagnostics.plamateaMash.v2.forms, ['奧特瑙斯']);
  assert.deepEqual(result.diagnostics.plamateaMash.v2.versions, ['黑槍版']);
  assert.ok(result.diagnostics.apexCandidate.disagreements.includes('IDENTITY_DISAGREEMENT'));
  assert.deepEqual(result.diagnostics.apexCandidate.v2.subjects, ['儀玄']);
  assert.ok(result.diagnostics.apexCandidate.v2.versions.some(value => value.includes('獨步滄溟')));
  assert.ok(result.diagnostics.redHood.disagreements.includes('SCALE_TYPE_DISAGREEMENT'));
  assert.deepEqual(result.diagnostics.redHood.v2.productTypes, ['MODEL_KIT']);
  assert.deepEqual(result.diagnostics.redHood.v2.scales, ['1/12']);
  assert.ok(result.diagnostics.smpCompound.disagreements.includes('COMPOUND_SUBJECT_DETECTED'));
  assert.deepEqual(result.diagnostics.smpCompound.v2.subjects, ['牙吠孔雀王', '牙吠眼鏡蛇王']);
  assert.deepEqual(result.comparisons.takaratomy, ['STRUCTURE_OK', 'IDENTITY_EQUIVALENCE_UNPROVEN']);
  assert.deepEqual(result.comparisons.smpAlias, ['STRUCTURE_OK', 'IDENTITY_EQUIVALENCE_UNPROVEN']);
  assert.deepEqual(forbiddenRequests, [], 'Shadow regression must issue 0 Catalog/Supabase requests');

  console.log('PASS 44-case v1 Decision/Selected Candidate/Score/Supplier/Raw Deadline/closing_date unchanged');
  console.log('PASS 44-case v1 Query Planner output unchanged');
  console.log('PASS Next-only mode gate; Cloud/Production/Test/Experimental diagnostics disabled');
  console.log('PASS special-case disagreement classification and compound subject diagnostics');
  console.log('PASS unresolved TAKARATOMY and SMP identity mappings remain IDENTITY_EQUIVALENCE_UNPROVEN');
  console.log('PASS Shadow helper has no Provider/IndexedDB/fetch/write dependency');
  console.log('PASS Production Supabase request = 0; unexpected DB write path = 0');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
