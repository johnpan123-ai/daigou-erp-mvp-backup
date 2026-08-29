import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4194';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4194', '--strictPort',
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
    const actions = await import('/src/lib/outboundGroupQuickActions.ts');
    const name = 'Hololive English Mococo 誕生日記念2026';
    const copyOnlyCalls = [];
    await actions.copyOutboundGroupNameToClipboard(name, async text => {
      copyOnlyCalls.push(['clipboard', text]);
    });

    const shortcutCalls = [];
    let resolveClipboard;
    const pendingClipboard = new Promise(resolve => { resolveClipboard = resolve; });
    const shortcutPromise = actions.copyOutboundGroupNameAndOpenMyacg(
      name,
      (...args) => shortcutCalls.push(['open', ...args]),
      async text => {
        shortcutCalls.push(['clipboard', text]);
        await pendingClipboard;
      },
    );
    const beforeClipboardSettles = [...shortcutCalls];
    resolveClipboard();
    await shortcutPromise;

    const failedClipboardCalls = [];
    let clipboardFailed = false;
    try {
      await actions.copyOutboundGroupNameAndOpenMyacg(
        name,
        (...args) => failedClipboardCalls.push(['open', ...args]),
        async text => {
          failedClipboardCalls.push(['clipboard', text]);
          throw new Error('clipboard denied');
        },
      );
    } catch {
      clipboardFailed = true;
    }

    return {
      url: actions.MYACG_MEMBER_CENTER_URL,
      copyOnlyCalls,
      shortcutCalls,
      beforeClipboardSettles,
      failedClipboardCalls,
      clipboardFailed,
    };
  });

  const expectedName = 'Hololive English Mococo 誕生日記念2026';
  assert.deepEqual(result.copyOnlyCalls, [['clipboard', expectedName]], 'Copy-only must use the unchanged group name and open no page');
  assert.deepEqual(result.beforeClipboardSettles, [
    ['clipboard', expectedName],
    ['open', 'https://www.myacg.com.tw/member_center_v2.php', '_blank', 'noopener,noreferrer'],
  ], 'Clipboard must start while ERP is focused and the new tab must still open before Clipboard settles');
  assert.deepEqual(result.shortcutCalls[0], ['clipboard', expectedName], 'Both actions must copy the identical name');
  assert.equal(result.clipboardFailed, true);
  assert.deepEqual(result.failedClipboardCalls[1], [
    'open', 'https://www.myacg.com.tw/member_center_v2.php', '_blank', 'noopener,noreferrer',
  ], 'Clipboard failure must not prevent opening MyACG');
  console.log('PASS copy-only preserves the exact existing group name and opens no page');
  console.log('PASS MyACG shortcut opens synchronously and copies the identical name');
  console.log('PASS Clipboard failure does not prevent the MyACG page from opening');

  const source = await readFile(new URL('../src/pages/OutboundShipmentDetail.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes("? '已複製' : '複製'"), 'Visible copy label must be shortened to 複製');
  assert.equal(source.includes("? '已複製' : '複製名稱'"), false, 'Old long copy label must not return');
  assert.ok(source.includes('title="複製名稱並開啟買動漫"'), 'Icon shortcut needs its explanatory tooltip');
  assert.ok(source.includes('openMyacgForGroup(groupName)'), 'Shortcut and copy-only must receive the same groupName source');
  assert.ok(source.includes('data-testid="outbound-group-title"'), 'Product name must occupy its own first row');
  assert.ok(source.includes('data-testid="outbound-group-meta"'), 'Channel quantities and actions must share the second row');
  assert.ok(source.includes("minWidth: isMobile ? 44 : undefined"), 'Mobile copy target must be at least 44px without changing desktop sizing');
  assert.ok(source.includes("width: isMobile ? 44 : 28"), 'Mobile MyACG target must be 44px while desktop remains 28px');
  assert.ok(source.includes("gap: isMobile ? 8 : 4"), 'Mobile actions need additional separation without changing desktop spacing');
  assert.ok(source.includes("flexWrap: isMobile ? 'wrap' : 'nowrap'"), 'Mobile meta/actions row must be allowed to wrap');
  assert.ok(source.includes('title={groupName}'), 'Truncated product names must retain their full-name tooltip');
  assert.deepEqual(supabaseRequests, []);
  console.log('PASS compact labels, shared name source, tooltip, and ellipsis protection are wired');
  console.log('PASS regression performs 0 Supabase requests and 0 data writes');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
