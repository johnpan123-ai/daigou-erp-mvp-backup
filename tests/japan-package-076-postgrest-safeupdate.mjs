// Migration 076 through the real path: authenticated PostgREST -> disposable native PostgreSQL with safeupdate preloaded.
// No cloud credentials. Same chain as tests/waca-counted-safeupdate-postgrest.mjs (Windows -> WSL PostgREST).
// v30 behaviour is recorded first (partial receiving wrote 'arrived'), then the exact 076 source is applied natively and
// the same operations are repeated over HTTP: new / partial / full / cancel / attach-to-confirmed, historical arrived /
// problem preserved, CAS stale rejection, viewer / anon rejection, outbound availability parity, safeupdate active.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { isolatedDatabase, owner, viewer } from './helpers/saveability-isolated.mjs';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';

const migration = '076_japan_package_daily_status_transitions.sql';
const safeupdateLibrary = process.env.WACA_TEST_SAFEUPDATE_LIBRARY;
assert.ok(safeupdateLibrary, 'Native safeupdate library is required; never silently skip');
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const db = await isolatedDatabase({ migrations: CANONICAL_FRESH_INSTALL_V3.slice(0, CANONICAL_FRESH_INSTALL_V3.indexOf(migration)), safeupdateLibrary,
  postgrestBinary: process.env.WACA_TEST_POSTGREST_BINARY });
const ref = 'rhfdjsklfrgpoqsaqpkn';
const id = (n, s) => `${String(s).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const checks = {};
const q = (s, a) => db.sql.query(s, a);
let seq = 500;
try {
  const tx = await vite.ssrLoadModule('/src/providers/cloud/japanPackageTransaction.ts');
  const pool = await vite.ssrLoadModule('/src/lib/outboundPoolAvailability.ts');
  await q(`create function public.erp_test_safeupdate_context() returns jsonb language sql security definer set search_path=pg_catalog as $$
    select jsonb_build_object('role',current_setting('role'),'enabled',current_setting('safeupdate.enabled',true),
      'preload',current_setting('session_preload_libraries')) $$;
    revoke all on function public.erp_test_safeupdate_context() from public,anon;
    grant execute on function public.erp_test_safeupdate_context() to authenticated`);
  const pkg = async pid => (await q('select to_jsonb(t) r from public.japan_packages t where id=$1', [pid])).rows[0].r;
  const items = async pid => (await q('select to_jsonb(t) r from public.japan_package_items t where japan_package_id=$1 and deleted_at is null order by id', [pid])).rows.map(x => x.r);
  const state = async () => (await q(`select public.erp_export_cloud_restore_snapshot_json() business,
    (select to_jsonb(e) from public.erp_cloud_restore_epoch e where singleton) epoch,
    (select generation from public.erp_restore_business_generation where singleton) generation`)).rows[0];
  const send = async (command, pid, sub = owner, mutate) => {
    const request = tx.buildJapanPackageTransactionRequest(pid ? await pkg(pid) : undefined, pid ? await items(pid) : [], command, ref);
    if (mutate) mutate(request);
    return db.http('/rpc/erp_apply_japan_package_transaction', { p_idempotency_key: command.idempotencyKey, p_request: request }, sub,
      { headers: { host: `${ref}.supabase.co` } });
  };
  const ok = async (command, pid) => { const r = await send(command, pid); assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.data.ok, true, JSON.stringify(r.data)); return r.data; };
  const key = () => id(seq++, 9);
  const create = async (n, status = 'registered') => { const pid = id(n, 1);
    await ok({ idempotencyKey: key(), transactionType: 'create-package', package: { id: pid, title: `pkg ${n}`, status, created_at: '2026-10-22T00:00:00.000Z', updated_at: '2026-10-22T00:00:00.000Z' } }); return pid; };
  const attach = async (pid, n, count) => ok({ idempotencyKey: key(), transactionType: 'attach-items', packageId: pid,
    items: Array.from({ length: count }, (_, i) => ({ id: id(n * 10 + i, 2), japan_package_id: pid, product_title: `item ${n}-${i}`, variant_name: 'A', sku: `SKU-${n}-${i}`, quantity: 2, checked: false,
      created_at: '2026-10-22T00:00:00.000Z', updated_at: '2026-10-22T00:00:00.000Z' })) }, pid);
  const receive = (pid, itemId, checked) => ok({ idempotencyKey: key(), transactionType: 'set-receiving', packageId: pid,
    updates: [{ itemId, checked, ...(checked ? { checkedAt: '2026-10-22T03:00:00.000Z' } : {}) }] }, pid);
  const available = async pid => pool.getAvailableJapanPackageItems([await pkg(pid)], await items(pid), []).map(x => ({ sku: x.item.sku, qty: x.availableQuantity }));

  await db.startPostgrest();
  const context = await db.http('/rpc/erp_test_safeupdate_context', {});
  assert.equal(context.status, 200, JSON.stringify(context)); assert.equal(context.data.role, 'authenticated'); assert.equal(context.data.enabled, 'on');
  assert.ok(context.data.preload.includes(safeupdateLibrary)); checks.authenticatedSafeupdate = context.data;
  // v30 (before 076): partial receiving writes 'arrived' (root cause, recorded).
  const p0 = await create(1); await attach(p0, 1, 2);
  const [a0] = (await items(p0)).map(x => x.id);
  await receive(p0, a0, true);
  checks.v30 = { partialStatus: (await pkg(p0)).status, outbound: await available(p0) };
  assert.equal(checks.v30.partialStatus, 'arrived');
  await db.stopPostgrest();
  const beforeApply = await state();
  await q(readFileSync('supabase/sql/' + migration, 'utf8'));
  assert.deepEqual(await state(), beforeApply, 'Migration 076 changes no business data / epoch / generation');
  assert.equal((await pkg(p0)).status, 'arrived', 'Existing arrived row is not converted by the migration');
  checks.migrationBusinessMutation = 0;
  await db.startPostgrest();
  // v31 over authenticated PostgREST with safeupdate.
  const p1 = await create(2); checks.created = (await pkg(p1)).status;
  await attach(p1, 2, 2); const [b1, b2] = (await items(p1)).map(x => x.id);
  await receive(p1, b1, true);
  const partial = await pkg(p1);
  checks.partial = { status: partial.status, arrivedAt: Boolean(partial.arrived_at), outbound: await available(p1) };
  assert.equal(checks.partial.status, 'registered'); assert.equal(checks.partial.arrivedAt, true);
  assert.deepEqual(checks.partial.outbound.map(x => x.qty), checks.v30.outbound.map(x => x.qty), 'Outbound availability parity v30 vs v31');
  await receive(p1, b2, true); checks.full = (await pkg(p1)).status; assert.equal(checks.full, 'confirmed');
  await receive(p1, b1, false); checks.cancel = { status: (await pkg(p1)).status, outbound: await available(p1) };
  assert.equal(checks.cancel.status, 'registered'); assert.deepEqual(checks.cancel.outbound.map(x => x.sku), ['SKU-2-1']);
  await receive(p1, b1, true); await attach(p1, 3, 1); checks.attachToConfirmed = (await pkg(p1)).status; assert.equal(checks.attachToConfirmed, 'registered');
  // Historical packages.
  const p2 = await create(4); await attach(p2, 4, 2);
  await q("update public.japan_packages set status='arrived', arrived_at='2026-10-01' where id=$1", [p2]);
  const [c1] = (await items(p2)).map(x => x.id);
  await receive(p2, c1, true); await receive(p2, c1, false);
  checks.legacyArrived = (await pkg(p2)).status; assert.equal(checks.legacyArrived, 'arrived');
  const p3 = await create(5); await attach(p3, 5, 1);
  await q("update public.japan_packages set status='problem', note='破損：盒角壓傷' where id=$1", [p3]);
  await receive(p3, (await items(p3))[0].id, true);
  checks.legacyProblem = { status: (await pkg(p3)).status, note: (await pkg(p3)).note };
  assert.deepEqual(checks.legacyProblem, { status: 'problem', note: '破損：盒角壓傷' });
  // CAS: a stale package version / item version is rejected with no change.
  const before = await state();
  const stale = await send({ idempotencyKey: key(), transactionType: 'set-receiving', packageId: p1, updates: [{ itemId: b2, checked: false }] }, p1, owner,
    request => { request.itemOperations[0].observedVersion = 1; });
  assert.equal(stale.data?.ok, false, JSON.stringify(stale)); assert.equal(stale.data.code, 'FIELD_CONFLICT');
  assert.deepEqual(await state(), before, 'Stale CAS write changes nothing');
  checks.cas = 'FIELD_CONFLICT, 0 change';
  // Permissions.
  const forbidden = await send({ idempotencyKey: key(), transactionType: 'set-receiving', packageId: p1, updates: [{ itemId: b2, checked: false }] }, p1, viewer);
  assert.ok(forbidden.status >= 400 || forbidden.data?.ok === false, JSON.stringify(forbidden));
  const anon = await send({ idempotencyKey: key(), transactionType: 'set-receiving', packageId: p1, updates: [{ itemId: b2, checked: false }] }, p1, null);
  assert.ok(anon.status >= 400, JSON.stringify(anon));
  assert.deepEqual(await state(), before, 'Rejected callers change nothing');
  checks.permissions = { viewer: forbidden.status, anon: anon.status };
  checks.arrivedWrittenByOperations = Number((await q("select count(*) n from public.japan_packages where status='arrived' and id not in ($1,$2)", [p0, p2])).rows[0].n);
  assert.equal(checks.arrivedWrittenByOperations, 0);
  console.log(JSON.stringify({ result: 'PASS', engine: 'Native PostgreSQL + authenticated PostgREST + safeupdate preload', checks }, null, 2));
} finally { await db.close(); await vite.close(); }
