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
      unresolved: '代理版 未知品牌 奇幻作品 神秘角色 藍色外套',
      semanticOnly: '代理版 無比例模型 一般版 約23公分 附特典',
    };
    return Object.fromEntries(Object.entries(titles).map(([key, title]) => [key, {
      legacy: parser.parseProxyProductIdentityV2(title),
      v21: parser.parseProxyProductIdentityV21(title),
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

  assert.deepEqual(result.unresolved.v21.subjects, [], 'Unknown structure must not promote the last token to Subject');
  assert.equal(result.unresolved.v21.subjectResolution, 'UNRESOLVED_SUBJECT');
  assert.ok(result.unresolved.v21.unresolvedSubjectTokens.includes('藍色外套'));
  assert.deepEqual(result.semanticOnly.v21.subjects, []);
  assert.equal(result.semanticOnly.v21.subjectResolution, 'UNRESOLVED_SUBJECT');
  assert.ok(result.semanticOnly.v21.dimensions.includes('約23公分'));
  assert.ok(!result.semanticOnly.v21.unresolvedSubjectTokens.includes('約'));

  assert.deepEqual(forbiddenRequests, [], 'Parser v2.1 regression must issue 0 Catalog/Supabase requests');

  console.log('PASS 索菲亞 F 希琳 is preserved as one multi-token Subject span');
  console.log('PASS 露易絲、夏娜、赫蘿 use explicit Product Line title grammar');
  console.log('PASS 瑪修·基利艾拉特 is preserved after the PLAMATEA role delimiter');
  console.log('PASS dimensions/versions/forms cannot become v2.1 Subjects');
  console.log('PASS unknown structures return UNRESOLVED_SUBJECT; no last-token fallback');
  console.log('PASS Parser v2.1 is shadow-only with 0 Catalog/Supabase requests and 0 writes');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
