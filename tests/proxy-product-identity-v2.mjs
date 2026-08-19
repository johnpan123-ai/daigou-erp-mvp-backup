import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4262;
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
  const apiRequests = [];
  page.on('request', request => {
    if (/\/api\/|\.supabase\.co\//i.test(request.url())) apiRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async () => {
    const v1 = await import('/src/lib/proxyProductIdentity.ts');
    const v2 = await import('/src/lib/proxyProductIdentityV2.ts');
    const cases = {
      kdcolleHolo: '代理版 角川 KDcolle 狼與辛香料 原作版 赫蘿 無比例模型',
      kadokawaHoloRegular: '代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 一般版',
      kadokawaHoloDx: '代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 DX Ver.',
      kdcolleShana: '代理版 角川 KDcolle 灼眼的夏娜 夏娜 原作版 無比例 全高約15公分',
      plamateaMashBlack: '代理版 PLAMATEA FGO Shielder/瑪修 [奧特瑙斯] 黑槍版',
      plamateaMash: '代理版 PLAMATEA FGO Shielder/瑪修 [奧特瑙斯]',
      jojoStarPlatinum: '代理版 超像可動 JOJO 星塵遠征軍 「白金之星」3rd',
      jojoJotaro: '代理版 超像可動 JOJO 星塵遠征軍 空條承太郎 Ver. 2',
      nendoroidMutsuki: '代理版 GSC 黏土人 3121 BanG Dream! 夢限大MewType 峰月律',
      apexYixuan: '代理版 APEX 1/7 絕區零 儀玄 獨步滄溟Ver 附特典',
      apexCandidate: '1/7 PVC 絕區零 儀玄·獨步滄溟 Ver.',
      smpRhino: '萬代 盒玩 SMP 百獸戰隊 牙吠連者 牙吠力士 牙吠犀牛&amp;牙吠犰狳（再販）',
      smpPeacock: '魂商店 萬代 SMP 牙吠孔雀王 & 牙吠眼鏡蛇王',
      smpTurtle: '魂商店 萬代 SMP 牙吠海龜王 ＆ 牙吠海象王',
      smpGroundTruthSource: '萬代 盒玩 SMP 百獸戰隊 牙吠連者 巨大化 牙吠獅 & 牙吠象',
      smpGroundTruthCatalog: 'SMP 百獸戰隊牙吠連者 威力獸 EXTRA 牙吠海龜＆牙吠海象',
      hmsRedHood: '代理版 26年第四季 和模線 勝利女神：妮姬 小紅帽 1/12 組裝模型',
      shfDeku: '代理版 萬代 S.H.Figuarts 我的英雄學院 黑化 綠谷出久 暗黑笨久',
      numericNoise: '代理版 GSC 黏土人 崩壞 星穹鐵道 流螢 0907 2026',
    };

    return Object.fromEntries(Object.entries(cases).map(([key, title]) => [key, {
      title,
      v1: v1.normalizeProxyProductIdentity(title),
      v2: v2.parseProxyProductIdentityV2(title),
    }]));
  });

  const includes = (values, expected, message) => assert.ok(values.includes(expected), message ?? `${expected} not found in ${JSON.stringify(values)}`);
  const excludes = (values, forbidden, message) => assert.ok(!values.includes(forbidden), message ?? `${forbidden} must not be a subject`);

  includes(result.kdcolleHolo.v2.productLines, 'KDCOLLE');
  includes(result.kdcolleHolo.v2.productTypes, 'UNSCALED_FIGURE');
  includes(result.kdcolleHolo.v2.subjects, '赫蘿');
  includes(result.kdcolleHolo.v2.versions, '原作版');
  excludes(result.kdcolleHolo.v2.subjects, '無比例模型');

  includes(result.kadokawaHoloRegular.v2.productLines, 'KADOKAWA_PLASTIC_MODEL_SERIES');
  includes(result.kadokawaHoloRegular.v2.productTypes, 'MODEL_KIT');
  includes(result.kadokawaHoloRegular.v2.subjects, '赫蘿');
  includes(result.kadokawaHoloRegular.v2.versions, '一般版');
  excludes(result.kadokawaHoloRegular.v2.subjects, '一般版');

  includes(result.kadokawaHoloDx.v2.subjects, '赫蘿');
  assert.ok(result.kadokawaHoloDx.v2.versions.some(value => /DX/iu.test(value)));
  includes(result.kdcolleShana.v2.subjects, '夏娜');
  assert.ok(result.kdcolleShana.v2.dimensions.some(value => value.includes('15公分')));
  excludes(result.kdcolleShana.v2.subjects, '全高約15公分');

  includes(result.plamateaMashBlack.v2.productLines, 'PLAMATEA');
  includes(result.plamateaMashBlack.v2.subjects, '瑪修');
  includes(result.plamateaMashBlack.v2.forms, '奧特瑙斯');
  includes(result.plamateaMashBlack.v2.versions, '黑槍版');
  excludes(result.plamateaMashBlack.v2.subjects, '黑槍版');
  includes(result.plamateaMash.v2.subjects, '瑪修');
  includes(result.plamateaMash.v2.forms, '奧特瑙斯');

  includes(result.jojoStarPlatinum.v2.productLines, 'CHOUZOUKADOU');
  includes(result.jojoStarPlatinum.v2.subjects, '白金之星');
  includes(result.jojoStarPlatinum.v2.versions, '3rd');
  includes(result.jojoJotaro.v2.subjects, '空條承太郎');
  assert.ok(result.jojoJotaro.v2.versions.some(value => /Ver\.\s*2/iu.test(value)));
  assert.ok(!result.jojoJotaro.v2.series.includes('2'));
  includes(result.nendoroidMutsuki.v2.productTypes, 'NENDOROID');
  includes(result.nendoroidMutsuki.v2.subjects, '峰月律');
  includes(result.nendoroidMutsuki.v2.modelCodes, '3121');

  includes(result.apexYixuan.v2.manufacturers, 'APEX');
  includes(result.apexYixuan.v2.scales, '1/7');
  includes(result.apexYixuan.v2.subjects, '儀玄');
  assert.ok(result.apexYixuan.v2.versions.some(value => value.includes('獨步滄溟')));
  includes(result.apexYixuan.v2.qualifiers, '附特典');
  includes(result.apexCandidate.v2.subjects, '儀玄');
  assert.ok(result.apexCandidate.v2.versions.some(value => value.includes('獨步滄溟')));

  for (const key of ['smpRhino', 'smpPeacock', 'smpTurtle', 'smpGroundTruthSource', 'smpGroundTruthCatalog']) {
    assert.equal(result[key].v2.compoundSubjects.length, 1, `${key} must preserve one compound product set`);
    assert.equal(result[key].v2.compoundSubjects[0].members.length, 2, `${key} must preserve both members`);
  }
  assert.deepEqual(result.smpPeacock.v2.compoundSubjects[0].members, ['牙吠孔雀王', '牙吠眼鏡蛇王']);
  assert.deepEqual(result.smpTurtle.v2.compoundSubjects[0].members, ['牙吠海龜王', '牙吠海象王']);
  assert.notDeepEqual(
    result.smpGroundTruthSource.v2.compoundSubjects[0].members,
    result.smpGroundTruthCatalog.v2.compoundSubjects[0].members,
    'Parser foundation must not invent the manually confirmed product-set alias',
  );

  includes(result.hmsRedHood.v2.scales, '1/12');
  includes(result.hmsRedHood.v2.productTypes, 'MODEL_KIT');
  assert.ok(!result.hmsRedHood.v2.productTypes.includes('SCALE_FIGURE'), 'Scale alone must not infer SCALE_FIGURE');
  includes(result.hmsRedHood.v2.subjects, '小紅帽');

  includes(result.shfDeku.v2.productLines, 'SHF');
  includes(result.shfDeku.v2.forms, '黑化');
  includes(result.shfDeku.v2.subjects, '綠谷出久');
  includes(result.shfDeku.v2.subjects, '暗黑笨久');
  includes(result.numericNoise.v2.businessMetadata, '0907');
  includes(result.numericNoise.v2.businessMetadata, '2026');

  const forbiddenSubjects = ['0907', '2026', 'PVC', '附特典', '再版', '再販', '無比例模型', '一般版', '全高約15公分', '1/6', '1/7', '1/12'];
  for (const entry of Object.values(result)) {
    for (const token of forbiddenSubjects) excludes(entry.v2.subjects, token);
  }
  assert.deepEqual(apiRequests, [], 'Offline parser evaluation must perform 0 API/Supabase requests');

  console.table(Object.entries(result).map(([caseName, value]) => ({
    case: caseName,
    v1Identity: value.v1.identityTokens.join(' + ') || '(none)',
    v2Subjects: value.v2.subjects.join(' + ') || '(none)',
    v2Version: value.v2.versions.join(' + ') || '(none)',
    v2Type: value.v2.productTypes.join(' + ') || '(unknown)',
    v2Line: value.v2.productLines.join(' + ') || '(unknown)',
  })));
  console.log('PASS semantic attributes cannot replace product subjects');
  console.log('PASS compound product sets preserve both members and separators');
  console.log('PASS scale metadata does not imply SCALE_FIGURE');
  console.log('PASS v1 vs v2 evaluation is offline and Production/Sandbox DB writes = 0');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
