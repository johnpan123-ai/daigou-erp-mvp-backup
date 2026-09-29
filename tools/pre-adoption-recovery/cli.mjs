import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { buildRecoveryBundle, recoverySha256, stableRecoveryJson, verifyRecoveryBundle } from './contract.mjs';
import { buildDeadlineSidecarReadScript } from './deadlineSidecarReadScript.mjs';
import { loadProductContracts } from './productContracts.mjs';
import { verifyCloudflareIdentity } from '../../scripts/promotion-safety.mjs';
import { runReadonlyWrangler } from '../../scripts/verify-erp2-promotion.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const option = name => {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || !args[index + 1]) throw new Error(`OPTION_REQUIRED:${name}`);
  return args[index + 1];
};
const readJson = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
const unwrap = (value, key) => {
  if (value && typeof value === 'object' && !Array.isArray(value) && value[key]) return value[key];
  if (Array.isArray(value) && value.length === 1 && value[0]?.[key]) return value[0][key];
  return value;
};
const git = (...gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8' }).trim();
const queryFiles = {
  structuralSnapshot: resolve('tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql'),
  partialStateExport: resolve('tools/pre-adoption-recovery/sql/export-partial-state-readonly.sql'),
};
const migrationFiles = ['018_cloud_import_batch_canonical.sql', '044_waca_cloud_ledger.sql',
  '045_waca_cloud_atomic_restore_closure.sql', '018b_cloud_import_batch_acl_compatibility_repair.sql',
  '045b_waca_cloud_atomic_restore_compatibility_repair.sql', '046b_waca_myacg_parent_compatibility_repair.sql',
  '047_erp_schema_migration_ledger.sql'];
const currentQueryChecksums = async () => Object.fromEntries(await Promise.all(Object.entries(queryFiles)
  .map(async ([key, path]) => [key, recoverySha256(await readFile(path, 'utf8'))])));
const currentMigrationSources = async () => Promise.all(migrationFiles.map(async file => ({
  id: file.split('_', 1)[0], file, checksum: recoverySha256(await readFile(resolve('supabase/sql', file), 'utf8')),
})));

if (!['build', 'verify', 'deadline-script'].includes(command)) {
  throw new Error('USAGE: node tools/pre-adoption-recovery/cli.mjs <build|verify|deadline-script> [options]');
}

const contracts = await loadProductContracts(process.cwd());
if (command === 'verify') {
  const bundle = await readJson(option('bundle'));
  const result = await verifyRecoveryBundle(bundle, contracts);
  if (bundle.manifest.sourceProjectRef !== option('expected-project-ref')) {
    throw new Error('RECOVERY_SOURCE_PROJECT_REF_MISMATCH');
  }
  if (git('status', '--porcelain')) throw new Error('RECOVERY_SOURCE_WORKTREE_DIRTY');
  if (git('rev-parse', 'HEAD') !== bundle.manifest.sourceGitHead
    || git('rev-parse', `${bundle.manifest.checkpoint}^{}`) !== bundle.manifest.sourceGitHead) {
    throw new Error('RECOVERY_SOURCE_GIT_IDENTITY_MISMATCH');
  }
  if (stableRecoveryJson(await currentQueryChecksums())
      !== stableRecoveryJson(bundle.schemaEvidence.snapshotQueryChecksums)
    || stableRecoveryJson((await currentMigrationSources()).sort((left, right) => left.id.localeCompare(right.id)))
      !== stableRecoveryJson(bundle.schemaEvidence.migrationSources)) {
    throw new Error('RECOVERY_SOURCE_CHECKSUM_MISMATCH');
  }
  console.log(JSON.stringify({ result: 'PASS', ...result }, null, 2));
  process.exit(0);
}

const output = resolve(option('output'));
const repoRoot = resolve(git('rev-parse', '--show-toplevel'));
const insideRepo = !relative(repoRoot, output).startsWith('..') && !isAbsolute(relative(repoRoot, output));
if (insideRepo) throw new Error('RECOVERY_OUTPUT_MUST_BE_OUTSIDE_GIT_WORKTREE');
if (command === 'deadline-script') {
  const contract = await readJson(resolve(repoRoot, 'config/erp-environment-identity.json'));
  const cloudflareProof = verifyCloudflareIdentity({
    contract,
    wrangler: (wranglerArgs, accountId) => runReadonlyWrangler(repoRoot, wranglerArgs, accountId),
  });
  await writeFile(output, buildDeadlineSidecarReadScript(contracts, { cloudflareProof }), { flag: 'wx' });
  console.log(JSON.stringify({
    result: 'PASS', output, mode: 'READ_ONLY_INDEXEDDB',
    identityMode: 'WRANGLER_ACCOUNT_PROJECT_PLUS_RUNTIME_SYSTEM_INFORMATION',
    cloudflare: cloudflareProof,
  }, null, 2));
  process.exit(0);
}
if (git('status', '--porcelain')) throw new Error('RECOVERY_SOURCE_WORKTREE_DIRTY');
const head = git('rev-parse', 'HEAD');
const checkpoint = option('checkpoint');
if (git('rev-parse', `${checkpoint}^{}`) !== head) throw new Error('RECOVERY_CHECKPOINT_HEAD_MISMATCH');

const liveExport = unwrap(await readJson(option('live-export')), 'erp2_pre_adoption_partial_state_export');
const schemaSnapshot = unwrap(await readJson(option('schema-snapshot')), 'erp_schema_snapshot');
const deadlineSidecar = await readJson(option('deadline-sidecar'));
const bundle = await buildRecoveryBundle({
  liveExport,
  deadlineSidecar,
  schemaSnapshot,
  identity: {
    sourceProjectRef: option('project-ref'),
    sourceEnvironmentRole: option('environment-role'),
    sourceGitHead: head,
    checkpoint,
    canonicalTargetFingerprint: option('canonical-fingerprint'),
  },
  queryChecksums: await currentQueryChecksums(),
  migrationSources: await currentMigrationSources(),
}, contracts);
const verification = await verifyRecoveryBundle(bundle, contracts);
if (bundle.manifest.sourceSchemaFingerprint !== option('expected-current-fingerprint')) {
  throw new Error('RECOVERY_CURRENT_SCHEMA_FINGERPRINT_MISMATCH');
}
await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({
  result: 'PASS', output, bundleChecksum: bundle.manifest.bundleChecksum,
  sourceSchemaFingerprint: bundle.manifest.sourceSchemaFingerprint,
  resourceCount: verification.resourceCount, totalRows: verification.totalRows,
  recoveryReady: verification.recoveryReady,
}, null, 2));
