// Real Windows -> WSL PostgREST -> disposable native PostgreSQL. No cloud credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createServer } from 'vite';
import { isolatedDatabase, owner, viewer, uuid } from './helpers/saveability-isolated.mjs';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';

const migration = '074_waca_counted_state_safeupdate.sql';
const safeupdateLibrary = process.env.WACA_TEST_SAFEUPDATE_LIBRARY;
assert.ok(safeupdateLibrary, 'Native safeupdate library is required; never silently skip');
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const db = await isolatedDatabase({ migrations: CANONICAL_FRESH_INSTALL_V3.slice(0, CANONICAL_FRESH_INSTALL_V3.indexOf(migration)), safeupdateLibrary,
  postgrestBinary: process.env.WACA_TEST_POSTGREST_BINARY });
const checks = {};
const q = (s, a) => db.sql.query(s, a);
const rpc = 'erp_commit_waca_counted_snapshot';
try {
  const core = await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const counted = await vite.ssrLoadModule('/src/waca/countedImport.ts');
  const storage = await vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const flow = await vite.ssrLoadModule('/src/waca/confirmFlow.ts');
  const errors = await vite.ssrLoadModule('/src/waca/importErrors.ts');
  await q('update public.product_variants set waca_manual_adjustment=10 where id=$1', [uuid(2)]);
  await q("update public.waca_state set mode='ORDER_REBASELINE_REQUIRED',payload='{\"mode\":\"ORDER_REBASELINE_REQUIRED\"}' where id='00000000-0000-4000-8000-000000000001'");
  await q("update public.erp_cloud_restore_epoch set epoch=33,restored_at='2026-10-19T03:06:55Z' where singleton");
  await q(`create function public.erp_test_safeupdate_context() returns jsonb language sql security definer set search_path=pg_catalog as $$
    select jsonb_build_object('role',current_setting('role'),'enabled',current_setting('safeupdate.enabled',true),
      'preload',current_setting('session_preload_libraries'),'pid',pg_backend_pid()) $$;
    revoke all on function public.erp_test_safeupdate_context() from public,anon;
    grant execute on function public.erp_test_safeupdate_context() to authenticated`);
  const start = (await q('select pg_postmaster_start_time() s')).rows[0].s;
  const state = async () => (await q(`select public.erp_export_cloud_restore_snapshot_json() business,
    (select to_jsonb(e) from public.erp_cloud_restore_epoch e where singleton) epoch,
    (select generation from public.erp_restore_business_generation where singleton) generation`)).rows[0];
  const variants = async () => (await q('select id::text,product_group_id::text,myacg_item_code,product_title,variant_name,waca_auto_quantity,waca_manual_adjustment from public.product_variants')).rows;
  const snapshot = async () => (await q('select public.erp_read_waca_snapshot() s')).rows[0].s;
  const display = async () => { const v = (await variants()).find(v => v.id === uuid(2)); return v.waca_auto_quantity + v.waca_manual_adjustment; };
  const row = (order, quantity, status = '完成付款') => ({ orderNumber: order, orderStatus: status, purchasedAt: '2026/10/17 12:00',
    productCode: 'GP-LOCAL', productTitle: 'Synthetic group', specCode: 'G-SYNTHETIC', spec1: 'A', spec2: '', quantity, subtotal: quantity * 100 });
  const prepare = async (rows, opts = {}) => {
    const current = await snapshot(), vs = await variants(), repo = storage.repositoryFromSnapshot(current, vs);
    const candidate = core.cloneWacaRepository(repo), requestId = crypto.randomUUID();
    const result = core.importWacaRows(rows, candidate, [{ mainCode: 'GP-LOCAL', childCode: 'G-SYNTHETIC', variantId: uuid(2),
      productGroupId: uuid(1), productTitle: 'Synthetic group', variantTitle: 'A', active: true }], requestId);
    assert.deepEqual(result.errors, []);
    const keys = new Set(rows.map(r => `${core.wacaOrderKey(r.orderNumber)}::${core.wacaFeature(r)}`));
    const importedKeys = new Set([...candidate.items.values()].filter(i => keys.has(`${i.orderKey}::${i.feature}`)).map(i => i.key));
    const epoch = (await q('select epoch,restored_at from public.erp_cloud_restore_epoch where singleton')).rows[0];
    const plan = counted.planWacaCountedImport({ variants: vs, current: repo, candidate, importedKeys,
      context: counted.wacaTransitionContext(current.cutoverState, { epoch: Number(epoch.epoch), restoredAt: epoch.restored_at.toISOString() }, '2026-10-19T12:00:00Z'),
      defaultMode: 'ACCUMULATE', actor: owner,
      overlapChoices: opts.choice ? new Map([...importedKeys].map(k => [k, opts.choice])) : undefined });
    counted.applyCountedItems(candidate, plan);
    const batch = { id: requestId, fileName: 'safeupdate-local.xlsx', importedAt: '2026-10-19T12:00:00Z', rows: rows.length,
      inserted: result.inserted, updated: result.updated, unchanged: result.unchanged, result, conflictRows: [] };
    return { p_snapshot: flow.wacaAtomicDelta(current, storage.snapshotFromRepository(current, candidate, [...current.batches, batch])),
      p_expected_revision: current.revision, p_plan: plan.plan, plan };
  };
  const send = async (p, sub = owner) => {
    console.log('HTTP start revision=' + p.p_expected_revision + ' actor=' + (sub ?? 'anon'));
    const r = await db.http('/rpc/' + rpc, { p_snapshot: p.p_snapshot, p_expected_revision: p.p_expected_revision, p_plan: p.p_plan }, sub, { signal: AbortSignal.timeout(15000) });
    console.log('HTTP end status=' + r.status + ' code=' + (r.data?.code ?? 'none'));
    return r;
  };
  const commit = async (rows, opts) => { const p = await prepare(rows, opts); const r = await send(p); assert.equal(r.status, 200, JSON.stringify(r)); return p; };
  const rejected = async (p, code, message, sub = owner) => {
    const before = await state(), r = await send(p, sub);
    assert.ok(r.status >= 400, JSON.stringify(r)); assert.equal(r.data.code, code); assert.match(r.data.message, new RegExp(message));
    assert.deepEqual(await state(), before, 'All 24 resources, epoch and business generation must roll back');
    return r;
  };
  await db.startPostgrest();
  const context = await db.http('/rpc/erp_test_safeupdate_context', {});
  assert.equal(context.status, 200, JSON.stringify(context)); assert.equal(context.data.role, 'authenticated'); assert.equal(context.data.enabled, 'on');
  assert.ok(context.data.preload.includes(safeupdateLibrary)); checks.authenticatedSafeupdate = context.data;
  const original = await rejected(await prepare([row('NEW', 2)]), '21000', 'UPDATE requires a WHERE clause');
  assert.equal(errors.classifyWacaError(original.data, 'commit', 'isolated', rpc).diagnostic.rpc, rpc);
  checks.original073 = original;
  console.log('PASS original 073: safeupdate 21000 + full rollback');
  await db.stopPostgrest();
  const beforeApply = await state();
  await q(readFileSync('supabase/sql/' + migration, 'utf8'));
  assert.deepEqual(await state(), beforeApply, 'Migration itself changes no business data/epoch/generation');
  checks.migrationBusinessMutation = 0;
  const native = new pg.Client({ connectionString: db.url.toString(), query_timeout: 15000 }); await native.connect();
  try {
    await native.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await native.query("LOAD '" + safeupdateLibrary + "'");
    const p = await prepare([row('NATIVE-CONTROL', 2)]);
    await native.query('begin');
    await native.query('select public.erp_commit_waca_counted_snapshot($1,$2,$3)', [JSON.stringify(p.p_snapshot), p.p_expected_revision, JSON.stringify(p.p_plan)]);
    await native.query('rollback');
    console.log('PASS repaired native safeupdate control (rolled back)');
  } finally { await native.end(); }
  await db.startPostgrest();
  console.log('PASS migration: business mutation 0; testing first real authenticated commit');
  const initial = await commit([row('NEW', 2)]); assert.equal(await display(), 12);
  await rejected(initial, '40001', 'WACA_STALE_REVISION');
  await commit([row('NEW', 2)]); assert.equal(await display(), 12);
  await commit([row('NEW', 1)]); assert.equal(await display(), 11);
  await commit([row('NEW', 1, '取消')]); assert.equal(await display(), 10);
  await commit([row('NEW', 1, '取消')]); assert.equal(await display(), 10);
  checks.normalRepeatReductionCancellation = '10 -> 12 -> 12 -> 11 -> 10 -> 10';
  await commit([row('ERP1-KNOWN', 3)], { choice: 'BASELINE_INCLUDED' });
  await commit([row('ERP1-KNOWN', 3)]); assert.equal(await display(), 10);
  const historic = await commit([row('ERP1-KNOWN', 3, '取消')]);
  assert.equal(historic.plan.variants.get(uuid(2)).baselineChangedItems, 1); assert.equal(await display(), 10);
  const unknown = await commit([row('ERP1-UNKNOWN', 1, '取消')]);
  assert.equal(unknown.plan.variants.get(uuid(2)).baselineChangedItems, 2); assert.equal(await display(), 10);
  checks.history = 'Proven ERP1 inclusion never re-adds; untraceable cancellation stays review, no deduction';
  const stale = await prepare([row('STALE-EPOCH', 1)]); stale.p_plan.restoreEpoch--;
  await rejected(stale, '40001', 'WACA_RESTORE_EPOCH_CHANGED');
  const bad = await prepare([row('BAD-PREVIEW', 2)]); bad.p_plan.expectedDisplay[uuid(2)].after++;
  await rejected(bad, '40001', 'WACA_COUNTED_PREVIEW_MISMATCH');
  const permitted = await prepare([row('PERMISSION', 1)]);
  await rejected(permitted, '42501', 'WACA_OWNER_REQUIRED', viewer);
  await rejected(permitted, '42501', 'WACA_OWNER_REQUIRED', uuid(999));
  await rejected(permitted, '42501', 'permission denied', null);
  checks.permissions = 'Viewer, unknown authenticated user and anon rejected with 0 business change';
  const lock = new pg.Client({ connectionString: db.url.toString() }); await lock.connect();
  try {
    await lock.query("select pg_advisory_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0))");
    await rejected(permitted, '55006', 'CLOUD_RESTORE_MAINTENANCE_LOCKED');
  } finally { await lock.end(); }
  checks.safety = 'CAS / epoch / Restore lock / post-ledger validation all fail closed';
  // Test-only trigger simulates a final singleton write affecting 0 rows. Never installed in cloud/migration.
  await q(`create function public.erp_test_skip_final_state() returns trigger language plpgsql as $$
    begin if new.mode='ORDER_DRIVEN_ACTIVE' and new.revision=old.revision then return null; end if; return new; end $$;
    create trigger erp_test_skip_final_state before update on public.waca_state for each row execute function public.erp_test_skip_final_state()`);
  await rejected(await prepare([row('FINAL-ZERO-ROWS', 2)]), '23514', 'WACA_COUNTED_STATE_UPDATE_MISMATCH');
  await q('drop trigger erp_test_skip_final_state on public.waca_state; drop function public.erp_test_skip_final_state()');
  checks.exactOneRow = 'Suppressed final singleton update -> 23514, complete transaction rollback';
  assert.equal((await q('select pg_postmaster_start_time() s')).rows[0].s.toISOString(), start.toISOString());
  checks.restart = 0; checks.partialWrite = 0;
  console.log(JSON.stringify({ result: 'PASS', engine: 'Native PostgreSQL + authenticated PostgREST + safeupdate preload', checks }, null, 2));
} finally { await db.close(); await vite.close(); }
