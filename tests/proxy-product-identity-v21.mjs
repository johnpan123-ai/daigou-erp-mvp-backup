import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4272;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_PATH = fileURLToPath(new URL('../src/lib/proxyProductIdentityV2.ts', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const source = await readFile(SOURCE_PATH, 'utf8');
assert.doesNotMatch(
  source,
  /dataProvider|indexedDB|saveProductGroups|closing_date|fetch\s*\(/u,
  'Parser v2.1 must remain a pure parser with no read/write/network dependency',
);

const vite = spawn(process.execPath, [
  VITE,
  '--mode', 'next',
  '--host', '127.0.0.1',
  '--port', String(PORT),
  '--strictPort',
], {
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

  const result = await page.evaluate(async () => {
    const parser = await import('/src/lib/proxyProductIdentityV2.ts');
    const titles = {
      sophia: '第四季 代理版 核金重構 1/9 包膠可動 索菲亞 F 希琳 碧藍兔子 附特典',
      louise: '代理版 角川 KDcolle 零之使魔 露易絲 20th 20週年紀念版 無比例 約23公分',
      shana: '代理版 角川 KDcolle 灼眼的夏娜 夏娜 原作版 無比例 全高約15公分',
      holoKdcolle: '代理版 角川 KDcolle 狼與辛香料 原作版 赫蘿 無比例模型',
      holoPlastic: '代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 DX Ver.',
      mashSource: '代理版 PLAMATEA FGO Shielder/瑪修 [奧特瑙斯]',
      mashCandidate: 'PLAMATEA Shielder/瑪修·基利艾拉特[奧特瑙斯] Black Barrel Edition',
      compound: '魂商店 萬代 SMP 牙吠孔雀王 & 牙吠眼鏡蛇王',
      compoundChainErp: '預購 再版 代理 萬代 盒玩 SMP 百獸戰隊 牙吠連者 牙吠力士 牙吠犀牛&犰狳',
      compoundChainCatalog: 'SMP 百獸戰隊牙吠連者 牙吠力士/牙吠犀牛&amp;牙吠犰狳（再販）',
      compoundChainFullwidth: 'SMP 牙吠力士／牙吠犰狳＆牙吠犀牛',
      releaseStatusReprint: '萬代 SMP 百獸戰隊 牙吠神 再版',
      releaseStatusResale: '萬代 SMP 百獸戰隊 牙吠神 再販',
      unresolved: '代理版 未知品牌 奇幻作品 神秘角色 藍色外套',
      semanticOnly: '代理版 無比例模型 一般版 約23公分 附特典',
      elaina: '預購 27年09月 代理版 GSC 魔女之旅 伊蕾娜 Azure 插畫 1/7',
      awayuki: '預購 27年05月 代理版 QuesQ SWAV 原畫 Tactical Bride 淡雪 1/7',
      nendoroid3059: '預購 27年03月 代理版 GSC 黏土人 3059 Monster Hunter 魔物獵人 火龍 雄火龍',
      mixedScriptMx: '預購 27年01月 代理版 GSC 組裝模型 PLAMATEA 繪師toridamono MX醬 約16公分',
      mixedScriptShortForm: '代理版 PLAMATEA F型',
      mixedScriptVersionLike: '代理版 PLAMATEA DX版',
      loneCjkSuffix: '代理版 PLAMATEA 醬',
      creatorOnly: '代理版 PLAMATEA 繪師toridamono',
      chouzouJotaro: '超像可動 TV動畫 JOJO的奇妙冒險 星塵遠征軍 空條承太郎 Ver.2',
      chouzouStarPlatinum: '超像可動 JOJO的奇妙冒險第三部 星塵遠征軍 白金之星 再版',
      chouzouStarCandidate: '*超像可動 JOJO的奇妙冒險 第3部 白金之星Third(可動)(再販)',
      hinaBasic: 'GSC 黏土人 蔚藍檔案 空崎陽奈（禮服）Basic',
      residualNatsume: 'GSC 黏土人 夏目友人帳 夏目貴志 & 貓咪老師 式神Ver. Basic',
      residualSonic: 'GSC 驚喜黏土人 音速小子 索尼克×夏特 世代重啟 中盒六入 驚喜零件隨機',
      residualMyethos: 'Myethos Gift+ 崩壞星穹鐵道 白厄 列車環遊記Ver 1/8 1006',
    };
    return Object.fromEntries(Object.entries(titles).map(([key, title]) => [key, {
      legacy: parser.parseProxyProductIdentityV2(title),
      v21: parser.parseProxyProductIdentityV21(title),
      phase1: parser.parseProxyProductIdentityV21Metadata(title),
    }]));
  });

  assert.deepEqual(result.sophia.legacy.subjects, ['碧藍兔子'], 'Regression precondition: legacy v2 remains frozen');
  assert.deepEqual(result.louise.legacy.subjects, ['約'], 'Regression precondition: legacy v2 remains frozen');

  assert.deepEqual(result.sophia.v21.subjects, ['索菲亞 F 希琳']);
  assert.ok(result.sophia.v21.forms.includes('碧藍兔子'));
  assert.ok(result.sophia.v21.productTypes.includes('ACTION_FIGURE'));
  assert.equal(result.sophia.v21.subjectResolution, 'RESOLVED_SUBJECT');
  assert.deepEqual(result.sophia.v21.subjectEvidence, ['MULTI_TOKEN_PERSON_NAME']);

  assert.deepEqual(result.louise.v21.subjects, ['露易絲']);
  assert.ok(result.louise.v21.series.includes('零之使魔'));
  assert.ok(result.louise.v21.versions.includes('20th'));
  assert.ok(result.louise.v21.versions.includes('20週年紀念版'));
  assert.ok(result.louise.v21.dimensions.includes('約23公分'));
  assert.ok(!result.louise.v21.subjects.includes('約'));
  assert.equal(result.louise.v21.subjectResolution, 'RESOLVED_SUBJECT');
  assert.deepEqual(result.louise.v21.subjectEvidence, ['PRODUCT_LINE_TITLE_GRAMMAR']);

  assert.deepEqual(result.shana.v21.subjects, ['夏娜']);
  assert.ok(result.shana.v21.series.includes('灼眼的夏娜'));
  assert.ok(result.shana.v21.dimensions.some(value => value.includes('15公分')));
  assert.deepEqual(result.holoKdcolle.v21.subjects, ['赫蘿']);
  assert.deepEqual(result.holoPlastic.v21.subjects, ['赫蘿']);

  assert.deepEqual(result.mashSource.v21.subjects, ['瑪修']);
  assert.deepEqual(result.mashCandidate.v21.subjects, ['瑪修·基利艾拉特']);
  assert.ok(result.mashSource.v21.forms.includes('奧特瑙斯'));
  assert.ok(result.mashCandidate.v21.forms.includes('奧特瑙斯'));
  assert.deepEqual(result.mashCandidate.v21.subjectEvidence, ['ROLE_DELIMITED_SUBJECT']);

  assert.equal(result.compound.v21.subjectResolution, 'COMPOUND_SUBJECT');
  assert.deepEqual(result.compound.v21.subjects, ['牙吠孔雀王', '牙吠眼鏡蛇王']);
  assert.deepEqual(result.compound.v21.subjectEvidence, ['COMPOUND_SUBJECT_SET']);

  const expectedCompoundChain = ['牙吠力士', '牙吠犀牛', '牙吠犰狳'];
  assert.deepEqual(result.compoundChainErp.v21.subjects, expectedCompoundChain);
  assert.deepEqual(result.compoundChainCatalog.v21.subjects, expectedCompoundChain);
  assert.deepEqual(
    [...result.compoundChainFullwidth.v21.subjects].sort(),
    [...expectedCompoundChain].sort(),
    'Compound member order and /, &, full-width, and HTML separators must normalize to the same set',
  );
  assert.ok(!result.compoundChainErp.v21.series.includes('牙吠犰狳'));
  assert.ok(!result.compoundChainCatalog.v21.series.includes('牙吠犰狳'));
  assert.deepEqual(result.compoundChainCatalog.v21.compoundSubjects[0].separators, ['/', '&']);
  assert.deepEqual(result.releaseStatusReprint.v21.versions, ['再版']);
  assert.deepEqual(result.releaseStatusResale.v21.versions, ['再版']);

  assert.deepEqual(result.unresolved.v21.subjects, [], 'Unknown structure must not promote the last token to Subject');
  assert.equal(result.unresolved.v21.subjectResolution, 'UNRESOLVED_SUBJECT');
  assert.ok(result.unresolved.v21.unresolvedSubjectTokens.includes('藍色外套'));
  assert.deepEqual(result.semanticOnly.v21.subjects, []);
  assert.equal(result.semanticOnly.v21.subjectResolution, 'UNRESOLVED_SUBJECT');
  assert.ok(result.semanticOnly.v21.dimensions.includes('約23公分'));
  assert.ok(!result.semanticOnly.v21.unresolvedSubjectTokens.includes('約'));
  assert.deepEqual(result.elaina.v21.modelCodes, []);
  assert.deepEqual(result.awayuki.v21.modelCodes, []);
  assert.ok(result.elaina.v21.businessMetadata.includes('27年09月'));
  assert.ok(result.awayuki.v21.businessMetadata.includes('27年05月'));
  assert.deepEqual(result.nendoroid3059.v21.modelCodes, ['3059']);
  assert.deepEqual(result.mixedScriptMx.v21.subjects, ['MX醬']);
  assert.deepEqual(result.mixedScriptMx.v21.subjectEvidence, ['DISTINCTIVE_MIXED_SCRIPT_SUBJECT']);
  assert.ok(result.mixedScriptMx.v21.productLines.includes('PLAMATEA'));
  assert.ok(result.mixedScriptMx.v21.productTypes.includes('MODEL_KIT'));
  assert.ok(result.mixedScriptMx.v21.dimensions.includes('約16公分'));
  assert.equal(result.mixedScriptMx.v21.series.includes('繪師toridamono'), false);
  for (const key of ['mixedScriptShortForm', 'mixedScriptVersionLike', 'loneCjkSuffix', 'creatorOnly']) {
    assert.deepEqual(result[key].v21.subjects, [], `${key} must not become a mixed-script Subject`);
    assert.equal(result[key].v21.subjectResolution, 'UNRESOLVED_SUBJECT');
  }

  assert.deepEqual(result.chouzouJotaro.phase1.subjects, ['空條承太郎']);
  assert.ok(result.chouzouJotaro.phase1.series.includes('JOJO的奇妙冒險'));
  assert.ok(result.chouzouJotaro.phase1.series.includes('星塵遠征軍'));
  assert.deepEqual(result.chouzouJotaro.phase1.editions, ['Ver.2']);
  assert.deepEqual(result.chouzouJotaro.phase1.releaseStatuses, []);
  assert.deepEqual(result.chouzouJotaro.phase1.subjectCandidates, [{
    value: '空條承太郎',
    evidence: ['PRODUCT_LINE_GRAMMAR'],
    rank: 1,
    queryEligible: true,
  }]);
  assert.ok(result.chouzouJotaro.phase1.productTypes.includes('ACTION_FIGURE'));
  assert.ok(result.chouzouJotaro.phase1.productTypeEvidence.some(evidence => (
    evidence.productType === 'ACTION_FIGURE'
    && evidence.source === 'PRODUCT_LINE'
    && evidence.productLine === 'CHOUZOUKADOU'
  )));

  assert.deepEqual(result.chouzouStarPlatinum.phase1.subjects, ['白金之星']);
  assert.ok(result.chouzouStarPlatinum.phase1.series.includes('JOJO的奇妙冒險第三部'));
  assert.deepEqual(result.chouzouStarPlatinum.phase1.editions, []);
  assert.deepEqual(result.chouzouStarPlatinum.phase1.releaseStatuses, ['再版']);
  assert.deepEqual(result.chouzouStarCandidate.phase1.releaseStatuses, ['再版']);
  assert.ok(result.chouzouStarCandidate.phase1.editions.includes('Third'));

  assert.deepEqual(result.hinaBasic.phase1.subjects, ['空崎陽奈']);
  assert.ok(result.hinaBasic.phase1.series.includes('蔚藍檔案'));
  assert.deepEqual(result.hinaBasic.phase1.forms, ['禮服']);
  assert.deepEqual(result.hinaBasic.phase1.editions, ['Basic']);
  assert.deepEqual(result.hinaBasic.phase1.releaseStatuses, []);
  assert.ok(result.hinaBasic.phase1.productTypeEvidence.some(evidence => (
    evidence.productType === 'NENDOROID' && evidence.source === 'EXPLICIT_MARKER'
  )));

  assert.deepEqual(result.residualNatsume.phase1.subjects, ['夏目貴志', '貓咪老師']);
  assert.deepEqual(result.residualNatsume.phase1.series, ['夏目友人帳']);
  assert.deepEqual(result.residualNatsume.phase1.compoundSubjects[0].members, ['夏目貴志', '貓咪老師']);
  assert.deepEqual(result.residualSonic.phase1.subjects, ['索尼克', '夏特']);
  assert.deepEqual(result.residualSonic.phase1.compoundSubjects[0].members, ['索尼克', '夏特']);
  assert.ok(result.residualSonic.phase1.series.includes('音速小子'));
  assert.ok(result.residualSonic.phase1.qualifiers.includes('中盒六入'));
  assert.ok(result.residualSonic.phase1.qualifiers.includes('驚喜零件隨機'));
  assert.deepEqual(result.residualMyethos.phase1.editions, ['列車環遊記 Ver.']);
  assert.deepEqual(result.residualMyethos.phase1.modelCodes, []);
  assert.ok(result.residualMyethos.phase1.businessMetadata.includes('1006'));

  assert.deepEqual(result.mixedScriptMx.phase1.subjects, ['MX醬']);
  assert.deepEqual(result.mixedScriptMx.phase1.subjectCandidates, [{
    value: 'MX醬',
    evidence: ['DISTINCTIVE_MIXED_SCRIPT'],
    rank: 1,
    queryEligible: true,
  }]);
  assert.ok(result.mixedScriptMx.phase1.productTypeEvidence.some(evidence => (
    evidence.productType === 'MODEL_KIT' && evidence.source === 'EXPLICIT_MARKER'
  )));

  for (const [key, forbidden] of [
    ['hinaBasic', ['禮服', 'Basic']],
    ['chouzouJotaro', ['Ver.2']],
    ['chouzouStarPlatinum', ['再版']],
    ['elaina', ['插畫']],
    ['awayuki', ['原畫']],
  ]) {
    assert.equal(
      forbidden.some(value => result[key].phase1.subjects.includes(value)),
      false,
      `${key}: semantic metadata must not become Subject`,
    );
    assert.equal(
      forbidden.some(value => result[key].phase1.subjectCandidates.some(candidate => candidate.value === value)),
      false,
      `${key}: semantic metadata must not become a Subject candidate`,
    );
  }
  assert.deepEqual(result.awayuki.phase1.modelCodes, []);
  assert.ok(result.awayuki.phase1.businessMetadata.includes('27年05月'));

  assert.deepEqual(forbiddenRequests, [], 'Parser v2.1 regression must issue 0 Catalog/Supabase requests');

  console.log('PASS 索菲亞 F 希琳 is preserved as one multi-token Subject span');
  console.log('PASS 露易絲、夏娜、赫蘿 use explicit Product Line title grammar');
  console.log('PASS 瑪修·基利艾拉特 is preserved after the PLAMATEA role delimiter');
  console.log('PASS A / B & C compound chains preserve every member across /, &, ＆, and &amp;');
  console.log('PASS 再版 and 再販 normalize to one release-status semantic');
  console.log('PASS dimensions/versions/forms cannot become v2.1 Subjects');
  console.log('PASS unknown structures return UNRESOLVED_SUBJECT; no last-token fallback');
  console.log('PASS ERP year/month metadata is excluded from Model Code extraction');
  console.log('PASS MX醬 is a distinctive mixed-script Subject; F型 / DX版 / 醬 / creator metadata remain unresolved');
  console.log('PASS Phase 1 CHOUZOUKADOU grammar resolves 空條承太郎 and 白金之星 instead of the JOJO series');
  console.log('PASS Phase 1 Form / Edition / Release Status metadata remain separate');
  console.log('PASS Phase 1 Subject candidates carry evidence and Product Type carries provenance');
  console.log('PASS Parser v2.1 is shadow-only with 0 Catalog/Supabase requests and 0 writes');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
