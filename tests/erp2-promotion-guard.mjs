import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANONICAL_ERP2_TARGET,
  buildManifestIdentity,
  listArtifactFiles,
  validatePublicTarget,
  verifyArtifactIdentity,
  verifyCloudflareIdentity,
  verifyPromotionIdentity,
  verifyRemoteCandidate,
  verifySchemaBaselineEvidence,
} from '../scripts/promotion-safety.mjs';
import { sealSchemaEvidence } from '../tools/schema-reconciliation/evidenceContract.mjs';
import { SCHEMA_FINGERPRINT_CONTRACT_VERSION, SCHEMA_CANONICAL_CONTRACT, SQL_CANONICAL_ALGORITHM } from '../tools/schema-reconciliation/schemaContract.mjs';

const contract = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url), 'utf8'));
const accepted = contract.githubPreDeployGate.acceptedHead;
const acceptedTag = contract.githubPreDeployGate.acceptedTag;
const reconciled = contract.githubPreDeployGate.lineage.reconciliationHead;
const reconciledTag = contract.githubPreDeployGate.lineage.reconciliationTag;
const head = '1111111111111111111111111111111111111111';
const branch = 'codex/next-promotion-fixture';
const checkpoint = 'checkpoint-promotion-fixture';

function gitFixture(overrides = {}) {
  const state = {
    head, branch, checkpointHead: head, remoteHead: head, dirty: '',
    acceptedRemote: accepted, reconciledRemote: reconciled,
    acceptedLocal: accepted, reconciledLocal: reconciled,
    lightweightCheckpoint: false, lightweightAccepted: false, lightweightReconciled: false,
    remoteUrl: 'https://github.com/johnpan123-ai/daigou-erp-mvp-backup.git',
    directAncestor: false, reconciledAncestor: true,
    ...overrides,
  };
  const git = argv => {
    if (argv[0] === 'rev-parse') {
      if (argv[1] === 'HEAD') return state.head;
      if (argv[1] === `${checkpoint}^{}`) return state.checkpointHead ?? '';
      if (argv[1] === `${acceptedTag}^{}`) return state.acceptedLocal ?? '';
      if (argv[1] === `${reconciledTag}^{}`) return state.reconciledLocal ?? '';
    }
    if (argv[0] === 'branch') return state.branch;
    if (argv[0] === 'status') return state.dirty;
    if (argv[0] === 'check-ref-format') return '';
    if (argv[0] === 'remote') return state.remoteUrl;
    if (argv[0] === 'ls-remote') return [
      state.remoteHead && `${state.remoteHead}\trefs/heads/${state.branch}`,
      state.checkpointHead && `${state.checkpointHead}\trefs/tags/${checkpoint}${state.lightweightCheckpoint ? '' : '^{}'}`,
      state.acceptedRemote && `${state.acceptedRemote}\trefs/tags/${acceptedTag}${state.lightweightAccepted ? '' : '^{}'}`,
      state.reconciledRemote && `${state.reconciledRemote}\trefs/tags/${reconciledTag}${state.lightweightReconciled ? '' : '^{}'}`,
    ].filter(Boolean).join('\n');
    if (argv[0] === '--no-replace-objects') {
      const ancestor = argv.at(-2);
      if ((ancestor === accepted && state.directAncestor) || (ancestor === reconciled && state.reconciledAncestor)) return '';
      throw new Error('not ancestor');
    }
    throw new Error(`unexpected git call: ${argv.join(' ')}`);
  };
  return { git, state };
}

const positiveGit = gitFixture();
const candidate = verifyRemoteCandidate({ contract, git: positiveGit.git, checkpointTag: checkpoint });
assert.equal(candidate.lineageMode, 'RECONCILED_CHECKPOINT_DESCENDANT');
assert.equal(candidate.remoteCheckpointPeeledHead, head);
const buyAnimeCandidate = verifyRemoteCandidate({
  contract,
  git: gitFixture({ branch: 'codex/buyanime-final-fast-path-v1' }).git,
  checkpointTag: checkpoint,
});
assert.equal(buyAnimeCandidate.branch, 'codex/buyanime-final-fast-path-v1');
assert.throws(() => verifyRemoteCandidate({
  contract,
  git: gitFixture({ branch: 'codex/feature-unreviewed' }).git,
  checkpointTag: checkpoint,
}), /DEPLOYMENT_GUARD_FAILED_CLOSED/u);
console.log('PASS exact BuyAnime release branch family; unrelated branch family remains fail-closed');
const lightweightCandidate = verifyRemoteCandidate({
  contract,
  git: gitFixture({ lightweightCheckpoint: true, lightweightAccepted: true, lightweightReconciled: true }).git,
  checkpointTag: checkpoint,
});
assert.equal(lightweightCandidate.remoteCheckpointPeeledHead, head);
console.log('PASS lightweight and annotated remote checkpoint tags resolve to the same commit contract');

const cloudflare = verifyCloudflareIdentity({ contract, wrangler: argv => argv[0] === 'whoami'
  ? { loggedIn: true, accounts: [{ id: CANONICAL_ERP2_TARGET.accountId }] }
  : [{ 'Project Name': CANONICAL_ERP2_TARGET.project, 'Project Domains': CANONICAL_ERP2_TARGET.domain }] });
assert.equal(cloudflare.project, CANONICAL_ERP2_TARGET.project);

const negatives = [
  ['dirty worktree', () => verifyRemoteCandidate({ contract, git: gitFixture({ dirty: ' M src/App.tsx' }).git, checkpointTag: checkpoint })],
  ['remote branch mismatch', () => verifyRemoteCandidate({ contract, git: gitFixture({ remoteHead: accepted }).git, checkpointTag: checkpoint })],
  ['checkpoint mismatch', () => verifyRemoteCandidate({ contract, git: gitFixture({ checkpointHead: accepted }).git, checkpointTag: checkpoint })],
  ['checkpoint missing', () => verifyRemoteCandidate({ contract, git: gitFixture({ checkpointHead: null }).git, checkpointTag: checkpoint })],
  ['accepted tag mismatch', () => verifyRemoteCandidate({ contract, git: gitFixture({ acceptedRemote: head }).git, checkpointTag: checkpoint })],
  ['invalid ancestry', () => verifyRemoteCandidate({ contract, git: gitFixture({ directAncestor: false, reconciledAncestor: false }).git, checkpointTag: checkpoint })],
  ['wrong account', () => verifyCloudflareIdentity({ contract, wrangler: argv => argv[0] === 'whoami'
    ? { loggedIn: true, accounts: [{ id: 'wrong' }] } : [] })],
  ['wrong project', () => verifyCloudflareIdentity({ contract, wrangler: argv => argv[0] === 'whoami'
    ? { loggedIn: true, accounts: [{ id: CANONICAL_ERP2_TARGET.accountId }] } : [] })],
  ['wrong project domain', () => verifyCloudflareIdentity({ contract, wrangler: argv => argv[0] === 'whoami'
    ? { loggedIn: true, accounts: [{ id: CANONICAL_ERP2_TARGET.accountId }] }
    : [{ 'Project Name': CANONICAL_ERP2_TARGET.project, 'Project Domains': 'wrong.pages.dev' }] })],
  ['wrong Supabase ref', () => validatePublicTarget({
    VITE_DEPLOYMENT_ENV: 'staging', VITE_SUPABASE_URL: 'https://twzpqyesbtnfxdkorluf.supabase.co', VITE_SUPABASE_ANON_KEY: 'not-logged',
  })],
  ['wrong fingerprint', () => validatePublicTarget({
    VITE_DEPLOYMENT_ENV: 'staging', VITE_SUPABASE_URL: `https://${CANONICAL_ERP2_TARGET.supabaseProject}.supabase.co`, VITE_SUPABASE_ANON_KEY: 'wrong',
  })],
];
for (const [name, action] of negatives) {
  assert.throws(action, /DEPLOYMENT_GUARD_FAILED_CLOSED/u, name);
  console.log(`PASS fail-closed: ${name}`);
}

const proof = verifyPromotionIdentity({
  contract, checkpointTag: checkpoint,
  candidateGit: positiveGit.git, guardGit: positiveGit.git,
  environment: {}, targetValidator: () => ({
    supabaseProject: CANONICAL_ERP2_TARGET.supabaseProject,
    publicFingerprint: CANONICAL_ERP2_TARGET.publicFingerprint,
  }),
  wrangler: argv => argv[0] === 'whoami'
    ? { loggedIn: true, accounts: [{ id: CANONICAL_ERP2_TARGET.accountId }] }
    : [{ name: CANONICAL_ERP2_TARGET.project, domains: [CANONICAL_ERP2_TARGET.domain] }],
});
assert.equal(proof.result, 'PASS');

const baselineFingerprint = contract.schemaBaseline.canonicalFingerprint;
const observedAt = '2026-09-29T04:00:00.000Z';
const now = Date.parse(observedAt);
const liveObservation = {
  projectRef: CANONICAL_ERP2_TARGET.supabaseProject, fingerprint: baselineFingerprint, observedAt,
};
const schemaEvidence = sealSchemaEvidence({
  contractVersion: 2, mode: 'PRE_ADOPTION', requiredBaselineId: contract.schemaBaseline.requiredBaselineId,
  fingerprintContractVersion: SCHEMA_FINGERPRINT_CONTRACT_VERSION,
  canonicalContract: SCHEMA_CANONICAL_CONTRACT, canonicalAlgorithm: SQL_CANONICAL_ALGORITHM,
  projectRef: CANONICAL_ERP2_TARGET.supabaseProject, sourceHead: head, checkpoint,
  migrationHistoryProvenance: 'UNAVAILABLE', currentFingerprint: baselineFingerprint,
  expectedFingerprint: baselineFingerprint, targetAfterDeltaFingerprint: baselineFingerprint,
  snapshotIdentity: {
    projectRef: CANONICAL_ERP2_TARGET.supabaseProject, environmentRole: 'PRODUCTION', capturedAt: observedAt,
    snapshotToolChecksum: contract.schemaBaseline.snapshotToolChecksum,
    schemaSnapshotChecksum: 'b'.repeat(64), currentFingerprint: baselineFingerprint,
  },
  evidenceFingerprint: 'c'.repeat(64), readyForApply: true, blockers: [], applyPlan: [],
  migrations: [{
    migrationId: 'fixture', sourceFile: 'fixture.sql', sourceChecksum: 'd'.repeat(64), canonicalOrder: 1,
    state: 'SATISFIED', safeToApply: false, dependencies: [], dependencySources: [], dependencyEvidence: [],
    repairs: [], applyMethod: 'NO_APPLY',
  }],
});
const schemaRegistry = Object.fromEntries(schemaEvidence.migrations.map(item => [item.migrationId, {
  sourceFile: item.sourceFile, sourceChecksum: item.sourceChecksum, canonicalOrder: item.canonicalOrder,
  dependencies: item.dependencies, dependencySources: item.dependencySources,
  repairClosure: item.repairClosure, repairs: item.repairs,
}]));
assert.equal(verifySchemaBaselineEvidence({ evidence: schemaEvidence, contract, candidate, liveObservation,
  migrationRegistry: schemaRegistry, now }).result, 'PASS');
for (const evidence of [
  sealSchemaEvidence({ ...schemaEvidence, projectRef: 'wrong' }),
  sealSchemaEvidence({ ...schemaEvidence, sourceHead: accepted }),
  sealSchemaEvidence({ ...schemaEvidence, blockers: [{ migrationId: '044', state: 'UNKNOWN' }] }),
  sealSchemaEvidence({ ...schemaEvidence, migrations: [{ ...schemaEvidence.migrations[0], state: 'UNKNOWN' }] }),
]) assert.throws(() => verifySchemaBaselineEvidence({ evidence, contract, candidate, liveObservation,
  migrationRegistry: schemaRegistry, now }), /DEPLOYMENT_GUARD_FAILED_CLOSED/u);
console.log('PASS fail-closed: schema baseline evidence');

const artifactRoot = await mkdtemp(join(tmpdir(), 'erp2-promotion-artifact-'));
try {
  await writeFile(join(artifactRoot, 'index.html'), '<!doctype html>fixture', 'utf8');
  const evidence = {
    schemaVersion: 2,
    schemaContract: { name: contract.schemaBaseline.canonicalContract,
      algorithm: contract.schemaBaseline.canonicalAlgorithm,
      version: contract.schemaBaseline.fingerprintContractVersion,
      fingerprint: contract.schemaBaseline.canonicalFingerprint },
    source: {
      head, branch, checkpointTag: checkpoint,
      acceptedBaselineTag: candidate.acceptedBaselineTag,
      acceptedBaselineHead: candidate.acceptedBaselineHead,
      lineageMode: candidate.lineageMode,
      reconciliationTag: candidate.reconciliationTag,
      reconciliationHead: candidate.reconciliationHead,
    },
    target: {
      role: CANONICAL_ERP2_TARGET.role, accountId: CANONICAL_ERP2_TARGET.accountId,
      project: CANONICAL_ERP2_TARGET.project, pagesBranch: CANONICAL_ERP2_TARGET.pagesBranch,
      runtimeMarker: CANONICAL_ERP2_TARGET.runtimeMarker,
      supabaseProject: CANONICAL_ERP2_TARGET.supabaseProject,
      publicFingerprint: CANONICAL_ERP2_TARGET.publicFingerprint,
    },
    build: { timestamp: '2026-09-28T00:00:00.000Z', mode: 'staging' },
    files: await listArtifactFiles(artifactRoot),
  };
  await writeFile(join(artifactRoot, 'erp-build-identity.json'), JSON.stringify({ ...evidence, identity: buildManifestIdentity(evidence) }));
  assert.equal((await verifyArtifactIdentity({ artifactRoot, proof, contract })).result, 'PASS');
  await writeFile(join(artifactRoot, 'index.html'), '<!doctype html>tampered', 'utf8');
  await assert.rejects(verifyArtifactIdentity({ artifactRoot, proof, contract }), /artifact file hash inventory mismatch/u);
  console.log('PASS fail-closed: artifact SHA mismatch');
} finally {
  await rm(artifactRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ result: 'PASS', negativeCases: negatives.length + 1, liveMutation: 0 }));
