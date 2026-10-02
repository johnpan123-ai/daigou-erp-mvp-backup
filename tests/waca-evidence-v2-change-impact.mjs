import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspectSafeDescendant, classifyDescendantFile } from '../scripts/post-adoption-descendant.mjs';
import { reviewedImpacts, sourceHash, reviewForCandidate } from '../scripts/reviewed-change-impact.mjs';

const review = reviewedImpacts.reviews.find(row => row.id === 'waca-evidence-resolver-v2');
assert.ok(review, 'this exact immutable patch must be registered');
const base = 'd0574a9525567febb6f7b21ceda992f80497033c';
const head = '0a2ae478a29d7fa24f5ccca9da82484bfb8a4093';
assert.equal(review.beforeHead, base);
assert.equal(review.reviewedHead, head);
const gitCache = new Map();
const realGit = args => {
  const key = JSON.stringify(args);
  if (!gitCache.has(key)) gitCache.set(key, execFileSync('git', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }));
  return gitCache.get(key);
};
const changed = realGit(['diff', '--name-only', '--no-renames', base, head, '--'])
  .trim().split(/\r?\n/u).sort();
assert.deepEqual(review.files.map(row => row.file).sort(), changed);
assert.equal(changed.length, 13);
assert.equal(changed.filter(file => file.startsWith('src/')).length, 3);
assert.equal(changed.filter(file => file.startsWith('tests/')).length, 10);
const patch = execFileSync('git', ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-color', base, head, '--']);
assert.equal(createHash('sha256').update(patch).digest('hex'), review.patchSha256);
for (const row of review.files) {
  assert.equal(sourceHash(realGit(['show', `${head}:${row.file}`])), row.afterHash);
  for (const key of ['changedInputs', 'changedOutputs', 'changedDurableFields', 'changedRpcContract',
    'changedProviderContract', 'changedBackupContract', 'changedSchemaExpectations', 'changedIdentitySemantics']) {
    assert.equal(typeof row[key], 'string', `${row.file}: ${key}`);
    assert.ok(row[key].length > 0);
  }
  assert.ok(row.functions.length > 0);
}
assert.equal(review.files.filter(row => row.classification === 'APPLICATION_DOMAIN_ONLY').length, 12);
assert.equal(review.files.filter(row => row.classification === 'PERSISTENCE_BEHAVIOR_SCHEMA_NEUTRAL').length, 1);
assert.equal(review.schemaSensitiveCount, 0);
assert.equal(review.unknownCount, 0);
assert.equal(review.newDurableResources, 0);
assert.equal(review.newRequiredDurableFields, 0);
for (const key of ['migrationChecksumParity', 'canonicalContractParity', 'backupContractParity', 'providerContractParity']) {
  assert.equal(review[key], 'PASS');
}

// These are deliberately offline unit fixtures. Only the baseline remote-tag
// lookup is substituted. Release execution separately verifies real remotes,
// clean fixed HEAD, exact script checksums and actual regression exit codes.
const specReview = reviewedImpacts.reviews.find(row => row.id === 'waca-spec-code-identity-v1');
const baseline = {
  sourceHead: specReview.beforeHead,
  checkpoint: 'checkpoint-20261001-erp2-v5-final-canonical-reconciliation-v1',
};
const offlineGit = args => args[0] === 'ls-remote'
  ? `${baseline.sourceHead}\trefs/tags/${baseline.checkpoint}^{}\n` : realGit(args);
const candidate = { head, checkpointTag: 'checkpoint-20261002-waca-evidence-resolver-v2',
  branch: 'codex/next-waca-order-integration-v1' };
const inspection = inspectSafeDescendant({ git: offlineGit, candidate, baselineRecord: baseline });
assert.equal(inspection.result, 'PASS');
assert.equal(inspection.mode, 'SAFE_DESCENDANT');
assert.equal(inspection.schemaSensitiveFiles, 0);
assert.equal(inspection.unknownFiles, 0);
assert.equal(inspection.schemaBaselineMutated, false);
for (const key of ['migrationChecksumParity', 'canonicalContractParity', 'backupContractParity', 'providerContractParity']) {
  assert.equal(inspection[key], 'PASS');
}
assert.ok(inspection.requiredRegressions.includes('evidence-review'));
assert.ok(inspection.requiredRegressions.includes('evidence-resolver'));
assert.ok(inspection.requiredRegressions.includes('postgrest'));
assert.deepEqual([...new Set(inspection.changedFiles.flatMap(row => row.reviewIds ?? []))], [specReview.id, review.id]);
assert.ok(reviewForCandidate(offlineGit, head).some(row => row.id === review.id));

const failMutation = (file, suffix) => {
  const mutatedGit = args => args[0] === 'show' && args[1] === `${head}:${file}`
    ? offlineGit(args) + suffix : offlineGit(args);
  assert.throws(() => inspectSafeDescendant({ git: mutatedGit, candidate, baselineRecord: baseline }),
    /FAILED_CLOSED/u, file);
};
for (const [file, suffix] of [
  ['src/waca/orderCore.ts', '\nexport interface FutureRequiredDurableField { requiredRevision: string }'],
  ['src/pages/WacaIntegration.tsx', "\nconst futureRpcPayload = { rpc: 'new_rpc', requiredField: 'new' };"],
  ['src/waca/masterReference.ts', '\nexport const newPersistentIdentity = true;'],
  ['src/providers/cloud/supabaseProvider.ts', "\nconst futureWrite = 'new_required_sql_column';"],
  ['src/lib/durableResourceRegistry.ts', "\nconst futureResource = 'new_durable_table';"],
  ['tools/schema-reconciliation/schemaContract.mjs', '\nconst futureFingerprint = 2;'],
  ['supabase/sql/044_waca_cloud_ledger.sql', '\n-- future RLS / ACL change'],
  ['supabase/sql/049_private_order_atomic_transaction.sql', '\n-- future migration change'],
]) failMutation(file, suffix);
for (const file of ['src/waca/unknownDurableRequirement.ts', 'src/providers/cloud/unknownPersistence.ts']) {
  assert.equal(classifyDescendantFile(file, null, 'new required durable contract'), 'SCHEMA_SENSITIVE_OR_UNREVIEWED');
}
const unknownFile = 'src/waca/unknownDurableRequirement.ts';
const unknownGit = args => {
  if (args[0] === 'ls-tree' && args.at(-1) === head) return offlineGit(args) + `${unknownFile}\n`;
  if (args[0] === 'diff' && args[3] === baseline.sourceHead && args[4] === head) return offlineGit(args) + `${unknownFile}\n`;
  if (args[0] === 'show' && args[1] === `${head}:${unknownFile}`) return 'export const newResource = true;';
  return offlineGit(args);
};
assert.throws(() => inspectSafeDescendant({ git: unknownGit, candidate, baselineRecord: baseline }), /FAILED_CLOSED/u);
const unrelatedGit = args => {
  if (args[0] === '--no-replace-objects' && args[3] === baseline.sourceHead && args[4] === head) {
    throw new Error('non-descendant fixture');
  }
  return offlineGit(args);
};
assert.throws(() => inspectSafeDescendant({ git: unrelatedGit, candidate, baselineRecord: baseline }), /FAILED_CLOSED/u);

// Optional JSONB provenance is explicitly disclosed, not claimed absent.
const domainReview = review.files.find(row => row.file === 'src/waca/orderCore.ts');
assert.match(domainReview.changedDurableFields, /resolution/u);
assert.match(domainReview.changedDurableFields, /candidateCount/u);
const domain = realGit(['show', `${head}:src/waca/orderCore.ts`]);
assert.match(domain, /resolution\?:/u);
assert.match(domain, /candidateCount\?:/u);
const sqlPath = 'supabase/sql/044_waca_cloud_ledger.sql';
assert.equal(realGit(['show', `${base}:${sqlPath}`]), realGit(['show', `${head}:${sqlPath}`]));
const policy = JSON.parse(readFileSync(new URL('../config/erp2-non-schema-release-policy.json', import.meta.url), 'utf8'));
assert.ok(policy.schemaSensitivePrefixes.includes('src/waca/'));
assert.ok(!policy.purePresentationFiles.includes('src/waca/orderCore.ts'));
console.log('PASS exact 13-file v2 diff; 12 application-domain / 1 persistence-schema-neutral; optional provenance disclosed');
console.log('PASS migration/canonical/provider/Backup/Deadline/Atomic Restore parity; no new required durable resource/field');
console.log('PASS future WACA durable/RPC/provider/registry/migration/canonical/unknown/non-descendant changes fail closed');
console.log('Offline unit fixtures only; release requires actual fixed-HEAD regression evidence and fresh Live Guard; Live writes=0');
