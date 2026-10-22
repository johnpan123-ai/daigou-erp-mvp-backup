import assert from 'node:assert/strict';
import{readFileSync}from'node:fs';
import{buildMigrationEffectRegistry}from'../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import{planSchemaDelta}from'../tools/schema-reconciliation/reconcile.mjs';
import{fingerprintStructuralSnapshot}from'../tools/schema-reconciliation/schemaContract.mjs';
const read=file=>JSON.parse(readFileSync('docs/schema-candidates/'+file));
const before=read('erp2-v32-waca-conflict-http409.snapshot.json'),after=read('erp2-v33-r5-source-capacity-receiving.snapshot.json');
const registry=await buildMigrationEffectRegistry();
const pre=planSchemaDelta(before,registry,{expectedSnapshot:after});
assert.deepEqual(pre.applyPlan.map(m=>m.migrationId),['078']);assert.deepEqual(pre.blockers,[]);
assert.ok(pre.migrations.filter(m=>m.migrationId!=='078').every(m=>m.state==='SATISFIED'));
const post=planSchemaDelta(after,registry,{expectedSnapshot:after});
assert.equal(post.readyForApply,true);assert.deepEqual(post.applyPlan,[]);assert.ok(post.migrations.every(m=>m.state==='SATISFIED'));
const first='public.erp_core_source_guard()';
const partial=structuredClone(before);partial.functions[first]=structuredClone(after.functions[first]);
assert.equal(planSchemaDelta(partial,registry,{expectedSnapshot:after}).readyForApply,false,'Partial core install cannot be reapplied');
for(const mutate of [
 s=>{s.functions[first].definition=s.functions[first].definition.replace('allocated>coalesce(capacity,0)','false');},
 s=>{s.functions[first].securityDefiner=false;},
 s=>{s.functions[first].authenticatedExecute=true;},
 s=>{s.tables['public.japan_package_items'].triggers.erp_core_capacity.definition=s.tables['public.japan_package_items'].triggers.erp_core_capacity.definition.replace('AFTER','BEFORE');},
 s=>{s.functions['public.erp_commit_waca_recognition(jsonb,jsonb)'].definition+='\nSELECT 42;';},
 s=>{s.functions['public.unrelated_rpc()']={definition:'SELECT 42',authenticatedExecute:true};},
]){
 const bad=structuredClone(after);mutate(bad);
 assert.notEqual(fingerprintStructuralSnapshot(bad),fingerprintStructuralSnapshot(after),'Negative must actually mutate schema');
 assert.equal(planSchemaDelta(bad,registry,{expectedSnapshot:after}).readyForApply,false);
}
console.log('PASS full v32->078 only delta, v33 zero delta; partial core, capacity bypass, ACL, trigger, WACA and unrelated RPC drift all blocked');
