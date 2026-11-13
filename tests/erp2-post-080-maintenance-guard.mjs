import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyPost080MaintenanceEvidence, verifyPost080ProductEvidence } from '../scripts/promotion-safety.mjs';

const contract = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url), 'utf8'));
const maintenance = contract.schemaBaseline.post080Maintenance;
const candidate = { head: '020190cd34deab6ff26ceb08eb230e812f53161f', checkpointTag: 'checkpoint-20261110-erp2-v33-080-ledger-realtime-final-v1' };
const row079 = { migrationId: '079', state: 'SATISFIED', applyMethod: 'NO_APPLY', sourceChecksum: 'f2d5af5d3fcf248a73182517edfbeb42af1ea55610be4d5fc3be4c5aabfbe3e1' };
const baseEvidence = {
  currentFingerprint: maintenance.requiredFingerprint,
  expectedFingerprint: maintenance.requiredFingerprint,
  targetAfterDeltaFingerprint: maintenance.requiredFingerprint,
  migrationHistoryProvenance: 'AVAILABLE',
  migrations: [row079], applyPlan: [], baselineRecord: null,
  migrationHistory: { available: true, records: [] },
};
const bootstrap = { ...baseEvidence, mode: maintenance.bootstrapMode, auditBootstrap: {
  migrationId: '080', sourceChecksum: maintenance.requiredMigrationSourceChecksum,
  sourceHead: maintenance.requiredMigrationSourceHead, checkpoint: maintenance.requiredMigrationCheckpoint,
  schemaFingerprintBefore: maintenance.previousFingerprint, schemaFingerprintAfter: maintenance.requiredFingerprint,
  candidateHead: candidate.head, candidateCheckpoint: candidate.checkpointTag,
  runnerPath: maintenance.auditRunnerPath, runnerCommit: maintenance.auditRunnerCommit,
} };
const registry = new Map([['079', row079]]);
verifyPost080MaintenanceEvidence({ evidence: bootstrap, contract, candidate, migrationsById: registry });
console.log('PASS 080 bootstrap: exact candidate and Owner audit runner, no ledger write claimed');
const applied = { eventType: 'MIGRATION_APPLIED', eventKey: '080', result: 'PASS', sourceHead: maintenance.requiredMigrationSourceHead,
  checkpoint: maintenance.requiredMigrationCheckpoint, sourceChecksum: maintenance.requiredMigrationSourceChecksum,
  schemaFingerprintBefore: maintenance.previousFingerprint, schemaFingerprintAfter: maintenance.requiredFingerprint,
  supabaseProjectRef: 'rhfdjsklfrgpoqsaqpkn', environmentRole: 'PRODUCTION', recordedAt: '2026-11-10T03:34:47.819716+00:00',
  metadata: { historicalMigrationExecutionClaimed: false } };
verifyPost080MaintenanceEvidence({ evidence: { ...baseEvidence, mode: maintenance.mode,
  migrationHistory: { available: true, records: [applied] } }, contract, candidate, migrationsById: registry });
console.log('PASS 080 final: exactly one matching Owner ledger event');
const historicalBaseline = { eventType: 'BASELINE_ADOPTED', eventKey: 'erp2-canonical-schema-v33-r5-source-capacity-receiving', result: 'PASS',
  recordedAt: '2026-10-23T05:12:19.611914+00:00', schemaFingerprintAfter: 'a5387d8513f2f1aab7eba16ab2f0b10a43a21fdbfeb85d8ac0686a6fc7878ac5',
  supabaseProjectRef: 'rhfdjsklfrgpoqsaqpkn', environmentRole: 'PRODUCTION' };
verifyPost080MaintenanceEvidence({ evidence: { ...baseEvidence, mode: maintenance.mode, baselineRecord: historicalBaseline,
  migrationHistory: { available: true, records: [historicalBaseline, applied] } }, contract, candidate, migrationsById: registry });
console.log('PASS 080 final: historical pre-080 baseline adoption retained');
const productRelease = contract.schemaBaseline.post080ProductRelease;
const productEvidence = { ...baseEvidence, mode: productRelease.mode,
  migrationHistory: { available: true, records: [historicalBaseline, applied] } };
verifyPost080ProductEvidence({ evidence: productEvidence, contract, candidate, migrationsById: registry });
console.log('PASS post-080 product lane: exact 080 ledger and 922a fingerprint, PRE-ADOPTION retained');
assert.throws(() => verifyPost080ProductEvidence({ evidence: { ...productEvidence, mode: 'PRE_ADOPTION_MAINTENANCE_080' }, contract, candidate, migrationsById: registry }), /DEPLOYMENT_GUARD_FAILED_CLOSED/u);
console.log('PASS fail-closed: product lane cannot impersonate 080 maintenance mode');
const post080Baseline = { ...historicalBaseline, recordedAt: '2026-11-10T04:00:00.000Z' };
assert.throws(() => verifyPost080MaintenanceEvidence({ evidence: { ...baseEvidence, mode: maintenance.mode, baselineRecord: post080Baseline,
  migrationHistory: { available: true, records: [applied, post080Baseline] } }, contract, candidate, migrationsById: registry }), /DEPLOYMENT_GUARD_FAILED_CLOSED/u);
console.log('PASS fail-closed: post-080 baseline adoption');
const rejects = [
  ['wrong fingerprint', { ...bootstrap, currentFingerprint: 'a'.repeat(64) }],
  ['wrong SQL checksum', { ...bootstrap, auditBootstrap: { ...bootstrap.auditBootstrap, sourceChecksum: 'b'.repeat(64) } }],
  ['wrong candidate checkpoint', { ...bootstrap, auditBootstrap: { ...bootstrap.auditBootstrap, candidateCheckpoint: 'checkpoint-wrong' } }],
  ['duplicate 080 event during bootstrap', { ...bootstrap, migrationHistory: { available: true, records: [applied] } }],
  ['baseline adoption', { ...bootstrap, migrationHistory: { available: true, records: [{ eventType: 'BASELINE_ADOPTED', result: 'PASS' }] } }],
];
for (const [name, evidence] of rejects) {
  assert.throws(() => verifyPost080MaintenanceEvidence({ evidence, contract, candidate, migrationsById: registry }), /DEPLOYMENT_GUARD_FAILED_CLOSED/u);
  console.log(`PASS fail-closed: ${name}`);
}
console.log(JSON.stringify({ result: 'PASS', cases: rejects.length + 4, liveMutation: 0 }));
