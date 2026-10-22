// B1: bulk receiving after partial receiving, through the real path (authenticated PostgREST -> native PostgreSQL, full
// canonical v32 install incl. 076/077). Only items whose checked state changes are submitted; already checked items keep
// their original checked_at; the server F3 validation, CAS and atomicity are unchanged and exercised here.
// safeupdate is preloaded when WACA_TEST_SAFEUPDATE_LIBRARY is set (Windows/WSL release runner); its presence is reported.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';

const safeupdateLibrary = process.env.WACA_TEST_SAFEUPDATE_LIBRARY || undefined;
assert.ok(safeupdateLibrary, 'safeupdate is mandatory for the integration gate');
assert.ok(process.env.WACA_TEST_POSTGREST_BINARY, 'native PostgREST required');
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
const db = await isolatedDatabase({ migrations: CANONICAL_FRESH_INSTALL_V3, safeupdateLibrary, postgrestBinary: process.env.WACA_TEST_POSTGREST_BINARY });
const ref = 'rhfdjsklfrgpoqsaqpkn';
const id = (n, s) => `${String(s).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const q = (s, a) => db.sql.query(s, a);
const checks = {};
let seq = 900;
try {
  await q(readFileSync('supabase/sql/078_core_source_capacity_and_receiving.sql', 'utf8'));
  assert.ok(CANONICAL_FRESH_INSTALL_V3.includes('076_japan_package_daily_status_transitions.sql'));
  assert.ok(CANONICAL_FRESH_INSTALL_V3.includes('077_waca_custom_conflict_http409.sql'));
  const tx = await vite.ssrLoadModule('/src/providers/cloud/japanPackageTransaction.ts');
  const pkg = async pid => (await q('select to_jsonb(t) r from public.japan_packages t where id=$1', [pid])).rows[0].r;
  const items = async pid => (await q('select to_jsonb(t) r from public.japan_package_items t where japan_package_id=$1 and deleted_at is null order by id', [pid])).rows.map(x => x.r);
  const snapshot = async pid => ({ pkg: await pkg(pid), items: await items(pid),
    outbound: (await q('select to_jsonb(o) r from public.outbound_shipment_items o order by id')).rows.map(x => x.r) });
  const rpc = (request, key) => db.http('/rpc/erp_apply_japan_package_transaction', { p_idempotency_key: key, p_request: request }, owner,
    { headers: { host: `${ref}.supabase.co` } });
  const build = async (command, pid) => tx.buildJapanPackageTransactionRequest(await pkg(pid), await items(pid), command, ref);
  const key = () => id(seq++, 9);
  const ok = async (command, pid) => { const r = await rpc(await build(command, pid), command.idempotencyKey); assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.data.ok, true, JSON.stringify(r.data)); return r.data; };
  const create0 = async n => { const pid = id(n, 1); const command = { idempotencyKey: key(), transactionType: 'create-package', package: { id: pid, title: `bulk ${n}`, status: 'registered', created_at: '2026-10-22T00:00:00.000Z', updated_at: '2026-10-22T00:00:00.000Z' } };
    const r = await rpc(tx.buildJapanPackageTransactionRequest(undefined, [], command, ref), command.idempotencyKey); assert.equal(r.status, 200, JSON.stringify(r)); return pid; };
  const attach = async (pid, n, count) => ok({ idempotencyKey: key(), transactionType: 'attach-items', packageId: pid,
    items: Array.from({ length: count }, (_, i) => ({ id: id(n * 10 + i, 2), japan_package_id: pid, product_title: `item ${n}-${i}`, variant_name: 'A', sku: `SKU-${n}-${i}`, quantity: 2, checked: false,
      created_at: '2026-10-22T00:00:00.000Z', updated_at: '2026-10-22T00:00:00.000Z' })) }, pid);
  const setReceiving = (pid, ids, checked, at = '2026-10-22T05:00:00.000Z') => ({ idempotencyKey: key(), transactionType: 'set-receiving', packageId: pid,
    updates: ids.map(itemId => ({ itemId, checked, ...(checked ? { checkedAt: at } : {}) })) });

  await db.startPostgrest();
  checks.safeupdate = safeupdateLibrary ? 'preloaded' : 'not available in this runner (reported, not assumed)';

  // 1. All unchecked -> bulk check succeeds, every item submitted once.
  const p1 = await create0(1); await attach(p1, 1, 3);
  const ids1 = (await items(p1)).map(x => x.id);
  const all1 = await build(setReceiving(p1, ids1, true), p1);
  assert.equal(all1.itemOperations.length, 3);
  await ok(setReceiving(p1, ids1, true), p1);
  checks.allUnchecked = { status: (await pkg(p1)).status, checked: (await items(p1)).filter(x => x.checked).length };
  assert.deepEqual(checks.allUnchecked, { status: 'confirmed', checked: 3 });

  // 2. Root cause: 5 items, 2 already checked (original time T0). The old request shape (re-sending the 2 checked items with
  //    only a new checked_at) is rejected as F3_RECEIVING_FIELDS_INVALID and changes nothing (whole batch rolled back).
  const p2 = await create0(2); await attach(p2, 2, 5);
  const ids2 = (await items(p2)).map(x => x.id);
  await ok(setReceiving(p2, ids2.slice(0, 2), true, '2026-10-20T01:00:00.000Z'), p2);
  const t0 = (await items(p2)).filter(x => x.checked).map(x => [x.id, x.checked_at]);
  const before2 = await snapshot(p2);
  const legacy = await build(setReceiving(p2, ids2.slice(2), true), p2);
  const p2items = await items(p2);
  for (const checkedItem of p2items.filter(x => x.checked)) legacy.itemOperations.push({ kind: 'patch', id: checkedItem.id,
    expected: { checked_at: checkedItem.checked_at }, changes: { checked_at: '2026-10-22T05:00:00.000Z' }, observedVersion: Number(checkedItem.version) });
  const legacyResult = await rpc(legacy, key());
  checks.legacyShape = { status: legacyResult.status, message: legacyResult.data?.message };
  assert.equal(legacyResult.status, 400); assert.equal(legacyResult.data?.message, 'F3_RECEIVING_FIELDS_INVALID');
  assert.deepEqual(await snapshot(p2), before2, 'rejected batch changes nothing');

  // 3. Fixed builder: "全部點收" with all 5 ids submits only the remaining 3; the 2 keep T0.
  const fixed = await build(setReceiving(p2, ids2, true), p2);
  checks.partialToAll = { submitted: fixed.itemOperations.length, ids: fixed.itemOperations.map(o => o.id).sort().join() === ids2.slice(2).sort().join() };
  assert.equal(fixed.itemOperations.length, 3); assert.equal(checks.partialToAll.ids, true);
  for (const op of fixed.itemOperations) { assert.deepEqual(Object.keys(op.changes).sort(), ['checked', 'checked_at']); assert.equal(op.changes.checked, true); }
  const fixedKey = key();
  const r3 = await rpc(fixed, fixedKey); assert.equal(r3.status, 200, JSON.stringify(r3)); assert.equal(r3.data.ok, true);
  const after3 = await items(p2);
  assert.equal(after3.filter(x => x.checked).length, 5);
  assert.deepEqual(after3.filter(x => t0.some(([i]) => i === x.id)).map(x => [x.id, x.checked_at]), t0, 'already checked items keep their original checked_at');
  assert.equal((await pkg(p2)).status, 'confirmed');
  checks.partialToAll.status = 'confirmed'; checks.partialToAll.originalCheckedAtKept = true;

  // 5. Repeat of the same request (same idempotency key) is a replay: no further write.
  const beforeReplay = await snapshot(p2);
  const replay = await rpc(fixed, fixedKey);
  assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true, JSON.stringify(replay.data));
  assert.deepEqual(await snapshot(p2), beforeReplay, 'replay writes nothing');
  checks.replay = 'replayed, 0 write';

  // 3b. All already checked -> nothing to submit (no RPC, no version change).
  assert.throws(() => tx.buildJapanPackageTransactionRequest(beforeReplay.pkg, beforeReplay.items, setReceiving(p2, ids2, true), ref),
    error => error.message === tx.JAPAN_PACKAGE_RECEIVING_NO_CHANGE);
  checks.allCheckedNoWrite = true;

  // 4. Partial -> "取消全部" submits only the checked items.
  const p4 = await create0(4); await attach(p4, 4, 5);
  const ids4 = (await items(p4)).map(x => x.id);
  await ok(setReceiving(p4, ids4.slice(0, 3), true), p4);
  const cancel = await build(setReceiving(p4, ids4, false), p4);
  assert.equal(cancel.itemOperations.length, 3);
  for (const op of cancel.itemOperations) { assert.equal(op.changes.checked, false); assert.equal(op.changes.checked_at, null); }
  await ok(setReceiving(p4, ids4, false), p4);
  checks.cancelPartial = { submitted: 3, checked: (await items(p4)).filter(x => x.checked).length, status: (await pkg(p4)).status };
  assert.deepEqual(checks.cancelPartial, { submitted: 3, checked: 0, status: 'registered' });

  // 6. CAS: a stale item version in the batch rejects the whole batch with no change.
  const p6 = await create0(6); await attach(p6, 6, 4);
  const ids6 = (await items(p6)).map(x => x.id);
  await ok(setReceiving(p6, [ids6[0]], true), p6);
  const stale = await build(setReceiving(p6, ids6, true), p6);
  assert.equal(stale.itemOperations.length, 3);
  stale.itemOperations[1].observedVersion = Number(stale.itemOperations[1].observedVersion) + 5;
  const before6 = await snapshot(p6);
  const r6 = await rpc(stale, key());
  checks.cas = { status: r6.status, ok: r6.data?.ok, code: r6.data?.code ?? r6.data?.message };
  assert.ok(r6.status >= 400 || r6.data?.ok === false, JSON.stringify(r6));
  assert.deepEqual(await snapshot(p6), before6, 'stale batch rolls back completely (no partial success)');

  // 7. Outbound allocation is untouched by bulk receiving.
  const p7 = await create0(7); await attach(p7, 7, 3);
  const ids7 = (await items(p7)).map(x => x.id);
  await ok(setReceiving(p7, [ids7[0]], true), p7);
  const shipment = id(70, 3);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  await q("insert into public.outbound_shipments(id,title,status) values($1,'bulk test','draft')", [shipment]);
  await q("insert into public.outbound_shipment_items(id,outbound_shipment_id,japan_package_item_id,sku,quantity,checked) values($1,$2,$3,'SKU-7-0',2,false)", [id(71, 3), shipment, ids7[0]]);
  const outboundBefore = (await snapshot(p7)).outbound;
  await ok(setReceiving(p7, ids7, true), p7);
  assert.deepEqual((await snapshot(p7)).outbound, outboundBefore, 'outbound rows unchanged');
  assert.equal((await pkg(p7)).status, 'confirmed');
  checks.outboundUntouched = true;

  // Integration: one allocated source refuses the entire bulk cancellation, including free rows.
  const beforeCancel = await snapshot(p7);
  const refused = await rpc(await build(setReceiving(p7, ids7, false), p7), key());
  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.equal(refused.data.message, 'CORE_SOURCE_CAPACITY');
  assert.deepEqual(await snapshot(p7), beforeCancel, 'allocated bulk cancellation rolls back every item and header');
  await ok(setReceiving(p7, ids7.slice(1), false), p7);
  assert.equal((await pkg(p7)).status, 'registered');
  assert.equal((await items(p7)).filter(x => x.checked).length, 1);
  checks.allocatedBulkCancelAtomic = true;
  checks.freeRowsCancelNormally = true;

  console.log(JSON.stringify({ result: 'PASS', engine: 'Native PostgreSQL (canonical v32) + authenticated PostgREST', checks }, null, 2));
} finally { await db.close(); await vite.close(); }
