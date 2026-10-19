import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isolatedDatabase } from './helpers/saveability-isolated.mjs';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';
import { fingerprintStructuralSnapshot, diffStructuralSnapshots } from '../tools/schema-reconciliation/schemaContract.mjs';
import { buildMigrationEffectRegistry } from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import { planSchemaDelta } from '../tools/schema-reconciliation/reconcile.mjs';
const file = '074_waca_counted_state_safeupdate.sql';
const old = readFileSync('supabase/sql/073_waca_counted_transition_import.sql');
assert.equal(createHash('sha256').update(old).digest('hex'), 'f96b253bacaa129d5d3757d9055a40619f6e83339502c21c5abcda2b8b5c42a6');
const db = await isolatedDatabase({ migrations: CANONICAL_FRESH_INSTALL_V3.filter(f => f !== file) });
try {
  const capture = async () => {
    const s = (await db.sql.query(readFileSync('tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql', 'utf8'))).rows[0].erp_schema_snapshot;
    s.integrity.inventoryItems = (await db.sql.query(readFileSync('tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql', 'utf8'))).rows[0].inventory_items_integrity;
    s.completeness.inventoryIntegrity = true;
    return s;
  };
  const business = async () => (await db.sql.query(`select public.erp_export_cloud_restore_snapshot_json() business,
    (select epoch from public.erp_cloud_restore_epoch where singleton) epoch,
    (select generation from public.erp_restore_business_generation where singleton) generation`)).rows[0];
  const before = await capture(), data = await business();
  assert.equal(fingerprintStructuralSnapshot(before), 'b66a94b2744874394cdc16996ed7d372633e4a387428fa13ca933e80c33d3601');
  await db.sql.query(readFileSync('supabase/sql/' + file, 'utf8'));
  assert.deepEqual(await business(), data);
  const after = await capture(), diff = diffStructuralSnapshots(before, after);
  const signature = 'public.erp_commit_waca_counted_snapshot(jsonb,bigint,jsonb)';
  const expected = structuredClone(before); expected.functions[signature].definition = after.functions[signature].definition;
  assert.equal(diffStructuralSnapshots(expected, after).semanticEqual, true, 'Only counted RPC definition may change, not ACL/config/owner or any other object');
  const bodyBefore = before.functions[signature].definition.replaceAll('\r\n', '\n');
  const bodyAfter = after.functions[signature].definition.replaceAll('\r\n', '\n');
  assert.equal(bodyAfter, bodyBefore.replace('  v_now timestamptz := now();', '  v_state_rows bigint;\n  v_now timestamptz := now();')
    .replace('    updated_at=v_now, updated_by=v_actor;', "    updated_at=v_now, updated_by=v_actor\n    where id='00000000-0000-4000-8000-000000000001'::uuid and revision=v_revision+1;\n  get diagnostics v_state_rows = row_count;\n  if v_state_rows <> 1 then\n    raise exception using errcode='23514',message='WACA_COUNTED_STATE_UPDATE_MISMATCH';\n  end if;"));
  const contract = JSON.parse(readFileSync('config/erp-environment-identity.json'));
  assert.equal(fingerprintStructuralSnapshot(after), contract.schemaBaseline.canonicalFingerprint);
  const registry = await buildMigrationEffectRegistry();
  const plan = planSchemaDelta(before, registry, { expectedSnapshot: after });
  const self = planSchemaDelta(after, registry, { expectedSnapshot: after });
  assert.equal(self.readyForApply, true, JSON.stringify(self.blockers));
  const result = { result: 'PASS', classification: 'SCHEMA_FUNCTION_CHANGE_NOT_UI_ONLY', before: fingerprintStructuralSnapshot(before),
    after: fingerprintStructuralSnapshot(after), migrationBusinessMutation: 0, changedObject: signature,
    migration073Unchanged: true, diff, plan, postApplyIsolated: self, liveApply: false, ledgerWrites: 0 };
  if (process.env.WACA_074_SCHEMA_EVIDENCE) writeFileSync(process.env.WACA_074_SCHEMA_EVIDENCE, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...result, diff: diff.semanticDifferences, plan: { ready: plan.readyForApply, blockers: plan.blockers,
    apply: plan.migrations.filter(m => m.state !== 'SATISFIED').map(m => ({ id: m.migrationId, state: m.state })) }, postApplyIsolated: self.readyForApply }, null, 2));
} finally { await db.close(); }
