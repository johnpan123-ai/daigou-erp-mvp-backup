import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4268;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const vite = spawn(process.execPath, [VITE, '--mode', 'next', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });

const waitForVite = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {
      // Starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${output}`);
};

let browser;
try {
  await waitForVite();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const requests = [];
  page.on('request', request => {
    if (/\/api\/|\.supabase\.co\//iu.test(request.url())) requests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const planner = await import('/src/lib/proxyProductIdentityQueryV2.ts');
    const cases = {
      kdcolleHolo: '代理版 角川 KDcolle 狼與辛香料 原作版 赫蘿 無比例模型',
      kdcolleShana: '代理版 角川 KDcolle 灼眼的夏娜 夏娜 原作版 無比例 全高約15公分',
      kadokawaHoloDx: '代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 DX Ver.',
      apexYixuan: '代理版 APEX 1/7 絕區零 儀玄 獨步滄溟Ver 附特典',
      starPlatinum: '代理版 超像可動 JOJO的奇妙冒險第三部 星塵遠征軍 白金之星',
      jotaro: '代理版 超像可動 JOJO 星塵遠征軍 空條承太郎 Ver. 2',
      compound: '魂商店 萬代 SMP 牙吠孔雀王 & 牙吠眼鏡蛇王',
    };
    return {
      max: planner.MAX_PROXY_CATALOG_V2_QUERIES,
      plans: Object.fromEntries(Object.entries(cases).map(([key, value]) => [key, planner.buildProxyCatalogQueriesV2(value)])),
    };
  });

  assert.equal(result.max, 5);
  for (const [name, queries] of Object.entries(result.plans)) {
    assert.ok(queries.length > 0 && queries.length <= 5, `${name}: bounded progressive plan required`);
    assert.equal(new Set(queries).size, queries.length, `${name}: queries must be deduplicated`);
  }
  assert.equal(result.plans.kdcolleHolo.at(-1), '赫蘿');
  assert.equal(result.plans.kdcolleShana.at(-1), '夏娜');
  assert.equal(result.plans.kadokawaHoloDx.at(-1), '赫蘿');
  assert.equal(result.plans.apexYixuan.at(-1), '儀玄');
  assert.equal(result.plans.starPlatinum.at(-1), '白金之星');
  assert.equal(result.plans.jotaro.at(-1), '空條承太郎');
  assert.equal(result.plans.compound.at(-1), '牙吠孔雀王 牙吠眼鏡蛇王');
  assert.ok(result.plans.kdcolleHolo.some(query => /KDcolle 赫蘿/iu.test(query)));
  assert.ok(result.plans.kadokawaHoloDx.some(query => /KADOKAWA PLASTIC MODEL SERIES 赫蘿/iu.test(query)));
  assert.ok(result.plans.jotaro.some(query => /空條承太郎 Ver\.?\s*2/iu.test(query)));
  assert.deepEqual(requests, [], 'Pure v2 Query Planner must issue 0 Catalog/Supabase requests');

  console.log('PASS v2 Query Planner uses structured metadata and subject fallback');
  console.log('PASS plans are progressive, deduplicated, and bounded to 5 requests');
  console.log('PASS compound subject query preserves every member');
  console.log('PASS Planner is pure; Catalog/Supabase requests = 0');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
