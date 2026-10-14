// P0-1 (tab switch -> same-account SIGNED_IN rebuilt the whole Cloud sync boundary) and
// P0-2 (Cloud mode showed / wrote back legacy localStorage default costs after a Restore).
// Isolated: Vite fixture + headless Chrome, fake Auth client, in-memory data provider.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.P0_TAB_SYNC_TEST_PORT || '4341';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
const FIXTURE = `${BASE_URL}/tests/fixtures/p0-tab-sync-and-cost-harness.html`;
const V374 = 'a0000000-0000-4000-8000-000000000374';
const V375 = 'a0000000-0000-4000-8000-000000000375';
const V376 = 'a0000000-0000-4000-8000-000000000376';

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--config', 'tests/fixtures/cloud-p0-5-vite.config.mjs',
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const check = async (name, run) => {
  try { await run(); results.push({ name, result: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, result: 'FAIL', error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
};

try {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    if (attempt === 119) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const newPage = async (init = {}) => {
    const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei', viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(seed => {
      if (sessionStorage.getItem('p0tab_seeded') === 'true') return;
      localStorage.clear();
      for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
      sessionStorage.setItem('p0tab_seeded', 'true');
    }, init);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/\.supabase\.co\//iu.test(request.url())) errors.push(`network:${request.url()}`); });
    return { page, errors, close: () => context.close() };
  };
  const snapshot = page => page.evaluate(() => window.__P0TAB__.snapshot());

  // ---------------- P0-1 A: AuthProvider keeps the same-account User reference ----------------
  await check('P0-1 auth: same-account SIGNED_IN/TOKEN_REFRESHED keep the User reference; profile still re-read', async () => {
    const { page, errors, close } = await newPage();
    try {
      await page.goto(`${FIXTURE}?part=auth`);
      await page.waitForFunction(() => window.__P0TAB__?.snapshot().role === 'owner' && window.__P0TAB__.snapshot().loading === false);
      const before = await snapshot(page);
      assert.equal(before.userIdentities, 1, 'initial session yields one User identity');
      // Supabase re-emits SIGNED_IN on every hidden -> visible transition (fresh parsed object).
      for (const event of ['SIGNED_IN', 'SIGNED_IN', 'SIGNED_IN', 'TOKEN_REFRESHED']) {
        await page.evaluate(name => window.__P0TAB__.emit(name, 'A'), event);
        await sleep(80);
      }
      await page.waitForFunction(count => window.__P0TAB__.snapshot().profileReads >= count, before.profileReads + 4);
      const same = await snapshot(page);
      assert.equal(same.userIdentities, 1, `same-account events must not replace the User object (identities=${same.userIdentities})`);
      assert.equal(same.profileLoadingTrue, before.profileLoadingTrue, 'same-account refresh must not flip profileLoading');
      // Permission changes are not ignored: a role change is picked up on the next same-account event.
      await page.evaluate(() => { window.__P0TAB__.setProfileRole('viewer'); window.__P0TAB__.emit('SIGNED_IN', 'A'); });
      await page.waitForFunction(() => window.__P0TAB__.snapshot().role === 'viewer');
      // A real change to the same account still replaces the User.
      await page.evaluate(() => window.__P0TAB__.emit('USER_UPDATED', 'A-email'));
      await page.waitForFunction(() => window.__P0TAB__.snapshot().email === 'p0-tab-a-renamed@staging.invalid');
      // A different account and sign-out are still delivered.
      await page.evaluate(() => window.__P0TAB__.emit('SIGNED_IN', 'B'));
      await page.waitForFunction(() => window.__P0TAB__.snapshot().userIds.at(-1) === '5b000000-0000-4000-8000-0000000000b2');
      await page.evaluate(() => window.__P0TAB__.emit('SIGNED_OUT', null));
      await page.waitForFunction(() => window.__P0TAB__.snapshot().userIds.at(-1) === null);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  // ---------------- P0-1 B: AuthProvider + Cloud sync boundary end to end ----------------
  await check('P0-1 sync: same-account SIGNED_IN after a tab switch keeps one Cloud sync generation; other account / sign-out rebuild', async () => {
    const { page, errors, close } = await newPage();
    try {
      await page.goto(`${FIXTURE}?part=sync`);
      await page.waitForFunction(() => window.__P0TAB__?.snapshot().attaches === 1);
      await sleep(300);
      const start = await snapshot(page);
      assert.equal(start.attaches, 1, `initial sign-in creates one sync generation (attaches=${start.attaches})`);
      // Each hidden -> visible transition: Supabase re-emits SIGNED_IN for the same account.
      for (const event of ['SIGNED_IN', 'SIGNED_IN', 'SIGNED_IN', 'TOKEN_REFRESHED']) {
        await page.evaluate(name => window.__P0TAB__.emit(name, 'A'), event);
        await sleep(150);
      }
      const same = await snapshot(page);
      assert.equal(same.attaches, 1, `same account must keep one sync generation (attaches=${same.attaches}, detaches=${same.detaches})`);
      assert.equal(same.detaches, 0, 'same account must not tear the sync boundary down');
      assert.equal(await page.evaluate(() => window.__P0TAB__.fallback()), true, 'authoritative catch-up still completes');
      await page.evaluate(() => window.__P0TAB__.emit('SIGNED_IN', 'B'));
      await page.waitForFunction(() => window.__P0TAB__.snapshot().attaches === 2 && window.__P0TAB__.snapshot().detaches === 1);
      await page.evaluate(() => window.__P0TAB__.emit('SIGNED_OUT', null));
      await page.waitForFunction(() => window.__P0TAB__.snapshot().detaches === 2 && !window.__P0TAB__.snapshot().attached);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  // ---------------- P0-2: Cloud default cost authority ----------------
  const LEGACY = { variant_default_jpy_costs: JSON.stringify({ [V375]: 3333, [V376]: 3333 }) };
  const priceCell = (page, sku) => page.evaluate(code => {
    const row = [...document.querySelectorAll('tr')].find(tr => tr.textContent.includes(code));
    const cell = row?.querySelectorAll('td')[1];
    const input = cell?.querySelector('input');
    return input ? `input:${input.value}` : cell?.textContent.trim() ?? null;
  }, sku);
  const waitRows = page => page.waitForFunction(() => document.body.textContent.includes('P0-G07592376'));

  await check('P0-2 cloud: NULL DB cost stays unset; legacy localStorage 3333 is neither shown nor written back', async () => {
    const { page, errors, close } = await newPage(LEGACY);
    try {
      await page.goto(`${FIXTURE}?part=cost&mode=cloud&costs=13000,null,null`);
      await waitRows(page);
      await sleep(1500);
      const snap = await snapshot(page);
      assert.equal(snap.calls.saveProductVariants.length, 0, `no automatic Cloud write on load (saveProductVariants calls=${snap.calls.saveProductVariants.length}: ${JSON.stringify(snap.calls.saveProductVariants.map(rows => rows.filter(row => [V375, V376].includes(row.id)).map(row => [row.id.slice(-3), row.default_jpy_cost])))})`);
      assert.equal(snap.calls.patch.length + snap.calls.bulk.length, 0, 'no patch on load');
      assert.deepEqual(snap.server.map(row => row.default_jpy_cost), [13000, null, null], 'server costs unchanged');
      assert.equal(await priceCell(page, 'P0-G07592374'), '¥ 13000');
      assert.equal(await priceCell(page, 'P0-G07592375'), '-', 'NULL cost must show as unset, not the legacy 3333');
      assert.equal(await priceCell(page, 'P0-G07592376'), '-');
      assert.equal(snap.legacyJpy, LEGACY.variant_default_jpy_costs, 'Cloud mode does not rewrite the legacy browser map');
      // F5 / re-open: still no write-back.
      await page.reload();
      await waitRows(page);
      await sleep(1000);
      const again = await snapshot(page);
      assert.equal(again.calls.saveProductVariants.length, 0, 'no write-back after reload');
      assert.equal(await priceCell(page, 'P0-G07592375'), '-');
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  await check('P0-2 cloud: explicit edit, bulk-all and bulk-category still write and read back; Restore value wins after reload', async () => {
    const { page, errors, close } = await newPage({ ...LEGACY, purchase_management_edit_mode: 'true' });
    try {
      await page.goto(`${FIXTURE}?part=cost&mode=cloud&costs=2000,null,null`);
      await waitRows(page);
      await sleep(800);
      assert.equal(await priceCell(page, 'P0-G07592374'), 'input:2000');
      assert.equal(await priceCell(page, 'P0-G07592375'), 'input:', 'NULL cost input is empty in Cloud mode');
      // explicit single edit 2000 -> 1500
      const row374 = page.locator('tr', { hasText: 'P0-G07592374' }).locator('td').nth(1).locator('input');
      await row374.fill('1500');
      await row374.press('Enter');
      await page.waitForFunction(() => window.__P0TAB__.snapshot().calls.patch.length === 1);
      let snap = await snapshot(page);
      assert.deepEqual(snap.calls.patch[0], { id: V374, patch: { default_jpy_cost: 1500 } });
      await page.waitForFunction(() => {
        const row = [...document.querySelectorAll('tr')].find(tr => tr.textContent.includes('P0-G07592374'));
        return row?.querySelectorAll('td')[1]?.querySelector('input')?.value === '1500';
      });
      // bulk: all variants
      await page.getByPlaceholder('輸入金額').fill('4444');
      await page.getByRole('button', { name: '套用單價至全部品項' }).click();
      await page.waitForFunction(() => window.__P0TAB__.snapshot().calls.bulk.length === 1);
      snap = await snapshot(page);
      assert.deepEqual(snap.calls.bulk[0].map(entry => entry.patch), [{ default_jpy_cost: 4444 }, { default_jpy_cost: 4444 }, { default_jpy_cost: 4444 }]);
      // bulk: selected category
      await page.getByPlaceholder('輸入金額').fill('5555');
      const option = await page.locator('#bulk-master-category-select option').nth(1).getAttribute('value');
      await page.locator('#bulk-master-category-select').selectOption(option);
      await page.getByRole('button', { name: '套用單價至選取分類' }).click();
      await page.waitForFunction(() => window.__P0TAB__.snapshot().calls.bulk.length === 2);
      snap = await snapshot(page);
      assert.ok(snap.calls.bulk[1].length >= 1 && snap.calls.bulk[1].every(entry => entry.patch.default_jpy_cost === 5555));
      assert.equal(snap.calls.saveProductVariants.length, 0, 'explicit edits never use the legacy whole-collection write');
      assert.equal(snap.legacyJpy, LEGACY.variant_default_jpy_costs, 'Cloud edits do not write the legacy browser map');
      // Simulated isolated Restore: the fixture server is re-seeded from the URL (2000, NULL, NULL); reload.
      await page.reload();
      await waitRows(page);
      await sleep(1200);
      const after = await snapshot(page);
      assert.equal(await priceCell(page, 'P0-G07592374'), 'input:2000', 'restored 2000 is shown after reload');
      assert.equal(await priceCell(page, 'P0-G07592375'), 'input:', 'restored NULL stays unset after reload');
      assert.equal(after.calls.saveProductVariants.length + after.calls.patch.length + after.calls.bulk.length, 0, 'no write after restore reload');
      assert.deepEqual(after.server.map(row => row.default_jpy_cost), [2000, null, null]);
      assert.deepEqual(after.server.map(row => row.id), [V374, V375, V376], 'variant ids unchanged');
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  await check('P0-2 local mode: legacy browser cost fallback and migration are unchanged', async () => {
    const { page, errors, close } = await newPage(LEGACY);
    try {
      await page.goto(`${FIXTURE}?part=cost&mode=local&costs=13000,null,null`);
      await waitRows(page);
      await page.waitForFunction(() => window.__P0TAB__.snapshot().calls.saveProductVariants.length === 1);
      const snap = await snapshot(page);
      const migrated = Object.fromEntries(snap.calls.saveProductVariants[0].map(row => [row.id, row.default_jpy_cost]));
      assert.equal(migrated[V375], 3333);
      assert.equal(migrated[V376], 3333);
      assert.equal(migrated[V374], 13000);
      await page.waitForFunction(() => {
        const row = [...document.querySelectorAll('tr')].find(tr => tr.textContent.includes('P0-G07592375'));
        return row?.querySelectorAll('td')[1]?.textContent.trim() === '¥ 3333';
      });
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });

  await browser.close();
} finally {
  vite.kill();
}

const failed = results.filter(entry => entry.result !== 'PASS');
console.log(JSON.stringify({ result: failed.length ? 'FAIL' : 'PASS', results }, null, 2));
if (failed.length) process.exit(1);
