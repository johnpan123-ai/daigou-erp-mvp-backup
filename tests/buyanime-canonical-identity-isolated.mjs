import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';

// Private fixtures remain outside Git. Only counts/identity metrics are logged.
const file = process.env.BUYANIME_FAILING_FILE || join(homedir(), 'Downloads', '399375_2026-10-03.xls');
const snapshotFile = process.env.BUYANIME_BEFORE_BACKUP || join(homedir(), 'Downloads', 'workbench-before-xls-import-20261003-011501.json');
const backup = JSON.parse(readFileSync(snapshotFile, 'utf8'));
const bytes = readFileSync(file);
const browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
const server = await createServer({ configFile: 'vite.config.ts', configLoader: 'runner', mode: 'next',
  server: { host: '127.0.0.1', port: 4289, strictPort: true }, optimizeDeps: { noDiscovery: true } });
await server.listen();
let parsed;
try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  let supabaseRequests = 0;
  page.on('request', request => { if (new URL(request.url()).hostname.endsWith('.supabase.co')) supabaseRequests++; });
  await page.goto('http://127.0.0.1:4289/inventory');
  parsed = await page.evaluate(async data => {
    const { parseMyAcgFile } = await import('/src/utils/myacgParser.ts');
    return parseMyAcgFile(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'exact-failure.xls'));
  }, bytes.toString('base64'));
  assert.equal(parsed.length, 1505);
  const dialogs = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  await page.locator('input[type=file]').setInputFiles(file);
  await page.waitForFunction(() => !document.body.innerText.includes('匯入中...'), null, { timeout: 120000 });
  assert.ok(dialogs.some(message => message.includes('1,505') || message.includes('1505')));
  assert.equal(supabaseRequests, 0);
  const missing = await page.evaluate(async () => {
    const { parseMyAcgFile } = await import('/src/utils/myacgParser.ts');
    try { await parseMyAcgFile(new File(['<table><tr><th>Wrong header</th></tr><tr><td>x</td></tr></table>'], 'missing.xls')); }
    catch (error) { return error.code; }
  });
  assert.equal(missing, 'REQUIRED_FIELD_MISSING');
  console.log('PASS exact 1505-row file, real NEXT UI isolated import, required-header diagnostic, Supabase requests=0');
} finally { await browser.close(); await server.close(); }

globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
const db = await isolatedDatabase();
try {
  await db.sql.query("set timezone='UTC'");
  const isolatedName = db.url.pathname.slice(1);
  assert.match(isolatedName, /^waca_v3_save_[a-f0-9]+$/u);
  await db.sql.query(`alter database ${isolatedName} set timezone='UTC'`);
  const { planCloudInventoryImport } = await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
  const { prepareInventoryUpsert } = await vite.ssrLoadModule('/src/lib/db.ts');
  const { toCloudFieldRow } = await vite.ssrLoadModule('/src/providers/cloud/cloudEntityPayload.ts');
  const { buildCloudCollectionMutationPlan, CLOUD_FIELD_ENTITY_CONTRACTS } = await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  const { planCatalogTransaction } = await vite.ssrLoadModule('/src/providers/cloud/catalogTransaction.ts');
  const normalized = backup.inventory.map(row => ({ ...toCloudFieldRow('inventory_items', row), version: row.version || 1 }));
  const columns = ['id', ...CLOUD_FIELD_ENTITY_CONTRACTS.inventory_items.create, 'version'];
  for (let i = 0; i < normalized.length; i += 400) await db.sql.query(
    `insert into public.inventory_items (${columns.join(',')}) select ${columns.join(',')} from jsonb_populate_recordset(null::public.inventory_items,$1)`,
    [JSON.stringify(normalized.slice(i, i + 400))]);
  const read = async () => (await db.sql.query('select to_jsonb(i) row from public.inventory_items i order by inventory_key')).rows.map(r => r.row);
  const snapshot = await read();
  const tagged = parsed.map(row => ({ ...row, latest_catalog_import_id: 'synthetic_diagnostic_import', catalog_last_seen_at: '2026-10-03T01:15:01.000Z' }));
  const oldProjection = prepareInventoryUpsert(snapshot, tagged);
  const oldOps = buildCloudCollectionMutationPlan('inventory_items', snapshot.map(r => toCloudFieldRow('inventory_items', r)), oldProjection.inventory.map(r => toCloudFieldRow('inventory_items', r)));
  const deletedByKey = new Map(oldOps.filter(o => o.kind === 'delete').map(o => [snapshot.find(r => r.id === o.id).inventory_key, o.id]));
  const replacements = oldOps.filter(o => o.kind === 'create' && deletedByKey.has(o.values.inventory_key));
  assert.equal(replacements.length, 685);
  assert.equal(replacements.filter(o => o.id < deletedByKey.get(o.values.inventory_key)).length, 340);
  await assert.rejects(db.sql.query('select public.erp_apply_field_mutations($1,$2) result', ['inventory_items', JSON.stringify(oldOps)]), error => error.code === '23505');
  assert.deepEqual(await read(), snapshot, 'Failed transaction partially wrote');

  await db.startPostgrest();
  const rpc = operations => db.http('/rpc/erp_apply_field_mutations', { p_entity: 'inventory_items', p_operations: operations });
  let before = snapshot;
  let metrics;
  for (let repeat = 1; repeat <= 3; repeat++) {
    const plan = planCloudInventoryImport(before, tagged);
    const existingByKey = new Map(before.map(row => [row.inventory_key, row.id]));
    assert.ok(plan.inventory.every(row => !existingByKey.has(row.inventory_key) || existingByKey.get(row.inventory_key) === row.id));
    assert.equal(plan.operations.filter(o => o.kind === 'delete').length, 0);
    if (repeat === 1) {
      const existing = parsed.filter(row => existingByKey.has(prepareInventoryUpsert([], [row]).inventory[0].inventory_key)).length;
      metrics = { existingKeyRows: existing, canonicalUuidReused: existing, beforeIdentityReplacements: 685,
        afterIdentityReplacements: 0, preventedReplacements: 685, collisionBefore: 340, collisionAfter: 0,
        creates: plan.operations.filter(o => o.kind === 'create').length };
      const native = (await db.sql.query('select public.erp_apply_field_mutations($1,$2) result', ['inventory_items', JSON.stringify(plan.operations)])).rows[0].result;
      assert.equal(native.ok, true, JSON.stringify({ code: native.code, fields: native.conflicts?.map(c => c.field) }));
    } else {
      assert.equal(plan.operations.filter(o => o.kind === 'create').length, 0);
      const response = await rpc(plan.operations);
      assert.equal(response.status, 200);
      assert.equal(response.data.ok, true, JSON.stringify({ code: response.data.code, fields: response.data.conflicts?.map(c => c.field) }));
    }
    before = await read();
    assert.equal(before.length, 5694);
  }
  // Real authoritative source updates remain CAS patches on stable IDs.
  const changed = tagged.map((row, index) => index ? row : { ...row, final_price: row.final_price + 1, myacg_sold_quantity: row.myacg_sold_quantity + 1 });
  const update = planCloudInventoryImport(before, changed);
  assert.equal((await rpc(update.operations)).data.ok, true);
  const afterUpdate = await read();
  assert.deepEqual(afterUpdate.map(r => [r.inventory_key, r.id]), before.map(r => [r.inventory_key, r.id]));
  // Backup JSON roundtrip (the restore serializer must preserve canonical IDs),
  // plus native isolated restore of the actual inventory before reimport.
  const restored = JSON.parse(JSON.stringify(afterUpdate));
  await db.sql.query('begin');
  await db.sql.query('delete from public.inventory_items');
  for (let i = 0; i < restored.length; i += 400) await db.sql.query(
    `insert into public.inventory_items (${columns.join(',')}) select ${columns.join(',')} from jsonb_populate_recordset(null::public.inventory_items,$1)`, [JSON.stringify(restored.slice(i, i + 400))]);
  await db.sql.query('commit');
  const restorePlan = planCloudInventoryImport(await read(), changed);
  assert.equal(restorePlan.operations.filter(o => o.kind !== 'patch').length, 0);
  assert.equal((await rpc(restorePlan.operations)).data.ok, true);
  const tombstone = { ...(await read())[0], deleted_at: '2026-10-03T00:00:00Z' };
  assert.throws(() => planCloudInventoryImport([tombstone], [{ ...tombstone }]), /SOFT_DELETED/u);
  await db.sql.query('begin');
  try {
    const row = (await read())[0];
    const removed = (await db.sql.query('select public.erp_apply_field_mutations($1,$2) result', ['inventory_items',
      JSON.stringify([{ kind: 'delete', id: row.id, expectedVersion: row.version }])])).rows[0].result;
    assert.equal(removed.ok, true);
    const held = (await read()).find(r => r.id === row.id);
    assert.ok(held.deleted_at && held.inventory_key === row.inventory_key, 'Adopted soft delete retains its unique key');
    assert.throws(() => planCloudInventoryImport([held], [{ ...row, id: crypto.randomUUID() }]), /SOFT_DELETED/u);
  } finally { await db.sql.query('rollback'); }

  // Continue the existing 050 catalog path on the actual imported inventory.
  // Seed the pre-failure catalog, keeping relationships and manual data intact.
  await db.sql.query('delete from public.product_variants; delete from public.product_groups');
  for (const [collection, table] of [['productGroups','product_groups'],['productCategories','product_categories'],['productVariants','product_variants']]) {
    const values = backup[collection].map(row => ({ ...toCloudFieldRow(table, row), version: row.version || 1, updated_by: owner }));
    const names = ['id', ...CLOUD_FIELD_ENTITY_CONTRACTS[table].create, 'version', 'updated_by'];
    for (let i = 0; i < values.length; i += 300) await db.sql.query(`insert into public.${table} (${names.join(',')}) select ${names.join(',')} from jsonb_populate_recordset(null::public.${table},$1)`, [JSON.stringify(values.slice(i, i + 300))]);
  }
  const catalogSnapshot = async () => {
    const result = { inventory: await read() };
    for (const [key, table] of [['groups','product_groups'],['categories','product_categories'],['variants','product_variants']]) result[key] = (await db.sql.query(`select to_jsonb(t) row from public.${table} t where deleted_at is null order by id`)).rows.map(r => r.row);
    return result;
  };
  const catalog = await planCatalogTransaction(await catalogSnapshot(), 'sync');
  const commit = (await db.sql.query('select public.erp_apply_catalog_transaction($1,$2) result', [crypto.randomUUID(), catalog.request])).rows[0].result;
  assert.equal(commit.ok, true, 'Catalog continuation failed');
  const final = await catalogSnapshot();
  assert.ok(final.inventory.length === 5694 && final.variants.length >= backup.productVariants.length);
  console.log(JSON.stringify({ result: 'PASS', metrics, canonicalUuidChurn: 0, repeatedImports: 3, nativePostgres: 'PASS', postgrest: 'PASS',
    old23505Reproduced: true, rollback: 'PASS', restoreThenReimport: 'PASS', catalogContinuation: 'PASS', liveWrites: 0 }));
} finally { await vite.close(); await db.close(); }
