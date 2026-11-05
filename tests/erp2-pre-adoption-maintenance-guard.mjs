import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyPreAdoptionMaintenanceEvidence } from '../scripts/promotion-safety.mjs';

const contract = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url), 'utf8'));
const maintenance = contract.schemaBaseline.preAdoptionMaintenance;
const fingerprint = maintenance.requiredFingerprint;
const timestamp = '2026-11-05T04:00:00.000Z';
const row079 = {
  migrationId: '079', sourceFile: '079_catalog_projection_without_purchase_list.sql',
  sourceChecksum: maintenance.requiredMigrationSourceChecksum, canonicalOrder: 57,
  state: 'SATISFIED', applyMethod: 'NO_APPLY', safeToApply: false,
};
const baseline = {
  eventType: 'BASELINE_ADOPTED', eventKey: contract.schemaBaseline.requiredBaselineId,
  result: 'PASS', recordedAt: '2026-10-23T05:12:19.000Z', schemaFingerprintAfter: 'a5387d8513f2f1aab7eba16ab2f0b10a43a21fdbfeb85d8ac0686a6fc7878ac5',
};
const applied = {
  eventType: 'MIGRATION_APPLIED', eventKey: '079', result: 'PASS',
  recordedAt: timestamp, sourceHead: maintenance.requiredMigrationSourceHead,
  checkpoint: maintenance.requiredMigrationCheckpoint, sourceChecksum: maintenance.requiredMigrationSourceChecksum,
  schemaFingerprintAfter: fingerprint, supabaseProjectRef: 'rhfdjsklfrgpoqsaqpkn', environmentRole: 'PRODUCTION',
  metadata: { historicalMigrationExecutionClaimed: false },
};
const make = overrides => ({
  mode: 'PRE_ADOPTION_MAINTENANCE', currentFingerprint: fingerprint,
  expectedFingerprint: fingerprint, targetAfterDeltaFingerprint: fingerprint,
  migrationHistoryProvenance: 'AVAILABLE', migrations: [row079], applyPlan: [],
  baselineRecord: baseline, migrationHistory: { available: true, records: [applied, baseline] },
  ...overrides,
});
const registry = new Map([['079', row079]]);
assert.equal(verifyPreAdoptionMaintenanceEvidence({ evidence: make(), contract, migrationsById: registry }).baselineAdoption, 'NOT_ADOPTED');
console.log('PASS maintenance positive: 079 applied, zero delta, historical baseline retained without adoption');
const rejects = [
  ['wrong fingerprint', make({ currentFingerprint: 'a'.repeat(64) })],
  ['nonzero migration delta', make({ applyPlan: [{ migrationId: '080' }] })],
  ['wrong 079 source head', make({ migrationHistory: { available: true, records: [{ ...applied, sourceHead: 'b'.repeat(40) }, baseline] } })],
  ['different migration applied', make({ migrationHistory: { available: true, records: [{ ...applied, eventKey: '080' }, baseline] } })],
  ['post-079 baseline adoption', make({ migrationHistory: { available: true, records: [{ ...applied }, { ...baseline, recordedAt: '2026-11-05T04:01:00.000Z', schemaFingerprintAfter: fingerprint }] } })],
];
for (const [name, evidence] of rejects) {
  assert.throws(() => verifyPreAdoptionMaintenanceEvidence({ evidence, contract, migrationsById: registry }), /DEPLOYMENT_GUARD_FAILED_CLOSED/u);
  console.log(`PASS fail-closed: ${name}`);
}
console.log(JSON.stringify({ result: 'PASS', cases: rejects.length + 1, liveMutation: 0 }));
