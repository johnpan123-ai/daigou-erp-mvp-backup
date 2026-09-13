import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SQL = readFileSync(new URL('../supabase/sql/023_cloud_atomic_json_restore.sql', import.meta.url), 'utf8');
const EXECUTION_SQL = readFileSync(new URL('../supabase/sql/025_cloud_atomic_restore_execution_timeout.sql', import.meta.url), 'utf8');
const PROVIDER = readFileSync(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8');
const CONTEXT = readFileSync(new URL('../src/contexts/CloudRealtimeSyncContext.tsx', import.meta.url), 'utf8');
const SUBMIT = readFileSync(new URL('../src/providers/cloud/cloudRestoreSubmit.ts', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../src/components/CloudAtomicRestorePanel.tsx', import.meta.url), 'utf8');
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));
const collections = {
  inventory: [{ id: uuid(15), inventory_key: 'restore::SKU::A', myacg_item_code: 'SKU', product_title: 'Restore Product', raw_variant_name: 'A', listing_type: 'normal', final_price: 1, myacg_available_quantity: 0, myacg_sold_quantity: 0, myacg_demand_quantity: 0, myacg_listed_at: '' }],
  productGroups: [{ id: uuid(1), local_id: 'group-1', title: 'Restore Product', priority: 'Medium', purchase_date: '', closing_date: '', release_month: '', has_official_site: false, product_url: '' }],
  productCategories: [{ id: uuid(2), local_id: 'category-1', product_group_id: uuid(1), title: 'Default', sort_order: 0 }],
  productVariants: [{ id: uuid(3), local_id: 'variant-1', product_group_id: uuid(1), product_category_id: uuid(2), myacg_item_code: 'SKU', product_title: 'Restore Product', variant_name: 'A', note: '', sort_order: 0 }],
  bundleComponents: [{ id: uuid(4), bundle_variant_id: uuid(3), component_variant_id: uuid(3) }],
  purchaseBatches: [{ id: uuid(5), local_id: 'batch-1', product_group_id: uuid(1), name: 'Restore batch', date: '2026-09-09', note: '' }],
  purchaseBatchItems: [{ id: uuid(6), local_id: 'batch-item-1', purchase_batch_id: uuid(5), product_variant_id: uuid(3), quantity: 1, cost: 10, note: '' }],
  privateOrders: [{ id: uuid(7), local_id: 'private-1', product_group_id: uuid(1), customer_name: 'Fixture', contact: '', note: '' }],
  privateOrderItems: [{ id: uuid(8), local_id: 'private-item-1', private_order_id: uuid(7), product_variant_id: uuid(3), quantity: 1, amount: 10, note: '' }],
  salesOrders: [{ id: uuid(9), local_id: 'order-1', platform: 'fixture', order_number: 'RESTORE-1', buyer_name: 'Fixture' }],
  salesOrderItems: [{ id: uuid(10), local_id: 'order-item-1', order_id: uuid(9), product_variant_id: uuid(3), myacg_item_code: 'SKU', quantity: 1 }],
  japanPackages: [{ id: uuid(11), title: 'Restore package', status: 'registered' }],
  japanPackageItems: [{ id: uuid(12), japan_package_id: uuid(11), product_group_id: uuid(1), product_variant_id: uuid(3), purchase_batch_id: uuid(5), purchase_batch_item_id: uuid(6), quantity: 1, checked: false }],
  outboundShipments: [{ id: uuid(13), title: 'Restore outbound', status: 'draft' }],
  outboundShipmentItems: [{ id: uuid(14), outbound_shipment_id: uuid(13), japan_package_item_id: uuid(12), product_group_id: uuid(1), product_variant_id: uuid(3), quantity: 1, checked: false }],
};
const documentFor = (suffix = '') => ({ schemaVersion: 'cloud-erp-snapshot-v1', sourceEnvironment: `fixture${suffix}`, data: clone(collections) });

class AtomicServer {
  state = { marker: 'before' };
  requests = new Map();
  rollbackSnapshots = [];
  locked = false;
  epoch = 0;
  async apply(key, candidate, options = {}) {
    if (this.locked) throw new Error('CLOUD_RESTORE_LOCK_CONFLICT');
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.fingerprint !== candidate.manifest.snapshotFingerprint) throw new Error('RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH');
      return { ...clone(previous.result), replayed: true };
    }
    this.locked = true;
    const before = clone(this.state);
    const working = {};
    this.rollbackSnapshots.push(before);
    try {
      let index = 0;
      for (const [, table] of candidateTables) {
        index += 1;
        working[table] = clone(candidate.data[table]);
        if (options.timeoutAt === index) throw new Error('QUERY_CANCELED_57014');
        if (options.failAt === index) throw new Error(`INJECTED_RESOURCE_FAILURE_${index}`);
      }
      if (options.integrityFailure) throw new Error('CLOUD_RESTORE_POST_INTEGRITY_COUNT_MISMATCH');
      this.state = working;
      this.epoch += 1;
      const result = { ok: true, replayed: false, idempotencyKey: key, snapshotFingerprint: candidate.manifest.snapshotFingerprint, rollbackSnapshotId: uuid(1000 + this.epoch), restoreEpoch: this.epoch, manifest: candidate.manifest };
      this.requests.set(key, { fingerprint: candidate.manifest.snapshotFingerprint, result: clone(result) });
      return result;
    } catch (error) {
      this.state = before;
      this.rollbackSnapshots.pop();
      throw error;
    } finally { this.locked = false; }
  }
}

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
let candidateTables;
let validDocument;
try {
  const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const submitDomain = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreSubmit.ts');
  const stagingHarness = await vite.ssrLoadModule('/src/lib/stagingCloudRestoreHarness.ts');
  let rejectedCalls = 0;
  for (const environment of [
    { projectRef: 'twzpqyesbtnfxdkorluf', runtimeRole: 'production', viteMode: 'production', deploymentEnvironment: 'production' },
    { projectRef: 'unknown', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' },
    { projectRef: '', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' },
    { projectRef: undefined, runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' },
  ]) {
    assert.throws(() => new stagingHarness.StagingCloudRestoreHarnessController(environment, async () => {
      rejectedCalls += 1; throw new Error('UNREACHABLE');
    }), /STAGING_CLOUD_RESTORE_HARNESS_DISABLED/u);
  }
  assert.equal(rejectedCalls, 0, 'Production/unknown harness construction must make zero Restore requests');
  const mutableBoundary = { projectRef: 'rhfdjsklfrgpoqsaqpkn', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' };
  const safeHarness = new stagingHarness.StagingCloudRestoreHarnessController(mutableBoundary, async command => ({
    ok: true, replayed: false, idempotencyKey: command.idempotencyKey,
    snapshotFingerprint: command.candidate.manifest.snapshotFingerprint,
    rollbackSnapshotId: uuid(990), restoreEpoch: 1, manifest: command.candidate.manifest,
  }));
  mutableBoundary.projectRef = 'twzpqyesbtnfxdkorluf';
  assert.equal(safeHarness.environment.projectRef, 'rhfdjsklfrgpoqsaqpkn');
  assert.equal(Object.isFrozen(safeHarness.environment), true);
  candidateTables = domain.CLOUD_RESTORE_TABLES;
  const makeDocument = async (suffix = '') => {
    const document = documentFor(suffix);
    const prepared = await domain.buildCloudRestoreManifest(document.data);
    return { ...document, manifest: prepared.manifest };
  };
  validDocument = await makeDocument();
  const candidate = await domain.prepareCloudRestoreSnapshot(JSON.stringify(validDocument));
  assert.equal(candidate.manifest.resourceCount, 15);
  assert.equal(candidate.manifest.orphanCount, 0);
  assert.equal(candidate.manifest.duplicateVariantIdCount, 0);
  assert.equal(candidate.manifest.snapshotFingerprint.length, 64);
  const serverSuccess = {
    ok: true, replayed: false, idempotencyKey: uuid(991),
    snapshotFingerprint: candidate.manifest.snapshotFingerprint,
    rollbackSnapshotId: uuid(992), restoreEpoch: 1, manifest: candidate.manifest,
  };
  submitDomain.resetCloudRestoreSubmitDiagnosticsForTests();
  const pendingRefreshResult = await submitDomain.preserveCloudRestoreSuccessThroughRefresh(
    serverSuccess,
    async () => { throw { code: 'REFRESH_TEST', message: 'Refresh failed safely' }; },
    { attemptCorrelationId: uuid(993), idempotencyKey: serverSuccess.idempotencyKey },
  );
  assert.equal(pendingRefreshResult.ok, true, 'Known Restore success must survive authoritative refresh failure');
  assert.equal(pendingRefreshResult.authoritativeRefresh.status, 'pending');
  assert.deepEqual(submitDomain.getCloudRestoreSubmitDiagnostics().map(entry => [entry.event, entry.outcome]), [
    ['authoritative-refresh', 'sync-pending'],
  ]);
  const correlationId = uuid(994);
  const rawSecretText = [
    'https://fake-project.supabase.co/rest/v1/private_orders?apikey=fake-public-key&token=fake-token',
    'postgres://fake-user:fake-password@fake-db.internal/fake-database?sslmode=require',
    'postgresql://fake-user:fake-password@fake-db.internal/fake-database?sslmode=require',
    'jdbc:postgresql://fake-user:fake-password@fake-db.internal/fake-database?sslmode=require',
    'jdbc%3Apostgresql%3A%2F%2Ffake-user%3Afake-password%40fake-db.internal%2Ffake-database',
    'jdbc%253Apostgresql%253A%252F%252Ffake-user%253Afake-password%2540fake-db.internal%252Ffake-database',
    'https%3A%2F%2Ffake-project.supabase.co%2Frest%2Fv1%3Ftoken%3Dfake-token',
    'host=fake-db.internal user=fake-user password=fake-password dbname=fake-database',
    'Bearer fake-token owner@example.invalid {"snapshot":{"customer":"private-business-value"}}',
    `${'安全前綴'.repeat(200)}\n${'https://fake-project.supabase.co/private?token=fake-token '.repeat(20)}`,
  ].join('\n');
  const circular = { code: '23505', message: rawSecretText };
  circular.cause = circular;
  const errorWithCause = Object.assign(new Error(rawSecretText), {
    code: '23505',
    cause: { message: rawSecretText, stack: rawSecretText },
  });
  const codedArray = [rawSecretText, { cause: rawSecretText }];
  codedArray.code = '23505';
  const knownWithThrowingAuxiliaryFields = { code: '23505' };
  for (const property of ['message', 'details', 'hint', 'stack', 'cause']) {
    Object.defineProperty(knownWithThrowingAuxiliaryFields, property, { get() { throw new Error(`getter:${property}`); } });
  }
  const knownVariants = [
    { code: '23505', message: rawSecretText, details: rawSecretText, hint: rawSecretText, stack: rawSecretText, cause: rawSecretText },
    { code: '23505', message: 'completely different raw text', phase: 'attacker-phase', attemptCorrelationId: 'attacker-id' },
    errorWithCause,
    codedArray,
    circular,
    knownWithThrowingAuxiliaryFields,
  ];
  const knownBaseline = submitDomain.normalizeCloudRestoreSubmitError(
    { code: '23505' },
    'rpc',
    { source: 'server-response', attemptCorrelationId: correlationId },
  );
  assert.deepEqual(Object.keys(knownBaseline).sort(), [
    'attemptCorrelationId', 'classification', 'code', 'message', 'outcome', 'phase',
  ]);
  assert.equal(knownBaseline.code, '23505');
  assert.equal(knownBaseline.classification, 'server');
  assert.equal(knownBaseline.phase, 'rpc');
  assert.equal(knownBaseline.attemptCorrelationId, correlationId);
  assert.equal(
    submitDomain.formatCloudRestoreSubmitError({ ...knownBaseline, message: rawSecretText }),
    submitDomain.formatCloudRestoreSubmitError(knownBaseline),
    'UI formatter must derive its message from the approved code map, not the supplied DTO text',
  );
  for (const variant of knownVariants) {
    assert.deepEqual(
      submitDomain.normalizeCloudRestoreSubmitError(
        variant,
        'rpc',
        { source: 'server-response', attemptCorrelationId: correlationId },
      ),
      knownBaseline,
      'Known-code safe output must be independent from every raw free-text field',
    );
  }

  const hostileGetter = {};
  for (const property of ['code', 'message', 'details', 'hint', 'stack', 'cause']) {
    Object.defineProperty(hostileGetter, property, { get() { throw new Error(`getter:${property}`); } });
  }
  const hostileProxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('proxy-descriptor'); } });
  const unknownInputs = [
    null,
    undefined,
    [rawSecretText],
    new Error(rawSecretText),
    { code: 'PGRST_TEST', message: rawSecretText, details: rawSecretText, cause: { stack: rawSecretText } },
    { message: rawSecretText },
    hostileGetter,
    hostileProxy,
  ];
  const unknownBaseline = submitDomain.normalizeCloudRestoreSubmitError(
    null,
    'rpc',
    { source: 'post-dispatch', attemptCorrelationId: correlationId },
  );
  assert.equal(unknownBaseline.code, 'UNKNOWN');
  assert.equal(unknownBaseline.classification, 'transport');
  assert.equal(unknownBaseline.outcome, 'unknown');
  for (const value of unknownInputs) {
    assert.deepEqual(
      submitDomain.normalizeCloudRestoreSubmitError(
        value,
        'rpc',
        { source: 'post-dispatch', attemptCorrelationId: correlationId },
      ),
      unknownBaseline,
      'Unknown post-dispatch errors must use one invariant safe output',
    );
  }
  const unknownLocal = submitDomain.normalizeCloudRestoreSubmitError(
    { code: 'VALID_LOOKING_BUT_NOT_APPROVED', message: rawSecretText },
    'submit',
    { source: 'local' },
  );
  assert.equal(unknownLocal.code, 'UNKNOWN');
  assert.equal(unknownLocal.classification, 'unknown');
  const serverValidation = submitDomain.normalizeCloudRestoreSubmitError(
    { code: 'RESTORE_MANIFEST_MISMATCH', message: rawSecretText },
    'rpc',
    { source: 'server-response', attemptCorrelationId: correlationId },
  );
  assert.equal(serverValidation.classification, 'server');
  assert.equal(serverValidation.outcome, 'failed');
  assert.doesNotMatch(serverValidation.message, /本次尚未送出/u, 'A server response must not be mislabeled as a pre-dispatch abort');
  assert.doesNotMatch(JSON.stringify([knownBaseline, unknownBaseline, unknownLocal]), /fake-|owner@example|private-business/u);

  const wrapped = submitDomain.createCloudRestoreSafeSubmitError(
    { code: '23505', message: rawSecretText, cause: circular },
    'server-response',
  );
  assert.equal(wrapped.cause, undefined);
  assert.doesNotMatch(`${wrapped.name} ${wrapped.message} ${wrapped.safeCode} ${wrapped.safeClassification}`, /fake-|owner@example|private-business/u);

  submitDomain.resetCloudRestoreSubmitDiagnosticsForTests();
  submitDomain.recordCloudRestoreSubmitDiagnostic({
    event: 'rpc-error',
    phase: 'rpc',
    outcome: 'failed',
    attemptCorrelationId: correlationId,
    idempotencyKey: uuid(995),
    error: { ...knownBaseline, message: rawSecretText },
  });
  const diagnosticText = JSON.stringify(submitDomain.getCloudRestoreSubmitDiagnostics());
  assert.doesNotMatch(diagnosticText, /fake-|owner@example|private-business/u);
  assert.match(diagnosticText, /"classification":"server".*"code":"23505"/u);
  assert.deepEqual(
    submitDomain.normalizeCloudRestoreSubmitError(
      wrapped,
      'rpc',
      { source: 'post-dispatch', attemptCorrelationId: correlationId },
    ),
    knownBaseline,
    'A safe wrapper remains stable without retaining the original error',
  );
  await assert.rejects(() => domain.prepareCloudRestoreSnapshot('{'), error => error.code === 'MALFORMED_JSON');
  await assert.rejects(() => domain.prepareCloudRestoreSnapshot({ ...documentFor(), schemaVersion: 'old' }), error => error.code === 'UNSUPPORTED_SCHEMA_VERSION');
  await assert.rejects(() => domain.prepareCloudRestoreSnapshot(documentFor()), error => error.code === 'RESTORE_MANIFEST_REQUIRED');
  const unexpected = await makeDocument(); unexpected.data.activityLog = [];
  await assert.rejects(() => domain.prepareCloudRestoreSnapshot(unexpected), error => error.code === 'UNEXPECTED_RESOURCE');
  const duplicate = await makeDocument(); duplicate.data.productVariants.push(clone(duplicate.data.productVariants[0]));
  await assert.rejects(() => domain.prepareCloudRestoreSnapshot(duplicate), error => error.code === 'DUPLICATE_CANONICAL_ID');
  const orphan = await makeDocument(); orphan.data.purchaseBatchItems[0].purchase_batch_id = uuid(999);
  await assert.rejects(() => domain.prepareCloudRestoreSnapshot(orphan), error => error.code === 'ORPHAN_RELATION');
  const localId = await makeDocument(); localId.data.productVariants[0].id = 'local-only'; delete localId.data.productVariants[0].database_id;
  await assert.rejects(() => domain.prepareCloudRestoreSnapshot(localId), error => error.code === 'CANONICAL_UUID_REQUIRED');

  const legacyGroupId = '99999999-9999-9999-9999-999999999999';
  const legacyCategoryId = '88888888-8888-8888-8888-888888888888';
  const legacyDocument = documentFor('-legacy-postgres-uuid');
  legacyDocument.data.productGroups[0].id = legacyGroupId;
  legacyDocument.data.productCategories[0].id = legacyCategoryId;
  for (const collection of Object.values(legacyDocument.data)) {
    for (const row of collection) {
      if (row.product_group_id === uuid(1)) row.product_group_id = legacyGroupId;
      if (row.product_category_id === uuid(2)) row.product_category_id = legacyCategoryId;
    }
  }
  const legacyPrepared = await domain.buildCloudRestoreManifest(legacyDocument.data);
  const legacyCandidate = await domain.prepareCloudRestoreSnapshot({
    ...legacyDocument,
    manifest: legacyPrepared.manifest,
  });
  assert.equal(legacyCandidate.data.product_groups[0].id, legacyGroupId);
  assert.equal(legacyCandidate.data.product_categories[0].id, legacyCategoryId);

  const uppercaseDocument = documentFor('-uppercase-postgres-uuid');
  const lowercaseOrderId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const uppercaseOrderId = lowercaseOrderId.toUpperCase();
  uppercaseDocument.data.salesOrders[0].id = uppercaseOrderId;
  uppercaseDocument.data.salesOrderItems[0].order_id = uppercaseOrderId;
  const uppercasePrepared = await domain.buildCloudRestoreManifest(uppercaseDocument.data);
  const uppercaseCandidate = await domain.prepareCloudRestoreSnapshot({
    ...uppercaseDocument,
    manifest: uppercasePrepared.manifest,
  });
  assert.equal(uppercaseCandidate.data.sales_orders[0].id, lowercaseOrderId);
  assert.equal(uppercaseCandidate.data.sales_order_items[0].order_id, lowercaseOrderId);

  for (const invalidId of [
    'not-a-uuid',
    '123',
    'local_abc123',
    '99999999999999999999999999999999',
    '99999999-9999-9999-9999',
    'gggggggg-gggg-gggg-gggg-gggggggggggg',
    '',
    '   ',
    null,
    undefined,
  ]) {
    const invalidDocument = clone(validDocument);
    invalidDocument.data.productGroups[0].id = invalidId;
    delete invalidDocument.data.productGroups[0].database_id;
    await assert.rejects(
      () => domain.prepareCloudRestoreSnapshot(invalidDocument),
      error => error.code === 'CANONICAL_UUID_REQUIRED',
      `Restore must reject non-PostgreSQL UUID identity: ${String(invalidId)}`,
    );
  }

  const metrics = { partial: 0, duplicates: 0, wrongCanonical: 0, stuckLocks: 0, missingRollback: 0 };
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); const key = uuid(2000 + round);
    const result = await server.apply(key, candidate);
    assert.equal(result.ok, true); assert.equal(server.rollbackSnapshots.length, 1);
  }
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); const before = clone(server.state);
    await assert.rejects(() => server.apply(uuid(3000 + round), candidate, { failAt: 10 }), /INJECTED_RESOURCE_FAILURE_10/u);
    assert.deepEqual(server.state, before); assert.equal(server.rollbackSnapshots.length, 0); assert.equal(server.locked, false);
  }
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); const key = uuid(4000 + round);
    const committed = await server.apply(key, candidate); const replay = await server.apply(key, candidate);
    assert.equal(replay.replayed, true); assert.equal(replay.rollbackSnapshotId, committed.rollbackSnapshotId); assert.equal(server.epoch, 1);
  }
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); const key = uuid(5000 + round); await server.apply(key, candidate);
    const otherDoc = await makeDocument(`-${round}`); otherDoc.data.productGroups[0].title = `Changed ${round}`;
    const rebuilt = await domain.buildCloudRestoreManifest(otherDoc.data);
    const other = { ...otherDoc, data: rebuilt.data, manifest: rebuilt.manifest };
    await assert.rejects(() => server.apply(key, other), /RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH/u);
  }
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); server.locked = true;
    await assert.rejects(() => server.apply(uuid(6000 + round), candidate), /CLOUD_RESTORE_LOCK_CONFLICT/u);
    server.locked = false;
  }
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); const before = clone(server.state);
    await assert.rejects(() => server.apply(uuid(7000 + round), candidate, { integrityFailure: true }), /POST_INTEGRITY/u);
    assert.deepEqual(server.state, before); assert.equal(server.locked, false);
  }
  for (let round = 0; round < 30; round += 1) {
    const server = new AtomicServer(); const before = clone(server.state);
    await assert.rejects(() => server.apply(uuid(8000 + round), candidate, { timeoutAt: 10 }), /QUERY_CANCELED_57014/u);
    assert.deepEqual(server.state, before);
    assert.equal(server.rollbackSnapshots.length, 0);
    assert.equal(server.requests.size, 0);
    assert.equal(server.epoch, 0);
    assert.equal(server.locked, false);
  }
  assert.deepEqual(metrics, { partial: 0, duplicates: 0, wrongCanonical: 0, stuckLocks: 0, missingRollback: 0 });
} finally { await vite.close(); }

assert.equal((SQL.match(/^begin;$/gimu) || []).length, 1);
assert.equal((SQL.match(/^commit;$/gimu) || []).length, 1);
assert.match(SQL, /security definer[\s\S]+set search_path = pg_catalog, public, extensions/u);
assert.match(SQL, /public\.is_owner\(v_actor\)/u);
assert.match(SQL, /pg_try_advisory_xact_lock\(hashtextextended\('erp-cloud-restore-maintenance-lock'/u);
assert.match(SQL, /create trigger erp_cloud_restore_maintenance_guard before insert or update or delete/u);
assert.match(SQL, /erp_cloud_restore_snapshots/u);
assert.match(SQL, /RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH/u);
assert.match(SQL, /CLOUD_RESTORE_POST_INTEGRITY_COUNT_MISMATCH/u);
assert.match(SQL, /CLOUD_RESTORE_MANIFEST_COUNT_MISMATCH/u);
assert.match(SQL, /CLOUD_RESTORE_MANIFEST_TOTAL_MISMATCH/u);
assert.match(SQL, /erp_cloud_restore_relationship_hash/u);
assert.match(SQL, /alter publication supabase_realtime add table public\.erp_cloud_restore_epoch/u);
assert.doesNotMatch(SQL, /service_role|grant\s+.+\s+to\s+(public|anon)/iu);
assert.match(PROVIDER, /reason: 'reconnect'[\s\S]+resources: \['products', 'purchases'/u);
assert.match(PROVIDER, /event: 'rpc-response'/u);
assert.match(SUBMIT, /event: 'authoritative-refresh'[\s\S]+outcome: 'sync-pending'/u);
assert.match(CONTEXT, /erp_cloud_restore_epoch[\s\S]+reconnect\.request/u);
const restoreProviderMethod = PROVIDER.slice(
  PROVIDER.indexOf('async restoreCloudSnapshot('),
  PROVIDER.indexOf('private async applyCloudFieldMutations'),
);
assert.doesNotMatch(restoreProviderMethod, /console\.(?:error|warn|log)\s*\(/u, 'Restore submit path must not log raw errors');
assert.doesNotMatch(restoreProviderMethod, /throw\s+(?:caughtError|error|resultError)\b/u, 'Restore submit path must not rethrow raw errors');
assert.doesNotMatch(restoreProviderMethod, /JSON\.stringify\s*\(\s*(?:caughtError|error|resultError)/u, 'Restore submit path must not serialize raw errors');
assert.match(restoreProviderMethod, /createCloudRestoreSafeSubmitError/u, 'Provider must replace raw failures with the safe local error representation');
assert.doesNotMatch(SUBMIT, /\.(?:details|hint|stack|cause)\b/u, 'Safe submit helper must not forward raw auxiliary fields');
assert.doesNotMatch(PANEL, /console\.(?:error|warn|log)\s*\(|JSON\.stringify\s*\(\s*error|String\s*\(\s*error|\.\.\.\s*error/u, 'Restore Panel must not log, serialize, stringify, or spread raw errors');

assert.equal((EXECUTION_SQL.match(/^begin;$/gimu) || []).length, 1);
assert.equal((EXECUTION_SQL.match(/^commit;$/gimu) || []).length, 1);
assert.match(EXECUTION_SQL, /create or replace function public\.erp_restore_cloud_snapshot\([\s\S]+set statement_timeout = '30s'/u);
assert.doesNotMatch(EXECUTION_SQL, /alter\s+(role|database)[\s\S]+statement_timeout/iu);
assert.equal((EXECUTION_SQL.match(/v_before\s*:=\s*public\.erp_cloud_restore_snapshot\(\)/gu) || []).length, 1);
const executionRestoreBody = EXECUTION_SQL.slice(EXECUTION_SQL.indexOf('create or replace function public.erp_restore_cloud_snapshot('));
assert.equal((executionRestoreBody.match(/public\.erp_cloud_restore_snapshot\(\)/gu) || []).length, 1, 'Restore must build one full before snapshot and no full after snapshot');
assert.match(SQL, /jsonb_populate_recordset\(null::%s, \$1\)/u);
assert.match(EXECUTION_SQL, /perform public\.erp_cloud_restore_insert_rows\('public\.inventory_items'/u);
assert.match(EXECUTION_SQL, /erp_cloud_restore_table_profile/u);
assert.match(EXECUTION_SQL, /erp_cloud_restore_live_relationship_hash/u);
assert.match(EXECUTION_SQL, /v_before_fingerprint[\s\S]+v_before_manifest[\s\S]+insert into public\.erp_cloud_restore_snapshots/u);
for (const phase of ['auth', 'lock_idempotency', 'input_validation', 'before_snapshot', 'rollback_row', 'delete', 'insert', 'integrity', 'epoch_idempotency']) {
  assert.match(EXECUTION_SQL, new RegExp(`CLOUD_RESTORE_TIMING phase=${phase} event=start`, 'u'));
}
assert.match(EXECUTION_SQL, /'timingsMs',v_phase_timings/u);
assert.match(EXECUTION_SQL, /when query_canceled then[\s\S]+classification=statement_timeout[\s\S]+raise;/u);
assert.match(EXECUTION_SQL, /when others then[\s\S]+classification=error[\s\S]+raise;/u);
assert.doesNotMatch(EXECUTION_SQL, /service_role|grant\s+.+\s+to\s+(public|anon)|twzpqyesbtnfxdkorluf/iu);

const PORT = process.env.CLOUD_RESTORE_TEST_PORT || '4256';
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const processVite = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--config', 'tests/fixtures/cloud-atomic-restore-vite.config.mjs', '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; processVite.stdout.on('data', chunk => { output += String(chunk); }); processVite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const url = `http://127.0.0.1:${PORT}/tests/fixtures/cloud-atomic-restore.html`;
  for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(url)).ok) break; } catch {} await sleep(250); if (attempt === 79) throw new Error(output); }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage(); const cloudRequests = []; const applicationLogs = [];
    page.on('request', request => { if (/\.supabase\.co\//u.test(request.url())) cloudRequests.push(request.url()); });
    page.on('console', message => { applicationLogs.push(message.text()); });
    const openFixture = async (behavior, portabilityMode = 'strict') => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('staging-cloud-restore-harness').waitFor();
      await page.getByText('STAGING TEST ONLY — CLOUD ATOMIC RESTORE').waitFor();
      await page.getByTestId('cloud-restore-harness-auth').getByText('true').waitFor();
      await page.evaluate(next => {
        window.__CLOUD_RESTORE_SUBMIT_TEST__.reset();
        window.__CLOUD_RESTORE_SUBMIT_TEST__.setBehavior(next);
        window.__CLOUD_RESTORE_CONNECTIVITY_TEST__.fresh(1);
      }, behavior);
      await page.getByTestId('cloud-restore-access').getByText('Owner / authoritative fresh', { exact: false }).waitFor();
      await page.locator('input[type=file]').setInputFiles({ name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(validDocument)) });
      await page.getByTestId('cloud-restore-preflight').waitFor();
      if (portabilityMode !== 'strict') {
        await page.getByTestId('cloud-restore-portability-mode').selectOption(portabilityMode);
        await page.getByTestId('cloud-restore-portability-summary').waitFor();
      }
      await page.getByTestId('cloud-restore-confirmation').fill('OVERWRITE CLOUD DATA');
      await page.getByTestId('cloud-restore-submit').click();
      await page.getByTestId('cloud-restore-final-confirmation').waitFor();
    };

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('staging-cloud-restore-harness').waitFor();
    await page.evaluate(() => window.__CLOUD_RESTORE_CONNECTIVITY_TEST__.loading());
    await page.getByTestId('cloud-restore-access').getByText('等待重新讀取雲端最新資料，完成後才能還原', { exact: true }).waitFor();
    await page.locator('input[type=file]').setInputFiles({ name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(validDocument)) });
    await page.getByTestId('cloud-restore-preflight').waitFor();
    assert.equal(await page.getByTestId('cloud-restore-confirmation').isDisabled(), true);
    assert.equal(await page.getByTestId('cloud-restore-submit').isDisabled(), true);

    await openFixture('success');
    await page.getByTestId('cloud-restore-final-submit').click();
    await page.getByTestId('cloud-restore-result').waitFor();
    assert.match(await page.getByTestId('cloud-restore-result').innerText(), /replayed=false.*epoch=1/u);
    assert.match(await page.getByTestId('cloud-restore-timings').locator('pre').textContent(), /"total": 27/u);
    let submitState = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(submitState.calls, 1, 'Fresh explicit confirmation must dispatch exactly once');
    assert.deepEqual(submitState.diagnostics.map(entry => entry.event), [
      'submit-start', 'confirmation-complete', 'readiness-check-pass', 'rpc-invocation', 'submit-finish',
    ]);
    assert.equal(submitState.targetValidationCalls, 0, 'Strict Restore must not call portability validation');

    await openFixture('success', 'cross-environment');
    await page.getByTestId('cloud-restore-final-submit').click();
    await page.getByTestId('cloud-restore-result').waitFor();
    submitState = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(submitState.targetValidationCalls, 1, 'Portable Restore must validate the target exactly once');
    assert.equal(submitState.calls, 1, 'Portable Restore must dispatch exactly once after target validation');
    assert.equal(submitState.candidates[0].portability.policyVersion, 'cross-environment-audit-null-v1');
    assert.equal(submitState.candidates[0].portability.targetProjectRef, 'rhfdjsklfrgpoqsaqpkn');
    assert.equal(submitState.candidates[0].allUpdatedByNull, true);
    assert.notEqual(submitState.candidates[0].executionFingerprint, submitState.candidates[0].fingerprint, 'Execution identity must bind portability semantics');
    assert.deepEqual(submitState.diagnostics.map(entry => entry.event), [
      'submit-start', 'confirmation-complete', 'readiness-check-pass', 'target-compatibility', 'rpc-invocation', 'submit-finish',
    ]);

    await openFixture('target-fail', 'cross-environment');
    await page.getByTestId('cloud-restore-final-submit').click();
    await page.getByTestId('cloud-restore-status').getByText('目標環境不符合跨環境還原政策，本次尚未送出', { exact: false }).waitFor();
    submitState = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(submitState.targetValidationCalls, 1);
    assert.equal(submitState.calls, 0, 'Target incompatibility must fail before the Restore RPC');
    assert.equal(submitState.diagnostics.some(entry => entry.event === 'rpc-invocation'), false);
    assert.ok(submitState.diagnostics.some(entry => entry.event === 'target-compatibility' && entry.outcome === 'not-submitted'));
    assert.doesNotMatch(JSON.stringify(submitState.diagnostics), /must-not-render raw target detail/u);

    await openFixture('success');
    await page.evaluate(() => {
      window.__CLOUD_RESTORE_CONNECTIVITY_TEST__.loading();
      window.dispatchEvent(new Event('focus'));
      document.querySelector('[data-testid="cloud-restore-final-confirmation"] form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.getByTestId('cloud-restore-status').getByText('雲端資料正在更新，本次尚未送出。', { exact: true }).waitFor();
    submitState = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(submitState.calls, 0, 'Freshness loss during confirmation must stay before RPC');
    assert.ok(submitState.diagnostics.some(entry => entry.event === 'readiness-check-blocked' && entry.outcome === 'not-submitted'));

    await openFixture('deferred-success');
    await page.evaluate(() => {
      const form = document.querySelector('[data-testid="cloud-restore-final-confirmation"] form');
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot().calls === 1);
    await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.releaseDeferred());
    await page.getByTestId('cloud-restore-result').waitFor();
    submitState = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(submitState.calls, 1, 'Synchronous in-flight ref must block duplicate submit handlers');

    await openFixture('plain-error');
    await page.getByTestId('cloud-restore-final-submit').click();
    const plainError = await page.getByTestId('cloud-restore-status').innerText();
    assert.match(plainError, /\[23505\].*伺服器已回覆還原錯誤.*階段：rpc.*追蹤/u);
    assert.doesNotMatch(plainError, /\[object Object\]|must-not-render|access_token|fake-project|fake-public-key|fake-db|fake-user|fake-password|fake-database/u);
    submitState = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.doesNotMatch(JSON.stringify(submitState.diagnostics), /must-not-render|fake-|owner@example|private-business/u);
    assert.doesNotMatch(applicationLogs.join('\n'), /must-not-render|fake-|owner@example|private-business/u);

    await openFixture('plain-error-variant');
    await page.getByTestId('cloud-restore-final-submit').click();
    const plainErrorVariant = await page.getByTestId('cloud-restore-status').innerText();
    assert.match(plainErrorVariant, /\[23505\].*伺服器已回覆還原錯誤.*階段：rpc.*追蹤/u);
    assert.doesNotMatch(plainErrorVariant, /other-user|other-password|other-db|other-database|外部錯誤/u);
    submitState = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.doesNotMatch(JSON.stringify(submitState.diagnostics), /other-user|other-password|other-db|other-database|外部錯誤/u);
    assert.doesNotMatch(applicationLogs.join('\n'), /other-user|other-password|other-db|other-database|外部錯誤/u);

    await openFixture('timeout');
    await page.getByTestId('cloud-restore-final-submit').click();
    const timeoutError = await page.getByTestId('cloud-restore-status').innerText();
    assert.match(timeoutError, /\[ETIMEDOUT\].*還原結果待查證.*階段：rpc.*追蹤/u);
    assert.equal(await page.getByTestId('cloud-restore-submit').isDisabled(), true, 'Unknown result must lock repeat submit');
    const timeoutState = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(timeoutState.calls, 1);
    const timeoutKey = timeoutState.idempotencyKeys[0];

    await openFixture('success');
    await page.getByTestId('cloud-restore-final-submit').click();
    await page.getByTestId('cloud-restore-result').waitFor();
    submitState = await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot());
    assert.equal(submitState.idempotencyKeys[0], timeoutKey, 'Remount must retain the same fingerprint idempotency key');

    await openFixture('refresh-pending');
    await page.getByTestId('cloud-restore-final-submit').click();
    await page.getByTestId('cloud-restore-result').waitFor();
    assert.match(await page.getByTestId('cloud-restore-status').innerText(), /還原已完成，畫面同步待完成；請勿再次還原/u);
    assert.equal((await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot())).calls, 1);

    await openFixture('guard-race');
    await page.getByTestId('cloud-restore-final-submit').click();
    const guardError = await page.getByTestId('cloud-restore-status').innerText();
    assert.match(guardError, /^雲端資料正在更新，本次尚未送出。 追蹤：[0-9a-f-]+$/u);
    assert.doesNotMatch(guardError, /\[object Object\]/u, 'Freshness guard is an Error and is independent from plain-object rendering');
    assert.equal((await page.evaluate(() => window.__CLOUD_RESTORE_SUBMIT_TEST__.snapshot())).calls, 0);
    assert.equal(cloudRequests.length, 0, 'All deterministic Restore submit cases must make zero Supabase requests');
  } finally { await browser.close(); }
} finally { processVite.kill(); }

console.log('PASS Cloud Atomic Restore: preflight, bounded execution SQL contract, 210-round deterministic soak, and submit readiness/error/idempotency React regressions');
