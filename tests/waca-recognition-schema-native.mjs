import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isolatedDatabase} from './helpers/saveability-isolated.mjs';
import {CANONICAL_FRESH_INSTALL_V3} from '../supabase/canonicalFreshInstallV3.mjs';
import {fingerprintStructuralSnapshot,diffStructuralSnapshots} from '../tools/schema-reconciliation/schemaContract.mjs';
import {buildMigrationEffectRegistry} from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import {planSchemaDelta} from '../tools/schema-reconciliation/reconcile.mjs';
const migration='075_waca_order_recognition_management.sql';
// Historical 075 gate: v29 (everything before 075) -> v30; later candidates (076) are reconciled separately.
const db=await isolatedDatabase({migrations:CANONICAL_FRESH_INSTALL_V3.slice(0,CANONICAL_FRESH_INSTALL_V3.indexOf(migration))});
try {
  const capture=async()=>{
    const s=(await db.sql.query(readFileSync('tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql','utf8'))).rows[0].erp_schema_snapshot;
    s.integrity.inventoryItems=(await db.sql.query(readFileSync('tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql','utf8'))).rows[0].inventory_items_integrity;
    s.completeness.inventoryIntegrity=true;return s;};
  const data=async()=>(await db.sql.query(`select public.erp_export_cloud_restore_snapshot_json() business,
    (select epoch from public.erp_cloud_restore_epoch where singleton) epoch,
    (select generation from public.erp_restore_business_generation where singleton) generation`)).rows[0];
  const before=await capture(),business=await data();assert.equal(fingerprintStructuralSnapshot(before),'8410d8090f11ac1441c803b01d2d364f552fcb07d58386d03463d238f026c1fa');
  await db.sql.query(readFileSync('supabase/sql/'+migration,'utf8'));assert.deepEqual(await data(),business);
  const after=await capture();assert.deepEqual(after.tables,before.tables,'No business/OPS schema expansion, indexes or table permissions');
  const expected=structuredClone(before);expected.functions=after.functions;
  assert.equal(diffStructuralSnapshots(expected,after).semanticEqual,true,'Function-only candidate');
  const allowed=new Set(['erp_commit_waca_snapshot','erp_commit_waca_snapshot_v044','erp_commit_waca_counted_snapshot','erp_commit_waca_counted_snapshot_v074',
    'erp_waca_reversal_keys','erp_waca_reversal_proven','erp_store_waca_recognition_continuity','erp_assert_waca_recognition_preserved',
    'erp_plan_waca_recognition','erp_preview_waca_recognition','erp_commit_waca_recognition','erp_prune_waca_recognition_evidence']);
  for(const [sig,fn] of Object.entries(after.functions))if(!allowed.has(sig.split('.')[1].split('(')[0]))assert.deepEqual(fn,before.functions[sig],sig);
  const registry=await buildMigrationEffectRegistry(),pre=planSchemaDelta(before,registry,{expectedSnapshot:after}),post=planSchemaDelta(after,registry,{expectedSnapshot:after});
  assert.equal(pre.readyForApply,true,JSON.stringify(pre.blockers));assert.deepEqual(pre.applyPlan.map(x=>x.migrationId),['075','076','077']);
  assert.equal(post.readyForApply,true,JSON.stringify(post.blockers));assert.deepEqual(post.applyPlan.map(x=>x.migrationId),['076','077']);
  assert.equal(post.migrations.length,46);assert.ok(post.migrations.every(m=>['076','077'].includes(m.migrationId) ? m.state==='NEEDS_APPLY' : (m.state==='SATISFIED' && m.applyMethod==='NO_APPLY')));
  assert.equal(fingerprintStructuralSnapshot(after),'5be9d80aeb00f2ab741904181660b46e0f5c2e238422c87dca41aa1fde5537f0');
  const result={result:'PASS',classification:'SCHEMA_RPC_CHANGE_NOT_UI_ONLY',before:fingerprintStructuralSnapshot(before),after:fingerprintStructuralSnapshot(after),
    sourceSha256:createHash('sha256').update(readFileSync('supabase/sql/'+migration)).digest('hex'),businessMutation:0,resources:24,newTable:0,newColumn:0,
    preApplyPlan:pre.applyPlan,postApplyPlan:post.applyPlan,repairDelegatesPrivate:true,historicalMigrationExecutionClaimed:false,cloudApply:0,ledgerWrites:0};
  if(process.env.WACA_075_SCHEMA_EVIDENCE)writeFileSync(process.env.WACA_075_SCHEMA_EVIDENCE,JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify(result,null,2));
} finally {await db.close();}
