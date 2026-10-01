import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Reproducible, fixed-source Sol evidence. Native tests create/drop their own
// random databases and ephemeral HTTP fixtures; no live connection fallback.
const { values } = parseArgs({ options: { output: { type: 'string' } } });
assert.ok(values.output, 'Use --output <ignored scratch evidence path>');
const output = resolve(values.output);
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git(['status', '--porcelain']), '', 'Run from clean fixed source');
assert.ok(git(['check-ignore', output]), 'Evidence must remain outside tracked source');
const pgUrl = new URL(process.env.WACA_ISOLATED_PG_URL || 'invalid:');
assert.equal(pgUrl.hostname, '127.0.0.1');
assert.equal(pgUrl.port, '55492');
assert.ok(pgUrl.pathname.startsWith('/waca_v3_'));
const sha = value => createHash('sha256').update(value).digest('hex');
const normalizedSourceHash = async path => sha((await readFile(path, 'utf8')).replaceAll('\r\n', '\n'));
const migrationChecksums = {
  '049_private_order_atomic_transaction.sql': '997680f5007bea6f3ad1bae475c88ac3c5f16611b1dd453ff1f0c9006bad5f57',
  '050_catalog_atomic_transaction.sql': '0842acb5710aea24aac82e2ca65223af3c5d49ab374d7cdf1ecc903b6cd8f4df',
  '051_related_saveability_atomic_transactions.sql': '46a67fa92041164c38b74b1c80af78788f1dddd0970fbf79c69269cce134016c',
};
for (const [file, expected] of Object.entries(migrationChecksums)) {
  assert.equal(await normalizedSourceHash('supabase/sql/' + file), expected);
}
const tests = [
  'schema-reconciliation', 'schema-reconciliation-pglite', 'saveability-migration-source',
  'private-order-atomic-isolated', 'catalog-atomic-isolated', 'related-saveability-isolated',
  'full-postgrest-write-matrix', 'saveability-native-ui', 'saveability-next-local',
  'saveability-matrix', 'cloud-field-cas', 'cloud-field-cas-react',
  'cloud-realtime-draft-catchup', 'promotion-sync-state', 'cloud-mutation-ordering-dynamic',
  'waca-matching-closure-v2', 'waca-pending-reimport', 'waca-backup-cutover-v3',
  'durable-resource-registry-v3', 'waca-cloud-restore-patch-v3', 'waca-postgrest-isolated-v3',
  'cloud-backup-next-restore-e2e', 'cloud-restore-execute-dispatch-boundary',
  'cloud-restore-durable-execution-closure', 'deadline-local-bridge-extension',
  'erp2-pre-adoption-guard', 'erp2-promotion-guard', 'staging-build-identity',
];
const evidence = {
  schemaVersion: 1, task: 'ERP2 saveability v5 pre-apply blocker closure',
  sourceHead: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']),
  startedAt: new Date().toISOString(), migrationChecksums,
  v4Fingerprint: 'bc0cb320bb57dce141b7ce9c24990097f35ce739e441c7835fbe20ca5b64d317',
  v5Fingerprint: '0bdcd2b4e65219107e4f815abecb8e54fc69886ac90bc5ccbb608e31243755ef',
  nativeTarget: 'disposable loopback PostgreSQL 18 / PostgREST',
  steps: [], result: 'RUNNING', liveMutation: 0,
};
await mkdir(dirname(output), { recursive: true });
const save = async () => writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
for (const test of tests) {
  const path = 'tests/' + test + '.mjs';
  const started = performance.now();
  const run = spawnSync(process.execPath, [path], {
    env: process.env, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
  });
  const passed = !run.error && run.status === 0;
  evidence.steps.push({ test, sourceChecksum: await normalizedSourceHash(path),
    result: passed ? 'PASS' : 'FAIL', exitCode: run.status,
    elapsedMs: Math.round(performance.now() - started),
    stdoutSha256: sha(run.stdout || ''), stderrSha256: sha(run.stderr || '') });
  // Keep only evidence hashes and statuses; never persist or print row dumps.
  await save();
  console.log(`${passed ? 'PASS' : 'FAIL'} ${test}`);
  if (!passed) {
    evidence.result = 'FAIL'; evidence.completedAt = new Date().toISOString(); await save();
    console.error((run.stderr || run.error?.message || 'Test failed').slice(-6000));
    process.exitCode = 1; break;
  }
}
if (!process.exitCode) {
  assert.equal(git(['rev-parse', 'HEAD']), evidence.sourceHead);
  assert.equal(git(['status', '--porcelain']), '');
  evidence.result = 'PASS'; evidence.completedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ result: 'PASS', tests: evidence.steps.length,
    sourceHead: evidence.sourceHead, evidencePath: output,
    evidenceSha256: sha(await readFile(output)), liveMutation: 0 }));
}
