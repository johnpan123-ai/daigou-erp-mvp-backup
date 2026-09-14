import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.CLOUD_P0_4_PROVIDER_PORT || '4224';
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
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* server starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const uuid = suffix => `50000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
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

      const batchId = uuid(2);
      const itemId = uuid(3);
      const groupId = uuid(4);
      const variantId = uuid(5);
      const command = {
        idempotencyKey: uuid(6),
        batch: { id: batchId, product_group_id: groupId, name: 'provider', date: '2026-09-07', note: '', created_at: '2026-09-07T00:00:00Z' },
        items: [{ id: itemId, purchase_batch_id: batchId, product_variant_id: variantId, quantity: 2, cost: 100, note: '' }],
      };
      const canonical = {
        ok: true, operationType: 'create', idempotencyKey: command.idempotencyKey, replayed: false,
        batch: { ...command.batch, id: batchId, local_id: batchId, version: 1 },
        items: [{ ...command.items[0], id: itemId, local_id: itemId, version: 1 }],
      };
      const calls = [];
      supabase.rpc = async (name, args) => {
        calls.push({ name, args });
        return { data: canonical, error: null };
      };
      await supabaseProvider.savePurchaseBatchTransaction(command);
      const afterSuccess = {
        batches: await cloudCacheDb.getPurchaseBatches(),
        items: await cloudCacheDb.getPurchaseBatchItems(),
      };

      const beforeFailure = JSON.stringify(afterSuccess);
      const edit = {
        ...command,
        idempotencyKey: uuid(7),
        batch: { ...afterSuccess.batches[0], note: 'must-not-enter-cache' },
      };
      supabase.rpc = async () => ({
        data: { ok: false, code: 'FIELD_CONFLICT', entity: 'purchase_batches', recordId: batchId },
        error: null,
      });
      let failureName = '';
      try { await supabaseProvider.savePurchaseBatchTransaction(edit); } catch (error) { failureName = error.name; }
      const afterFailure = JSON.stringify({
        batches: await cloudCacheDb.getPurchaseBatches(),
        items: await cloudCacheDb.getPurchaseBatchItems(),
      });

      const captureBoundary = async (nextCommand, rpc) => {
        let calls = 0;
        supabase.rpc = async (...args) => { calls += 1; return rpc(...args); };
        try {
          await supabaseProvider.savePurchaseBatchTransaction(nextCommand);
          return { calls, name: '', kind: '', message: '' };
        } catch (error) {
          return { calls, name: error.name, kind: error.kind, message: error.message };
        }
      };
      const transportUnknown = await captureBoundary(
        { ...edit, idempotencyKey: uuid(8) },
        async () => { throw new Error('postgresql://fake-user:fake-password@fake-db.internal/private'); },
      );
      const serverRejected = await captureBoundary(
        { ...edit, idempotencyKey: uuid(9) },
        async () => ({ data: null, error: { code: '23503', message: 'UNSAFE RAW DATABASE DETAIL' } }),
      );
      const originalCacheCommit = cloudCacheDb.savePurchaseBatchTransaction.bind(cloudCacheDb);
      cloudCacheDb.savePurchaseBatchTransaction = async () => { throw new Error('UNSAFE LOCAL CACHE DETAIL'); };
      const committedSyncPending = await captureBoundary(
        { ...edit, idempotencyKey: uuid(10) },
        async () => ({ data: { ...canonical, idempotencyKey: uuid(10), operationType: 'edit' }, error: null }),
      );
      cloudCacheDb.savePurchaseBatchTransaction = originalCacheCommit;

      return {
        rpcName: calls[0].name,
        rpcKey: calls[0].args.p_idempotency_key,
        operationType: calls[0].args.p_request.operationType,
        batchKinds: calls[0].args.p_request.batchOperations.map(operation => operation.kind),
        itemKinds: calls[0].args.p_request.itemOperations.map(operation => operation.kind),
        cachedBatchId: afterSuccess.batches[0].id,
        cachedItemId: afterSuccess.items[0].id,
        cacheCollectionsCommittedTogether: afterSuccess.batches.length === 1 && afterSuccess.items.length === 1,
        failureName,
        failureCacheUnchanged: beforeFailure === afterFailure,
        transportUnknown,
        serverRejected,
        committedSyncPending,
      };
    });
    assert.deepEqual(result, {
      rpcName: 'erp_apply_purchase_batch_transaction',
      rpcKey: '50000000-0000-4000-8000-000000000006',
      operationType: 'create',
      batchKinds: ['create'],
      itemKinds: ['create'],
      cachedBatchId: '50000000-0000-4000-8000-000000000002',
      cachedItemId: '50000000-0000-4000-8000-000000000003',
      cacheCollectionsCommittedTogether: true,
      failureName: 'PurchaseBatchTransactionError',
      failureCacheUnchanged: true,
      transportUnknown: {
        calls: 1,
        name: 'PurchaseBatchSubmitBoundaryError',
        kind: 'result-unknown',
        message: '採購儲存結果待查證，請勿重複操作。',
      },
      serverRejected: {
        calls: 1,
        name: 'PurchaseBatchSubmitBoundaryError',
        kind: 'server-rejected',
        message: '伺服器已拒絕這次採購儲存，草稿仍保留，請重新確認後再試。',
      },
      committedSyncPending: {
        calls: 1,
        name: 'PurchaseBatchSubmitBoundaryError',
        kind: 'committed-sync-pending',
        message: '採購已提交，畫面同步尚未完成，請勿重複操作。',
      },
    });
    console.log('PASS actual Cloud Provider sends one idempotent Batch+Items RPC command');
    console.log('PASS canonical server result atomically updates both Cloud cache collections');
    console.log('PASS structured server conflict leaves both Cloud cache collections unchanged');
    console.log('PASS real Provider emits fixed safe unknown, rejected, and committed-sync-pending boundaries');
  } finally {
    await context.close();
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}
