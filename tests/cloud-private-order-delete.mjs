import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const origin = 'http://127.0.0.1:4402';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging', '--host', '127.0.0.1', '--port', '4402', '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VITE_DEPLOYMENT_ENV: 'staging',
    VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co', VITE_SUPABASE_ANON_KEY: 'isolated-test-public-key' } });
let browser; let log = '';
vite.stdout.on('data', chunk => { log += chunk; }); vite.stderr.on('data', chunk => { log += chunk; });
try {
  for (let n = 0; n < 80; n++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* startup */ }
    if (n === 79 || vite.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const context = await browser.newContext(); let liveRequests = 0;
  await context.route('**/*.supabase.co/**', route => { liveRequests++; return route.abort(); });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.dismiss());
  await page.goto(origin + '/tests/fixtures/cloud-mutation-field-contract.html');
  await page.waitForFunction(() => !!window.fieldContractFixture);
  await page.locator('input[placeholder="-"]').first().waitFor();
  const result = await page.evaluate(async () => {
    const [{ supabase }, { dataProvider }, { SupabaseProvider }, { cloudCacheDb }, { markCloudReadFresh }, cas] = await Promise.all([
      import('/src/providers/cloud/supabaseClient.ts'), import('/src/providers/dataProvider.ts'), import('/src/providers/cloud/supabaseProvider.ts'),
      import('/src/lib/db.ts'), import('/src/providers/cloud/cloudConnectivity.ts'), import('/src/providers/cloud/cloudFieldCas.ts'),
    ]);
    const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const rows = [4, 5].map(n => ({ id: id(n), database_id: id(n), product_group_id: id(1), customer_name: `Synthetic-${n}`, status: 'pending', note: '', version: 1 }));
    await cloudCacheDb.savePrivateOrders(structuredClone(rows));
    const originalFrom = supabase.from.bind(supabase); const originalRpc = supabase.rpc.bind(supabase);
    const operations = []; let rejectNext = true;
    supabase.from = table => {
      if (table !== 'private_orders') return originalFrom(table);
      let selectedIds;
      const builder = { select() { return builder; }, is() { return builder; }, order() { return builder; }, range() { return builder; },
        limit() { return builder; }, abortSignal() { return builder; },
        in(_field, ids) { selectedIds = ids; return builder; },
        then(resolve, reject) { return Promise.resolve({ data: structuredClone(rows.filter(row => !row.deleted_at && (!selectedIds || selectedIds.includes(row.id)))), error: null }).then(resolve, reject); } };
      return builder;
    };
    supabase.rpc = async (name, args) => {
      if (name !== 'erp_apply_field_mutations' || args.p_entity !== 'private_orders') return originalRpc(name, args);
      cas.assertCloudMutationOperations(args.p_entity, args.p_operations);
      operations.push(structuredClone(args.p_operations));
      if (rejectNext) { rejectNext = false; return { data: null, error: { code: 'P0001', message: 'Synthetic server rejection' } }; }
      for (const op of args.p_operations) {
        const row = rows.find(row => row.id === op.id);
        if (op.kind !== 'delete' || op.expectedVersion !== row.version) return { data: { ok: false, code: 'FIELD_CONFLICT', entity: args.p_entity, recordId: op.id }, error: null };
      }
      args.p_operations.forEach(op => { Object.assign(rows.find(row => row.id === op.id), { deleted_at: new Date().toISOString(), version: 2 }); });
      return { data: { ok: true, entity: args.p_entity }, error: null };
    };
    markCloudReadFresh(1);
    let failed = false;
    try { await dataProvider.savePrivateOrders([structuredClone(rows[1])]); } catch { failed = true; }
    const failedCache = (await cloudCacheDb.getPrivateOrders()).length;
    markCloudReadFresh(1);
    await dataProvider.savePrivateOrders([structuredClone(rows[1])]);
    const acknowledgedCache = await cloudCacheDb.getPrivateOrders();
    // New provider instance simulates fresh bootstrap/F5 against the same server.
    const fresh = await new SupabaseProvider().getPrivateOrders();
    return { failed, failedCache, acknowledgedCache: acknowledgedCache.map(row => row.id), fresh: fresh.map(row => row.id),
      operationKinds: operations.map(batch => batch.map(op => op.kind)), survivorVersion: rows[1].version,
      deleted: Boolean(rows[0].deleted_at), survivor: id(5) };
  });
  assert.equal(result.failed, true, 'Delete-only change must reach RPC and surface rejection; early-return cannot claim success');
  assert.equal(result.failedCache, 2, 'Rejected deletion changed cache');
  assert.deepEqual(result.operationKinds, [['delete'], ['delete']]);
  assert.deepEqual(result.acknowledgedCache, [result.survivor]); assert.deepEqual(result.fresh, [result.survivor]);
  assert.equal(result.survivorVersion, 1, 'Unchanged survivor was needlessly written'); assert.equal(result.deleted, true);
  assert.equal(errors.length, 0, errors.join('\n')); assert.equal(liveRequests, 0);
  console.log('PASS actual private-order delete-only path: rejection preserves cache; retry sends one CAS delete; unchanged survivor untouched; fresh readback; no live requests');
} finally { await browser?.close(); vite.kill(); }
