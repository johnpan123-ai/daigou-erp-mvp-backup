import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildMigrationEffectRegistry} from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import {planSchemaDelta, reconcileMigration} from '../tools/schema-reconciliation/reconcile.mjs';
import {verifySchemaBaselineEvidence} from '../scripts/promotion-safety.mjs';
import {fingerprintStructuralSnapshot} from '../tools/schema-reconciliation/schemaContract.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
// Current candidate canonical (v31 = v30 + 076; the 075-retained WACA implementations are byte-identical in both).
const canonical = read('../docs/schema-candidates/erp2-v32-waca-conflict-http409.snapshot.json');
const contract = read('../config/erp-environment-identity.json');
const registry = await buildMigrationEffectRegistry();
const head = '1'.repeat(40), checkpoint = 'checkpoint-isolated-retained-implementation';
const now = Date.now(), capturedAt = new Date(now).toISOString();
const snapshot = structuredClone(canonical);
snapshot.identity = {...snapshot.identity, projectRef:'rhfdjsklfrgpoqsaqpkn', environmentRole:'PRODUCTION'};
snapshot.capturedAt = capturedAt;
snapshot.integrity = {inventoryItems:{result:'PASS',nullIdCount:0,invalidUuidCount:0,duplicateIdCount:0,
  duplicateInventoryKeyCount:0,dependentReferenceViolationCount:0}};
snapshot.completeness.inventoryIntegrity = true;
snapshot.migrationHistory = {available:true,entries:{},records:[{
  eventType:'BASELINE_ADOPTED',eventKey:contract.schemaBaseline.requiredBaselineId,result:'PASS',
  sourceHead:head,checkpoint,supabaseProjectRef:'rhfdjsklfrgpoqsaqpkn',environmentRole:'PRODUCTION',
  schemaFingerprintAfter:contract.schemaBaseline.canonicalFingerprint,
  metadata:{historicalMigrationExecutionClaimed:false},
}]};
const plan = s => planSchemaDelta(s,registry,{expectedSnapshot:canonical,sourceHead:head,checkpoint,
  requiredBaselineId:contract.schemaBaseline.requiredBaselineId,mode:'POST_ADOPTION',
  snapshotToolChecksum:contract.schemaBaseline.snapshotToolChecksum});
const verify = p => verifySchemaBaselineEvidence({evidence:p,contract,candidate:{head,checkpointTag:checkpoint},
  migrationRegistry:registry,liveObservation:{projectRef:'rhfdjsklfrgpoqsaqpkn',fingerprint:p.currentFingerprint,observedAt:capturedAt},now});
let checks = 0;
const positive = plan(snapshot);
assert.equal(positive.migrations.length,46);
assert.ok(positive.migrations.every(item=>item.state==='SATISFIED' && item.applyMethod==='NO_APPLY'));
assert.deepEqual(positive.applyPlan,[]);
assert.equal(verify(positive).deploymentLineage.mode,'EXACT_BASELINE'); checks++;
console.log('PASS canonical v32 -> 46/46 -> original strict POST_ADOPTION');

const chain = registry['074'].postconditions[0].retainedImplementation.functions;
function reject(name, mutate) {
  const bad = structuredClone(snapshot); mutate(bad);
  for (const id of ['044','073','074']) assert.notEqual(reconcileMigration(bad,registry[id]).state,'SATISFIED',`${name} / ${id}`);
  assert.throws(()=>verify(plan(bad)),/FAILED_CLOSED/,name); checks++;
  console.log('PASS reject '+name);
}
for (const entry of chain) {
  reject('missing '+entry.object,s=>{delete s.functions[entry.object];});
  reject('changed body '+entry.object,s=>{s.functions[entry.object].definition=s.functions[entry.object].definition.replace(/\nAS /,'\nAS ')
    .replace(/\$function\$\s*$/,'\n-- changed fixture\n$function$');
    // A comment is intentionally presentation-only; change executable SQL too.
    s.functions[entry.object].definition=s.functions[entry.object].definition.replace(/\b(select|begin)\b/i,'select 7654321; $1');});
}
const delegate='public.erp_commit_waca_counted_snapshot_v074(jsonb,bigint,jsonb)';
for (const key of ['publicExecute','anonExecute','authenticatedExecute']) reject('private ACL '+key,s=>{s.functions[delegate][key]=true;});
for (const [key,value] of [['owner','unexpected_owner'],['securityDefiner',false],['leakproof',true],['strict',true],['returnType','text']])
  reject('delegate metadata '+key,s=>{s.functions[delegate][key]=value;});
reject('delegate search_path',s=>{s.functions[delegate].config=['search_path=public','statement_timeout=120s'];});
reject('delegate unbounded timeout',s=>{s.functions[delegate].config=['search_path=pg_catalog, public, extensions','statement_timeout=0'];});
for (const marker of ['WACA_OWNER_REQUIRED','WACA_STALE_REVISION','WACA_RESTORE_EPOCH_CHANGED',
  'CLOUD_RESTORE_MAINTENANCE_LOCKED','WACA_COUNTED_STATE_UPDATE_MISMATCH',
  "where id='00000000-0000-4000-8000-000000000001'::uuid and revision=v_revision+1"])
  reject('protection removed '+marker,s=>{assert.ok(s.functions[delegate].definition.includes(marker));s.functions[delegate].definition=s.functions[delegate].definition.replace(marker,'CHANGED_PROTECTION');});
reject('wrapper calls wrong delegate',s=>{const fn=s.functions['public.erp_commit_waca_counted_snapshot(jsonb,bigint,jsonb)'];
  fn.definition=fn.definition.replace('public.erp_commit_waca_counted_snapshot_v074(','public.erp_commit_waca_snapshot_v044(');});
reject('literal case is meaningful',s=>{s.functions[delegate].definition=s.functions[delegate].definition.replace('WACA_OWNER_REQUIRED','waca_owner_required');});

// Whitespace and comments are not SQL behavior changes, unlike string literals.
const formatting=structuredClone(snapshot);
formatting.functions[delegate].definition='-- PostgreSQL formatting-only fixture\n'+formatting.functions[delegate].definition.replaceAll('\n','\r\n');
assert.ok(plan(formatting).migrations.every(item=>item.state==='SATISFIED')); checks++;
// Unit fixture: reverse only 075's reviewed renames/ACL and new functions.
// The separate native test verifies the actual SQL-generated pre-075 schema.
// The pre-075 (v29) reconstruction starts from the adopted v30 canonical, not from the later v31 candidate.
const prior=structuredClone(read('../docs/schema-candidates/erp2-v30-waca-order-recognition.snapshot.json'));
for(const [name,delegateName,args] of [
  ['erp_commit_waca_snapshot','erp_commit_waca_snapshot_v044','jsonb,bigint,boolean'],
  ['erp_commit_waca_counted_snapshot','erp_commit_waca_counted_snapshot_v074','jsonb,bigint,jsonb'],
]) {
  prior.functions[`public.${name}(${args})`]={...prior.functions[`public.${delegateName}(${args})`],authenticatedExecute:true,
    definition:prior.functions[`public.${delegateName}(${args})`].definition.replace(`public.${delegateName}(`,`public.${name}(`)};
}
for(const entry of chain)if(!['public.erp_commit_waca_snapshot(jsonb,bigint,boolean)',
  'public.erp_commit_waca_counted_snapshot(jsonb,bigint,jsonb)'].includes(entry.object))delete prior.functions[entry.object];
assert.equal(fingerprintStructuralSnapshot(prior),'8410d8090f11ac1441c803b01d2d364f552fcb07d58386d03463d238f026c1fa');
prior.integrity=snapshot.integrity;prior.completeness.inventoryIntegrity=true;
for(const id of ['044','073','074'])assert.equal(reconcileMigration(prior,registry[id]).state,'SATISFIED'); checks++;
const pre=planSchemaDelta(prior,registry,{expectedSnapshot:canonical});
assert.equal(pre.readyForApply,true);assert.deepEqual(pre.applyPlan.map(item=>item.migrationId),['075','076','077']); checks++;
assert.equal(fingerprintStructuralSnapshot(snapshot),contract.schemaBaseline.canonicalFingerprint);
console.log(JSON.stringify({result:'PASS',checks,migrations:'46/46 SATISFIED',strictPostAdoption:'PASS',
  schema:contract.schemaBaseline.canonicalFingerprint,cloudWrites:0,ledgerWrites:0,delegateContracts:chain.length}));
