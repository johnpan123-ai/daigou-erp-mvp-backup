import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.OUTBOUND_PROVIDER_TEST_PORT || '4290';
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
  const page = await browser.newPage();
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const uuid = suffix => `83000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
      const [{ supabaseProvider }, { supabase }, { cloudCacheDb }, connectivity] = await Promise.all([
        import('/src/providers/cloud/supabaseProvider.ts'), import('/src/providers/cloud/supabaseClient.ts'),
        import('/src/lib/db.ts'), import('/src/providers/cloud/cloudConnectivity.ts'),
      ]);
      connectivity.markCloudReadFresh(1);
      await cloudCacheDb.clearData();
      supabase.auth.getSession = async () => ({ data: { session: { user: { id: uuid(1) } } }, error: null });
      supabase.from = () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { role: 'owner' }, error: null }) }) }) });
      const shipment = { id: uuid(2), title: 'F4 provider', status: 'draft', version: 1 };
      const item = { id: uuid(3), outbound_shipment_id: shipment.id, quantity: 1, checked: false, version: 1 };
      await cloudCacheDb.saveOutboundShipmentTransaction([shipment], [item]);
      const rpcCalls = [];
      const command = { idempotencyKey: uuid(4), transactionType: 'delete-shipment', shipmentId: shipment.id };
      supabase.rpc = async (name, args) => {
        rpcCalls.push({ name, args });
        return { data: { ok: true, transactionType: 'delete-shipment', idempotencyKey: command.idempotencyKey,
          replayed: false, shipmentId: shipment.id, itemIds: [item.id] }, error: null };
      };
      const deleted = await supabaseProvider.deleteOutboundShipmentTransaction(command);
      const cacheAfter = { shipments: await cloudCacheDb.getOutboundShipments(), items: await cloudCacheDb.getOutboundShipmentItems() };

      await cloudCacheDb.saveOutboundShipmentTransaction([shipment], [item]);
      const originalCommit = cloudCacheDb.saveOutboundShipmentTransaction.bind(cloudCacheDb);
      cloudCacheDb.saveOutboundShipmentTransaction = async () => { throw new Error('UNSAFE CACHE DETAIL'); };
      const pendingCommand = { ...command, idempotencyKey: uuid(5) };
      const pending = await supabaseProvider.deleteOutboundShipmentTransaction(pendingCommand);
      cloudCacheDb.saveOutboundShipmentTransaction = originalCommit;

      const unknownCommand = { ...command, idempotencyKey: uuid(6) };
      supabase.rpc = async () => { throw new Error('UNSAFE postgres://fake:password@db/private'); };
      let unknown = {};
      try { await supabaseProvider.deleteOutboundShipmentTransaction(unknownCommand); } catch (error) {
        unknown = { name: error.name, kind: error.kind, message: error.message };
      }
      return {
        rpcName: rpcCalls[0].name,
        target: rpcCalls[0].args.p_request.targetProjectRef,
        key: rpcCalls[0].args.p_idempotency_key,
        itemKinds: rpcCalls[0].args.p_request.itemOperations.map(operation => operation.kind),
        deleted,
        cacheAfter,
        pending,
        unknown,
      };
    });
    assert.equal(result.rpcName, 'erp_apply_outbound_shipment_transaction');
    assert.equal(result.target, 'rhfdjsklfrgpoqsaqpkn');
    assert.equal(result.itemKinds.join(','), 'delete');
    assert.deepEqual(result.cacheAfter, { shipments: [], items: [] });
    assert.equal(result.deleted.syncPending, undefined);
    assert.equal(result.pending.syncPending, true);
    assert.deepEqual(result.unknown, {
      name: 'OutboundShipmentDeleteBoundaryError', kind: 'result-unknown',
      message: '刪除結果待查證，請勿重複操作。',
    });
    console.log('PASS provider sends one targeted idempotent F4 delete RPC and atomically commits both caches');
    console.log('PASS committed/cache-failure remains success-pending; unknown transport uses fixed-safe output');
  } finally {
    await page.close();
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}
