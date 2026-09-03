import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4294';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4294', '--strictPort',
], { cwd: ROOT_PATH, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
const page = await context.newPage();
const supabaseRequests = [];
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url());
});

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const actions = await import('/src/lib/outboundGroupMyacgShortcut.ts');
    const names = [
      '一般商品名稱',
      '套組：Hololive English Mococo 誕生日記念2026',
      '很長很長的商品名稱 '.repeat(20).trim(),
    ];
    const cases = [];
    for (const name of names) {
      const calls = [];
      let resolveClipboard;
      const pendingClipboard = new Promise(resolve => { resolveClipboard = resolve; });
      const shortcutPromise = actions.copyOutboundGroupNameAndOpenMyacg(
        name,
        (...args) => calls.push(['open', ...args]),
        async text => {
          calls.push(['clipboard', text]);
          await pendingClipboard;
        },
      );
      const beforeClipboardSettles = [...calls];
      resolveClipboard();
      await shortcutPromise;
      cases.push({ name, calls, beforeClipboardSettles });
    }

    const failureCases = [];
    for (const failSynchronously of [false, true]) {
      const calls = [];
      let rejected = false;
      try {
        await actions.copyOutboundGroupNameAndOpenMyacg(
          names[0],
          (...args) => calls.push(['open', ...args]),
          text => {
            calls.push(['clipboard', text]);
            if (failSynchronously) throw new Error('clipboard unavailable');
            return Promise.reject(new Error('clipboard denied'));
          },
        );
      } catch {
        rejected = true;
      }
      failureCases.push({ calls, rejected });
    }
    return { url: actions.MYACG_MEMBER_CENTER_URL, cases, failureCases };
  });

  assert.equal(result.url, 'https://www.myacg.com.tw/member_center_v2.php?e_id=1&list_type=3');
  for (const testCase of result.cases) {
    assert.deepEqual(testCase.beforeClipboardSettles, [
      ['clipboard', testCase.name],
      ['open', result.url, '_blank', 'noopener,noreferrer'],
    ]);
    assert.deepEqual(testCase.calls, testCase.beforeClipboardSettles);
  }
  for (const failureCase of result.failureCases) {
    assert.equal(failureCase.rejected, true);
    assert.deepEqual(failureCase.calls[1], ['open', result.url, '_blank', 'noopener,noreferrer']);
  }

  const source = await readFile(new URL('../src/pages/OutboundShipmentDetail.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('void copyGroupName(groupName)'), 'Existing copy handler must remain unchanged');
  assert.ok(source.includes("? '已複製' : '複製名稱'"), 'Existing copy label must remain unchanged');
  assert.ok(source.includes('openMyacgForGroup(groupName)'), 'Both buttons must receive the same groupName source');
  assert.ok(source.includes('title="複製名稱並開啟買動漫"'));
  assert.ok(source.includes('title={groupName}'), 'Long names must retain their existing full-name tooltip');
  assert.deepEqual(supabaseRequests, [], 'Regression must perform no Supabase requests or ERP writes');

  console.log('PASS existing copy behavior and label remain unchanged');
  console.log('PASS normal, bundle, and long names are copied verbatim and open MyACG synchronously');
  console.log('PASS Clipboard failures still open MyACG without crashing ERP');
  console.log('PASS 0 Supabase requests and 0 ERP data writes');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
