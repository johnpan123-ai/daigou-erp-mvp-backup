// Egress E1 regression: the real ERP2 app (Vite staging mode) against an isolated fake Supabase (no network).
// Proves (1) a Realtime channel that never confirms postgres_changes listening no longer re-reads all tables
// in a loop and stays read-only (not synced), (2) once listening is confirmed the authoritative catch-up runs
// and the app becomes synced, (3) a hidden tab defers full re-reads after drops and catches up when visible,
// (4) a Restore epoch change is always re-verified, (5) a normal rejoin still re-reads once (completeness).
// Data: ERP2_EGRESS_BACKUP (a cloud-authoritative backup file); never committed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { FakeSupabase, loadTables, session } from './fixtures/egress-fake-supabase.mjs';

const backupPath = process.env.ERP2_EGRESS_BACKUP;
assert.ok(backupPath, 'ERP2_EGRESS_BACKUP (cloud-authoritative backup JSON) is required');
const REF = 'rhfdjsklfrgpoqsaqpkn';
const PORT = Number(process.env.REALTIME_BUDGET_PORT || 4471);
const origin = `http://127.0.0.1:${PORT}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--configLoader', 'runner'],
  { env: { ...process.env, VITE_SUPABASE_URL: `https://${REF}.supabase.co`, VITE_SUPABASE_ANON_KEY: 'isolated-test-key-not-a-real-credential', VITE_DEPLOYMENT_ENV: 'staging' }, stdio: ['ignore', 'pipe', 'pipe'] });
let vout = ''; vite.stdout.on('data', c => { vout += c; }); vite.stderr.on('data', c => { vout += c; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fake = new FakeSupabase(loadTables(backupPath));
const fullReads = () => fake.log.filter(e => e.kind === 'rest' && e.table === 'purchase_batches').length;
const mb = () => +(fake.log.reduce((s, e) => s + (e.kind === 'rest' ? e.raw : 0), 0) / 1e6).toFixed(2);
async function settle(maxMs = 90000, idleMs = 5000) {
  const start = Date.now(); let last = -1; let since = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(500);
    const n = fake.log.filter(e => !e.kind.startsWith('realtime')).length;
    if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since >= idleMs) return;
  }
}
let browser;
const report = {};
try {
  for (let n = 0; n < 160; n++) { try { if ((await fetch(origin)).ok) break; } catch { /* starting */ } if (vite.exitCode !== null) throw new Error(vout); await sleep(250); }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript(([ref, s]) => {
    if (!localStorage.getItem('erp_provider_mode')) localStorage.setItem('erp_provider_mode', 'cloud');
    if (!localStorage.getItem(`sb-${ref}-auth-token`)) localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s));
  }, [REF, session()]);
  await context.route(`https://${REF}.supabase.co/**`, route => fake.handle(route));
  await context.route(/^https:\/\/(?!rhfdjsklfrgpoqsaqpkn).*/u, route => route.abort());
  await context.routeWebSocket(/realtime\/v1\/websocket/u, ws => { fake.attachSocket(ws); });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const status = () => page.evaluate(() => document.querySelector('[data-global-sync-banner]')?.getAttribute('data-global-sync-banner') ?? 'synced');
  const setHidden = hidden => page.evaluate(h => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event(h ? 'blur' : 'focus'));
  }, hidden);

  fake.reset(); await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  for (let t = Date.now(); !fake.log.some(e => e.kind === 'rest') && Date.now() - t < 120000;) await sleep(250);
  await settle(150000);
  assert.equal(fullReads(), 1, 'first open: one bootstrap read'); assert.equal(await status(), 'synced');
  report.open = { fullReads: fullReads(), mb: mb() };

  // (5) normal rejoin: one completeness re-read, synced again
  fake.reset(); fake.dropAllSockets(); await sleep(40000); await settle();
  assert.equal(fullReads(), 1, 'rejoin: exactly one authoritative re-read'); assert.equal(await status(), 'synced');
  report.rejoin = { fullReads: fullReads(), mb: mb() };

  // (1) listening never confirmed: bounded (<= 1 unproven read in 3 min), never synced
  fake.reset(); fake.systemMode = 'none'; fake.dropAllSockets(); await sleep(180000);
  const unprovenReads = fullReads();
  assert.ok(unprovenReads <= 1, `unproven channel re-read ${unprovenReads} times in 3 min`);
  assert.notEqual(await status(), 'synced', 'unproven state must not be shown as synced');
  report.unproven3min = { fullReads: unprovenReads, mb: mb(), status: await status() };

  // (2) listening confirmed again -> authoritative catch-up -> synced
  fake.reset(); fake.systemMode = 'ok'; fake.dropAllSockets(); await sleep(45000); await settle();
  assert.ok(fullReads() >= 1, 'catch-up after confirmation'); assert.equal(await status(), 'synced');
  report.recovered = { fullReads: fullReads(), mb: mb() };

  // (3) hidden tab: drops while hidden do not re-read; visible again -> one catch-up -> synced
  fake.reset(); await setHidden(true);
  for (let i = 0; i < 2; i++) { await sleep(15000); fake.dropAllSockets(); await sleep(60000); }
  assert.equal(fullReads(), 0, 'hidden tab must defer full re-reads');
  report.hidden = { fullReads: fullReads(), mb: mb(), status: await status() };
  fake.reset(); await setHidden(false); await sleep(5000); await settle();
  assert.equal(fullReads(), 1, 'visible again: one catch-up'); assert.equal(await status(), 'synced');
  report.visible = { fullReads: fullReads(), mb: mb() };

  // (4) Restore epoch change is always re-verified
  fake.reset(); fake.sendEpochUpdate(9); await sleep(5000); await settle();
  assert.equal(fullReads(), 1, 'epoch change re-verified'); assert.equal(await status(), 'synced');
  report.epoch = { fullReads: fullReads(), mb: mb() };
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', ...report }));
} finally { await browser?.close(); vite.kill(); }
