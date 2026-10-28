// Synthetic, private-data-free: BuyAnime Inventory outcome classification
// against the real 072 RPCs on a disposable PostgreSQL/PostgREST.
//  A  definitive server rejection (FIELD_CONFLICT) -> journal FAILED_PRE_COMMIT,
//     real reason shown, zero writes, safe re-import.
//  B  lost apply response -> unknown -> receipt/CAS reconcile by the SAME actor
//     -> proven NOT committed -> closed, never re-dispatched as a duplicate.
//  B' a DIFFERENT actor cannot use the rejection as proof: stays fail-closed.
//  C  committed import after recovery: one commit, no duplicate keys/UUIDs.
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
const second = '00000000-0000-4000-8000-000000000097';
let browser, stage = 'prepare'; const summary = {};
try {
  const dbm = await vite.ssrLoadModule('/src/lib/db.ts');
  await db.sql.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'second@example.invalid','{}')", [second]);
  await db.sql.query("update public.profiles set role='owner' where user_id=$1", [second]);
  const rows = [];
  for (let f = 0; f < 30; f++) for (let v = 0; v < 4; v++) {
    const code = `REJ${String(f).padStart(3, '0')}${v}`, title = `拒絕測試商品 ${f}`, raw = `規格 ${v}`;
    rows.push({ id: randomUUID(), code, parent: `REJP${f}`, title, raw, key: `${dbm.normalizeProductTitle(title)}::${code}::${raw}`, norm: dbm.normalizeProductTitle(title), sort: rows.length + 1 });
  }
  for (const x of rows) await db.sql.query(`insert into inventory_items(id,inventory_key,myacg_item_code,myacg_parent_code,product_id,product_title,normalized_product_title,
    raw_variant_name,listing_type,final_price,myacg_available_quantity,myacg_sold_quantity,import_sort_index,updated_by)
    values($1,$2,$3,$4,$3,$5,$6,$7,'日本代購',800,1,2,$8,$9)`, [x.id, x.key, x.code, x.parent, x.title, x.norm, x.raw, x.sort, owner]);
  await db.startPostgrest(); await server.listen();
  browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const loss = { apply: 0, reconcile: 0 }; const rpc = [];
  const open = async actor => {
    const context = await browser.newContext(); await context.route('https://**/*', route => route.abort());
    const page = await context.newPage();
    await page.exposeFunction('__BUYANIME_ISOLATED_HTTP__', async request => {
      const response = await db.http(request.path, request.body, actor, { method: request.method, headers: { ...(request.prefer ? { prefer: request.prefer } : {}), ...(request.accept ? { accept: request.accept } : {}) } });
      const match = request.path.match(/rpc\/erp_(apply|reconcile)_inventory_import/u);
      if (match) {
        rpc.push({ actor: actor === owner ? 'owner' : 'second', rpc: match[1], ok: response.data?.ok, code: response.data?.code, outcome: response.data?.outcome });
        if (loss[match[1]] > 0) { loss[match[1]]--; throw new Error('ISOLATED_RESPONSE_LOST'); }
      }
      return response;
    });
    await page.goto('http://127.0.0.1:4292/tests/fixtures/buyanime-resume-provider.html');
    await page.waitForFunction(() => Boolean(window.__BUYANIME_RESUME_PROVIDER__));
    await page.evaluate(id => window.__BUYANIME_RESUME_PROVIDER__.setup(id), actor);
    await page.evaluate(() => window.__BUYANIME_RESUME_PROVIDER__.provider().waitForCloudBootstrapConvergence());
    return { context, page };
  };
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const file = sold => Buffer.from('<table><tr><th>子編號(商品編號)</th><th>主編號(多規格編號)</th><th>商品名稱</th><th>規格項目</th><th>商品種類</th><th>價格</th><th>庫存</th><th>已售</th></tr>'
    + rows.map(x => `<tr><td>${esc(x.code)}</td><td>${x.parent}</td><td>${esc(x.title)}</td><td>${esc(x.raw)}</td><td>日本代購</td><td>800</td><td>1</td><td>${sold}</td></tr>`).join('') + '</table>').toString('base64');
  const runImport = (page, base64) => page.evaluate(async base64 => {
    const bridge = window.__BUYANIME_RESUME_PROVIDER__, provider = bridge.provider();
    const parsed = await bridge.parse(base64); const id = `catalog_import_${crypto.randomUUID()}`, at = new Date().toISOString();
    const { getBuyAnimeFlowPresentation } = await import('/src/providers/cloud/buyAnimeImportCoordinator.ts');
    const { buyAnimeRecoveryUserMessage } = await import('/src/providers/cloud/buyAnimeImportResume.ts');
    try {
      const done = await provider.completeBuyAnimeImport(parsed.map(row => ({ ...row, latest_catalog_import_id: id, catalog_last_seen_at: at })), 'rejected-recovery.xls');
      return { ok: true, stage: done.stage };
    } catch (error) {
      return { ok: false, code: error.code, stage: error.record?.stage, server: error.cause?.code ?? null,
        message: buyAnimeRecoveryUserMessage(error), flowError: getBuyAnimeFlowPresentation().error, active: getBuyAnimeFlowPresentation().active,
        pending: Boolean(await provider.getBuyAnimeImportRecovery().catch(() => true)) };
    }
  }, base64);
  const businessRows = async () => (await db.sql.query('select id,myacg_sold_quantity,version from inventory_items order by id')).rows;
  const journals = async () => (await db.sql.query("select count(*)::int n from import_batches where platform='buyanime-catalog-resume-v1'")).rows[0].n;

  stage = 'A definitive rejection';
  let a = await open(owner);
  await db.sql.query('update inventory_items set myacg_sold_quantity=9,version=version+1 where id=$1', [rows[7].id]); // concurrent edit after bootstrap
  let before = await businessRows();
  let result = await runImport(a.page, file(5));
  assert.equal(result.ok, false); assert.equal(result.code, 'BUYANIME_INVENTORY_REJECTED'); assert.equal(result.server, 'FIELD_CONFLICT');
  assert.equal(result.stage, 'FAILED_PRE_COMMIT'); assert.equal(result.pending, false, 'journal must not block');
  assert.match(result.message, /其他操作修改.*沒有寫入任何資料/u); assert.equal(result.flowError, result.message); assert.equal(result.active, false);
  assert.deepEqual(await businessRows(), before, 'A: zero business writes');
  assert.deepEqual(rpc.map(x => `${x.rpc}:${x.code ?? x.outcome}`), ['apply:FIELD_CONFLICT'], 'A: never reconciled as unknown, never re-dispatched');
  await a.context.close(); summary.A = 'PASS';

  stage = 'C re-import after refresh';
  a = await open(owner); rpc.length = 0;
  result = await runImport(a.page, file(5));
  assert.deepEqual(result, { ok: true, stage: 'COMPLETE' });
  assert.deepEqual(rpc.map(x => `${x.rpc}:${x.code ?? x.outcome}`), ['apply:COMMITTED']);
  assert.equal((await db.sql.query('select count(*)::int n from inventory_items where myacg_sold_quantity=5')).rows[0].n, rows.length);
  await a.context.close(); summary.C = 'PASS';

  stage = "B' lost responses, different actor stays fail-closed";
  a = await open(owner); rpc.length = 0;
  await db.sql.query('update inventory_items set myacg_sold_quantity=8,version=version+1 where id=$1', [rows[11].id]);
  loss.apply = 1; loss.reconcile = 9; // apply lost; owner's own reconcile responses lost too -> stays UNKNOWN
  before = await businessRows();
  result = await runImport(a.page, file(6));
  assert.equal(result.ok, false); assert.notEqual(result.stage, 'FAILED_PRE_COMMIT'); assert.equal(result.pending, true, 'unknown outcome keeps the durable journal');
  loss.reconcile = 0; await a.context.close();
  const b = await open(second); rpc.length = 0;
  result = await runImport(b.page, file(6));
  assert.equal(result.ok, false); assert.equal(result.code, 'BUYANIME_INVENTORY_READBACK_IDENTITY_ERROR', 'another actor cannot prove NOT committed');
  assert.equal(result.pending, true); assert.ok(rpc.every(x => x.rpc === 'reconcile'), "B': no apply dispatched by the second actor");
  assert.deepEqual(await businessRows(), before);
  await b.context.close(); summary["B'"] = 'PASS';

  stage = 'B same actor reconcile proves NOT committed, then new file imports';
  a = await open(owner); rpc.length = 0;
  result = await runImport(a.page, file(6));
  assert.deepEqual(result, { ok: true, stage: 'COMPLETE' }, 'stuck journal closed as NOT committed; the selected file then imports');
  assert.deepEqual(rpc.map(x => `${x.rpc}:${x.code ?? x.outcome}`), ['reconcile:FIELD_CONFLICT', 'apply:COMMITTED']);
  assert.equal((await db.sql.query('select count(*)::int n from inventory_items where myacg_sold_quantity=6')).rows[0].n, rows.length);
  await a.context.close(); summary.B = 'PASS';

  stage = 'identity';
  const ids = (await db.sql.query('select count(*)::int n,count(distinct inventory_key)::int k from inventory_items')).rows[0];
  assert.deepEqual(ids, { n: rows.length, k: rows.length });
  assert.equal((await db.sql.query('select count(*)::int n from inventory_items where id=any($1::uuid[])', [rows.map(x => x.id)])).rows[0].n, rows.length);
  summary.journals = await journals(); summary.result = 'PASS';
  console.log(JSON.stringify(summary));
} catch (error) { console.log(JSON.stringify({ stage, error: String(error.message).slice(0, 1200) })); throw new Error('BUYANIME_REJECTED_RECOVERY_FAILED: ' + stage); }
finally { if (browser) await browser.close(); await server.close(); await vite.close(); await db.close(); }
