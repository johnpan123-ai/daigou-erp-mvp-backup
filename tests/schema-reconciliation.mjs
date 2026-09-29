import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBaselineAdoptionRecord, OPS_METADATA_CLASSIFICATION } from '../tools/schema-reconciliation/baselineContract.mjs';
import { buildMigrationEffectRegistry } from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import { detectInventoryBridgeState, EFFECT_STATES, planSchemaDelta } from '../tools/schema-reconciliation/reconcile.mjs';
import { fingerprintStructuralSnapshot, SCHEMA_SNAPSHOT_CONTRACT_VERSION } from '../tools/schema-reconciliation/schemaContract.mjs';
import { verifySchemaBaselineEvidence } from '../scripts/promotion-safety.mjs';
import { sealSchemaEvidence } from '../tools/schema-reconciliation/evidenceContract.mjs';
import { readdir } from 'node:fs/promises';

const contract = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url), 'utf8'));
const registry = await buildMigrationEffectRegistry();
assert.deepEqual(Object.keys(registry), ['018','026b','027','029','030','041','042','043','044','045','046','046b','047']);
for (const effect of Object.values(registry)) {
  assert.match(effect.sourceChecksum, /^[0-9a-f]{64}$/u);
  assert.ok(effect.sourceEffects.transactionWrapped);
  assert.ok(effect.postconditions.length > 0);
  assert.ok(effect.preconditions.length > 0);
  assert.equal(effect.dependencySources.length, effect.dependencies.length);
  assert.ok(effect.dependencySources.every(value => /^[0-9a-f]{64}$/u.test(value.sourceChecksum)));
}
assert.ok(registry['018'].sourceEffects.tables.some(value => value.name === 'import_batches'));
assert.ok(registry['044'].sourceEffects.tables.some(value => value.name === 'waca_orders'));
assert.ok(registry['043'].sourceEffects.functions.some(value => value.name === 'erp_restore_proven_cloud_snapshot_attempt'));
assert.ok(registry['044'].sourceEffects.tables.find(value => value.name === 'waca_order_items').foreignKeys
  .some(value => value.referencedTable === 'public.waca_orders'));
assert.ok(registry['026b'].sourceEffects.identityRewrites.some(value => value.table === 'inventory_items'));
assert.ok(registry['043'].sourceEffects.functionAcl.some(value => value.action === 'GRANT'));
assert.deepEqual(registry['046b'].repairs, ['046']);
assert.equal(registry['047'].dependencies.includes('046b'), true);
console.log('PASS migration effect registry is checksum-bound to parsed SQL source');

for (const file of await readdir(new URL('../tools/schema-reconciliation/sql/', import.meta.url))) {
  const sql = await readFile(new URL(`../tools/schema-reconciliation/sql/${file}`, import.meta.url), 'utf8');
  const withoutComments = sql.replace(/--[^\r\n]*/gu, ' ');
  const withoutLiterals = withoutComments.replace(/'(?:''|[^'])*'/gu, "''");
  assert.doesNotMatch(withoutLiterals, /\b(create|alter|drop|insert|update|delete|truncate|call|grant|revoke)\b/iu, file);
  assert.match(withoutComments, /^\s*(with|select)\b/iu, file);
}
console.log('PASS live query pack is SELECT-only');

const blank = () => ({
  contractVersion: SCHEMA_SNAPSHOT_CONTRACT_VERSION,
  identity: { projectRef: 'rhfdjsklfrgpoqsaqpkn', environmentRole: 'PRODUCTION' },
  capturedAt: '2026-09-29T04:00:00.000Z',
  migrationHistory: { available: false, entries: {} },
  completeness: { structural: true, tables: true, columns: true, constraints: true, indexes: true,
    triggers: true, functions: true, policies: true, grants: true, inventoryIntegrity: true },
  schemas: ['auth','extensions','public'], tables: {}, functions: {},
  integrity: { inventoryItems: { result: 'PASS', nullInventoryKeyCount: 0, duplicateInventoryKeyCount: 0,
    nullIdCount: 0, invalidUuidCount: 0, duplicateIdCount: 0, dependentReferenceViolationCount: 0 } },
});
const ensureTable = (snapshot, name) => snapshot.tables[name] ??= {
  owner: 'postgres', rls: false, forceRls: false, columns: {}, primaryKey: [], uniques: [], indexes: {},
  constraints: [], triggers: {}, policies: {}, grants: { public: [], authenticated: [], anon: [] },
};
const applyCondition = (snapshot, condition) => {
  const [schema, tableName, detail] = condition.object.split('.');
  if (condition.kind === 'function') {
    const value = snapshot.functions[condition.object] ??= { config: [], definition: '', securityDefiner: false,
      authenticatedExecute: false, anonExecute: false, publicExecute: false };
    if (condition.owner !== undefined) value.owner = condition.owner;
    if (condition.returnType !== undefined) value.returnType = condition.returnType;
    if (condition.securityDefiner !== undefined) value.securityDefiner = condition.securityDefiner;
    if (condition.authenticatedExecute !== undefined) value.authenticatedExecute = condition.authenticatedExecute;
    if (condition.anonExecute !== undefined) value.anonExecute = condition.anonExecute;
    if (condition.publicExecute !== undefined) value.publicExecute = condition.publicExecute;
    value.config = [...new Set([...value.config, ...(condition.requiredConfig ?? [])])];
    value.definition += ` ${(condition.definitionIncludes ?? []).join(' ')}`;
    return;
  }
  if (condition.kind === 'index') {
    ensureTable(snapshot, 'public.__fixture_index_host').indexes[condition.object] = {
      definition: `using btree (${(condition.definitionIncludes ?? []).join(' ')})`,
      unique: condition.unique ?? false, primary: condition.primary ?? false, valid: condition.valid ?? true,
    };
    return;
  }
  const table = ensureTable(snapshot, `${schema}.${tableName}`);
  if (condition.kind === 'table') { if (condition.rls !== undefined) table.rls = condition.rls; if (condition.forceRls !== undefined) table.forceRls = condition.forceRls; }
  if (condition.kind === 'tableOwner') table.owner = condition.expected;
  if (condition.kind === 'column') table.columns[detail] = { dataType: condition.expected, nullable: condition.nullable ?? true, default: null };
  if (condition.kind === 'primaryKey') table.primaryKey = [...condition.expected];
  if (condition.kind === 'unique') table.uniques.push([...condition.expected]);
  if (condition.kind === 'foreignKey') table.constraints.push({ type: 'f', columns: [...condition.columns],
    referencedTable: condition.referencedTable, referencedColumns: [...condition.referencedColumns],
    definition: `foreign key (${condition.columns.join(',')}) references ${condition.referencedTable} (${condition.referencedColumns.join(',')})${condition.onDelete ? ` on delete ${condition.onDelete}` : ''}` });
  if (condition.kind === 'trigger') table.triggers[detail] = { definition: detail };
  if (condition.kind === 'policy') table.policies[detail] = { command: 'ALL' };
  if (condition.kind === 'tableGrant' || condition.kind === 'tableGrantContains') table.grants[detail] = [...condition.expected];
};
const canonical = blank();
for (const tableName of [
  'inventory_items','product_groups','product_categories','product_variants','bundle_components','purchase_batches',
  'purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items','japan_packages',
  'japan_package_items','outbound_shipments','outbound_shipment_items',
]) {
  const table = ensureTable(canonical, `public.${tableName}`); table.primaryKey = ['id'];
}
ensureTable(canonical, 'public.inventory_items').columns = {
  id: { dataType: 'uuid', nullable: false }, inventory_key: { dataType: 'text', nullable: false },
};
ensureTable(canonical, 'public.inventory_items').uniques = [['inventory_key']];
for (const signature of ['public.is_owner(uuid)','public.is_editor(uuid)']) canonical.functions[signature] = {
  config: [], definition: signature, securityDefiner: true, authenticatedExecute: false, anonExecute: false,
};
for (const effect of Object.values(registry)) for (const condition of effect.postconditions) applyCondition(canonical, condition);

const reordered = structuredClone(canonical);
reordered.schemas.reverse();
assert.equal(fingerprintStructuralSnapshot(canonical), fingerprintStructuralSnapshot(reordered));
console.log('PASS deterministic structural fingerprint ignores catalog ordering');

const fullPlan = planSchemaDelta(canonical, registry, { expectedSnapshot: canonical,
  sourceHead: 'c12bd42567b9080d84051825f7c3ff2c955677e8', checkpoint: 'checkpoint-fixture',
  requiredBaselineId: contract.schemaBaseline.requiredBaselineId,
  snapshotToolChecksum: contract.schemaBaseline.snapshotToolChecksum });
assert.equal(fullPlan.readyForApply, true);
assert.ok(fullPlan.migrations.every(item => item.state === EFFECT_STATES.SATISFIED));
assert.ok(fullPlan.migrations.every(item => item.historicalExecution === 'UNPROVEN'));
console.log('PASS full canonical schema is SATISFIED without fake APPLIED history');

const emptyPlan = planSchemaDelta(blank(), registry, { expectedSnapshot: canonical });
assert.equal(emptyPlan.readyForApply, false);
assert.equal(emptyPlan.migrations.find(item => item.migrationId === '018').state, EFFECT_STATES.NEEDS_APPLY);
assert.equal(emptyPlan.migrations.find(item => item.migrationId === '026b').state, EFFECT_STATES.CONFLICT);
console.log('PASS empty schema fixture requires prerequisites and cannot manufacture a safe delta');

const incomplete = structuredClone(canonical); incomplete.completeness.functions = false;
const incompletePlan = planSchemaDelta(incomplete, registry, { expectedSnapshot: canonical });
assert.equal(incompletePlan.readyForApply, false);
assert.ok(incompletePlan.migrations.some(item => item.state === EFFECT_STATES.UNKNOWN));
console.log('PASS incomplete snapshot is UNKNOWN / BLOCK');

const partialWaca = structuredClone(canonical);
delete partialWaca.functions['public.erp_read_waca_snapshot()'];
const partialPlan = planSchemaDelta(partialWaca, registry, { expectedSnapshot: canonical });
assert.equal(partialPlan.migrations.find(item => item.migrationId === '044').state, EFFECT_STATES.PARTIAL);
assert.equal(partialPlan.readyForApply, false);
console.log('PASS partial WACA migration is PARTIAL / BLOCK');

const legacy = structuredClone(canonical); const legacyInventory = legacy.tables['public.inventory_items'];
legacyInventory.primaryKey = ['inventory_key']; delete legacyInventory.columns.id; legacyInventory.uniques = [];
assert.deepEqual(detectInventoryBridgeState(legacy), {
  state: 'STATE_A', safeToApply: true, reason: 'legacy identity and data preconditions pass',
});
const partialBridge = structuredClone(legacy); partialBridge.tables['public.inventory_items'].columns.id = { dataType: 'uuid', nullable: false };
assert.equal(detectInventoryBridgeState(partialBridge).state, 'STATE_B');
const conflicting = structuredClone(canonical); conflicting.tables['public.inventory_items'].primaryKey = ['product_id'];
assert.equal(detectInventoryBridgeState(canonical).state, 'STATE_C');
assert.equal(detectInventoryBridgeState(conflicting).state, 'STATE_D');
assert.equal(planSchemaDelta(conflicting, registry, { expectedSnapshot: canonical }).readyForApply, false);
console.log('PASS 026b states A/B/C/D fail closed on partial and conflicting PK');

assert.equal(registry['027'].preconditions.some(item => item.object === 'public.inventory_items'), true);
assert.equal(registry['029'].dependencies.includes('027'), true);
console.log('PASS 027/029 compatibility is anchored to canonical UUID id identity');

assert.equal(fullPlan.migrations.find(item => item.migrationId === '041').state, EFFECT_STATES.SATISFIED);
assert.equal(fullPlan.migrations.find(item => item.migrationId === '043').state, EFFECT_STATES.SATISFIED);
assert.equal(fullPlan.migrations.find(item => item.migrationId === '043').historicalExecution, 'UNPROVEN');
console.log('PASS 041/043 schema effects can be satisfied without invented migration history');

const live046 = structuredClone(canonical);
const live046Inventory = live046.tables['public.inventory_items'];
delete live046Inventory.columns.myacg_parent_code;
for (const value of Object.values(live046.tables)) delete value.indexes?.['public.inventory_items_myacg_parent_code_idx'];
const parentFunction = live046.functions['public.erp_apply_field_mutations(text,jsonb)'];
parentFunction.definition = "v_create_allowed := ARRAY['inventory_key','myacg_item_code','product_id'";
live046Inventory.grants.anon = ['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE'];
live046Inventory.grants.authenticated = ['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'];
delete live046.tables['public.erp_schema_migration_ledger'];
delete live046.functions['public.erp_record_schema_migration_event(text,text,text,text,text,text,text,text,text,text,jsonb)'];
for (const value of Object.values(live046.tables)) delete value.indexes?.['public.erp_schema_migration_ledger_recorded_at_idx'];
const live046Plan = planSchemaDelta(live046, registry, { expectedSnapshot: canonical });
const original046 = live046Plan.migrations.find(item => item.migrationId === '046');
const repair046 = live046Plan.migrations.find(item => item.migrationId === '046b');
const ledger047 = live046Plan.migrations.find(item => item.migrationId === '047');
assert.equal(original046.state, EFFECT_STATES.CONFLICT);
assert.equal(original046.coveredByRepair, '046b');
assert.equal(repair046.state, EFFECT_STATES.NEEDS_APPLY);
assert.equal(repair046.safeToApply, true);
assert.equal(ledger047.state, EFFECT_STATES.NEEDS_APPLY);
assert.equal(ledger047.safeToApply, true);
assert.equal(ledger047.dependencyBlocker, undefined);
assert.equal(live046Plan.readyForApply, true);
assert.deepEqual(live046Plan.applyPlan.map(item => item.migrationId), ['046b','047']);
assert.equal(original046.applyMethod, 'SUPERSEDED_BY_COMPATIBILITY_REPAIR');
console.log('PASS live-like 046 conflict is covered by the ordered 046b compatibility closure');

const unsafe046Fixtures = [
  ['wrong column type', fixture => { fixture.tables['public.inventory_items'].columns.myacg_parent_code = { dataType: 'uuid', nullable: true, default: null }; }],
  ['conflicting index', fixture => {
    ensureTable(fixture, 'public.__fixture_index_host').indexes['public.inventory_items_myacg_parent_code_idx'] = {
      definition: 'using btree (myacg_parent_code)', unique: true, primary: false, valid: true,
    };
  }],
  ['unexpected function signature', fixture => { fixture.functions['public.erp_apply_field_mutations(uuid,jsonb)'] = structuredClone(parentFunction); }],
  ['non-canonical inventory PK', fixture => { fixture.tables['public.inventory_items'].primaryKey = ['inventory_key']; }],
  ['unexpected table privilege', fixture => { fixture.tables['public.inventory_items'].grants.anon.push('UNEXPECTED'); }],
];
for (const [label, mutate] of unsafe046Fixtures) {
  const fixture = structuredClone(live046); mutate(fixture);
  const plan = planSchemaDelta(fixture, registry, { expectedSnapshot: canonical });
  const repair = plan.migrations.find(item => item.migrationId === '046b');
  assert.equal(repair.safeToApply, false, label);
  assert.equal(plan.readyForApply, false, label);
}
console.log('PASS unsafe 046 column/index/function/PK/ACL states fail closed');

const adoption = createBaselineAdoptionRecord({ plan: fullPlan, baselineId: contract.schemaBaseline.requiredBaselineId,
  sourceHead: 'c12bd42567b9080d84051825f7c3ff2c955677e8', checkpoint: 'checkpoint-fixture',
  environmentRole: 'PRODUCTION', projectRef: 'rhfdjsklfrgpoqsaqpkn' });
assert.equal(adoption.eventType, 'BASELINE_ADOPTED');
assert.equal(adoption.metadata.historicalMigrationExecutionClaimed, false);
assert.equal(adoption.metadata.classification, OPS_METADATA_CLASSIFICATION);
assert.throws(() => createBaselineAdoptionRecord({ plan: partialPlan }), /BASELINE_ADOPTION_RECONCILIATION_REQUIRED/u);
console.log('PASS baseline adoption never fabricates migration execution');

const fixtureContract = structuredClone(contract);
fixtureContract.schemaBaseline.canonicalFingerprint = fullPlan.expectedFingerprint;
const evidence = fullPlan;
const liveObservation = { projectRef: evidence.projectRef, fingerprint: evidence.currentFingerprint,
  observedAt: evidence.snapshotIdentity.capturedAt };
const fixtureNow = Date.parse(evidence.snapshotIdentity.capturedAt);
assert.equal(verifySchemaBaselineEvidence({ evidence, contract: fixtureContract, candidate: {
  head: evidence.sourceHead, checkpointTag: evidence.checkpoint,
}, liveObservation, now: fixtureNow }).result, 'PASS');
const postAdoptionEvidence = sealSchemaEvidence({ ...evidence, mode: 'POST_ADOPTION', migrationHistoryProvenance: 'AVAILABLE',
  baselineRecord: {
    ...adoption, eventKey: contract.schemaBaseline.requiredBaselineId,
    sourceHead: evidence.sourceHead, checkpoint: evidence.checkpoint,
    schemaFingerprintAfter: evidence.currentFingerprint,
  } });
assert.equal(verifySchemaBaselineEvidence({ evidence: postAdoptionEvidence, contract: fixtureContract, candidate: {
  head: evidence.sourceHead, checkpointTag: evidence.checkpoint,
}, liveObservation, now: fixtureNow }).mode, 'POST_ADOPTION');
assert.throws(() => verifySchemaBaselineEvidence({ evidence: sealSchemaEvidence({ ...evidence, currentFingerprint: '0'.repeat(64) }),
  contract: fixtureContract, candidate: { head: evidence.sourceHead, checkpointTag: evidence.checkpoint },
  liveObservation, now: fixtureNow }), /FAILED_CLOSED/u);
assert.throws(() => verifySchemaBaselineEvidence({ evidence: {
  ...postAdoptionEvidence,
  baselineRecord: { ...postAdoptionEvidence.baselineRecord,
    metadata: { historicalMigrationExecutionClaimed: true } },
}, contract: fixtureContract, candidate: { head: evidence.sourceHead, checkpointTag: evidence.checkpoint },
liveObservation, now: fixtureNow }), /FAILED_CLOSED/u);
console.log('PASS deployment guard accepts PRE/POST adoption proof and rejects stale or fabricated history');

const observed = blank(); observed.completeness = { structural: false, tables: true, columns: false, constraints: false,
  indexes: false, triggers: false, functions: false, policies: false, grants: false, inventoryIntegrity: false };
for (const name of ['sales_orders','sales_order_items','product_variants']) ensureTable(observed, `public.${name}`);
const observedPlan = planSchemaDelta(observed, registry);
assert.equal(observedPlan.readyForApply, false);
assert.ok(observedPlan.migrations.every(item => item.state === EFFECT_STATES.UNKNOWN));
console.log('PASS Luna observed pre-adoption fixture cannot manufacture an Apply delta');

console.log(JSON.stringify({ result: 'PASS', fixtures: ['empty','043','pre-026b','post-026b','partial-026b',
  'no-ledger-041-043','WACA-absent','WACA-partial','WACA-full'], liveMutation: 0 }));
