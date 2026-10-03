import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CANONICAL_ERP2_TARGET as target, DeploymentGuardError, assertCanonicalContract,
  runGitAt, validatePublicTarget, verifyRemoteCandidate, verifyCloudflareIdentity,
  verifyArtifactIdentity, verifySchemaBaselineEvidence, buildManifestIdentity,
} from './promotion-safety.mjs';
import { buildMigrationEffectRegistry } from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';

const fail = message => { throw new DeploymentGuardError(message); };
const sha = value => /^[a-f0-9]{40}$/u.test(value ?? '');
const remoteTag = (git, tag) => {
  git(['check-ref-format', `refs/tags/${tag}`]);
  const refs = new Map(git(['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
    .trim().split(/\r?\n/u).filter(Boolean).map(row => { const [head, ref] = row.split(/\s+/u); return [ref, head]; }));
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
};
const ancestor = (git, before, after, label) => {
  try { git(['--no-replace-objects', 'merge-base', '--is-ancestor', before, after]); }
  catch { fail(`${label} ancestry missing`); }
};

// A registered, previously published immutable release is mandatory. This is
// not a --force flag, a broad old-commit allowlist, or SAFE_DESCENDANT bypass.
export function verifyHistoricalRelease({ registry, releaseId, manifest, git, tooling, contract, deployments }) {
  assertCanonicalContract(contract);
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.releases)
    || registry.releases.filter(row => row.id === releaseId).length !== 1) fail('unknown historical release');
  const release = registry.releases.find(row => row.id === releaseId);
  if (!sha(release.head) || !release.checkpoint?.startsWith('checkpoint-') || !release.recoveryTag?.startsWith('backup-')
    || !/^[A-F0-9]{64}$/u.test(release.artifactIdentity ?? '') || !Number.isSafeInteger(release.artifactFiles)
    || release.artifactFiles < 1 || !release.knownGoodReleaseEvidence
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(release.deploymentId ?? '')
    || release.canonicalContract !== contract.schemaBaseline.canonicalContract
    || release.canonicalFingerprint !== contract.schemaBaseline.canonicalFingerprint
    || release.deploymentUrl !== `https://${release.deploymentId.slice(0, 8)}.${target.domain}`) {
    fail('invalid known historical release contract');
  }
  if (git(['--no-replace-objects', 'rev-parse', `${release.head}^{commit}`]).trim() !== release.head
    || git(['rev-parse', `${release.checkpoint}^{}`]).trim() !== release.head
    || remoteTag(git, release.checkpoint) !== release.head
    || git(['rev-parse', `${release.recoveryTag}^{}`]).trim() !== release.head
    || remoteTag(git, release.recoveryTag) !== release.head) fail('historical Git/checkpoint identity mismatch');
  ancestor(git, release.head, tooling.head, 'historical source -> release tooling');
  const gate = contract.githubPreDeployGate;
  let lineageMode;
  try { git(['--no-replace-objects', 'merge-base', '--is-ancestor', gate.acceptedHead, release.head]);
    lineageMode = 'DIRECT_ACCEPTED_BASELINE_DESCENDANT'; }
  catch { ancestor(git, gate.lineage.reconciliationHead, release.head, 'accepted reconciled source');
    lineageMode = 'RECONCILED_CHECKPOINT_DESCENDANT'; }
  if (manifest?.identity !== release.artifactIdentity || manifest.files?.length !== release.artifactFiles
    || manifest.source?.head !== release.head || manifest.source?.branch !== release.branch
    || manifest.source?.checkpointTag !== release.checkpoint
    || manifest.target?.accountId !== target.accountId || manifest.target?.project !== target.project
    || manifest.target?.supabaseProject !== target.supabaseProject
    || manifest.target?.publicFingerprint !== target.publicFingerprint
    || manifest.target?.pagesBranch !== target.pagesBranch) fail('historical artifact HEAD/target mismatch');
  const deployment = Array.isArray(deployments) ? deployments.find(row => row.Id === release.deploymentId) : null;
  if (!deployment || deployment.Environment !== 'Production' || deployment.Branch !== target.pagesBranch
    || !/^[a-f0-9]{7,40}$/u.test(deployment.Source ?? '') || !release.head.startsWith(deployment.Source)
    || deployment.Deployment !== release.deploymentUrl
    || deployment.Build !== `https://dash.cloudflare.com/${target.accountId}/pages/view/${target.project}/${release.deploymentId}`) {
    fail('historical Cloudflare deployment evidence mismatch');
  }
  return { release, deployment, candidate: { head: release.head, branch: release.branch,
    checkpointTag: release.checkpoint, acceptedBaselineTag: gate.acceptedTag, acceptedBaselineHead: gate.acceptedHead,
    reconciliationTag: gate.lineage.reconciliationTag, reconciliationHead: gate.lineage.reconciliationHead, lineageMode } };
}

export function verifyRecoveryPoint({ git, tag, manifest, deployments, tooling, now = Date.now() }) {
  if (!tag?.startsWith('backup-') || git(['cat-file', '-t', `refs/tags/${tag}`]).trim() !== 'tag') fail('annotated current recovery tag required');
  const tagRefs = new Map(git(['ls-remote', 'origin', `refs/tags/${tag}`]).trim().split(/\r?\n/u)
    .filter(Boolean).map(row => { const [head, ref] = row.split(/\s+/u); return [ref, head]; }));
  if (tagRefs.get(`refs/tags/${tag}`) !== git(['rev-parse', `refs/tags/${tag}`]).trim()) fail('remote recovery annotation identity mismatch');
  let point;
  try { point = JSON.parse(git(['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`]).trim()); }
  catch { fail('current runtime recovery metadata missing'); }
  const age = now - Date.parse(point.capturedAt ?? '');
  const { identity, ...manifestPayload } = manifest;
  if (point.kind !== 'ERP2_RUNTIME_RECOVERY_POINT' || !Number.isFinite(age) || age < -60000 || age > 7200000
    || manifest.schemaVersion !== 2 || identity !== buildManifestIdentity(manifestPayload)
    || point.head !== manifest.source?.head || point.checkpoint !== manifest.source?.checkpointTag
    || point.artifactIdentity !== manifest.identity || point.accountId !== target.accountId
    || point.project !== target.project || point.supabaseProject !== target.supabaseProject
    || point.publicFingerprint !== target.publicFingerprint
    || manifest.target?.accountId !== point.accountId || manifest.target?.project !== point.project
    || manifest.target?.supabaseProject !== point.supabaseProject
    || manifest.target?.publicFingerprint !== point.publicFingerprint
    || git(['rev-parse', `${tag}^{}`]).trim() !== point.head || remoteTag(git, tag) !== point.head
    || remoteTag(git, point.checkpoint) !== point.head) fail('current runtime recovery point mismatch');
  const refs = new Map(git(['ls-remote', 'origin', `refs/heads/${point.branch}`]).trim().split(/\r?\n/u).map(row => { const [head, ref] = row.split(/\s+/u); return [ref, head]; }));
  if (refs.get(`refs/heads/${point.branch}`) !== point.head) fail('current release branch moved since recovery point');
  ancestor(git, point.head, tooling.head, 'current release -> tooling');
  if (!deployments?.some(row => row.Id === point.deploymentId && row.Environment === 'Production'
    && row.Branch === target.pagesBranch && point.head.startsWith(row.Source)
    && row.Build === `https://dash.cloudflare.com/${target.accountId}/pages/view/${target.project}/${point.deploymentId}`)) {
    fail('current recovery deployment not verified');
  }
  return { result: 'PASS', tag, ...point };
}

export function assertRollbackCompatibility({ schemaBaseline, artifact, release, contract }) {
  const lineage = schemaBaseline?.deploymentLineage;
  if (schemaBaseline?.result !== 'PASS' || schemaBaseline.mode !== 'POST_ADOPTION'
    || schemaBaseline.currentFingerprint !== contract.schemaBaseline.canonicalFingerprint
    || !Array.isArray(schemaBaseline.applyDelta) || schemaBaseline.applyDelta.length
    || lineage?.result !== 'PASS' || lineage.schemaBaselineMutated !== false
    || !['SAFE_DESCENDANT', 'EXACT_BASELINE'].includes(lineage.mode)
    || (lineage.mode === 'SAFE_DESCENDANT' && (lineage.schemaSensitiveFiles !== 0 || lineage.unknownFiles !== 0
      || lineage.migrationChecksumParity !== 'PASS' || lineage.canonicalContractParity !== 'PASS'
      || lineage.providerContractParity !== 'PASS' || lineage.backupContractParity !== 'PASS'))
    || artifact?.result !== 'PASS' || artifact.identity !== release.artifactIdentity
    || artifact.source?.head !== release.head || artifact.files !== release.artifactFiles) {
    fail('current DB/runtime compatibility not proven');
  }
  return { result: 'PASS', currentFingerprint: schemaBaseline.currentFingerprint, migrationDelta: 0 };
}

export async function runHistoricalRollbackGuard({ root, args, environment, wrangler, now = Date.now() }) {
  const contract = JSON.parse(await readFile(resolve(root, 'config/erp-environment-identity.json')));
  const git = runGitAt(root);
  const tooling = verifyRemoteCandidate({ contract, git, checkpointTag: args.get('checkpoint-tag'), label: 'release tooling' });
  const publicTarget = validatePublicTarget(environment);
  const cloudflare = verifyCloudflareIdentity({ contract, wrangler });
  const registry = JSON.parse(await readFile(resolve(root, 'config/erp2-historical-runtime-releases.json')));
  const artifactRoot = resolve(root, args.get('artifact-dir') ?? fail('missing historical artifact directory'));
  const manifest = JSON.parse(await readFile(resolve(artifactRoot, 'erp-build-identity.json')));
  const deployments = wrangler(['pages', 'deployment', 'list', '--profile', cloudflare.profile,
    '--project-name', cloudflare.project, '--json'], cloudflare.accountId);
  const historical = verifyHistoricalRelease({ registry, releaseId: args.get('release-id'), manifest, git, tooling, contract, deployments });
  const artifact = await verifyArtifactIdentity({ artifactRoot, proof: historical, contract });
  // Independently compare the original published manifest, not just the local
  // registry or recovered directory. Full payload checksums were checked above.
  const remoteManifest = await fetch(`${historical.release.deploymentUrl}/erp-build-identity.json`,
    { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) }).then(response => {
    if (!response.ok) fail('historical deployment manifest inaccessible'); return response.json();
  });
  if (JSON.stringify(remoteManifest) !== JSON.stringify(manifest)) fail('recovered manifest differs from actual historical deployment');
  const dailyManifest = await fetch(`https://${target.domain}/erp-build-identity.json`,
    { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) }).then(response => {
    if (!response.ok) fail('current daily runtime manifest inaccessible'); return response.json();
  });
  const recoveryPoint = verifyRecoveryPoint({ git, tag: args.get('recovery-tag'), manifest: dailyManifest, deployments, tooling, now });
  const schemaEvidence = JSON.parse(await readFile(resolve(root, args.get('schema-evidence') ?? fail('fresh schema evidence required'))));
  const changeImpactEvidence = JSON.parse(await readFile(resolve(root, args.get('change-impact-evidence') ?? fail('historical change-impact evidence required'))));
  if (schemaEvidence.mode !== 'POST_ADOPTION') fail('historical rollback requires adopted current canonical schema');
  const schemaBaseline = verifySchemaBaselineEvidence({ evidence: schemaEvidence, contract,
    candidate: historical.candidate, candidateGit: git, changeImpactEvidence,
    migrationRegistry: await buildMigrationEffectRegistry(), now, liveObservation: {
      projectRef: environment.ERP2_LIVE_SCHEMA_PROJECT_REF,
      fingerprint: environment.ERP2_LIVE_SCHEMA_FINGERPRINT,
      observedAt: environment.ERP2_LIVE_SCHEMA_OBSERVED_AT,
    } });
  assertRollbackCompatibility({ schemaBaseline, artifact, release: historical.release, contract });
  if (git(['rev-parse', 'HEAD']).trim() !== tooling.head || git(['status', '--porcelain', '--untracked-files=all']).trim()) {
    fail('release tooling changed during rollback verification');
  }
  return { result: 'PASS', mode: 'HISTORICAL_RUNTIME_ROLLBACK', candidate: historical.candidate,
    guardSource: tooling, cloudflare, publicTarget, artifact, schemaBaseline, recoveryPoint,
    historicalDeployment: historical.deployment, currentDBCompatibility: 'PASS',
    historicalRuntimeChanged: false, schemaBaselineMutated: false, candidateWorktree: root, artifactRoot };
}
