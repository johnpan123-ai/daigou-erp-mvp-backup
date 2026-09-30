import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { classifyDescendantFile, verifySafeDescendant } from '../scripts/post-adoption-descendant.mjs';
import { verifySchemaBaselineEvidence } from '../scripts/promotion-safety.mjs';
import { sealSchemaEvidence } from '../tools/schema-reconciliation/evidenceContract.mjs';

const baseline = '5cbf5137cb7a2e6fd6244606692feca5ba42521a';
const uiCandidate = '8a8564a4155e39be2bcf53a066e6adfe73152503';
const baselineCheckpoint = 'checkpoint-20260930-erp2-post-migration-canonical-reconciliation-v1-guard-closure';
const checkpoint = 'checkpoint-20260930-erp2-cloud-waca-ui-sidebar-parity-v1';
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
const readGit = (head, file) => { try { return git(['show', `${head}:${file}`]); } catch { return null; } };
const baselineRecord = { eventType: 'BASELINE_ADOPTED', eventKey: 'erp2-canonical-schema-v4',
  sourceHead: baseline, checkpoint: baselineCheckpoint, result: 'PASS',
  environmentRole: 'PRODUCTION',
  supabaseProjectRef: 'rhfdjsklfrgpoqsaqpkn', metadata: { historicalMigrationExecutionClaimed: false } };
const candidate = { head: uiCandidate, checkpointTag: checkpoint };
// Unit tests use read-only real Git trees/ancestry but never contact any Cloud.
const offlineGit = args => args[0] === 'ls-remote'
  ? `${baseline}\trefs/tags/${baselineCheckpoint}^{}\n` : git(args);
const current = verifySafeDescendant({ git: offlineGit, candidate, baselineRecord });
assert.equal(current.mode, 'SAFE_DESCENDANT');
assert.equal(current.schemaSensitiveFiles, 0); assert.equal(current.nonSchemaFiles, 9);
assert.equal(current.migrationChecksumParity, 'PASS'); assert.equal(current.canonicalContractParity, 'PASS');
assert.equal(current.schemaBaselineMutated, false);
console.log('PASS actual 5cbf513 -> 8a8564a: 9 non-schema files; all SQL and canonical source parity');
console.log(JSON.stringify(current.changedFiles));

const exact = verifySafeDescendant({ git: offlineGit,
  candidate: { head: baseline, checkpointTag: baselineCheckpoint }, baselineRecord });
assert.equal(exact.mode, 'EXACT_BASELINE');
console.log('PASS exact baseline and real ancestor relation');

const appBefore = readGit(baseline, 'src/components/layout/AppLayout.tsx');
const appAfter = readGit(uiCandidate, 'src/components/layout/AppLayout.tsx');
assert.equal(classifyDescendantFile('src/components/layout/AppLayout.tsx', appBefore, appAfter), 'UI_PRESENTATION');
const wacaBefore = readGit(baseline, 'src/pages/WacaIntegration.tsx');
const wacaAfter = readGit(uiCandidate, 'src/pages/WacaIntegration.tsx');
assert.equal(classifyDescendantFile('src/pages/WacaIntegration.tsx', wacaBefore, wacaAfter), 'UI_PRESENTATION');
const gateOnly = wacaBefore.replace("if (getProviderMode() !== 'next')", "if (!['next', 'cloud', 'fallback'].includes(getProviderMode()))");
assert.equal(classifyDescendantFile('src/pages/WacaIntegration.tsx', wacaBefore, gateOnly), 'UI_PRESENTATION');
console.log('PASS sidebar-only and WACA presentation-gate-only changes');

const sensitive = [
  ['migration SQL', 'supabase/sql/048_erp2_live_canonical_contract_reconciliation.sql', 'select 1;', 'select 2;'],
  ['RLS', 'supabase/sql/new_rls.sql', null, 'alter table public.x disable row level security;'],
  ['Cloud provider', 'src/providers/cloud/SupabaseProvider.ts', 'const quantity = 1;', 'const quantity = 2;'],
  ['backup registry', 'src/backup/durableRegistry.ts', 'const count = 24;', 'const count = 15;'],
  ['schema contract', 'tools/schema-reconciliation/schemaContract.mjs', 'old', 'new'],
  ['DB identity', 'src/lib/db.ts', 'old', 'new'],
  ['unknown TS file', 'src/new-quantity-helper.ts', null, 'export const value=19;'],
  ['RPC payload inside UI', 'src/pages/WacaIntegration.tsx', wacaAfter,
    wacaAfter.replace('commitNextWacaSnapshot(next, current.revision, true)', 'commitNextWacaSnapshot(next, current.revision, false)')],
  ['quantity source inside UI', 'src/pages/WacaIntegration.tsx', wacaAfter,
    wacaAfter.replace('const after = pendingImport.afterQuantities.get(variant.id) ?? 0;', 'const after = (pendingImport.afterQuantities.get(variant.id) ?? 0) + 8;')],
  ['write hidden in read loader', 'src/pages/WacaIntegration.tsx', wacaAfter,
    wacaAfter.replace('const nextGroups = await dataProvider.getProductGroups();', 'const nextGroups = await dataProvider.deleteProductGroup("x");')],
  ['persistence moved to helper', 'src/waca/providerSupport.ts', null,
    readGit(uiCandidate, 'src/waca/providerSupport.ts') + '\nexport function save() { return fetch("/rpc"); }'],
  ['deployment script replacement', 'scripts/deploy-erp2-pages.mjs', 'old', 'new'],
  ['dependency/build script change', 'package.json', readGit(baseline, 'package.json'),
    readGit(uiCandidate, 'package.json').replace('tsc -b && vite build', 'node bypass.mjs && vite build')],
];
for (const [name, file, before, after] of sensitive) {
  assert.equal(classifyDescendantFile(file, before, after), 'SCHEMA_SENSITIVE_OR_UNREVIEWED', name);
  console.log(`PASS fail-closed classification: ${name}`);
}

const blocked = (name, mutation) => {
  assert.throws(() => verifySafeDescendant({ git: mutation, candidate, baselineRecord }), /FAILED_CLOSED/u, name);
  console.log(`PASS fail-closed Git proof: ${name}`);
};
blocked('not a descendant', args => args[0] === '--no-replace-objects' ? (() => { throw new Error('not ancestor'); })() : offlineGit(args));
blocked('missing baseline remote checkpoint', args => args[0] === 'ls-remote' ? '' : offlineGit(args));
blocked('local baseline checkpoint mismatch', args => args[0] === 'rev-parse' ? uiCandidate : offlineGit(args));
blocked('migration checksum even if omitted from changed-file list', args => args[0] === 'show'
  && args[1].startsWith(uiCandidate + ':supabase/sql/048_') ? offlineGit(args) + '\n-- altered source\n' : offlineGit(args));
blocked('canonical checksum even if omitted from changed-file list', args => args[0] === 'show'
  && args[1] === `${uiCandidate}:tools/schema-reconciliation/schemaContract.mjs` ? offlineGit(args) + '\n// altered\n' : offlineGit(args));

const contract = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url)));
const fingerprint = contract.schemaBaseline.canonicalFingerprint;
const now = Date.now(); const observedAt = new Date(now).toISOString();
const migration = { migrationId: '047', sourceFile: '047_fixture.sql', sourceChecksum: 'a'.repeat(64),
  canonicalOrder: 47, state: 'SATISFIED', safeToApply: false, dependencies: [], dependencySources: [],
  dependencyEvidence: [], repairs: [], repairClosure: null, applyMethod: 'NO_APPLY' };
const record = { ...baselineRecord, schemaFingerprintAfter: fingerprint };
const makeEvidence = overrides => sealSchemaEvidence({
  contractVersion: 2, mode: 'POST_ADOPTION', requiredBaselineId: contract.schemaBaseline.requiredBaselineId,
  projectRef: 'rhfdjsklfrgpoqsaqpkn', sourceHead: candidate.head, checkpoint: candidate.checkpointTag,
  snapshotIdentity: { projectRef: 'rhfdjsklfrgpoqsaqpkn', environmentRole: 'PRODUCTION', capturedAt: observedAt,
    currentFingerprint: fingerprint, snapshotToolChecksum: contract.schemaBaseline.snapshotToolChecksum,
    schemaSnapshotChecksum: 'c'.repeat(64) },
  migrationHistoryProvenance: 'AVAILABLE', currentFingerprint: fingerprint, expectedFingerprint: fingerprint,
  targetAfterDeltaFingerprint: fingerprint, migrations: [migration], applyPlan: [], blockers: [],
  readyForApply: true, evidenceFingerprint: 'b'.repeat(64), baselineRecord: record, ...overrides,
});
const verify = (evidence, liveObservation = { projectRef: 'rhfdjsklfrgpoqsaqpkn', fingerprint, observedAt }) =>
  verifySchemaBaselineEvidence({ evidence, contract, candidate, candidateGit: offlineGit,
    migrationRegistry: { '047': migration }, liveObservation, now });
assert.equal(verify(makeEvidence()).deploymentLineage.mode, 'SAFE_DESCENDANT');
assert.equal(record.sourceHead, baseline); assert.equal(record.checkpoint, baselineCheckpoint);
assert.throws(() => verify(makeEvidence(), { projectRef: 'rhfdjsklfrgpoqsaqpkn', fingerprint: 'd'.repeat(64), observedAt }), /FAILED_CLOSED/u);
assert.throws(() => verify(makeEvidence({ checkpoint: 'wrong' })), /FAILED_CLOSED/u);
assert.throws(() => verify(makeEvidence({ baselineRecord: { ...record, metadata: { historicalMigrationExecutionClaimed: true } } })), /FAILED_CLOSED/u);
assert.throws(() => verify(makeEvidence({ migrationHistoryProvenance: 'UNAVAILABLE' })), /FAILED_CLOSED/u);
assert.throws(() => verify(makeEvidence({ baselineRecord: { ...record, result: 'FAIL' } })), /FAILED_CLOSED/u);
assert.throws(() => verify(makeEvidence({ baselineRecord: { ...record, supabaseProjectRef: 'other' } })), /FAILED_CLOSED/u);
console.log('PASS POST_ADOPTION SAFE_DESCENDANT integration; fresh Live fingerprint/drift/checkpoint/history fail closed');
console.log(JSON.stringify({ result: 'PASS', schemaSensitiveFiles: 0, nonSchemaFiles: 9, liveMutation: 0 }));
