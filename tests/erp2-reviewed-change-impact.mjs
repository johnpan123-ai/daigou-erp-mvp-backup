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
// Keep the historical v4 fixture fixed: later schema baselines cannot be
// treated as UI-only descendants of the old v4 canonical contract.
const candidate = { head: 'de2ccc03f6557d05db8709ce4586f6c8d9a146f2', checkpointTag: 'checkpoint-unit-fixture', branch: 'codex/next-waca-order-integration-v1' };
const inspection = inspectSafeDescendant({ git: offlineGit, candidate, baselineRecord });
assert.equal(inspection.result, 'PASS'); assert.equal(inspection.unknownFiles, 0);
assert.equal(inspection.schemaSensitiveFiles, 0); assert.equal(inspection.persistenceSchemaNeutralFiles, 8);
assert.equal(inspection.migrationChecksumParity, 'PASS'); assert.equal(inspection.backupContractParity, 'PASS');
assert.equal(inspection.providerContractParity, 'PASS'); assert.equal(inspection.schemaBaselineMutated, false);
assert.ok(inspection.requiredRegressions.includes('postgrest')); assert.ok(inspection.requiredRegressions.includes('mutation-native'));
assert.ok(inspection.requiredRegressions.includes('private-delete'));
const providerChain = reviewForCandidate(offlineGit, candidate.head).filter(review => review.files.some(row => row.file === 'src/providers/cloud/supabaseProvider.ts'));
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
for (const review of reviewForCandidate(offlineGit, candidate.head)) {
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
const specReview = reviewedImpacts.reviews.find(review => review.id === 'waca-spec-code-identity-v1');
assert.ok(specReview);
const v5Tag = 'checkpoint-20261001-erp2-v5-final-canonical-reconciliation-v1';
const v5Baseline = { sourceHead: specReview.beforeHead, checkpoint: v5Tag };
const specCandidate = { ...candidate, head: specReview.reviewedHead };
const v5Git = args => args[0] === 'ls-remote'
  ? `${v5Baseline.sourceHead}\trefs/tags/${v5Tag}^{}\n` : offlineGit(args);
const specInspection = inspectSafeDescendant({ git: v5Git, candidate: specCandidate, baselineRecord: v5Baseline });
assert.equal(specInspection.mode, 'SAFE_DESCENDANT');
assert.equal(specInspection.schemaSensitiveFiles, 0);
assert.equal(specInspection.migrationChecksumParity, 'PASS');
assert.equal(specInspection.canonicalContractParity, 'PASS');
assert.ok(specInspection.requiredRegressions.includes('spec-code'));
assert.ok(!specInspection.requiredRegressions.includes('mutation-native'), 'already adopted patches do not expand this release review');
assert.deepEqual([...new Set(specInspection.changedFiles.flatMap(row => row.reviewIds ?? []))], [specReview.id]);
for (const file of ['src/waca/orderCore.ts', 'src/pages/WacaIntegration.tsx',
  'supabase/sql/049_private_order_atomic_transaction.sql', 'tools/schema-reconciliation/schemaContract.mjs',
  'src/lib/durableResourceRegistry.ts', 'src/providers/cloud/supabaseProvider.ts']) {
  const badGit = args => args[0] === 'show' && args[1] === `${specCandidate.head}:${file}`
    ? v5Git(args) + '\nexport const unreviewedFutureContract = 1;' : v5Git(args);
  assert.throws(() => inspectSafeDescendant({ git: badGit, candidate: specCandidate, baselineRecord: v5Baseline }), /FAILED_CLOSED/u, file);
}
assert.throws(() => inspectSafeDescendant({ git: v5Git, candidate: specCandidate, baselineRecord: {
  ...v5Baseline, sourceHead: candidate.head } }), /FAILED_CLOSED/u, 'cannot relabel an old baseline as v5');
console.log('PASS v5 adopted review anchoring: only exact post-baseline spec patch; future hunks/SQL/provider/registry drift still blocked');
console.log('PASS exact WACA and mutation patches A/B/C; unchanged SQL, canonical, provider RPC and Backup/Restore contract; baseline immutable');
console.log('PASS future db/WACA/provider hunks, SQL/RLS/resource/RPC/allowlist drift, unknown files and missing/stale/failed/tampered evidence fail closed');
console.log('Unit fixtures only; real release regression execution is required separately; live writes=0');

const buyAnimeReview = reviewedImpacts.reviews.find(review => review.id === 'buyanime-canonical-identity-v1');
assert.ok(buyAnimeReview, 'BuyAnime review must bind an immutable exact patch');
const buyAnimeCandidate = { ...candidate, head: buyAnimeReview.reviewedHead };
assert.throws(() => reviewForCandidate(v5Git, buyAnimeCandidate.head), /FAILED_CLOSED/u,
  'an arbitrary missing review cannot reset the chain without a verified adoption boundary');
assert.ok(reviewForCandidate(v5Git, buyAnimeCandidate.head, v5Baseline.sourceHead)
  .some(review => review.id === buyAnimeReview.id));
const falseBoundaryGit = args => args[0] === '--no-replace-objects' && args[2] === '--is-ancestor'
  && args[3] === v5Baseline.sourceHead && args[4] === buyAnimeReview.beforeHead
  ? (() => { throw new Error('false adoption boundary'); })() : v5Git(args);
assert.throws(() => reviewForCandidate(falseBoundaryGit, buyAnimeCandidate.head, v5Baseline.sourceHead), /FAILED_CLOSED/u);
const v7BaselineHead = '60ca9f03aee353243b57b5d4d54b3f407ba085e2';
const successGateCandidateHead = 'e636274c23a84fbdd48bcafec63973c64ca0793c';
assert.ok(reviewForCandidate(realGit, successGateCandidateHead, v7BaselineHead)
  .some(review => review.id === 'buyanime-success-gate-provenance-reconciliation-v1'),
  'a v7 baseline must absorb discontinuities that are fully historical while preserving the exact post-baseline patch');
const buyAnimeInspection = inspectSafeDescendant({ git: v5Git, candidate: buyAnimeCandidate, baselineRecord: v5Baseline });
assert.equal(buyAnimeInspection.result, 'PASS');
assert.equal(buyAnimeInspection.schemaSensitiveFiles, 0);
assert.equal(buyAnimeInspection.unknownFiles, 0);
assert.equal(buyAnimeInspection.providerContractParity, 'PASS');
assert.equal(buyAnimeInspection.migrationChecksumParity, 'PASS');
assert.equal(buyAnimeInspection.backupContractParity, 'PASS');
assert.equal(buyAnimeInspection.canonicalContractParity, 'PASS');
assert.ok(buyAnimeInspection.requiredRegressions.includes('buyanime-real'));
const exactPatch = execFileSync('git', ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-color',
  buyAnimeReview.beforeHead, buyAnimeReview.reviewedHead, '--']);
assert.equal((await import('node:crypto')).createHash('sha256').update(exactPatch).digest('hex'), buyAnimeReview.patchSha256);
for (const file of ['src/providers/cloud/inventoryImportPlan.ts', 'src/providers/cloud/supabaseProvider.ts',
  'src/lib/db.ts', 'src/utils/myacgParser.ts', 'src/utils/myacgImportErrors.ts', 'src/pages/Inventory.tsx',
  'supabase/sql/050_catalog_atomic_transaction.sql', 'src/lib/durableResourceRegistry.ts',
  'tools/schema-reconciliation/schemaContract.mjs']) {
  const badGit = args => args[0] === 'show' && args[1] === `${buyAnimeCandidate.head}:${file}`
    ? v5Git(args) + '\nexport const futureRequiredDurableField = 1;' : v5Git(args);
  assert.throws(() => inspectSafeDescendant({ git: badGit, candidate: buyAnimeCandidate, baselineRecord: v5Baseline }), /FAILED_CLOSED/u, file);
}
const plannerFile = 'src/providers/cloud/inventoryImportPlan.ts';
const plannerSource = realGit(['show', `${buyAnimeCandidate.head}:${plannerFile}`]);
assertReviewedProviderContract(plannerFile, null, plannerSource);
assert.throws(() => assertReviewedProviderContract(plannerFile, null,
  plannerSource.replace('const byKey =', "fetch('/unsafe'); const byKey =")), /FAILED_CLOSED/u);
const beforeProvider = realGit(['show', `${buyAnimeReview.beforeHead}:${provider}`]);
const afterProvider = realGit(['show', `${buyAnimeReview.reviewedHead}:${provider}`]);
assertReviewedProviderContract(provider, beforeProvider, afterProvider);
assert.throws(() => assertReviewedProviderContract(provider, beforeProvider,
  afterProvider.replace("supabase.rpc('erp_apply_field_mutations'", "supabase.rpc('erp_unsafe_write'")), /FAILED_CLOSED/u);
assert.equal(classifyDescendantFile('src/providers/cloud/futurePlanner.ts', null, 'unknown'), 'SCHEMA_SENSITIVE_OR_UNREVIEWED');
const successGateReview = reviewedImpacts.reviews.find(review => review.id === 'buyanime-success-gate-provenance-reconciliation-v1');
assert.ok(successGateReview);
const resumeFile = 'src/providers/cloud/buyAnimeImportResume.ts';
const resumeBefore = realGit(['show', `${successGateReview.beforeHead}:${resumeFile}`]);
const resumeAfter = realGit(['show', `${successGateReview.reviewedHead}:${resumeFile}`]);
assert.doesNotThrow(() => assertReviewedProviderContract(resumeFile, resumeBefore, resumeAfter));
assert.throws(() => assertReviewedProviderContract(resumeFile, resumeBefore,
  resumeAfter.replace('const reconciled =', "fetch('/unsafe'); const reconciled =")), /FAILED_CLOSED/u);
console.log('PASS exact BuyAnime canonical identity diff and SHA; future planner/provider/DB/parser/RPC/migration/backup/canonical hunks fail closed');
