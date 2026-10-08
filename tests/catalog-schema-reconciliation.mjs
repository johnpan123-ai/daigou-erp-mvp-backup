import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isolatedDatabase } from './helpers/saveability-isolated.mjs';
import { buildMigrationEffectRegistry } from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import { planSchemaDelta } from '../tools/schema-reconciliation/reconcile.mjs';

const db = await isolatedDatabase();
try {
  const snapshot = (await db.sql.query(await readFile('tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql','utf8'))).rows[0].erp_schema_snapshot;
  snapshot.integrity.inventoryItems = (await db.sql.query(await readFile('tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql','utf8'))).rows[0].inventory_items_integrity;
  snapshot.completeness.inventoryIntegrity = true;
  const registry = await buildMigrationEffectRegistry();
  const plan = planSchemaDelta(snapshot, registry, { expectedSnapshot: snapshot });
  assert.equal(plan.readyForApply, true);
  assert.deepEqual(plan.applyPlan, []);
  for (const id of ['050','056']) {
    assert.equal(plan.migrations.find(m=>m.migrationId===id).state, 'SATISFIED');
  }
  assert.equal(plan.migrations.find(m=>m.migrationId==='070').state, 'SATISFIED');
  // A supersession never accepts incomplete helpers, exposed ACL, removed
  // provenance validation, or an altered canonical function definition.
  for (const mutate of [
    s=>{delete s.functions['public.erp_apply_catalog_fields_set_based(text,jsonb)'];},
    s=>{s.functions['public.erp_apply_catalog_fields_set_based(text,jsonb)'].authenticatedExecute=true;},
    s=>{s.functions['public.erp_apply_catalog_transaction(uuid,jsonb)'].definition=s.functions['public.erp_apply_catalog_transaction(uuid,jsonb)'].definition.replaceAll('CATALOG_PROVENANCE_TRANSITION_FORBIDDEN','REMOVED_PROVENANCE');},
    s=>{s.functions['public.erp_reconcile_catalog_transaction(uuid,jsonb)'].anonExecute=true;},
    s=>{s.functions['public.erp_apply_catalog_transaction(uuid,jsonb)'].definition+='\n SELECT unsafe_extra_call();';},
  ]) {
    const drift=structuredClone(snapshot); mutate(drift);
    assert.equal(planSchemaDelta(drift,registry,{expectedSnapshot:snapshot}).readyForApply,false);
  }
  console.log('PASS exact 070 supersession closes 050/056 delta; five negative drift/ACL/contracts fail closed');
} finally { await db.close(); }
