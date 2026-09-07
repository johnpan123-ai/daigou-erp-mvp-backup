import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.CLOUD_MUTATION_ORDERING_TEST_PORT || '4199';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (let attempt = 0; attempt < 60; attempt += 1) {
  if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
  try {
    if ((await fetch(BASE_URL)).ok) break;
  } catch {}
  if (attempt === 59) throw new Error(`Vite did not start:\n${output}`);
  await sleep(250);
}

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext();
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
const page = await context.newPage();
page.on('dialog', dialog => dialog.dismiss());
const supabaseRequests = [];
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url());
});

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const { localDb, cloudCacheDb } = await import('/src/lib/db.ts');
    const { dataProvider } = await import('/src/providers/dataProvider.ts');
    const { supabase } = await import('/src/providers/cloud/supabaseClient.ts');
    const { markCloudReadFresh } = await import('/src/providers/cloud/cloudConnectivity.ts');

    localStorage.setItem('erp_provider_mode', 'cloud');
    const ids = {
      local: '90000000-0000-4000-8000-000000000001',
      group: '90000000-0000-4000-8000-000000000002',
      categoryA: '90000000-0000-4000-8000-000000000003',
      categoryB: '90000000-0000-4000-8000-000000000004',
      variantA: '90000000-0000-4000-8000-000000000005',
      variantB: '90000000-0000-4000-8000-000000000006',
    };
    await localDb.saveProductGroups([{ id: ids.local, title: 'Local authoritative sentinel', priority: 'Medium' }]);
    const localHash = JSON.stringify(await localDb.getProductGroups());
    const server = new Map([
      ['product_groups', []],
      ['product_categories', []],
      ['product_variants', []],
    ]);
    let failNext = null;
    let canonicalLabel = '';
    const calls = [];

    const matches = (row, filters) => filters.every(filter => {
      if (filter.kind === 'eq') return row[filter.column] === filter.value;
      if (filter.kind === 'in') return filter.values.includes(row[filter.column]);
      return true;
    });

    supabase.auth.getSession = async () => ({ data: { session: { user: { id: 'fixture-user' } } }, error: null });
    supabase.from = table => {
      let operation = 'select';
      let payload = null;
      const filters = [];
      const builder = {
        select() { return builder; },
        upsert(value) { operation = 'upsert'; payload = value; return builder; },
        update(value) { operation = 'update'; payload = value; return builder; },
        delete() { operation = 'delete'; return builder; },
        eq(column, value) { filters.push({ kind: 'eq', column, value }); return builder; },
        in(column, values) { filters.push({ kind: 'in', column, values }); return builder; },
        is() { return builder; }, order() { return builder; }, range() { return builder; }, limit() { return builder; },
        single: async () => table === 'profiles'
          ? ({ data: { role: 'owner' }, error: null })
          : ({ data: null, error: null }),
        then(resolve, reject) {
          calls.push({ table, operation });
          if (failNext && failNext.table === table && failNext.operation === operation) {
            failNext = null;
            return Promise.resolve({ data: null, error: { message: 'network request timed out', code: 'ETIMEDOUT' } }).then(resolve, reject);
          }
          const rows = server.get(table) || [];
          if (operation === 'upsert') {
            const next = new Map(rows.map(row => [row.id, row]));
            for (const item of Array.isArray(payload) ? payload : [payload]) {
              const current = next.get(item.id) || {};
              next.set(item.id, {
                ...current,
                ...item,
                ...(canonicalLabel ? { canonical_label: canonicalLabel } : {}),
                version: Number(current.version || item.version || 0) + 1,
                updated_at: '2026-09-07T01:00:00.000Z',
              });
            }
            server.set(table, [...next.values()]);
            return Promise.resolve({ data: [...next.values()], error: null }).then(resolve, reject);
          }
          if (operation === 'update') {
            const updated = rows.map(row => matches(row, filters)
              ? { ...row, ...payload, version: Number(row.version || 0) + 1, updated_at: '2026-09-07T01:00:01.000Z' }
              : row);
            server.set(table, updated);
            return Promise.resolve({ data: updated.filter(row => matches(row, filters)), error: null }).then(resolve, reject);
          }
          if (operation === 'delete') {
            server.set(table, rows.filter(row => !matches(row, filters)));
            return Promise.resolve({ data: [], error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: rows.filter(row => matches(row, filters)), error: null }).then(resolve, reject);
        },
      };
      return builder;
    };

    const groupDraft = { id: ids.group, title: 'Client create', priority: 'Medium' };
    canonicalLabel = 'server-create';
    markCloudReadFresh(1);
    await dataProvider.saveProductGroups([groupDraft]);
    const createCache = await cloudCacheDb.getProductGroups();

    canonicalLabel = 'server-update';
    markCloudReadFresh(1);
    await dataProvider.saveProductGroups([{ ...createCache[0], title: 'Client update' }]);
    const updateCache = await cloudCacheDb.getProductGroups();

    const beforeFailedUpdate = JSON.stringify(updateCache);
    failNext = { table: 'product_groups', operation: 'upsert' };
    markCloudReadFresh(1);
    let updateFailure = false;
    try {
      await dataProvider.saveProductGroups([{ ...updateCache[0], title: 'Must not enter cache' }]);
    } catch {
      updateFailure = true;
    }
    const failedUpdateCacheStable = beforeFailedUpdate === JSON.stringify(await cloudCacheDb.getProductGroups());

    const categories = [
      { id: ids.categoryA, product_group_id: ids.group, title: 'A', sort_order: 1 },
      { id: ids.categoryB, product_group_id: ids.group, title: 'B', sort_order: 2 },
    ];
    server.set('product_categories', categories.map(row => ({ ...row, version: 1 })));
    await cloudCacheDb.saveProductCategories(categories);
    canonicalLabel = 'server-reorder';
    markCloudReadFresh(1);
    await dataProvider.saveProductCategories([
      { ...categories[0], sort_order: 2 },
      { ...categories[1], sort_order: 1 },
    ]);
    const reorderCache = await cloudCacheDb.getProductCategories();
    const beforeFailedReorder = JSON.stringify(reorderCache);
    failNext = { table: 'product_categories', operation: 'upsert' };
    markCloudReadFresh(1);
    let reorderFailure = false;
    try {
      await dataProvider.saveProductCategories(reorderCache.map(row => ({ ...row, sort_order: row.sort_order === 1 ? 2 : 1 })));
    } catch {
      reorderFailure = true;
    }
    const failedReorderCacheStable = beforeFailedReorder === JSON.stringify(await cloudCacheDb.getProductCategories());

    const variants = [ids.variantA, ids.variantB].map((id, index) => ({
      id,
      product_group_id: ids.group,
      myacg_item_code: `SKU-${index}`,
      variant_name: `Variant ${index}`,
      product_title: 'Fixture product',
      note: '',
      version: 1,
    }));
    server.set('product_variants', variants.map(row => ({ ...row })));
    await cloudCacheDb.saveProductVariants(variants);
    canonicalLabel = 'server-bulk';
    markCloudReadFresh(1);
    await dataProvider.updateProductVariantPatchBulk(variants.map(row => ({ id: row.id, patch: { note: 'bulk update' } })));
    const bulkCache = await cloudCacheDb.getProductVariants();
    const beforeFailedBulk = JSON.stringify(bulkCache);
    failNext = { table: 'product_variants', operation: 'upsert' };
    markCloudReadFresh(1);
    let bulkFailure = false;
    try {
      await dataProvider.updateProductVariantPatchBulk(variants.map(row => ({ id: row.id, patch: { note: 'must not enter cache' } })));
    } catch {
      bulkFailure = true;
    }
    const failedBulkCacheStable = beforeFailedBulk === JSON.stringify(await cloudCacheDb.getProductVariants());

    failNext = null;
    markCloudReadFresh(1);
    await dataProvider.deleteProductVariant(ids.variantA);
    const deleteCache = await cloudCacheDb.getProductVariants();
    const beforeFailedDelete = JSON.stringify(deleteCache);
    failNext = { table: 'product_variants', operation: 'update' };
    markCloudReadFresh(1);
    let deleteFailure = false;
    try {
      await dataProvider.deleteProductVariant(ids.variantB);
    } catch {
      deleteFailure = true;
    }
    const failedDeleteCacheStable = beforeFailedDelete === JSON.stringify(await cloudCacheDb.getProductVariants());

    const beforeImport = JSON.stringify({
      groups: await cloudCacheDb.getProductGroups(),
      categories: await cloudCacheDb.getProductCategories(),
      variants: await cloudCacheDb.getProductVariants(),
    });
    markCloudReadFresh(1);
    let importFailure = false;
    try {
      await dataProvider.importData('{}');
    } catch {
      importFailure = true;
    }
    const afterImport = JSON.stringify({
      groups: await cloudCacheDb.getProductGroups(),
      categories: await cloudCacheDb.getProductCategories(),
      variants: await cloudCacheDb.getProductVariants(),
    });

    return {
      createCanonical: createCache[0]?.canonical_label,
      updateCanonical: updateCache[0]?.canonical_label,
      updateFailure,
      failedUpdateCacheStable,
      reorderCanonical: reorderCache.map(row => row.canonical_label),
      reorderSort: reorderCache.map(row => row.sort_order).sort(),
      reorderFailure,
      failedReorderCacheStable,
      bulkCanonical: bulkCache.map(row => row.canonical_label),
      bulkNotes: bulkCache.map(row => row.note),
      bulkFailure,
      failedBulkCacheStable,
      deletedVariantAbsent: !deleteCache.some(row => row.id === ids.variantA),
      deleteFailure,
      failedDeleteCacheStable,
      importFailure,
      importCacheStable: beforeImport === afterImport,
      localStable: localHash === JSON.stringify(await localDb.getProductGroups()),
      calls,
    };
  });

  assert.equal(result.createCanonical, 'server-create');
  assert.equal(result.updateCanonical, 'server-update');
  assert.equal(result.updateFailure, true);
  assert.equal(result.failedUpdateCacheStable, true);
  assert.deepEqual(result.reorderCanonical, ['server-reorder', 'server-reorder']);
  assert.deepEqual(result.reorderSort, [1, 2]);
  assert.equal(result.reorderFailure, true);
  assert.equal(result.failedReorderCacheStable, true);
  assert.deepEqual(result.bulkCanonical, ['server-bulk', 'server-bulk']);
  assert.deepEqual(result.bulkNotes, ['bulk update', 'bulk update']);
  assert.equal(result.bulkFailure, true);
  assert.equal(result.failedBulkCacheStable, true);
  assert.equal(result.deletedVariantAbsent, true);
  assert.equal(result.deleteFailure, true);
  assert.equal(result.failedDeleteCacheStable, true);
  assert.equal(result.importFailure, true);
  assert.equal(result.importCacheStable, true);
  assert.equal(result.localStable, true);
  assert.equal(supabaseRequests.length, 0, 'Mutation ordering fixture contacted Supabase');

  console.log('PASS create/update use server canonical readback; failed update leaves cache unchanged');
  console.log('PASS reorder uses server canonical readback; failed reorder leaves cache unchanged');
  console.log('PASS bulk update uses server canonical readback; failed bulk leaves cache unchanged');
  console.log('PASS delete removes cache only after server acknowledgement; failed delete leaves cache unchanged');
  console.log('PASS browser Cloud import is fail-closed and changes neither cache nor Local DB');
  console.log('PASS dynamic mutation families leave Local authoritative DB unchanged and make 0 live Supabase requests');
} finally {
  await context.close();
  await browser.close();
  vite.kill('SIGTERM');
}
