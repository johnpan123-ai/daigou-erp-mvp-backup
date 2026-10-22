// Migration 076 schema gate on disposable native PostgreSQL (no Live connection):
// v30 (canonical up to 075) -> apply the exact 076 source -> v31.
// Proves: business mutation 0 (24 resources, epoch, generation), no table/column/index/grant change, only the two
// reviewed functions change, and each new definition equals the old one with exactly the anchored fragments replaced
// (so CAS / idempotency / advisory locks / editor checks / rollback paths are byte-identical); owner, SECURITY DEFINER,
// config and ACL unchanged; reconciliation pre = only 076 NEEDS_APPLY, post = 45/45 SATISFIED; a second run fails closed
// without any change; fingerprint == contract v31.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isolatedDatabase } from './helpers/saveability-isolated.mjs';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';
import { buildMigrationEffectRegistry } from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import { planSchemaDelta } from '../tools/schema-reconciliation/reconcile.mjs';
import { fingerprintStructuralSnapshot, diffStructuralSnapshots } from '../tools/schema-reconciliation/schemaContract.mjs';

const migration = '076_japan_package_daily_status_transitions.sql';
const source = readFileSync('supabase/sql/' + migration, 'utf8');
const contract = JSON.parse(readFileSync('config/erp-environment-identity.json', 'utf8'));
const db = await isolatedDatabase({ migrations: CANONICAL_FRESH_INSTALL_V3.slice(0, CANONICAL_FRESH_INSTALL_V3.indexOf(migration)) });
const JP = 'public.erp_apply_japan_package_transaction(uuid,jsonb)', REL = 'public.erp_apply_related_transaction(uuid,jsonb)';
const between = (text, start, end) => { const a = text.indexOf(start); const b = text.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a, `anchor ${start}`); return text.slice(a + start.length, b); };
try {
  const capture = async () => {
    const s = (await db.sql.query(readFileSync('tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql', 'utf8'))).rows[0].erp_schema_snapshot;
    s.integrity.inventoryItems = (await db.sql.query(readFileSync('tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql', 'utf8'))).rows[0].inventory_items_integrity;
    s.completeness.inventoryIntegrity = true; s.identity.projectRef = 'rhfdjsklfrgpoqsaqpkn'; return s;
  };
  const data = async () => (await db.sql.query(`select public.erp_export_cloud_restore_snapshot_json() business,
    (select to_jsonb(e) from public.erp_cloud_restore_epoch e where singleton) epoch,
    (select generation from public.erp_restore_business_generation where singleton) generation`)).rows[0];
  // Representative business rows including historical arrived / problem packages (must survive untouched).
  await db.sql.query(`insert into public.japan_packages(id,title,status,arrived_at,note) values
    ('20000000-0000-4000-8000-000000000001','legacy arrived','arrived','2026-10-01',''),
    ('20000000-0000-4000-8000-000000000002','legacy problem','problem',null,'破損：盒角壓傷'),
    ('20000000-0000-4000-8000-000000000003','registered','registered',null,'')`);
  const before = await capture(), business = await data();
  assert.equal(fingerprintStructuralSnapshot(before), '5be9d80aeb00f2ab741904181660b46e0f5c2e238422c87dca41aa1fde5537f0', 'v30 base');
  await db.sql.query(source);
  assert.deepEqual(await data(), business, 'Migration 076 changes no business data / epoch / generation');
  const after = await capture();
  assert.deepEqual(after.tables, before.tables, 'No table / column / index / grant change');
  const expected = structuredClone(before); expected.functions = after.functions;
  assert.equal(diffStructuralSnapshots(expected, after).semanticEqual, true, 'Function-only change');
  const changed = Object.keys(after.functions).filter(sig => JSON.stringify(after.functions[sig]) !== JSON.stringify(before.functions[sig])).sort();
  assert.deepEqual(changed, [JP, REL].sort(), 'Only the two reviewed RPCs change');
  for (const sig of changed) {
    const { definition: d0, ...meta0 } = before.functions[sig]; const { definition: d1, ...meta1 } = after.functions[sig];
    assert.deepEqual(meta1, meta0, `${sig}: owner / security definer / config / ACL / signature unchanged`);
  }
  // Exact text proof: new body == old body with only the anchored fragments replaced.
  const norm = v => v.replaceAll('\r\n', '\n');
  const fragments = (open, close) => [norm(between(source, open, close)), null];
  const [oldState] = fragments("v_jp_old_state text := $old$", '$old$;'), [newState] = fragments("v_jp_new_state text := $new$", '$new$;');
  const [oldUpdate] = fragments("v_jp_old_update text := $old$", '$old$;'), [newUpdate] = fragments("v_jp_new_update text := $new$", '$new$;');
  const oldRel = "ELSE CASE WHEN p.status='confirmed' THEN 'arrived' ELSE p.status END END", newRel = "ELSE CASE WHEN p.status='confirmed' THEN 'registered' ELSE p.status END END";
  const jp0 = norm(before.functions[JP].definition), jp1 = norm(after.functions[JP].definition);
  const rel0 = norm(before.functions[REL].definition), rel1 = norm(after.functions[REL].definition);
  // The snapshot stores canonicalized definitions; compare through the same normalization on both sides.
  assert.equal(jp1, jp0.replace(oldState.trim(), newState.trim()).replace(oldUpdate.trim(), newUpdate.trim()), 'JP RPC: only state + update fragments replaced');
  assert.equal(rel1, rel0.replaceAll(oldRel, newRel), 'Related RPC: only the two reopen fragments replaced');
  assert.ok(!/v_target_status := 'arrived'/u.test(jp1) && !rel1.includes("THEN 'arrived'"), 'No operation path produces arrived');
  for (const guard of ['NOT public.is_editor(v_actor)', 'ON CONFLICT (actor_id, idempotency_key) DO NOTHING', 'pg_advisory_xact_lock', 'FIELD_CONFLICT', 'F3_STRUCTURED_ROLLBACK', 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH'])
    assert.ok(jp1.includes(guard), `JP guard retained: ${guard}`);
  assert.equal(fingerprintStructuralSnapshot(after), '76b44aa27ed32c540272da5e210df75d09cc55d5d0d3d993e41b060f403e0b16', 'v31 contract fingerprint');
  // This independently reviewed 076 gate deliberately ends at v31; 077 has its own full gate.
  const registry = Object.fromEntries(Object.entries(await buildMigrationEffectRegistry()).filter(([id])=>id!=='077'));
  const pre = planSchemaDelta(before, registry, { expectedSnapshot: after });
  const post = planSchemaDelta(after, registry, { expectedSnapshot: after });
  assert.equal(pre.readyForApply, true, JSON.stringify(pre.blockers)); assert.deepEqual(pre.applyPlan.map(x => x.migrationId), ['076']);
  assert.equal(pre.migrations.filter(m => m.state === 'SATISFIED').length, 44);
  assert.equal(post.readyForApply, true, JSON.stringify(post.blockers)); assert.deepEqual(post.applyPlan, []);
  assert.equal(post.migrations.length, 45); assert.ok(post.migrations.every(m => m.state === 'SATISFIED' && m.applyMethod === 'NO_APPLY'));
  // A second execution fails closed and changes nothing.
  let rerun = null;
  try { await db.sql.query(source); } catch (error) { rerun = error.message; }
  assert.match(String(rerun), /JP_DAILY_STATUS_STATE_ANCHOR_MISMATCH/u);
  await db.sql.query('rollback').catch(() => {});
  assert.equal(fingerprintStructuralSnapshot(await capture()), '76b44aa27ed32c540272da5e210df75d09cc55d5d0d3d993e41b060f403e0b16'); assert.deepEqual(await data(), business);
  const legacy = (await db.sql.query("select id::text,status,arrived_at::text,note from public.japan_packages order by id")).rows;
  console.log(JSON.stringify({ result: 'PASS', classification: 'SCHEMA_RPC_CHANGE_NOT_UI_ONLY', before: fingerprintStructuralSnapshot(before),
    after: fingerprintStructuralSnapshot(after), sourceSha256: createHash('sha256').update(readFileSync('supabase/sql/' + migration)).digest('hex'),
    businessMutation: 0, changedFunctions: changed, preApplyPlan: pre.applyPlan.map(x => x.migrationId), postApply: '45/45 SATISFIED',
    rerun: 'FAIL_CLOSED_NO_CHANGE', legacyRowsPreserved: legacy, cloudApply: 0, ledgerWrites: 0 }, null, 1));
} finally { await db.close(); }
