import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_ERP2_TARGET,
  buildManifestIdentity,
  listArtifactFiles,
  runGitAt,
  validatePublicTarget,
  verifyArtifactIdentity,
  verifyLocalCandidate,
} from './promotion-safety.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_ROOT = resolve(ROOT, 'staging-release-artifacts');
const DIST_DIR = resolve(OUTPUT_ROOT, 'dist');

const readCheckpoint = argv => {
  const marker = argv.indexOf('--checkpoint-tag');
  if (marker < 0 || !argv[marker + 1] || argv.length !== 2) {
    throw new Error('STAGING_BUILD_FAILED_CLOSED: use exactly --checkpoint-tag <remote-ready-checkpoint>');
  }
  return argv[marker + 1];
};

const run = (file, args, environment) => {
  const result = spawnSync(file, args, { cwd: ROOT, stdio: 'inherit', env: environment });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} exited with status ${result.status}`);
};

const checkpointTag = readCheckpoint(process.argv.slice(2));
const contract = JSON.parse(await readFile(resolve(ROOT, 'config/erp-environment-identity.json'), 'utf8'));
const publicTarget = validatePublicTarget(process.env);
const source = verifyLocalCandidate({ contract, git: runGitAt(ROOT), checkpointTag });
const buildTimestamp = new Date().toISOString();
const buildEnvironment = {
  ...process.env,
  VITE_ERP_BUILD_SHA: source.head,
  VITE_ERP_BUILD_BRANCH: source.branch,
  VITE_ERP_CHECKPOINT_TAG: source.checkpointTag,
  VITE_ERP_ACCEPTED_TAG: source.acceptedBaselineTag,
  VITE_ERP_BUILD_TIME: buildTimestamp,
  VITE_ERP_ENVIRONMENT_ROLE: CANONICAL_ERP2_TARGET.role,
};

await rm(OUTPUT_ROOT, { recursive: true, force: true });
await mkdir(DIST_DIR, { recursive: true });
run(process.execPath, ['node_modules/typescript/bin/tsc', '-b'], buildEnvironment);
run(process.execPath, [
  'node_modules/vite/bin/vite.js', 'build', '--mode', 'staging', '--outDir', DIST_DIR, '--emptyOutDir',
], buildEnvironment);

const evidence = {
  schemaVersion: 2,
  schemaContract: {
    name: contract.schemaBaseline.canonicalContract,
    algorithm: contract.schemaBaseline.canonicalAlgorithm,
    version: contract.schemaBaseline.fingerprintContractVersion,
    fingerprint: contract.schemaBaseline.canonicalFingerprint,
  },
  source: {
    head: source.head,
    branch: source.branch,
    checkpointTag: source.checkpointTag,
    acceptedBaselineTag: source.acceptedBaselineTag,
    acceptedBaselineHead: source.acceptedBaselineHead,
    lineageMode: source.lineageMode,
    reconciliationTag: source.reconciliationTag,
    reconciliationHead: source.reconciliationHead,
  },
  target: {
    role: CANONICAL_ERP2_TARGET.role,
    accountId: CANONICAL_ERP2_TARGET.accountId,
    project: CANONICAL_ERP2_TARGET.project,
    pagesBranch: CANONICAL_ERP2_TARGET.pagesBranch,
    runtimeMarker: CANONICAL_ERP2_TARGET.runtimeMarker,
    supabaseProject: publicTarget.supabaseProject,
    publicFingerprint: publicTarget.publicFingerprint,
  },
  build: { timestamp: buildTimestamp, mode: 'staging' },
  files: await listArtifactFiles(DIST_DIR),
};
const manifest = { ...evidence, identity: buildManifestIdentity(evidence) };
await writeFile(resolve(DIST_DIR, 'erp-build-identity.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const verifiedArtifact = await verifyArtifactIdentity({ artifactRoot: DIST_DIR, proof: { candidate: source }, contract });
console.log(`ERP2 staging candidate ready: ${verifiedArtifact.identity}`);
console.log(`Source=${source.head} checkpoint=${source.checkpointTag} target=${publicTarget.supabaseProject}`);
