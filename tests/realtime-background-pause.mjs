// Background-tab Realtime pause (real ERP2 app in staging mode vs. an isolated fake Supabase + fake
// Realtime socket; synthetic data, no network). Real timers (no test switches in product code):
//  - hidden < 5 min: same single subscription, no new joins / reads;
//  - hidden > 5 min: channel removed (socket closed), no reconnect attempts, no counter, no reads,
//    shown as "背景暫停中，切回後同步", writes blocked (Fresh withheld);
//  - visible: exactly one new join, one proving catch-up read, "正在重新連線…" then "已同步", writes allowed;
//  - 10 quick hidden/visible toggles: no extra joins / reads; real Realtime failure still warns.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { FakeSupabase, loadTables, session } from './fixtures/egress-fake-supabase.mjs';

const at = '2026-11-01T00:00:00.000Z';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const data = { inventory: [], productGroups: [], productVariants: [] };
for (let g = 0; g < 40; g++) {
  data.productGroups.push({ id: id(g + 1), title: `合成背景測試商品 ${g}`, normalized_title: `合成背景測試商品 ${g}`, show_in_purchase_list: false, created_at: at, updated_at: at, version: 1 });
  for (let v = 0; v < 2; v++) {
    const code = `BG${g}-${v}`;
    data.productVariants.push({ id: id(1000 + g * 2 + v), product_group_id: id(g + 1), myacg_item_code: code, product_title: `合成背景測試商品 ${g}`, variant_name: `款 ${v}`, raw_variant_name: `款 ${v}`, source: 'inventory_import', updated_at: at, version: 1 });
    data.inventory.push({ id: id(5000 + g * 2 + v), inventory_key: `bg-${code}`, myacg_item_code: code, product_title: `合成背景測試商品 ${g}`, raw_variant_name: `款 ${v}`, myacg_sold_quantity: 1, import_sort_index: g * 2 + v, updated_at: at, version: 1 });
  }
}
const backupPath = join(mkdtempSync(join(tmpdir(), 'erp2-bg-')), 'synthetic-backup.json');
writeFileSync(backupPath, JSON.stringify({ schemaVersion: 'synthetic', data }));

const REF = 'rhfdjsklfrgpoqsaqpkn';
const PORT = Number(process.env.REALTIME_BG_PORT || 4473);
const origin = `http://127.0.0.1:${PORT}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--configLoader', 'runner'],
  { env: { ...process.env, VITE_SUPABASE_URL: `https://${REF}.supabase.co`, VITE_SUPABASE_ANON_KEY: 'isolated-test-key-not-a-real-credential', VITE_DEPLOYMENT_ENV: 'staging' }, stdio: ['ignore', 'pipe', 'pipe'] });
let vout = ''; vite.stdout.on('data', c => { vout += c; }); vite.stderr.on('data', c => { vout += c; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fake = new FakeSupabase(loadTables(backupPath));
const count = (kind, path) => fake.log.filter(e => e.kind === kind && (!path || e.path === path)).length;
const fullReads = () => fake.log.filter(e => e.kind === 'rest' && e.table === 'product_groups').length;
const restCount = () => count('rest');
const joins = () => count('realtime-in', 'phx_join');
const heartbeats = () => count('realtime-in', 'heartbeat');
const restKB = () => Math.round(fake.log.reduce((s, e) => s + (e.kind === 'rest' ? (e.raw ?? 0) : 0), 0) / 1024);
let browser;
const report = {};
try {
  for (let n = 0; n < 160; n++) { try { if ((await fetch(origin)).ok) break; } catch { /* starting */ } if (vite.exitCode !== null) throw new Error(vout); await sleep(250); }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript(([ref, s]) => {
    if (!localStorage.getItem('erp_provider_mode')) localStorage.setItem('erp_provider_mode', 'cloud');
    if (!localStorage.getItem(`sb-${ref}-auth-token`)) localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s));
    window.__recovery = [];
    window.addEventListener('cloud-realtime-recovery-diagnostic', e => window.__recovery.push(e.detail.kind));
  }, [REF, session()]);
  await context.route(`https://${REF}.supabase.co/**`, route => fake.handle(route));
  await context.route(/^https:\/\/(?!rhfdjsklfrgpoqsaqpkn).*/u, route => route.abort());
  await context.routeWebSocket(/realtime\/v1\/websocket/u, ws => { fake.attachSocket(ws); });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const label = () => page.evaluate(() => document.querySelector('.global-sync-status')?.textContent?.trim() ?? '');
  const banner = () => page.evaluate(() => document.querySelector('[data-global-sync-banner]')?.textContent?.trim() ?? null);
  const counterShown = () => page.evaluate(() => /第 \d+ 次自動重新連線/u.test(document.body.textContent));
  const writeAllowed = () => page.evaluate(async () => {
    const c = await import('/src/providers/cloud/cloudConnectivity.ts');
    try { c.assertCloudWriteAllowed(); return true; } catch { return false; }
  });
  const setHidden = hidden => page.evaluate(h => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event(h ? 'blur' : 'focus'));
  }, hidden);
  const waitLabel = async (re, ms = 90000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(await label())) return Date.now() - t; await sleep(100); } throw new Error(`label ${re} not reached; now "${await label()}"`); };

  // Open: one bootstrap read, one subscription, synced.
  fake.reset(); await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await waitLabel(/已同步/u, 150000); await sleep(3000);
  report.open = { joins: joins(), fullReads: fullReads(), rest: restCount(), restKB: restKB(), sockets: fake.sockets.size };
  assert.equal(report.open.joins, 1); assert.equal(report.open.fullReads, 1); assert.equal(await writeAllowed(), true);

  // 1 foreground 60 s: heartbeats only.
  fake.reset(); await sleep(60000);
  report.foreground60s = { joins: joins(), heartbeats: heartbeats(), rest: restCount() };
  assert.equal(report.foreground60s.joins, 0); assert.ok(report.foreground60s.heartbeats >= 1); assert.equal(report.foreground60s.rest, 0);

  // 2 hidden < 5 min: same subscription, nothing re-created, still synced.
  fake.reset(); await setHidden(true); await sleep(120000);
  report.hidden2min = { joins: joins(), rest: restCount(), sockets: fake.sockets.size, label: await label() };
  assert.equal(report.hidden2min.joins, 0); assert.equal(report.hidden2min.rest, 0); assert.equal(report.hidden2min.sockets, 1);

  // 3 hidden > 5 min: paused (channel removed, socket closed), not synced, writes blocked, no banner/counter.
  await sleep(200000);
  await sleep(60000); // the SDK closes the socket 2 x heartbeat (~50 s) after its last channel is removed
  report.paused = { recovery: await page.evaluate(() => window.__recovery.filter(k => k.startsWith('background'))), sockets: fake.sockets.size, label: await label(), banner: await banner(), write: await writeAllowed() };
  assert.deepEqual(report.paused.recovery, ['background-pause'], 'paused once');
  assert.equal(report.paused.sockets, 0, 'socket closed: no heartbeats, no reconnects');
  assert.match(report.paused.label, /背景暫停中，切回後同步/u); assert.equal(report.paused.banner, null); assert.equal(report.paused.write, false, 'paused is not synced: writes blocked');

  // 4 stay hidden another 5 min (total hidden ~11 min) (simulated network drops would have nothing to drop): no joins, reads or counter.
  fake.reset(); await sleep(300000);
  report.pausedMore5min = { joins: joins(), rest: restCount(), heartbeats: heartbeats(), counter: await counterShown(), label: await label() };
  assert.deepEqual([report.pausedMore5min.joins, report.pausedMore5min.rest, report.pausedMore5min.heartbeats, report.pausedMore5min.counter], [0, 0, 0, false]);

  // 5/6/7/8 visible: one join, writes blocked until proven, one full read, synced, writes allowed.
  fake.reset(); const t0 = Date.now(); await setHidden(false); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const resumingLabel = await label();
  const resumingWrite = await writeAllowed();
  const toSyncedMs = await waitLabel(/已同步/u); await sleep(5000);
  report.resume = { resumingLabel, resumingWrite, toSyncedMs: Date.now() - t0 - 5000, joins: joins(), fullReads: fullReads(), rest: restCount(), restKB: restKB(), sockets: fake.sockets.size, write: await writeAllowed() };
  assert.match(resumingLabel, /正在重新連線…|已同步/u); assert.equal(resumingWrite, false, 'writes blocked before the resumed channel is proven');
  assert.equal(report.resume.joins, 1, 'exactly one subscription'); assert.equal(report.resume.fullReads, 1, 'exactly one proving catch-up');
  assert.equal(report.resume.sockets, 1); assert.equal(report.resume.write, true, 'writes allowed after proof');
  void toSyncedMs;

  // 9 ten quick hidden/visible toggles (< 5 min each): no new subscriptions, timers or full reads.
  fake.reset();
  for (let i = 0; i < 10; i++) { await setHidden(true); await sleep(300); await setHidden(false); await sleep(300); }
  await sleep(8000);
  report.toggles = { joins: joins(), fullReads: fullReads(), sockets: fake.sockets.size, pauses: await page.evaluate(() => window.__recovery.filter(k => k === 'background-pause').length) };
  assert.deepEqual([report.toggles.joins, report.toggles.fullReads, report.toggles.sockets, report.toggles.pauses], [0, 0, 1, 1]);

  // 11 a real Realtime failure (listening never confirmed after a drop) still shows the warning.
  fake.reset(); fake.systemMode = 'none'; fake.dropAllSockets(); await sleep(30000);
  report.realFailure = { banner: (await banner())?.slice(0, 12) ?? null, write: await writeAllowed() };
  assert.match(report.realFailure.banner ?? '', /即時同步目前未確認/u); assert.equal(report.realFailure.write, false);
  fake.systemMode = 'ok';
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(report));
  console.log('PASS background pause: no reconnect loop while hidden; one subscription + one proving catch-up on return; writes blocked until proven');
} finally { if (browser) await browser.close(); vite.kill('SIGTERM'); }
