// Current v33 path: React request builder -> authenticated PostgREST -> disposable PostgreSQL + safeupdate.
// Synthetic rows only. No cloud URL, credentials, or production writes are used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { isolatedDatabase, owner, uuid } from './helpers/saveability-isolated.mjs';

process.env.WACA_ISOLATED_PG_URL ||= 'postgresql://postgres@127.0.0.1:55492/waca_v3_base';
process.env.WACA_TEST_SAFEUPDATE_LIBRARY ||= '/tmp/erp2-waca-21000-safeupdate.JpCreateV33/safeupdate.so';
process.env.WACA_TEST_POSTGREST_BINARY ||= '/tmp/erp2-waca-074-postgrest.JpCreateV33/postgrest';
process.env.WACA_TEST_POSTGREST_PORT ||= '4511';
assert.ok(process.env.WACA_TEST_SAFEUPDATE_LIBRARY, 'safeupdate required');
assert.ok(process.env.WACA_TEST_POSTGREST_BINARY, 'native PostgREST required');
const db = await isolatedDatabase({
  safeupdateLibrary: process.env.WACA_TEST_SAFEUPDATE_LIBRARY,
  postgrestBinary: process.env.WACA_TEST_POSTGREST_BINARY,
});
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const q = (sql, values) => db.sql.query(sql, values);
const ref = 'rhfdjsklfrgpoqsaqpkn';
const host = { host: `${ref}.supabase.co` };
const checks = {};
let sequence = 300;
const nextId = () => uuid(sequence++);

try {
  const beforeMigration = (await q('select public.erp_export_cloud_restore_snapshot_json() snapshot')).rows[0].snapshot;
  await q(readFileSync('supabase/sql/078_core_source_capacity_and_receiving.sql', 'utf8').replace(/\r\n?/g, '\n'));
  assert.deepEqual((await q('select public.erp_export_cloud_restore_snapshot_json() snapshot')).rows[0].snapshot, beforeMigration);
  checks.migrationBusinessRowsChanged = 0;

  await q(`create function public.erp_package_create_test_context() returns jsonb language sql set search_path=pg_catalog as $$
    select jsonb_build_object('role',current_user,'safeupdate',current_setting('safeupdate.enabled',true)) $$;
    revoke all on function public.erp_package_create_test_context() from public,anon;
    grant execute on function public.erp_package_create_test_context() to authenticated`);
  await db.startPostgrest();
  const context = await db.http('/rpc/erp_package_create_test_context', {}, owner, { headers: host });
  assert.deepEqual(context.data, { role: 'authenticated', safeupdate: 'on' });
  checks.authenticatedPostgrest = context.data;

  const client = await vite.ssrLoadModule('/src/providers/cloud/japanPackageTransaction.ts');
  const call = (request, key) => db.http('/rpc/erp_apply_japan_package_transaction', {
    p_idempotency_key: key,
    p_request: request,
  }, owner, { headers: host });
  const createPackage = async (row, key = nextId()) => {
    const command = { idempotencyKey: key, transactionType: 'create-package', package: row };
    const request = client.buildJapanPackageTransactionRequest(undefined, [], command, ref);
    const response = await call(request, key);
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(response.data.ok, true, JSON.stringify(response.data));
    return { command, request, response };
  };
  const readPackage = async id => (await q('select to_jsonb(p) row from public.japan_packages p where id=$1', [id])).rows[0]?.row;
  const readItems = async id => (await q('select to_jsonb(i) row from public.japan_package_items i where japan_package_id=$1 and deleted_at is null order by id', [id])).rows.map(row => row.row);
  const generic = (entity, operations) => db.http('/rpc/erp_apply_field_mutations', { p_entity: entity, p_operations: operations }, owner, { headers: host });
  const ok = response => {
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(response.data.ok, true, JSON.stringify(response.data));
    return response;
  };

  const nameOnlyId = nextId();
  const nameOnly = await createPackage({
    id: nameOnlyId,
    title: '羊周邊',
    status: 'registered',
    created_at: '2026-10-26T06:00:00.000Z',
    updated_at: '2026-10-26T06:00:00.000Z',
  });
  assert.equal(nameOnly.response.data.package.title, '羊周邊');
  assert.equal(nameOnly.response.data.package.status, 'registered');
  assert.equal(nameOnly.response.data.items.length, 0);
  checks.nameOnly = { status: nameOnly.response.status, state: nameOnly.response.data.package.status };

  const fullId = nextId();
  const full = await createPackage({
    id: fullId,
    title: '日本語・中文 包裹',
    vendor_name: 'アニメイト台北',
    carrier: '日本通運',
    tracking_number: 'JP-測試-123',
    shipped_at: '2026-10-25',
    expected_arrival_at: '2026-10-27',
    arrived_at: '2026-10-26',
    status: 'registered',
    note: '全選用欄位測試',
    created_at: '2026-10-26T06:01:00.000Z',
    updated_at: '2026-10-26T06:01:00.000Z',
  });
  assert.equal(full.response.data.package.title, '日本語・中文 包裹');
  assert.equal(full.response.data.package.vendor_name, 'アニメイト台北');
  assert.equal(full.response.data.package.expected_arrival_at, '2026-10-27');
  checks.allOptionalAndUnicode = 'PASS';

  const replay = await call(full.request, full.command.idempotencyKey);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(Number((await q('select count(*) n from public.japan_packages where id=$1', [fullId])).rows[0].n), 1);
  checks.duplicateSubmit = 'one row; second response replayed';

  const rejectedId = nextId();
  const rejectedKey = nextId();
  const rejectedCommand = {
    idempotencyKey: rejectedKey,
    transactionType: 'create-package',
    package: { id: rejectedId, title: 'should rollback', status: 'registered' },
  };
  const rejectedRequest = client.buildJapanPackageTransactionRequest(undefined, [], rejectedCommand, ref);
  rejectedRequest.packageOperation.values.status = 'not-a-status';
  const rejected = await call(rejectedRequest, rejectedKey);
  assert.ok(rejected.status >= 400, JSON.stringify(rejected));
  assert.equal(await readPackage(rejectedId), undefined);
  assert.equal(Number((await q('select count(*) n from public.erp_idempotency_keys where idempotency_key=$1', [rejectedKey])).rows[0].n), 0);
  checks.rejectedAtomicRollback = { status: rejected.status, packageRows: 0, idempotencyRows: 0 };

  const listRead = await db.http(`/japan_packages?select=id,title,status&id=eq.${nameOnlyId}`, undefined, owner, { headers: host });
  assert.equal(listRead.status, 200);
  assert.deepEqual(listRead.data, [{ id: nameOnlyId, title: '羊周邊', status: 'registered' }]);
  checks.immediateAndRefreshReadback = 'PASS';

  const itemId = nextId();
  const current = await readPackage(nameOnlyId);
  const attachCommand = {
    idempotencyKey: nextId(),
    transactionType: 'attach-items',
    packageId: nameOnlyId,
    items: [{
      id: itemId,
      japan_package_id: nameOnlyId,
      product_title: '羊周邊商品',
      variant_name: '通常版',
      sku: 'SHEEP-JP-1',
      quantity: 1,
      checked: false,
      created_at: '2026-10-26T06:02:00.000Z',
      updated_at: '2026-10-26T06:02:00.000Z',
    }],
  };
  const attachRequest = client.buildJapanPackageTransactionRequest(current, [], attachCommand, ref);
  ok(await call(attachRequest, attachCommand.idempotencyKey));
  const beforeReceiving = await readPackage(nameOnlyId);
  const items = await readItems(nameOnlyId);
  const receiveCommand = {
    idempotencyKey: nextId(),
    transactionType: 'set-receiving',
    packageId: nameOnlyId,
    updates: [{ itemId, checked: true, checkedAt: '2026-10-26T06:03:00.000Z' }],
  };
  const receiveRequest = client.buildJapanPackageTransactionRequest(beforeReceiving, items, receiveCommand, ref);
  ok(await call(receiveRequest, receiveCommand.idempotencyKey));
  assert.equal((await readPackage(nameOnlyId)).status, 'confirmed');
  assert.equal((await readItems(nameOnlyId))[0].checked, true);

  const shipmentId = nextId();
  ok(await generic('outbound_shipments', [{ kind: 'create', id: shipmentId, values: { title: 'package create flow' } }]));
  ok(await generic('outbound_shipment_items', [{
    kind: 'create', id: nextId(), values: {
      outbound_shipment_id: shipmentId,
      japan_package_item_id: itemId,
      product_title: '羊周邊商品',
      sku: 'SHEEP-JP-1',
      quantity: 1,
    },
  }]));
  assert.equal(Number((await q('select coalesce(sum(quantity),0) n from public.outbound_shipment_items where japan_package_item_id=$1 and deleted_at is null', [itemId])).rows[0].n), 1);
  checks.followOnItemReceivingOutbound = 'PASS';

  console.log(JSON.stringify({
    result: 'PASS',
    runtime: 'native PostgreSQL v33 + authenticated PostgREST + safeupdate',
    checks,
  }, null, 2));
} finally {
  await vite.close();
  await db.stopPostgrest();
  await db.close();
}
