#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  STAGING_PROJECT_REF,
  assertConnectionTargetsProject,
  assertRefreshDirection,
  resolveDryRunConnection,
  resolveRestoreConnection,
  resolveSnapshotConnection,
} from './policy.mjs';
import {
  applyAuthAttributionPolicy,
  assertSchemaCompatible,
  buildRestoreScopeManifest,
  buildSnapshotManifest,
  compareManifests,
  createSnapshotEnvelope,
  validateSnapshotEnvelope,
} from './manifest.mjs';
import {
  assertNoExternalIncomingReferences,
  assertRestoreWriterRole,
  assertStagingActorExists,
  buildRestoreMutationSql,
  captureConsistentSnapshot,
  captureSnapshotWithClient,
  inspectSchema,
  withSerializableRestoreTransaction,
} from './postgres.mjs';

const args = Object.fromEntries(process.argv.slice(3).map(argument => {
  const [key, ...rest] = argument.replace(/^--/u, '').split('=');
  return [key, rest.length ? rest.join('=') : true];
}));
const command = process.argv[2];
const required = name => {
  const value = args[name];
  if (!value || value === true) throw new Error(`MISSING_ARGUMENT:${name}`);
  return String(value);
};
const readJson = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
const writeJson = async (path, value) => writeFile(
  resolve(path),
  `${JSON.stringify(value, null, 2)}\n`,
  { flag: 'wx', mode: 0o600 },
);

async function snapshotCommand() {
  const role = required('role');
  const output = required('output');
  const { connectionUrl, expectedRef: projectRef, label } = resolveSnapshotConnection(role, process.env);
  const capture = await captureConsistentSnapshot({ connectionUrl, expectedRef: projectRef, label });
  if (capture.classification.reviewRequired.length) {
    throw new Error(`SCHEMA_REVIEW_REQUIRED:${capture.classification.reviewRequired.join(',')}`);
  }
  const envelope = createSnapshotEnvelope({
    sourceProjectRef: projectRef,
    schema: capture.schema,
    data: capture.data,
    piiMode: required('pii-mode'),
  });
  const manifest = buildSnapshotManifest(envelope);
  await writeJson(output, envelope);
  await writeJson(`${output}.manifest.json`, manifest);
  console.log(JSON.stringify({ status: 'SNAPSHOT_CREATED', snapshotId: envelope.snapshotId, manifestHash: manifest.manifestHash }));
}

const authPolicyFromArgs = () => {
  const mode = required('auth-attribution');
  return mode === 'staging-actor' ? { mode, actorId: required('staging-actor-id') } : { mode };
};

async function prepareRestore(connection) {
  const snapshot = validateSnapshotEnvelope(await readJson(required('snapshot')));
  const rollback = validateSnapshotEnvelope(await readJson(required('rollback-snapshot')));
  assertRefreshDirection(snapshot.sourceProjectRef, STAGING_PROJECT_REF);
  if (rollback.sourceProjectRef !== STAGING_PROJECT_REF) throw new Error('ROLLBACK_SNAPSHOT_NOT_STAGING');
  const rollbackAgeMs = Date.now() - Date.parse(rollback.capturedAt);
  if (!Number.isFinite(rollbackAgeMs) || rollbackAgeMs < 0 || rollbackAgeMs > 60 * 60_000) {
    throw new Error('ROLLBACK_SNAPSHOT_TOO_OLD');
  }
  const { connectionUrl, expectedRef, label } = connection;
  assertConnectionTargetsProject(connectionUrl, expectedRef, label);
  const targetSchema = await inspectSchema({ connectionUrl, expectedRef, label });
  const tables = Object.keys(snapshot.data);
  assertSchemaCompatible(snapshot.schema, targetSchema, tables);
  assertNoExternalIncomingReferences(targetSchema, tables);
  const authPolicy = authPolicyFromArgs();
  if (authPolicy.mode === 'staging-actor') {
    await assertStagingActorExists(
      { connectionUrl, expectedRef, label },
      authPolicy.actorId,
    );
  }
  const prepared = applyAuthAttributionPolicy(snapshot, targetSchema, authPolicy);
  const preparedManifest = buildRestoreScopeManifest(prepared, tables);
  return {
    connectionUrl,
    targetSchema,
    tables,
    prepared,
    preparedManifest,
    sql: buildRestoreMutationSql(prepared),
  };
}

async function dryRunCommand() {
  const result = await prepareRestore(resolveDryRunConnection(process.env));
  console.log(JSON.stringify({
    status: 'DRY_RUN_READY',
    targetProjectRef: STAGING_PROJECT_REF,
    snapshotId: result.prepared.snapshotId,
    schemaFingerprint: result.preparedManifest.schemaFingerprint,
    tables: result.preparedManifest.tables,
    sidecarAction: 'BACKUP_THEN_REINITIALIZE_EACH_STAGING_BROWSER',
  }, null, 2));
}

async function restoreCommand() {
  if (args.execute !== true) throw new Error('RESTORE_REQUIRES_EXPLICIT_EXECUTE');
  if (required('maintenance-ack') !== 'STAGING_WRITES_PAUSED') throw new Error('STAGING_MAINTENANCE_NOT_CONFIRMED');
  const restoreConnection = resolveRestoreConnection(process.env);
  await assertRestoreWriterRole(restoreConnection);
  const result = await prepareRestore(restoreConnection);
  if (required('approval-snapshot-id') !== result.prepared.snapshotId) throw new Error('SNAPSHOT_APPROVAL_MISMATCH');
  const comparison = await withSerializableRestoreTransaction({
    connectionUrl: result.connectionUrl,
    expectedRef: STAGING_PROJECT_REF,
    label: 'Staging restore writer',
  }, async client => {
    await client.query(result.sql);
    const after = await captureSnapshotWithClient(client, result.tables);
    const afterSnapshot = createSnapshotEnvelope({
      sourceProjectRef: STAGING_PROJECT_REF,
      schema: after.schema,
      data: after.data,
      piiMode: result.prepared.piiMode,
      snapshotId: result.prepared.snapshotId,
      capturedAt: result.prepared.capturedAt,
    });
    const afterManifest = buildRestoreScopeManifest(afterSnapshot, result.tables);
    const transactionComparison = compareManifests(result.preparedManifest, afterManifest);
    if (!transactionComparison.accepted) {
      throw new Error(`POST_RESTORE_INTEGRITY_FAILED:${transactionComparison.differences.join(',')}`);
    }
    return transactionComparison;
  });
  console.log(JSON.stringify({ status: 'STAGING_REFRESHED', snapshotId: result.prepared.snapshotId, comparison }));
}

async function verifyOnlyCommand() {
  const connection = resolveDryRunConnection(process.env);
  const snapshot = validateSnapshotEnvelope(await readJson(required('snapshot')));
  assertRefreshDirection(snapshot.sourceProjectRef, STAGING_PROJECT_REF);
  const { connectionUrl, expectedRef, label } = connection;
  const targetSchema = await inspectSchema(connection);
  const tables = Object.keys(snapshot.data);
  assertSchemaCompatible(snapshot.schema, targetSchema, tables);
  const prepared = applyAuthAttributionPolicy(snapshot, targetSchema, authPolicyFromArgs());
  const expectedManifest = buildRestoreScopeManifest(prepared, tables);
  const current = await captureConsistentSnapshot(
    { connectionUrl, expectedRef, label },
    { tables },
  );
  const currentSnapshot = createSnapshotEnvelope({
    sourceProjectRef: STAGING_PROJECT_REF,
    schema: current.schema,
    data: current.data,
    piiMode: prepared.piiMode,
    snapshotId: prepared.snapshotId,
    capturedAt: prepared.capturedAt,
  });
  const comparison = compareManifests(
    expectedManifest,
    buildRestoreScopeManifest(currentSnapshot, tables),
  );
  if (!comparison.accepted) {
    throw new Error(`VERIFY_ONLY_INTEGRITY_FAILED:${comparison.differences.join(',')}`);
  }
  console.log(JSON.stringify({
    status: 'STAGING_VERIFY_ONLY_PASS',
    snapshotId: prepared.snapshotId,
    targetProjectRef: STAGING_PROJECT_REF,
    comparison,
    verified: {
      schemaFingerprint: expectedManifest.schemaFingerprint,
      tables: expectedManifest.tables,
      relationships: expectedManifest.relationships,
      productVariantIdentityHash: expectedManifest.productVariantIdentityHash,
      anomalies: expectedManifest.anomalies,
    },
    databaseWrite: 0,
  }));
}

try {
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(`Production → Staging refresh tooling

Commands:
  snapshot  Create a read-only Production or Staging rollback snapshot
  dry-run   Validate direction, schema, attribution and restore plan only
  verify-only  Compare current Staging to the prepared Production snapshot without writes
  restore   Execute only with a fresh rollback snapshot and explicit approvals

See tools/staging-refresh/README.md for the guarded operator procedure.`);
  } else if (command === 'snapshot') await snapshotCommand();
  else if (command === 'dry-run') await dryRunCommand();
  else if (command === 'verify-only') await verifyOnlyCommand();
  else if (command === 'restore') await restoreCommand();
  else throw new Error('COMMAND_REQUIRED:snapshot|dry-run|verify-only|restore');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
