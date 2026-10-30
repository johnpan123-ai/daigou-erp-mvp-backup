// First BuyAnime import while Global Sync is still converging (synthetic data,
// real 072 RPCs on disposable PostgreSQL/PostgREST). Realtime completeness can
// withhold Fresh after the core bootstrap (readiness timeout -> catch-up); an
// import started then must wait for Fresh, never dispatch early, and never be
// reported as an unknown commit when nothing was sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';
globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const db = await isolatedDatabase();
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
const server = await createServer({ configFile: 'tests/fixtures/inventory-cloud-import-vite.config.mjs', configLoader: 'runner', mode: 'staging', server: { host: '127.0.0.1', port: 4292, strictPort: true, hmr: false, watch: null } });
let browser, stage = 'prepare'; const summary = {};
try {
  const dbm = await vite.ssrLoadModule('/src/lib/db.ts');
  const rows = [];
  for (let f = 0; f < 20; f++) for (let v = 0; v < 3; v++) {
    const code = `SYNC${String(f).padStart(3, '0')}${v}`, title = `同步閘門測試 ${f}`, raw = `款 ${v}`;
    rows.push({ id: randomUUID(), code, title, raw, key: `${dbm.normalizeProductTitle(title)}::${code}::${raw}`, norm: dbm.normalizeProductTitle(title), sort: rows.length + 1 });
  }
  for (const x of rows) await db.sql.query(`insert into inventory_items(id,inventory_key,myacg_item_code,product_id,product_title,normalized_product_title,
    raw_variant_name,listing_type,final_price,myacg_available_quantity,myacg_sold_quantity,import_sort_index,updated_by)
    values($1,$2,$3,$3,$4,$5,$6,'日本代購',500,1,1,$7,$8)`, [x.id, x.key, x.code, x.title, x.norm, x.raw, x.sort, owner]);
  await db.startPostgrest(); await server.listen();
  browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const rpc = [];
  const open = async () => {
    const context = await browser.newContext(); await context.route('https://**/*', route => route.abort());
    const page = await context.newPage();
    await page.exposeFunction('__BUYANIME_ISOLATED_HTTP__', async request => {
      const response = await db.http(request.path, request.body, owner, { method: request.method, headers: { ...(request.prefer ? { prefer: request.prefer } : {}), ...(request.accept ? { accept: request.accept } : {}) } });
      if (/rpc\/erp_(apply|reconcile)_inventory_import|import_batches/u.test(request.path) && request.method !== 'GET')
        rpc.push(`${request.method} ${request.path.split('?')[0]} ${response.data?.outcome ?? response.data?.code ?? response.status}`);
      return response;
    });
    await page.goto('http://127.0.0.1:4292/tests/fixtures/buyanime-resume-provider.html');
    await page.waitForFunction(() => Boolean(window.__BUYANIME_RESUME_PROVIDER__));
    await page.evaluate(id => window.__BUYANIME_RESUME_PROVIDER__.setup(id), owner);
    await page.evaluate(() => window.__BUYANIME_RESUME_PROVIDER__.provider().waitForCloudBootstrapConvergence());
    return { context, page };
  };
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const file = sold => Buffer.from('<table><tr><th>子編號(商品編號)</th><th>商品名稱</th><th>規格項目</th><th>商品種類</th><th>價格</th><th>庫存</th><th>已售</th></tr>'
    + rows.map(x => `<tr><td>${x.code}</td><td>${esc(x.title)}</td><td>${esc(x.raw)}</td><td>日本代購</td><td>500</td><td>1</td><td>${sold}</td></tr>`).join('') + '</table>').toString('base64');
  // holdMs: release the completeness hold after this delay (null = never).
  const runImport = (page, base64, holdMs) => page.evaluate(async ({ base64, holdMs }) => {
    const bridge = window.__BUYANIME_RESUME_PROVIDER__, provider = bridge.provider();
    const connectivity = await import('/src/providers/cloud/cloudConnectivity.ts');
    const { classifyMyAcgImportError } = await import('/src/utils/myacgImportErrors.ts');
    connectivity.holdCloudFresh('isolated-realtime-completeness', 'pending', 'readiness-timeout-catch-up');
    const before = connectivity.getCloudConnectivitySnapshot().readStatus;
    if (holdMs !== null) setTimeout(() => connectivity.releaseCloudFresh('isolated-realtime-completeness'), holdMs);
    const parsed = await bridge.parse(base64); const id = `catalog_import_${crypto.randomUUID()}`, at = new Date().toISOString();
    const started = performance.now();
    try {
      const done = await provider.completeBuyAnimeImport(parsed.map(row => ({ ...row, latest_catalog_import_id: id, catalog_last_seen_at: at })), 'first-import.xls');
      return { ok: true, stage: done.stage, before, waitedMs: Math.round(performance.now() - started) };
    } catch (error) {
      const classified = classifyMyAcgImportError(error, 'commit');
      return { ok: false, before, raw: error.code ?? error.name, category: classified.code, message: classified.message,
        pending: Boolean(await provider.getBuyAnimeImportRecovery().catch(() => true)), waitedMs: Math.round(performance.now() - started) };
    } finally { connectivity.releaseCloudFresh('isolated-realtime-completeness'); }
  }, { base64, holdMs });
  const sold = async () => (await db.sql.query('select array_agg(distinct myacg_sold_quantity) v from inventory_items')).rows[0].v.map(Number);
  const journals = async () => (await db.sql.query("select count(*)::int n from import_batches where platform='buyanime-catalog-resume-v1'")).rows[0].n;

  stage = 'S1 import during catch-up, sync converges shortly after';
  let a = await open();
  let result = await runImport(a.page, file(4), 1500);
  summary.S1 = result;
  assert.ok(!['fresh-online', 'fresh-empty'].includes(result.before), 'Fresh was withheld when the import started');
  assert.deepEqual([result.ok, result.stage], [true, 'COMPLETE'], JSON.stringify(result));
  assert.ok(result.waitedMs >= 1400, 'waited for Global Sync before dispatch');
  assert.deepEqual(await sold(), [4]);
  await a.context.close();

  stage = 'S2 sync never converges: no dispatch, clear not-saved message';
  a = await open(); rpc.length = 0;
  const journalsBefore = await journals();
  result = await runImport(a.page, file(5), null);
  summary.S2 = { ...result, rpc: [...rpc] };
  assert.equal(result.ok, false); assert.equal(result.raw, 'CLOUD_OFFLINE_WRITE_BLOCKED');
  assert.equal(result.category, 'CLOUD_SYNC_NOT_READY', 'never reported as an unknown commit');
  assert.match(result.message, /尚未開始儲存.*資料未變更/u);
  assert.equal(result.pending, false); assert.deepEqual(rpc, [], 'nothing was dispatched (no journal, no RPC)');
  assert.equal(await journals(), journalsBefore); assert.deepEqual(await sold(), [4]);

  stage = 'S3 retry after sync: exactly one commit';
  rpc.length = 0;
  result = await runImport(a.page, file(5), 0);
  assert.deepEqual([result.ok, result.stage], [true, 'COMPLETE'], JSON.stringify(result));
  assert.equal(rpc.filter(x => x.includes('erp_apply_inventory_import')).length, 1);
  assert.deepEqual(await sold(), [5]);
  const keys = (await db.sql.query('select count(*)::int n,count(distinct inventory_key)::int k from inventory_items')).rows[0];
  assert.deepEqual(keys, { n: rows.length, k: rows.length });
  await a.context.close();
  summary.result = 'PASS';
  console.log(JSON.stringify(summary));
} catch (error) { console.log(JSON.stringify({ stage, error: String(error.message).slice(0, 1500), summary })); throw new Error('BUYANIME_FIRST_IMPORT_SYNC_GATE_FAILED: ' + stage); }
finally { if (browser) await browser.close(); await server.close(); await vite.close(); await db.close(); }
