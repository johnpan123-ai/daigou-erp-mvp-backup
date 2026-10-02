import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ configFile: 'tests/fixtures/inventory-cloud-import-vite.config.mjs',
  configLoader: 'runner', mode: 'staging', server: { host: '127.0.0.1', port: 4291, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4291/tests/fixtures/inventory-cloud-import.html');
  const result = await page.evaluate(async () => {
    const [{ SupabaseProvider }, { supabase }, { cloudCacheDb }, connectivity] = await Promise.all([
      import('/src/providers/cloud/supabaseProvider.ts'), import('/src/providers/cloud/supabaseClient.ts'),
      import('/src/lib/db.ts'), import('/src/providers/cloud/cloudConnectivity.ts'),
    ]);
    const provider = new SupabaseProvider();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const old = { id, inventory_key: 'Synthetic::G1::A', version: 3, myacg_item_code: 'G1', product_title: 'Synthetic',
      raw_variant_name: 'A', listing_type: '', final_price: 10, myacg_sold_quantity: 2, myacg_available_quantity: 1, myacg_listed_at: '' };
    await cloudCacheDb.saveInventory([{ ...old, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', version: 1 }]);
    let rows = [old];
    const calls = [];
    let readbackFailure = false;
    connectivity.markCloudReadFresh(1);
    supabase.auth.getSession = async () => ({ data: { session: { user: { id } } }, error: null });
    supabase.from = table => ({ select: fields => {
      calls.push({ table, fields });
      if (table === 'profiles') return { eq: () => ({ single: async () => ({ data: { role: 'owner' }, error: null }) }) };
      return { order: key => ({ range: async (from, to) => {
        calls.push({ key, from, to }); return { data: rows.slice(from, to + 1), error: null };
      } }) };
    } });
    provider.refreshAcknowledgedCloudRows = async () => { if (readbackFailure) throw new Error('synthetic readback failure'); };
    const incoming = { ...old, id: undefined, version: undefined, final_price: 20 };
    let rpcMode = 'ok';
    const rpcCalls = [];
    supabase.rpc = async (name, args) => {
      rpcCalls.push({ name, args });
      if (rpcMode === 'lost') throw new Error('Failed to fetch');
      if (rpcMode === 'unique') return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "inventory_items_inventory_key_key"' } };
      return { data: { ok: true, entity: 'inventory_items', rows: [] }, error: null };
    };
    await provider.upsertInventory([incoming]);
    const capture = async () => {
      connectivity.markCloudReadFresh(1);
      try { await provider.upsertInventory([incoming]); return ''; } catch (error) { return error.code; }
    };
    rpcMode = 'unique'; const unique = await capture();
    rpcMode = 'lost'; const lost = await capture();
    rpcMode = 'ok'; readbackFailure = true; const readback = await capture();
    readbackFailure = false;
    const beforeTombstone = rpcCalls.length;
    rows = [{ ...old, deleted_at: '2026-10-03T00:00:00Z' }];
    const tombstone = await capture();
    return { ids: rpcCalls.map(call => call.args.p_operations.map(op => op.id)),
      kinds: rpcCalls[0].args.p_operations.map(op => op.kind),
      rpc: rpcCalls[0].name, entity: rpcCalls[0].args.p_entity,
      freshReads: calls.filter(call => call.table === 'inventory_items').length,
      unique, lost, readback, tombstone, tombstoneDispatched: rpcCalls.length - beforeTombstone };
  });
  assert.ok(result.ids.flat().every(id => id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  assert.deepEqual(result.kinds, ['patch']);
  assert.equal(result.rpc, 'erp_apply_field_mutations');
  assert.equal(result.entity, 'inventory_items');
  assert.equal(result.freshReads, 5);
  assert.equal(result.unique, 'CLOUD_COMMIT_ERROR');
  assert.equal(result.lost, 'COMMIT_RESULT_UNKNOWN');
  assert.equal(result.readback, 'COMMITTED_READBACK_PENDING');
  assert.equal(result.tombstone, 'CLOUD_STAGING_ERROR');
  assert.equal(result.tombstoneDispatched, 0);
  console.log('PASS actual Cloud provider: fresh authoritative UUID beats stale cache, single CAS patch, SQL rollback/response-lost/committed-readback boundaries, tombstone pre-dispatch rejection');
} finally { await browser.close(); await server.close(); }
