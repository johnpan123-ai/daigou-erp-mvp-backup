import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isolatedDatabase} from './helpers/saveability-isolated.mjs';
import {CANONICAL_FRESH_INSTALL_V3} from '../supabase/canonicalFreshInstallV3.mjs';
import {buildMigrationEffectRegistry} from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import {planSchemaDelta} from '../tools/schema-reconciliation/reconcile.mjs';
import {fingerprintStructuralSnapshot,fingerprintStructuralSnapshotV2} from '../tools/schema-reconciliation/schemaContract.mjs';
const files=CANONICAL_FRESH_INSTALL_V3.slice(-4);
assert.deepEqual(files,['049_private_order_atomic_transaction.sql','050_catalog_atomic_transaction.sql','051_related_saveability_atomic_transactions.sql','052_waca_master_link_delta_merge.sql']);
const base=CANONICAL_FRESH_INSTALL_V3.slice(0,-4);
const read=p=>readFileSync(p,'utf8');
const capture=async db=>{
  const snapshot=(await db.sql.query(read('tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql'))).rows[0].erp_schema_snapshot;
  snapshot.identity.projectRef='rhfdjsklfrgpoqsaqpkn';
  snapshot.integrity.inventoryItems=(await db.sql.query(read('tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql'))).rows[0].inventory_items_integrity;
  snapshot.completeness.inventoryIntegrity=true;return snapshot;
};
const registry=await buildMigrationEffectRegistry();
const fresh=await isolatedDatabase({migrations:CANONICAL_FRESH_INSTALL_V3});let upgrade;
try{
  upgrade=await isolatedDatabase({migrations:base});
  const before=await capture(upgrade);const plan=planSchemaDelta(before,registry);
  assert.equal(fingerprintStructuralSnapshotV2(before),'bc0cb320bb57dce141b7ce9c24990097f35ce739e441c7835fbe20ca5b64d317');
  assert.equal(plan.readyForApply,true);assert.deepEqual(plan.applyPlan.map(e=>e.migrationId),['049','050','051','052']);
  assert.equal(plan.blockers.length,0);
  const businessSnapshot=async db=>(await db.sql.query('select public.erp_cloud_restore_snapshot() result')).rows[0].result;
  const oldBusiness=await businessSnapshot(upgrade);
  assert.equal(Object.keys(oldBusiness).length,24);
  const partialPlans=[];
  for(const [index,file] of files.entries()){
    await upgrade.sql.query(read('supabase/sql/'+file));
    const stage=planSchemaDelta(await capture(upgrade),registry);
    const remaining=files.slice(index+1).map(entry=>entry.slice(0,3));
    assert.equal(stage.readyForApply,true);assert.equal(stage.blockers.length,0);
    assert.deepEqual(stage.applyPlan.map(entry=>entry.migrationId),remaining);
    assert.deepEqual(await businessSnapshot(upgrade),oldBusiness,'Migration changed durable business data:'+file);
    partialPlans.push({applied:file.slice(0,3),remaining});
  }
  const after=await capture(upgrade);const canonical=await capture(fresh);
  const contract=JSON.parse(read('config/erp-environment-identity.json'));
  assert.equal(contract.schemaBaseline.canonicalFingerprint,fingerprintStructuralSnapshot(canonical),'Candidate canonical source identity stale');
  assert.equal(contract.schemaBaseline.requiredBaselineId,'erp2-canonical-schema-v6-waca-master-delta');
  assert.equal(fingerprintStructuralSnapshot(after),fingerprintStructuralSnapshot(canonical),'Fresh/048-upgrade schema drift');
  assert.deepEqual(Object.keys(after.tables).sort(),Object.keys(before.tables).sort(),'Migration added business tables');
  assert.deepEqual(await businessSnapshot(upgrade),oldBusiness,'Additive source changed business rows');
  const finalPlan=planSchemaDelta(after,registry);assert.equal(finalPlan.blockers.length,0);assert.equal(finalPlan.applyPlan.length,0);
  for(const file of files)await upgrade.sql.query(read('supabase/sql/'+file));
  assert.equal(fingerprintStructuralSnapshot(await capture(upgrade)),fingerprintStructuralSnapshot(after),'Migration reapply drift');
  for(const signature of ['erp_apply_private_order_transaction(uuid,jsonb)','erp_reconcile_private_order_transaction(uuid,jsonb)','erp_apply_catalog_transaction(uuid,jsonb)','erp_apply_related_transaction(uuid,jsonb)']){
    const acl=(await upgrade.sql.query(`select has_function_privilege('anon',$1,'execute') anon,
      has_function_privilege('authenticated',$1,'execute') authenticated,
      has_function_privilege('service_role',$1,'execute') service`,['public.'+signature])).rows[0];
    assert.deepEqual(acl,{anon:false,authenticated:true,service:false});
    const fn=(await upgrade.sql.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure',['public.'+signature])).rows[0];
    assert.equal(fn.prosecdef,true);assert.ok(fn.proconfig.some(v=>/^search_path=""$/u.test(v)));
  }
  for(const file of base){
    const baseline=execFileSync('git',['show','450eba3f95dfb5ada5f35e4df113be01d997784a:supabase/sql/'+file]);
    const current=readFileSync('supabase/sql/'+file);
    const hash=b=>createHash('sha256').update(b.toString('utf8').replaceAll('\r\n','\n')).digest('hex');
    assert.equal(hash(current),hash(baseline),'Previously adopted SQL changed:'+file);
  }
  console.log(JSON.stringify({PASS:true,engine:'native PostgreSQL',isolated048Delta:plan.applyPlan.map(e=>e.migrationId),freshUpgradeParity:true,
    v4Fingerprint:fingerprintStructuralSnapshotV2(before),semanticFingerprint:fingerprintStructuralSnapshot(after),partialPlans,
    reapply:true,existingMigrationChecksumsUnchanged:true,ACL:true,newTables:0,newDurableResources:0,businessFixtureMutation:0,liveApply:0}));
}finally{await upgrade?.close();await fresh.close();}
