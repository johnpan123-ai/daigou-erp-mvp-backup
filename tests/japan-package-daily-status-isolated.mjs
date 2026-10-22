// Japan Package daily status (076) in disposable PostgreSQL, real RPC erp_apply_japan_package_transaction, real client
// request builder. Runs the same scenarios on a fresh install WITHOUT 076 (before) and WITH 076 (after):
//   new package -> registered; partial receiving; full receiving; cancel receiving; attach to a confirmed package;
//   historical 'arrived' and 'problem' packages (never converted, problem note kept); outbound eligibility
//   (status arrived/confirmed OR arrived_at) unchanged for partially received items.
// No Live connection.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';
import { isolatedDatabase } from './helpers/saveability-isolated.mjs';

const MIGRATION = '076_japan_package_daily_status_transitions.sql';
assert.ok(CANONICAL_FRESH_INSTALL_V3.includes(MIGRATION), '076 is part of the canonical fresh install');
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const ref = 'rhfdjsklfrgpoqsaqpkn';
const id = (n, s) => `${String(s).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const result = {};
try {
  const tx = await vite.ssrLoadModule('/src/providers/cloud/japanPackageTransaction.ts');
  const run = async label => {
    const db = await isolatedDatabase({ migrations: label === 'before' ? CANONICAL_FRESH_INSTALL_V3.filter(x => x !== MIGRATION) : CANONICAL_FRESH_INSTALL_V3 });
    const seq = { n: 100 };
    try {
      await db.sql.query("select set_config('request.headers',$1,false)", [JSON.stringify({ host: `${ref}.supabase.co` })]);
      const pkg = async pid => (await db.sql.query('select to_jsonb(t) r from public.japan_packages t where id=$1', [pid])).rows[0].r;
      const items = async pid => (await db.sql.query('select to_jsonb(t) r from public.japan_package_items t where japan_package_id=$1 and deleted_at is null order by id', [pid])).rows.map(x => x.r);
      const call = async (command, pid) => {
        const request = tx.buildJapanPackageTransactionRequest(pid ? await pkg(pid) : undefined, pid ? await items(pid) : [], command, ref);
        const r = (await db.sql.query('select public.erp_apply_japan_package_transaction($1,$2::jsonb) result', [command.idempotencyKey, JSON.stringify(request)])).rows[0].result;
        assert.equal(r.ok, true, `${label}: ${JSON.stringify(r).slice(0, 300)}`);
        return r;
      };
      const key = () => id(seq.n++, 9);
      const newPackage = async (n, status = 'registered', note = '') => {
        const pid = id(n, 1);
        await call({ idempotencyKey: key(), transactionType: 'create-package', package: { id: pid, title: `pkg ${n}`, status, note, created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z' } });
        return pid;
      };
      const attach = async (pid, n, count) => call({ idempotencyKey: key(), transactionType: 'attach-items', packageId: pid,
        items: Array.from({ length: count }, (_, i) => ({ id: id(n * 10 + i, 2), japan_package_id: pid, product_title: `item ${n}-${i}`, variant_name: 'A', sku: `SKU-${n}-${i}`, quantity: 1, checked: false, created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z' })) }, pid);
      const receive = async (pid, itemId, checked) => call({ idempotencyKey: key(), transactionType: 'set-receiving', packageId: pid,
        updates: [{ itemId, checked, ...(checked ? { checkedAt: '2026-10-21T03:00:00.000Z' } : {}) }] }, pid);
      const state = async pid => { const p = await pkg(pid); return { status: p.status, arrivedAt: Boolean(p.arrived_at), version: Number(p.version) }; };
      const outboundEligible = async pid => { const p = await pkg(pid); return p.status === 'arrived' || p.status === 'confirmed' || Boolean(p.arrived_at); };
      const r = {};

      // New package -> registered.
      const a = await newPackage(1);
      r.created = (await state(a)).status;
      await attach(a, 1, 2);
      r.afterAttach = (await state(a)).status;
      const [i1, i2] = (await items(a)).map(x => x.id);
      await receive(a, i1, true);
      r.partial = { ...(await state(a)), outboundEligible: await outboundEligible(a) };
      await receive(a, i2, true);
      r.full = (await state(a)).status;
      await receive(a, i1, false);
      r.cancelFromConfirmed = { ...(await state(a)), outboundEligible: await outboundEligible(a) };
      await receive(a, i1, true);
      r.fullAgain = (await state(a)).status;
      await attach(a, 3, 1);
      r.attachToConfirmed = (await state(a)).status;
      // Historical 'arrived' package (seeded directly like old data): never converted by partial / cancel.
      const b = await newPackage(4);
      await attach(b, 4, 2);
      await db.sql.query("update public.japan_packages set status='arrived', arrived_at='2026-10-01' where id=$1", [b]);
      const [b1, b2] = (await items(b)).map(x => x.id);
      await receive(b, b1, true);
      r.legacyArrivedPartial = (await state(b)).status;
      await receive(b, b1, false);
      r.legacyArrivedCancel = (await state(b)).status;
      await receive(b, b1, true); await receive(b, b2, true);
      r.legacyArrivedFull = (await state(b)).status;
      // Historical 'problem' package: receiving never changes it; the problem note is kept.
      const c = await newPackage(5);
      await attach(c, 5, 1);
      await db.sql.query("update public.japan_packages set status='problem', note='破損：盒角壓傷' where id=$1", [c]);
      await receive(c, (await items(c))[0].id, true);
      const cp = await pkg(c);
      r.legacyProblem = { status: cp.status, note: cp.note };
      // No row anywhere was ever written as 'arrived' by an operation in the "after" run (only the seeded one).
      r.arrivedRows = Number((await db.sql.query("select count(*) n from public.japan_packages where status='arrived'")).rows[0].n);
      // Function source after migration (no 'arrived' target left in the state machines).
      const src = (await db.sql.query("select string_agg(prosrc, '\n') s from pg_proc where proname in ('erp_apply_japan_package_transaction','erp_apply_related_transaction')")).rows[0].s;
      r.functionsWriteArrived = /v_target_status := 'arrived'|THEN 'arrived'/u.test(src);
      return r;
    } finally { await db.close(); }
  };
  result.before = await run('before');
  result.after = await run('after');
  const A = result.after;
  assert.equal(A.created, 'registered'); assert.equal(A.afterAttach, 'registered');
  assert.equal(A.partial.status, 'registered', 'partial receiving never auto-arrives and is never confirmed');
  assert.equal(A.partial.arrivedAt, true); assert.equal(A.partial.outboundEligible, result.before.partial.outboundEligible, 'outbound eligibility unchanged');
  assert.equal(A.full, 'confirmed');
  assert.equal(A.cancelFromConfirmed.status, 'registered'); assert.equal(A.cancelFromConfirmed.outboundEligible, true);
  assert.equal(A.fullAgain, 'confirmed'); assert.equal(A.attachToConfirmed, 'registered');
  assert.deepEqual([A.legacyArrivedPartial, A.legacyArrivedCancel, A.legacyArrivedFull], ['arrived', 'arrived', 'confirmed']);
  assert.deepEqual(A.legacyProblem, { status: 'problem', note: '破損：盒角壓傷' });
  assert.equal(A.functionsWriteArrived, false);
  // Before 076 the same operations produced 'arrived' (documents the root cause).
  assert.equal(result.before.partial.status, 'arrived'); assert.equal(result.before.cancelFromConfirmed.status, 'arrived');
  assert.equal(result.before.functionsWriteArrived, true);
  console.log(JSON.stringify({ result: 'PASS', ...result }, null, 1));
} finally { await vite.close(); }
