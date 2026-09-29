import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifySchemaBaselineEvidence } from '../scripts/promotion-safety.mjs';
import { sealSchemaEvidence } from '../tools/schema-reconciliation/evidenceContract.mjs';

const contract = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url), 'utf8'));
const projectRef = 'rhfdjsklfrgpoqsaqpkn';
const candidate = { head: '1'.repeat(40), checkpointTag: 'checkpoint-pre-adoption-fixture' };
const canonical = contract.schemaBaseline.canonicalFingerprint;
const current = '4ffaa73afba3d7a30add9a53e759afbabe6cf74c78920aebbc72427f123c5e8d';
const now = Date.parse('2026-09-29T05:00:00.000Z');
const nowIso = new Date(now).toISOString();
const checksum = value => value.repeat(64).slice(0, 64);

const migration = (migrationId, canonicalOrder, state, overrides = {}) => ({
  migrationId,
  sourceFile: `${migrationId}_fixture.sql`,
  sourceChecksum: checksum(String(canonicalOrder % 10)),
  canonicalOrder,
  state,
  safeToApply: state === 'NEEDS_APPLY',
  dependencies: [],
  dependencySources: [],
  dependencyEvidence: [],
  repairs: [],
  repairClosure: null,
  coveredByRepair: null,
  applyMethod: state === 'SATISFIED' ? 'NO_APPLY'
    : state === 'NEEDS_APPLY' ? 'APPLY_SOURCE_MIGRATION_TRANSACTION'
      : 'MANUAL_SCHEMA_RECONCILIATION_REQUIRED',
  ...overrides,
});

const planRow = item => ({
  migrationId: item.migrationId,
  sourceFile: item.sourceFile,
  sourceChecksum: item.sourceChecksum,
  canonicalOrder: item.canonicalOrder,
  applyMethod: item.applyMethod,
});

const makeEvidence = ({ migrations, mode = 'PRE_ADOPTION', capturedAt = nowIso,
  currentFingerprint = current, targetAfterDeltaFingerprint = canonical, applyPlan, baselineRecord,
  snapshotProjectRef = projectRef, snapshotCurrentFingerprint = currentFingerprint,
  migrationHistoryProvenance = mode === 'POST_ADOPTION' ? 'AVAILABLE' : 'UNAVAILABLE' } = {}) => sealSchemaEvidence({
  contractVersion: 2,
  mode,
  requiredBaselineId: contract.schemaBaseline.requiredBaselineId,
  environment: 'PRODUCTION',
  projectRef,
  sourceHead: candidate.head,
  checkpoint: candidate.checkpointTag,
  snapshotIdentity: {
    projectRef: snapshotProjectRef,
    environmentRole: 'PRODUCTION',
    capturedAt,
    snapshotToolChecksum: contract.schemaBaseline.snapshotToolChecksum,
    schemaSnapshotChecksum: 'a'.repeat(64),
    currentFingerprint: snapshotCurrentFingerprint,
  },
  migrationHistoryProvenance,
  currentFingerprint,
  expectedFingerprint: canonical,
  targetAfterDeltaFingerprint,
  migrations,
  baselineRecord: baselineRecord ?? null,
  blockers: [],
  applyPlan: applyPlan ?? migrations.filter(item => item.state === 'NEEDS_APPLY'
    && item.safeToApply && !item.coveredByRepair).map(planRow),
  readyForApply: true,
  evidenceFingerprint: 'b'.repeat(64),
});

const observe = (fingerprint = current, observedAt = nowIso) => ({ projectRef, fingerprint, observedAt });
const registryFor = evidence => Object.fromEntries(evidence.migrations.map(item => [item.migrationId, {
  sourceFile: item.sourceFile, sourceChecksum: item.sourceChecksum, canonicalOrder: item.canonicalOrder,
  dependencies: item.dependencies, dependencySources: item.dependencySources,
  repairClosure: item.repairClosure, repairs: item.repairs,
}]));
const pass = evidence => verifySchemaBaselineEvidence({ evidence, contract, candidate,
  liveObservation: observe(evidence.currentFingerprint), migrationRegistry: registryFor(evidence), now });
const blocked = (evidence, liveObservation = observe(evidence.currentFingerprint)) => assert.throws(
  () => verifySchemaBaselineEvidence({ evidence, contract, candidate, liveObservation,
    migrationRegistry: registryFor(evidence), now }),
  /DEPLOYMENT_GUARD_FAILED_CLOSED/u,
);

const externalDependencies = ['001','002-core','011'].map((migrationId, index) => ({
  migrationId, sourceFile: `${migrationId}_dependency.sql`, sourceChecksum: checksum(String(index + 3)),
}));
const safeDelta = [migration('018', 18, 'NEEDS_APPLY', {
  dependencies: externalDependencies.map(item => item.migrationId),
  dependencySources: externalDependencies,
  dependencyEvidence: externalDependencies.map(item => ({ ...item, scope: 'SOURCE_REGISTRY',
    resolution: 'SATISFIED_BY_SAFE_PRECONDITIONS' })),
}),
  migration('026b', 26, 'SATISFIED')];
assert.deepEqual(pass(makeEvidence({ migrations: safeDelta })).applyDelta, ['018']);
console.log('PASS A: PRE_ADOPTION permits current != canonical with an exact safe delta');

blocked(makeEvidence({ migrations: [migration('044', 44, 'PARTIAL', { safeToApply: false })] }));
console.log('PASS B: PARTIAL blocks');

blocked(makeEvidence({ migrations: [migration('044', 44, 'UNKNOWN', { safeToApply: false,
  applyMethod: 'COLLECT_READ_ONLY_EVIDENCE' })] }));
console.log('PASS C: UNKNOWN blocks');

blocked(makeEvidence({ migrations: [migration('046', 46, 'CONFLICT', { safeToApply: false })] }));
console.log('PASS D: uncovered CONFLICT blocks');

const superseded = [
  migration('046', 46, 'CONFLICT', { safeToApply: false, repairClosure: '046b', coveredByRepair: '046b',
    applyMethod: 'SUPERSEDED_BY_COMPATIBILITY_REPAIR' }),
  migration('046b', 47, 'NEEDS_APPLY', { repairs: ['046'] }),
];
assert.deepEqual(pass(makeEvidence({ migrations: superseded })).applyDelta, ['046b']);
console.log('PASS E: explicit 046 -> 046b safe supersession is accepted');

blocked(makeEvidence({ migrations: safeDelta, targetAfterDeltaFingerprint: current }));
console.log('PASS F: non-canonical target-after-delta blocks');

blocked(makeEvidence({ migrations: safeDelta, snapshotProjectRef: 'wrong-project' }));
console.log('PASS G: wrong snapshot project ref blocks');

blocked(makeEvidence({ migrations: safeDelta, snapshotCurrentFingerprint: 'e'.repeat(64) }));
console.log('PASS H: changed snapshot fingerprint blocks');

const ordered = [migration('044', 44, 'NEEDS_APPLY'), migration('045', 45, 'NEEDS_APPLY', { dependencies: ['044'] })];
blocked(makeEvidence({ migrations: ordered, applyPlan: ordered.map(planRow).reverse() }));
console.log('PASS I: reordered or mismatched exact delta blocks');

const ledgerDelta = [
  migration('046b', 47, 'SATISFIED', { repairs: ['046'] }),
  migration('047', 48, 'NEEDS_APPLY', { dependencies: ['046b'] }),
];
assert.deepEqual(pass(makeEvidence({ migrations: ledgerDelta })).applyDelta, ['047']);
console.log('PASS J: absent 047 ledger is accepted only as an explicit safe PRE_ADOPTION delta');

const staleAt = new Date(now - contract.schemaBaseline.snapshotMaxAgeMs - 1).toISOString();
blocked(makeEvidence({ migrations: safeDelta, capturedAt: staleAt }));
const fresh = makeEvidence({ migrations: safeDelta });
blocked(fresh, observe(fresh.currentFingerprint,
  new Date(now - contract.schemaBaseline.liveObservationMaxAgeMs - 1).toISOString()));
console.log('PASS freshness extensions: stale snapshot and stale live observation both block');

const postMigrations = [migration('047', 47, 'SATISFIED')];
const baselineRecord = {
  eventType: 'BASELINE_ADOPTED', eventKey: contract.schemaBaseline.requiredBaselineId,
  sourceHead: candidate.head, checkpoint: candidate.checkpointTag, schemaFingerprintAfter: canonical,
  metadata: { historicalMigrationExecutionClaimed: false },
};
const post = makeEvidence({ migrations: postMigrations, mode: 'POST_ADOPTION', currentFingerprint: canonical,
  baselineRecord });
assert.equal(verifySchemaBaselineEvidence({ evidence: post, contract, candidate,
  liveObservation: observe(canonical), migrationRegistry: registryFor(post), now }).mode, 'POST_ADOPTION');
blocked(makeEvidence({ migrations: postMigrations, mode: 'POST_ADOPTION', baselineRecord: {
  ...baselineRecord, schemaFingerprintAfter: current,
} }));
console.log('PASS POST_ADOPTION extension: canonical current state and valid baseline adoption proof are mandatory');

console.log(JSON.stringify({ result: 'PASS', cases: 10, liveMutation: 0 }));
