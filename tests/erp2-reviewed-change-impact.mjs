import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inspectSafeDescendant, verifySafeDescendant, classifyDescendantFile, assertReviewedProviderContract } from '../scripts/post-adoption-descendant.mjs';
import { sourceHash, impactHash, reviewedImpacts, regressionScripts, sealImpactEvidence, classifyReviewedFile, reviewForCandidate } from '../scripts/reviewed-change-impact.mjs';
const baseline = '5cbf5137cb7a2e6fd6244606692feca5ba42521a';
const tag = 'checkpoint-20260930-erp2-post-migration-canonical-reconciliation-v1-guard-closure';
const baselineRecord = { sourceHead: baseline, checkpoint: tag };
const cache = new Map();
const realGit = args => {
  const key = JSON.stringify(args);
  if (!cache.has(key)) cache.set(key, execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  return cache.get(key);
};
const offlineGit = args => {
  if (args[0] === 'ls-remote') return `${baseline}\trefs/tags/${tag}^{}\n`;
  // During the pre-commit unit run this new test is not yet in the immutable
  // candidate tree. The fixture substitutes only that test checksum; the real
  // release runner never substitutes trees/checksums or any test result.
  if (args[0] === 'show' && args[1].endsWith(':tests/erp2-reviewed-change-impact.mjs')) return readFileSync(new URL(import.meta.url), 'utf8');
  return realGit(args);
};
const actualMutationHead = 'f79d7d6b4a23199e2c5a37a082bca134375bc69f';
const candidate = { head: reviewedImpacts.reviews.at(-1).reviewedHead, checkpointTag: 'checkpoint-unit-fixture', branch: 'codex/next-waca-order-integration-v1' };
const inspection = inspectSafeDescendant({ git: offlineGit, candidate, baselineRecord });
assert.equal(inspection.result, 'PASS'); assert.equal(inspection.unknownFiles, 0);
assert.equal(inspection.schemaSensitiveFiles, 0); assert.equal(inspection.persistenceSchemaNeutralFiles, 8);
assert.equal(inspection.migrationChecksumParity, 'PASS'); assert.equal(inspection.backupContractParity, 'PASS');
assert.equal(inspection.providerContractParity, 'PASS'); assert.equal(inspection.schemaBaselineMutated, false);
assert.ok(inspection.requiredRegressions.includes('postgrest')); assert.ok(inspection.requiredRegressions.includes('mutation-native'));
assert.ok(inspection.requiredRegressions.includes('private-delete'));
const providerChain = reviewedImpacts.reviews.filter(review => review.files.some(row => row.file === 'src/providers/cloud/supabaseProvider.ts'));
const latestProvider = realGit(['show', `${candidate.head}:src/providers/cloud/supabaseProvider.ts`]);
assert.equal(classifyReviewedFile({ file: 'src/providers/cloud/supabaseProvider.ts', after: latestProvider, reviews: providerChain }).chain.length, 2);
const discontinuous = structuredClone(providerChain);
discontinuous.at(-1).files.find(row => row.file === 'src/providers/cloud/supabaseProvider.ts').beforeHash = '0'.repeat(64);
assert.throws(() => classifyReviewedFile({ file: 'src/providers/cloud/supabaseProvider.ts', after: latestProvider, reviews: discontinuous }), /FAILED_CLOSED/u);
const nonChronologicalGit = args => args[0] === '--no-replace-objects' && args[2] === '--is-ancestor'
  && args[3] === providerChain[0].reviewedHead && args[4] === providerChain.at(-1).beforeHead
  ? (() => { throw new Error('nonchronological fixture'); })() : offlineGit(args);
assert.throws(() => reviewForCandidate(nonChronologicalGit, candidate.head), /FAILED_CLOSED/u);
const evidence = sealImpactEvidence({ schemaVersion: 1, kind: 'ERP2_REVIEWED_CHANGE_IMPACT', completedAt: new Date().toISOString(), inspection,
  regressions: inspection.requiredRegressions.map(id => ({ id, script: regressionScripts[id],
    scriptChecksum: sourceHash(offlineGit(['show', `${candidate.head}:${regressionScripts[id]}`])),
    outputChecksum: impactHash('unit evidence only, not a claim of test execution'), result: 'PASS', exitCode: 0, elapsedMs: 1 })) });
assert.equal(verifySafeDescendant({ git: offlineGit, candidate, baselineRecord, changeImpactEvidence: evidence }).regressionEvidence.result, 'PASS');
assert.throws(() => verifySafeDescendant({ git: offlineGit, candidate, baselineRecord }), /FAILED_CLOSED/u);
for (const review of reviewedImpacts.reviews) {
  for (const row of review.files.filter(row => row.file.startsWith('src/'))) {
    const mutatedGit = args => args[0] === 'show' && args[1] === `${candidate.head}:${row.file}`
      ? offlineGit(args) + '\nexport const unsafeFutureWrite = 1;' : offlineGit(args);
    assert.throws(() => inspectSafeDescendant({ git: mutatedGit, candidate, baselineRecord }), /FAILED_CLOSED/u, row.file);
  }
}
for (const file of ['supabase/sql/048_erp2_live_canonical_contract_reconciliation.sql', 'tools/schema-reconciliation/schemaContract.mjs', 'src/lib/durableResourceRegistry.ts', 'src/providers/cloud/cloudEntityPayload.ts']) {
  const git = args => args[0] === 'show' && args[1] === `${candidate.head}:${file}` ? offlineGit(args) + '\n// corruption\n' : offlineGit(args);
  assert.throws(() => inspectSafeDescendant({ git, candidate, baselineRecord }), /FAILED_CLOSED/u, file);
}
const provider = 'src/providers/cloud/supabaseProvider.ts';
const old = realGit(['show', `a2d092c5eae9c2c4d45fc42fb237ef8a882b77fc:${provider}`]);
const updated = realGit(['show', `${actualMutationHead}:${provider}`]);
assertReviewedProviderContract(provider, old, updated);
assert.throws(() => assertReviewedProviderContract(provider, old, updated.replace("supabase.rpc('erp_apply_field_mutations'", "supabase.rpc('erp_unsafe_write'")), /FAILED_CLOSED/u);
const fields = 'src/providers/cloud/cloudFieldCas.ts';
assert.throws(() => assertReviewedProviderContract(fields, realGit(['show', `${baseline}:${fields}`]),
  realGit(['show', `${actualMutationHead}:${fields}`]).replace("'default_jpy_cost',", "'updated_at', 'default_jpy_cost',")), /FAILED_CLOSED/u);
for (const file of ['src/providers/cloud/newPersistence.ts', 'src/waca/unknownWrite.ts', 'supabase/sql/new.sql']) {
  assert.equal(classifyDescendantFile(file, null, 'unsafe'), 'SCHEMA_SENSITIVE_OR_UNREVIEWED');
}
const verifyBad = value => assert.throws(() => verifySafeDescendant({ git: offlineGit, candidate, baselineRecord,
  changeImpactEvidence: sealImpactEvidence(value) }), /FAILED_CLOSED/u);
const { identity: _identity, ...unsigned } = evidence;
verifyBad({ ...unsigned, completedAt: '2000-01-01T00:00:00Z' });
verifyBad({ ...unsigned, regressions: [] });
verifyBad({ ...unsigned, regressions: unsigned.regressions.map((r, i) => i ? r : { ...r, exitCode: 1, result: 'FAIL' }) });
verifyBad({ ...unsigned, regressions: unsigned.regressions.map((r, i) => i ? r : { ...r, scriptChecksum: '0'.repeat(64) }) });
verifyBad({ ...unsigned, inspection: { ...inspection, candidateHead: baseline } });
assert.throws(() => inspectSafeDescendant({ git: args => args[0] === '--no-replace-objects' ? (() => { throw new Error('unrelated'); })() : offlineGit(args), candidate, baselineRecord }), /FAILED_CLOSED/u);
console.log('PASS exact WACA and mutation patches A/B/C; unchanged SQL, canonical, provider RPC and Backup/Restore contract; baseline immutable');
console.log('PASS future db/WACA/provider hunks, SQL/RLS/resource/RPC/allowlist drift, unknown files and missing/stale/failed/tampered evidence fail closed');
console.log('Unit fixtures only; real release regression execution is required separately; live writes=0');
