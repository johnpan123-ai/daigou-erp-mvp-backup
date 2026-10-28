// Real PostgREST + provider bootstrap: partitioned keyset reads return exactly
// the database rows in the database's own key order (collation included).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';
const db = await isolatedDatabase();
const server = await createServer({ configFile: 'tests/fixtures/inventory-cloud-import-vite.config.mjs', configLoader: 'runner', mode: 'staging', server: { host: '127.0.0.1', port: 4292, strictPort: true, hmr: false, watch: null } });
let browser;
try {
  // 6,250 Inventory rows (live scale) with mixed-script keys, plus a 3,500-row Variant table.
  await db.sql.query(`insert into inventory_items(id,inventory_key,myacg_item_code,product_title,raw_variant_name,updated_by)
    select gen_random_uuid(), (array['ホロ','Holo','hololive','代理','b','B','_x'])[1+i%7] || ' ' || md5(i::text) || '::C' || i || '::', 'C'||i, 'T'||i, '', $1
    from generate_series(1,6250) i`, [owner]);
  const group = randomUUID();
  await db.sql.query("insert into product_groups(id,title) values($1,'Keyset Group')", [group]);
  await db.sql.query(`insert into product_variants(id,product_group_id,myacg_item_code,product_title,variant_name,raw_variant_name)
    select gen_random_uuid(),$1,'V'||i,'Keyset Group','v'||i,'v'||i from generate_series(1,3500) i`, [group]);
  await db.startPostgrest(); await server.listen();
  browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const page = await (await browser.newContext()).newPage();
  let requests = 0;
  await page.exposeFunction('__BUYANIME_ISOLATED_HTTP__', request => { requests++; return db.http(request.path, request.body, owner, { method: request.method, headers: { ...(request.prefer ? { prefer: request.prefer } : {}), ...(request.accept ? { accept: request.accept } : {}) } }); });
  await page.goto('http://127.0.0.1:4292/tests/fixtures/buyanime-resume-provider.html');
  await page.waitForFunction(() => Boolean(window.__BUYANIME_RESUME_PROVIDER__));
  await page.evaluate(id => window.__BUYANIME_RESUME_PROVIDER__.setup(id), owner);
  const cached = await page.evaluate(async () => {
    const provider = window.__BUYANIME_RESUME_PROVIDER__.provider();
    await provider.waitForCloudBootstrapConvergence();
    const { cloudCacheDb } = await import('/src/lib/db.ts');
    return { inventory: (await cloudCacheDb.getInventory()).map(row => row.inventory_key), variants: (await cloudCacheDb.getProductVariants({ raw: true })).map(row => row.id) };
  });
  const dbInventory = (await db.sql.query('select inventory_key from inventory_items where deleted_at is null order by inventory_key')).rows.map(r => r.inventory_key);
  const dbVariants = (await db.sql.query('select id::text from product_variants where deleted_at is null order by id')).rows.map(r => r.id);
  assert.deepEqual(cached.inventory, dbInventory, 'Inventory cache must equal DB rows in DB key order');
  assert.deepEqual([...cached.variants].sort(), [...dbVariants].sort(), 'Variant cache must equal DB rows');
  console.log(JSON.stringify({ result: 'PASS', inventory: cached.inventory.length, variants: cached.variants.length, requests }));
} finally { if (browser) await browser.close(); await server.close(); await db.close(); }
