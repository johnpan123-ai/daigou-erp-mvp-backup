// Mobile "switch to another app and come back" (ERP2 -> LINE -> ERP2), real ERP2 app in staging mode vs an
// isolated fake Supabase + fake Realtime socket. Synthetic production-sized data, no network, mobile viewport.
// A phone freezes the page and the OS / server drops the WebSocket while another app is in front; this is
// modelled by hiding the page and closing the socket from the server side. Real phones are NOT covered here.
// MOBILE_RESUME_MODE=measure prints the measurements without asserting the fixed behaviour (baseline run).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { FakeSupabase, loadTables, session } from './fixtures/egress-fake-supabase.mjs';

const MEASURE_ONLY = process.env.MOBILE_RESUME_MODE === 'measure';
const LONG = process.env.MOBILE_RESUME_LONG !== '0';
const at = '2026-11-01T00:00:00.000Z';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pad = n => 'x'.repeat(n);
// Production-like volume (~14 MB JSON): 1500 groups, 6800 variants, 6400 inventory rows, 5700 audit rows.
const data = { inventory: [], productGroups: [], productVariants: [], wacaCutoverAudit: [] };
for (let g = 0; g < 1500; g++) {
  data.productGroups.push({ id: id(g + 1), title: `合成現場採購商品 ${g}`, normalized_title: `合成現場採購商品 ${g}`, show_in_purchase_list: g < 400, created_at: at, updated_at: at, version: 1, note: pad(300) });
  for (let v = 0; v < 5 && data.productVariants.length < 6800; v++) {
    const code = `MB${g}-${v}`;
    data.productVariants.push({ id: id(100000 + g * 5 + v), product_group_id: id(g + 1), myacg_item_code: code, product_title: `合成現場採購商品 ${g}`, variant_name: `款 ${v}`, raw_variant_name: `款 ${v}`, source: 'inventory_import', updated_at: at, version: 1, note: pad(700) });
    if (data.inventory.length < 6400) data.inventory.push({ id: id(500000 + g * 5 + v), inventory_key: `mb-${code}`, myacg_item_code: code, product_title: `合成現場採購商品 ${g}`, raw_variant_name: `款 ${v}`, myacg_sold_quantity: 2, import_sort_index: g * 5 + v, updated_at: at, version: 1, note: pad(800) });
  }
}
for (let n = 0; n < 5700; n++) data.wacaCutoverAudit.push({ id: id(900000 + n), created_at: at, updated_at: at, detail: pad(600) });
const backupPath = join(mkdtempSync(join(tmpdir(), 'erp2-mobile-')), 'synthetic-backup.json');
writeFileSync(backupPath, JSON.stringify({ schemaVersion: 'synthetic', data }));

const REF = 'rhfdjsklfrgpoqsaqpkn';
const PORT = Number(process.env.MOBILE_RESUME_PORT || 4476);
const origin = `http://127.0.0.1:${PORT}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--configLoader', 'runner'],
  { env: { ...process.env, VITE_SUPABASE_URL: `https://${REF}.supabase.co`, VITE_SUPABASE_ANON_KEY: 'isolated-test-key-not-a-real-credential', VITE_DEPLOYMENT_ENV: 'staging' }, stdio: ['ignore', 'pipe', 'pipe'] });
let vout = ''; vite.stdout.on('data', c => { vout += c; }); vite.stderr.on('data', c => { vout += c; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fake = new FakeSupabase(loadTables(backupPath));
// MOBILE_RESUME_081=1: the fake server answers as a server with candidate 081 applied; otherwise as PostgREST
// does for a function that does not exist (404 PGRST202).
const WITH_081 = process.env.MOBILE_RESUME_081 === '1';
// Mobile-network model for REST responses: 120 ms round trip + 10 Mbit/s download (gzip size).
const NET = { rttMs: Number(process.env.MOBILE_RESUME_RTT_MS ?? 120), bytesPerMs: 1250 };
const handle = route => {
  if (route.request().method() !== 'OPTIONS' && new URL(route.request().url()).pathname === '/rest/v1/rpc/erp_sync_capabilities') {
    const body = JSON.stringify(WITH_081 ? { inventoryItemsVersionForced: true } : { code: 'PGRST202', message: 'Could not find the function public.erp_sync_capabilities without parameters in the schema cache' });
    fake.record({ kind: 'rpc', table: 'erp_sync_capabilities', method: 'POST', status: WITH_081 ? 200 : 404, raw: body.length, gz: body.length, rows: 0 });
    return route.fulfill({ status: WITH_081 ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
  }
  return fake.handle({
  request: () => route.request(),
    fulfill: async options => { const size = Buffer.byteLength(options.body ?? ''); await sleep(NET.rttMs + Math.round(size / 6 / NET.bytesPerMs)); return route.fulfill(options); },
  });
};
const rest = () => fake.log.filter(e => e.kind === 'rest' || e.kind === 'rpc');
const joins = () => fake.log.filter(e => e.kind === 'realtime-in' && e.path === 'phx_join').length;
const fullReadsOld = () => fake.log.filter(e => e.kind === 'rest' && e.table === 'product_variants' && (e.rows ?? 0) >= 500).length ? Math.max(1, Math.round(fake.log.filter(e => e.kind === 'rest' && e.table === 'product_variants').reduce((s, e) => s + (e.rows ?? 0), 0) / 6800)) : 0;
// passes = how many times product_variants was gone through (rows or keys); completeTables = tables downloaded as complete rows.
const passes = () => Math.round(fake.log.filter(e => e.kind === 'rest' && e.table === 'product_variants').reduce((sum, e) => sum + (e.rows ?? 0), 0) / 6800);
const completeTables = () => [...new Set(fake.log.filter(e => e.kind === 'rest' && (e.rows ?? 0) >= 100 && (e.raw ?? 0) / e.rows > 300).map(e => e.table))].sort().join(',');
const mb = () => +(rest().reduce((s, e) => s + (e.raw ?? 0), 0) / 1e6).toFixed(2);
let browser;
const report = {};
try {
  for (let n = 0; n < 160; n++) { try { if ((await fetch(origin)).ok) break; } catch { /* starting */ } if (vite.exitCode !== null) throw new Error(vout); await sleep(250); }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  await context.addInitScript(([ref, s]) => {
    if (!localStorage.getItem('erp_provider_mode')) localStorage.setItem('erp_provider_mode', 'cloud');
    if (!localStorage.getItem(`sb-${ref}-auth-token`)) localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s));
    window.__recovery = [];
    window.addEventListener('cloud-realtime-recovery-diagnostic', e => window.__recovery.push(e.detail.kind));
    window.__proofs = [];
    window.addEventListener('cloud-realtime-proof-diagnostic', e => { if (e.detail.kind === 'catch-up') window.__proofs.push(`${e.detail.trigger}:${e.detail.proven ? 'proven' : 'unproven'}:rereads${e.detail.rereads}`); });
  }, [REF, session()]);
  await context.route(`https://${REF}.supabase.co/**`, handle);
  await context.route(/^https:\/\/(?!rhfdjsklfrgpoqsaqpkn).*/u, route => route.abort());
  await context.routeWebSocket(/realtime\/v1\/websocket/u, ws => {
    const state = fake.attachSocket(ws);
    // Complete the closing handshake when the page closes its side (as a real server does).
    ws.onClose((code, reason) => { state.open = false; fake.sockets.delete(state); try { ws.close({ code, reason }); } catch { /* already closed */ } });
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const label = () => page.evaluate(() => document.querySelector('.global-sync-status')?.textContent?.trim() ?? '');
  const writeAllowed = () => page.evaluate(async () => {
    const c = await import('/src/providers/cloud/cloudConnectivity.ts');
    try { c.assertCloudWriteAllowed(); return true; } catch { return false; }
  });
  // pageEvents: some mobile browsers also fire pagehide / pageshow on an app switch.
  const setHidden = (hidden, pageEvents = false) => page.evaluate(([h, pe]) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    if (h && pe) window.dispatchEvent(new Event('pagehide'));
    document.dispatchEvent(new Event('visibilitychange'));
    if (!h) { if (pe) window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('focus')); } else window.dispatchEvent(new Event('blur'));
  }, [hidden, pageEvents]);
  const ui = () => page.evaluate(() => ({
    search: document.querySelector('input[placeholder="搜尋商品名稱..."]')?.value ?? null,
    scrollY: Math.round(window.scrollY || document.scrollingElement?.scrollTop || 0),
    fullPageLoading: /載入中|Loading/u.test(document.querySelector('main')?.textContent?.slice(0, 200) ?? '') && !document.querySelector('input[placeholder="搜尋商品名稱..."]'),
    cards: document.querySelectorAll('.summary-card').length,
    draft: [...document.querySelectorAll('input[type="text"]')].filter(e => e.placeholder !== '搜尋商品名稱...').map(e => e.value).join('|') || null,
  }));
  const waitFresh = async (ms = 180000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await writeAllowed()) return Date.now() - t; await sleep(50); } return null; };

  fake.reset(); const tOpen = Date.now();
  await page.goto(origin + '/purchasing', { waitUntil: 'domcontentloaded' });
  const openMs = await waitFresh(240000); await sleep(4000);
  report.open = { toWritableMs: openMs, joins: joins(), rest: rest().length, MB: mb(), label: await label(), wall: Date.now() - tOpen };
  assert.ok(openMs !== null, 'opened and synced');

  // The helper is working: a search is typed and the list is scrolled.
  const search = page.locator('input[placeholder="搜尋商品名稱..."]');
  await search.fill('商品 12'); await sleep(500);
  await page.evaluate(() => window.scrollTo(0, 600)); await sleep(300);

  // One app switch: hidden for `hiddenMs`; `drop` = the OS/server closed the WebSocket meanwhile; `change` = another
  // user changed a row meanwhile (must be visible after the return).
  const appSwitch = async (name, hiddenMs, { drop = true, change = null, pageEvents = false } = {}) => {
    fake.reset(); await page.evaluate(() => { window.__recovery.length = 0; window.__proofs.length = 0; });
    const before = await ui();
    await setHidden(true, pageEvents);
    if (drop) { await sleep(Math.min(2000, hiddenMs / 2)); fake.dropAllSockets(); }
    if (change) change();
    await sleep(Math.max(0, hiddenMs - (drop ? Math.min(2000, hiddenMs / 2) : 0)));
    const hiddenRest = rest().length; const hiddenJoins = joins(); const hiddenRt = fake.log.filter(e => e.kind.startsWith('realtime')).map(e => e.kind.slice(9) + ':' + e.path).join(','); const hiddenSockets = fake.sockets.size;
    fake.reset(); const t0 = Date.now();
    await setHidden(false, pageEvents);
    const samples = []; const tEnd = Date.now() + 400;
    while (Date.now() < tEnd) { samples.push(await ui()); await sleep(60); }
    const writableAtReturn = await writeAllowed();
    const toWritableMs = await waitFresh(); const settledLabelAt = Date.now() - t0;
    await sleep(6000);
    const after = await ui();
    const r = {
      hiddenMs, drop, whileHidden: { rest: hiddenRest, joins: hiddenJoins, sockets: hiddenSockets, ...(process.env.MOBILE_RESUME_DEBUG ? { rt: hiddenRt, rtAfter: fake.log.filter(e => e.kind.startsWith('realtime')).map(e => e.kind.slice(9) + ':' + e.path).join(','), by: Object.fromEntries(Object.entries(fake.summary('x').by).map(([k, v]) => [k.replace('rest:', ''), `${v.n}/${Math.round(v.raw / 1024)}KB/${v.rows}r`])) } : {}) }, writableAtReturn, toWritableMs, settledLabelAt,
      joins: joins(), passes: passes(), completeTables: completeTables(), rest: rest().length, MB: mb(), sockets: fake.sockets.size, label: await label(),
      searchKept: after.search === before.search, scrollKept: Math.abs(after.scrollY - before.scrollY) <= 2,
      fullPageLoadingSeen: samples.some(s => s.fullPageLoading) || after.fullPageLoading,
      draftKept: after.draft === before.draft, proofs: await page.evaluate(() => [...window.__proofs]),
      recovery: (await page.evaluate(() => [...window.__recovery])).filter(k => k !== 'recovery-view'),
    };
    report[name] = r; console.log(name, JSON.stringify(r));
    return r;
  };

  console.log('open', JSON.stringify(report.open));
  const DEBUG = Boolean(process.env.MOBILE_RESUME_DEBUG);
  if (!DEBUG) await appSwitch('s1_line10s_socketAlive', 10000, { drop: false });
  await appSwitch('s1_line10s_socketDropped', 10000);
  await appSwitch('s1_line10s_pagehide', 10000, { drop: false, pageEvents: true });
  if (!DEBUG) await appSwitch('s2_line60s_socketDropped', 60000);

  // 6 an unsaved purchase batch (name + quantity typed, not saved) while switching apps.
  await page.locator('.summary-card').first().click(); await sleep(800);
  await page.getByRole('button', { name: '新增採購批次' }).first().click(); await sleep(800);
  const draftInputs = page.locator('input[type="text"]');
  await draftInputs.nth(0).fill('合成現場草稿批次'); await draftInputs.nth(1).fill('7'); await sleep(300);
  const draft = await appSwitch('s6_unsavedDraft', 15000);
  assert.match((await ui()).draft ?? '', /合成現場草稿批次\|7/u, 'unsaved batch name and quantity are still on screen');
  assert.equal(draft.draftKept, true);
  await page.getByRole('button', { name: '取消' }).first().click(); await sleep(400);
  await page.getByRole('button', { name: '返回清單' }).first().click(); await sleep(800);
  await search.fill('商品 12'); await sleep(400);

  // 5 Wi-Fi -> mobile data: browser offline/online events + socket drop, page stays visible.
  fake.reset(); const t5 = Date.now(); await page.evaluate(() => { window.__recovery.length = 0; window.__proofs.length = 0; window.__rc = []; window.addEventListener('cloud-reconnect-diagnostic', e => window.__rc.push(`${e.detail.event}:${e.detail.trigger}:g${e.detail.generation}a${e.detail.attempt}`)); });
  await context.setOffline(true); fake.dropAllSockets(); await sleep(3000); await context.setOffline(false);
  await sleep(500); const t5w = await waitFresh(); await sleep(6000);
  report.s5_networkSwitch = { toWritableMs: t5w === null ? null : Date.now() - t5 - 6000, joins: joins(), passes: passes(), completeTables: completeTables(), rest: rest().length, MB: mb(), sockets: fake.sockets.size, proofs: await page.evaluate(() => [...window.__proofs]), recovery: (await page.evaluate(() => [...window.__recovery])).filter(k => k !== 'recovery-view'), reconnect: await page.evaluate(() => window.__rc) };
  console.log('s5_networkSwitch', JSON.stringify(report.s5_networkSwitch));
  if (DEBUG) throw new Error('debug stop');

  if (DEBUG) { /* straight to the network switch */ } else {
  // 4 ten consecutive switches (3 s away each, socket dropped each time).
  fake.reset(); const t4 = Date.now(); let maxJoinsAtOnce = 0;
  for (let i = 0; i < 10; i++) { await setHidden(true); await sleep(1500); fake.dropAllSockets(); await sleep(1500); await setHidden(false); await sleep(2500); maxJoinsAtOnce = Math.max(maxJoinsAtOnce, fake.sockets.size); }
  const t4w = await waitFresh(); await sleep(6000);
  report.s4_tenSwitches = { toWritableMsAfterLast: t4w, joins: joins(), passes: passes(), completeTables: completeTables(), rest: rest().length, MB: mb(), sockets: fake.sockets.size, maxSockets: maxJoinsAtOnce, wallMs: Date.now() - t4, ...(await ui()) };
  console.log('s4_tenSwitches', JSON.stringify(report.s4_tenSwitches));
  }

  // 7 another user changed a product while the phone was in LINE: the change must be on screen after the return.
  await search.fill('商品 77'); await sleep(600);
  const changedTitle = '合成現場採購商品 77（他人已改名）';
  const changed = await appSwitch('s7_changedWhileAway', 20000, { change: () => {
    const row = fake.tables.product_groups.find(g => g.id === id(78));
    row.title = changedTitle; row.normalized_title = changedTitle; row.version = 2; row.updated_at = new Date().toISOString();
  } });
  report.s7_changedWhileAway.changeVisible = await page.evaluate(t => document.body.textContent.includes(t), '他人已改名');
  assert.equal(report.s7_changedWhileAway.changeVisible, true, 'a change made while away is shown after the return');
  assert.equal(changed.writableAtReturn, false, 'writes stay blocked until the return is proven');
  await search.fill('商品 12'); await sleep(400);

  // 3 long switch (6 min, beyond the 5 min background pause).
  if (LONG) await appSwitch('s3_line6min', 6 * 60_000 + 5000);
  report.cache = await page.evaluate(async () => (await import('/src/providers/cloud/cloudTargetedCache.ts')).getKeyVersionVerificationMetrics?.() ?? null);

  if (!MEASURE_ONLY) {
    const perPassMB = WITH_081 ? 2 : 9;   // keys only (~1.4 MB) / keys + complete inventory_items (~7.6 MB); complete read = 14.75 MB
    for (const name of ['s1_line10s_socketDropped', 's1_line10s_pagehide', 's2_line60s_socketDropped', 's6_unsavedDraft', 's7_changedWhileAway', ...(LONG ? ['s3_line6min'] : [])]) {
      const r = report[name];
      assert.equal(r.writableAtReturn, false, `${name}: writes blocked until the return is proven`);
      assert.ok(r.toWritableMs !== null, `${name}: writable again`);
      assert.equal(r.searchKept && r.scrollKept && r.draftKept, true, `${name}: search, scroll and draft kept`);
      assert.equal(r.fullPageLoadingSeen, false, `${name}: no full-page loading`);
      assert.ok(r.joins <= 1 && r.whileHidden.joins <= 1 && r.sockets === 1, `${name}: one live subscription, no duplicate join`);
      assert.ok(r.passes === 1 && r.MB <= perPassMB, `${name}: one verification pass, ${r.MB} MB <= ${perPassMB}`);
      assert.equal(r.completeTables, WITH_081 ? '' : 'inventory_items', `${name}: complete rows only where the server does not force the version`);
    }
    const alive = report.s1_line10s_socketAlive;
    assert.ok(alive.passes === 0 && alive.joins === 0 && alive.writableAtReturn === true && alive.MB < 0.1, 'socket alive: nothing re-read, writable immediately');
    const ten = report.s4_tenSwitches;
    assert.ok(ten.toWritableMsAfterLast !== null, 'ten switches: not left blocked by the read budget');
    // Without 081 each pass still downloads inventory_items and is charged to the hourly egress budget, so fewer
    // than ten passes may run; the page must nevertheless become writable again without waiting for that window.
    assert.ok(ten.passes <= 10 && ten.MB <= 10 * perPassMB && ten.sockets === 1 && ten.maxSockets <= 1 && ten.joins <= 10, 'ten switches: at most one pass and one subscription per switch');
    assert.equal(ten.search, '商品 12', 'ten switches: search kept');
    const net = report.s5_networkSwitch;
    assert.ok(net.toWritableMs !== null && net.passes <= 2 && net.MB <= 2 * perPassMB && net.sockets === 1, 'network switch: recovers with verification passes only');
  }
  assert.deepEqual(errors, []);
  console.log('REPORT ' + JSON.stringify(report));
  console.log(MEASURE_ONLY ? 'MEASURED mobile app switch' : `PASS mobile app switch (${WITH_081 ? 'server with 081' : 'current server'}): one subscription and one verification pass per return, UI state kept, writes blocked until proven`);
} finally { if (browser) await browser.close(); vite.kill('SIGTERM'); }
