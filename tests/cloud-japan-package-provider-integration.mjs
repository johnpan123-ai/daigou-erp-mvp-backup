import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.JAPAN_PACKAGE_PROVIDER_TEST_PORT || '4288';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const uuid = suffix => `73000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
      const [{ supabaseProvider }, { supabase }, { cloudCacheDb }, connectivity] = await Promise.all([
        import('/src/providers/cloud/supabaseProvider.ts'),
        import('/src/providers/cloud/supabaseClient.ts'),
        import('/src/lib/db.ts'),
        import('/src/providers/cloud/cloudConnectivity.ts'),
      ]);
      connectivity.markCloudReadFresh(1);
      await cloudCacheDb.clearData();
      supabase.auth.getSession = async () => ({ data: { session: { user: { id: uuid(1) } } }, error: null });
      supabase.from = () => ({
        select: () => ({ eq: () => ({ single: async () => ({ data: { role: 'owner' }, error: null }) }) }),
      });
      const packageId = uuid(2);
      const itemId = uuid(3);
      const packageRow = {
        id: packageId, title: 'provider F3', status: 'registered',
        created_at: '2026-09-19T00:00:00.000Z', updated_at: '2026-09-19T00:00:00.000Z',
      };
      const itemRow = {
        id: itemId, japan_package_id: packageId, product_title: 'item', variant_name: 'variant',
        sku: 'F3-PROVIDER', quantity: 1, checked: false,
        created_at: '2026-09-19T00:00:00.000Z', updated_at: '2026-09-19T00:00:00.000Z',
      };
      const rpcCalls = [];
      const createCommand = { idempotencyKey: uuid(4), transactionType: 'create-package', package: packageRow };
      supabase.rpc = async (name, args) => {
        rpcCalls.push({ name, args });
        return { data: {
          ok: true, transactionType: 'create-package', idempotencyKey: createCommand.idempotencyKey, replayed: false,
          package: { ...packageRow, database_id: packageId, version: 1 }, items: [],
        }, error: null };
      };
      const created = await supabaseProvider.applyJapanPackageTransaction(createCommand);
      const afterCreate = { packages: await cloudCacheDb.getJapanPackages(), items: await cloudCacheDb.getJapanPackageItems() };

      const attachCommand = { idempotencyKey: uuid(5), transactionType: 'attach-items', packageId, items: [itemRow] };
      supabase.rpc = async (name, args) => {
        rpcCalls.push({ name, args });
        return { data: {
          ok: true, transactionType: 'attach-items', idempotencyKey: attachCommand.idempotencyKey, replayed: false,
          package: { ...afterCreate.packages[0], version: 2 }, items: [{ ...itemRow, database_id: itemId, version: 1 }],
        }, error: null };
      };
      await supabaseProvider.applyJapanPackageTransaction(attachCommand);
      const beforeFailure = JSON.stringify({ packages: await cloudCacheDb.getJapanPackages(), items: await cloudCacheDb.getJapanPackageItems() });
      const receivingCommand = {
        idempotencyKey: uuid(6), transactionType: 'set-receiving', packageId,
        updates: [{ itemId, checked: true, checkedAt: '2026-09-19T01:00:00.000Z' }],
      };
      supabase.rpc = async () => ({ data: { ok: false, code: 'FIELD_CONFLICT' }, error: null });
      let rejected = {};
      try { await supabaseProvider.applyJapanPackageTransaction(receivingCommand); } catch (error) {
        rejected = { name: error.name, kind: error.kind, message: error.message };
      }
      const afterFailure = JSON.stringify({ packages: await cloudCacheDb.getJapanPackages(), items: await cloudCacheDb.getJapanPackageItems() });

      const unknownCommand = { ...receivingCommand, idempotencyKey: uuid(7) };
      supabase.rpc = async () => { throw new Error('UNSAFE postgres://fake:password@db/private'); };
      let unknown = {};
      try { await supabaseProvider.applyJapanPackageTransaction(unknownCommand); } catch (error) {
        unknown = { name: error.name, kind: error.kind, message: error.message };
      }

      const cacheCommit = cloudCacheDb.saveJapanPackageTransaction.bind(cloudCacheDb);
      cloudCacheDb.saveJapanPackageTransaction = async () => { throw new Error('UNSAFE CACHE DETAIL'); };
      const pendingCommand = { ...receivingCommand, idempotencyKey: uuid(8) };
      supabase.rpc = async () => ({ data: {
        ok: true, transactionType: 'set-receiving', idempotencyKey: pendingCommand.idempotencyKey, replayed: false,
        package: { ...afterCreate.packages[0], status: 'confirmed', version: 3 },
        items: [{ ...itemRow, checked: true, checked_at: '2026-09-19T01:00:00.000Z', version: 2 }],
      }, error: null });
      const pending = await supabaseProvider.applyJapanPackageTransaction(pendingCommand);
      cloudCacheDb.saveJapanPackageTransaction = cacheCommit;

      return {
        createRpcName: rpcCalls[0].name,
        createTarget: rpcCalls[0].args.p_request.targetProjectRef,
        createKey: rpcCalls[0].args.p_idempotency_key,
        createdId: created.package.id,
        cacheCreatedTogether: afterCreate.packages.length === 1 && afterCreate.items.length === 0,
        attachKinds: rpcCalls[1].args.p_request.itemOperations.map(operation => operation.kind),
        failureCacheUnchanged: beforeFailure === afterFailure,
        rejected,
        unknown,
        pending: { syncPending: pending.syncPending, packageStatus: pending.package.status, itemChecked: pending.items[0].checked },
      };
    });
    assert.deepEqual(result, {
      createRpcName: 'erp_apply_japan_package_transaction',
      createTarget: 'rhfdjsklfrgpoqsaqpkn',
      createKey: '73000000-0000-4000-8000-000000000004',
      createdId: '73000000-0000-4000-8000-000000000002',
      cacheCreatedTogether: true,
      attachKinds: ['create'],
      failureCacheUnchanged: true,
      rejected: {
        name: 'JapanPackageSubmitBoundaryError', kind: 'server-rejected',
        message: '伺服器已拒絕這次日本包裹操作，請重新讀取資料後再確認。',
      },
      unknown: {
        name: 'JapanPackageSubmitBoundaryError', kind: 'result-unknown',
        message: '日本包裹操作結果待查證，請勿重複操作。',
      },
      pending: { syncPending: true, packageStatus: 'confirmed', itemChecked: true },
    });
    console.log('PASS actual Cloud Provider sends one fixed-target idempotent Japan Package RPC');
    console.log('PASS canonical result atomically updates Package/Items cache and rejection leaves cache unchanged');
    console.log('PASS unknown transport is fixed-safe; Server success survives local cache failure as syncPending');
  } finally {
    await context.close();
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}
