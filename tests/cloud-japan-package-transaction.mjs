import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SQL_PATH = fileURLToPath(new URL('../supabase/sql/031_japan_package_receiving_atomic_transaction.sql', import.meta.url));
const PROVIDER_PATH = fileURLToPath(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url));
const DETAIL_PATH = fileURLToPath(new URL('../src/pages/JapanPackageDetail.tsx', import.meta.url));
const LIST_PATH = fileURLToPath(new URL('../src/pages/JapanPackagesList.tsx', import.meta.url));
const uuid = suffix => `71000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const clone = value => structuredClone(value);

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

class AtomicJapanPackageServer {
  packages = new Map();
  items = new Map();
  requests = new Map();
  commits = 0;

  execute(actor, key, request, options = {}) {
    if (!actor) return { ok: false, code: 'FORBIDDEN' };
    const fingerprint = JSON.stringify(request);
    const requestKey = `${actor}:${key}`;
    const previous = this.requests.get(requestKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { ok: false, code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' };
      return { ...clone(previous.result), replayed: true };
    }
    if (request.targetProjectRef !== 'rhfdjsklfrgpoqsaqpkn') return { ok: false, code: 'TARGET_PROJECT_FORBIDDEN' };
    const stagedPackages = new Map([...this.packages].map(([id, row]) => [id, clone(row)]));
    const stagedItems = new Map([...this.items].map(([id, row]) => [id, clone(row)]));
    const currentPackage = stagedPackages.get(request.packageId);
    if (request.transactionType === 'create-package') {
      if (currentPackage) return { ok: false, code: 'DUPLICATE_CREATE' };
      stagedPackages.set(request.packageId, {
        id: request.packageId,
        ...clone(request.packageOperation.values),
        version: 1,
      });
    } else {
      if (!currentPackage || currentPackage.deleted_at) return { ok: false, code: 'RECORD_DELETED_OR_MISSING' };
      if (currentPackage.version !== request.expectedPackageVersion) return { ok: false, code: 'FIELD_CONFLICT' };
      for (const operation of request.itemOperations) {
        if (request.transactionType === 'attach-items') {
          if (stagedItems.has(operation.id)) return { ok: false, code: 'DUPLICATE_CREATE' };
          if (options.invalidPurchaseItem) return { ok: false, code: 'PURCHASE_ITEM_RELATION_INVALID' };
          if (operation.values.purchase_batch_item_id && [...stagedItems.values()].some(
            item => !item.deleted_at && item.purchase_batch_item_id === operation.values.purchase_batch_item_id,
          )) return { ok: false, code: 'DUPLICATE_RELATION' };
          if (options.failItemConstraint) return { ok: false, code: 'TRANSACTION_CONSTRAINT_FAILED' };
          stagedItems.set(operation.id, { id: operation.id, ...clone(operation.values), version: 1 });
        } else {
          const item = stagedItems.get(operation.id);
          if (!item || item.japan_package_id !== request.packageId) return { ok: false, code: 'RECORD_DELETED_OR_MISSING' };
          if (item.version !== operation.observedVersion) return { ok: false, code: 'FIELD_CONFLICT' };
          stagedItems.set(operation.id, { ...item, ...clone(operation.changes), version: item.version + 1 });
        }
      }
      const active = [...stagedItems.values()].filter(item => item.japan_package_id === request.packageId && !item.deleted_at);
      let status = currentPackage.status;
      if (status !== 'problem') {
        if (active.length > 0 && active.every(item => item.checked)) status = 'confirmed';
        else if (status === 'confirmed') status = 'arrived';
      }
      const packageChanged = request.transactionType === 'attach-items' || status !== currentPackage.status;
      stagedPackages.set(request.packageId, {
        ...currentPackage,
        status,
        version: currentPackage.version + (packageChanged ? 1 : 0),
      });
    }
    const packageRow = stagedPackages.get(request.packageId);
    const packageItems = [...stagedItems.values()].filter(item => item.japan_package_id === request.packageId && !item.deleted_at);
    const result = {
      ok: true,
      transactionType: request.transactionType,
      idempotencyKey: key,
      replayed: false,
      package: clone(packageRow),
      items: clone(packageItems),
    };
    this.packages = stagedPackages;
    this.items = stagedItems;
    this.requests.set(requestKey, { fingerprint, result: clone(result) });
    this.commits += 1;
    return result;
  }
}

const vite = await createServer({ root: ROOT, mode: 'experimental', server: { middlewareMode: true }, appType: 'custom' });
try {
  const module = await vite.ssrLoadModule('/src/providers/cloud/japanPackageTransaction.ts');
  const {
    JapanPackageIntentCoordinator,
    buildJapanPackageTransactionRequest,
    stableJapanPackagePayload,
  } = module;
  const packageId = uuid(1);
  const itemId = uuid(2);
  const purchaseBatchId = uuid(3);
  const purchaseItemId = uuid(4);
  const variantId = uuid(5);
  const groupId = uuid(6);
  const packageRow = {
    id: packageId,
    title: 'F3 package',
    status: 'registered',
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
  };
  const itemRow = {
    id: itemId,
    japan_package_id: packageId,
    purchase_batch_id: purchaseBatchId,
    purchase_batch_item_id: purchaseItemId,
    product_group_id: groupId,
    product_variant_id: variantId,
    product_title: 'F3 product',
    variant_name: 'F3 variant',
    sku: 'F3-SKU',
    quantity: 1,
    checked: false,
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
  };

  const createCommand = { idempotencyKey: uuid(10), transactionType: 'create-package', package: packageRow };
  const createRequest = buildJapanPackageTransactionRequest(undefined, [], createCommand);
  assert.equal(createRequest.transactionType, 'create-package');
  assert.equal(createRequest.packageOperation.kind, 'create');
  assert.equal(createRequest.targetProjectRef, 'rhfdjsklfrgpoqsaqpkn');

  const server = new AtomicJapanPackageServer();
  const actor = uuid(20);
  const created = server.execute(actor, createCommand.idempotencyKey, createRequest);
  assert.equal(created.ok, true);
  assert.equal(server.packages.size, 1);
  assert.equal(server.items.size, 0);

  const canonicalPackage = created.package;
  const attachCommand = { idempotencyKey: uuid(11), transactionType: 'attach-items', packageId, items: [itemRow] };
  const attachRequest = buildJapanPackageTransactionRequest(canonicalPackage, [], attachCommand);
  assert.deepEqual(attachRequest.itemOperations.map(operation => operation.kind), ['create']);
  const attached = server.execute(actor, attachCommand.idempotencyKey, attachRequest);
  assert.equal(attached.ok, true);
  assert.equal(attached.package.version, 2, 'Attaching children advances the parent CAS generation');
  assert.equal(attached.items.length, 1);

  const receivingCommand = {
    idempotencyKey: uuid(12),
    transactionType: 'set-receiving',
    packageId,
    updates: [{ itemId, checked: true, checkedAt: '2026-09-19T01:00:00.000Z' }],
  };
  const receivingRequest = buildJapanPackageTransactionRequest(attached.package, attached.items, receivingCommand);
  assert.deepEqual(receivingRequest.itemOperations.map(operation => operation.kind), ['patch']);
  const received = server.execute(actor, receivingCommand.idempotencyKey, receivingRequest);
  assert.equal(received.ok, true);
  assert.equal(received.package.status, 'confirmed');
  assert.equal(received.items[0].checked, true);

  const replay = server.execute(actor, receivingCommand.idempotencyKey, receivingRequest);
  assert.equal(replay.replayed, true);
  assert.equal(server.commits, 3);
  const mismatch = clone(receivingRequest);
  mismatch.itemOperations[0].changes.checked_at = '2026-09-19T02:00:00.000Z';
  assert.equal(server.execute(actor, receivingCommand.idempotencyKey, mismatch).code, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');

  const staleCommand = {
    ...receivingCommand,
    idempotencyKey: uuid(13),
    updates: [{ itemId, checked: false }],
  };
  const staleRequest = buildJapanPackageTransactionRequest(received.package, received.items, staleCommand);
  staleRequest.itemOperations[0].observedVersion = 1;
  assert.equal(server.execute(actor, staleCommand.idempotencyKey, staleRequest).code, 'FIELD_CONFLICT');
  assert.equal(server.items.get(itemId).checked, true);

  const rollbackServer = new AtomicJapanPackageServer();
  rollbackServer.packages.set(packageId, { ...canonicalPackage, version: 1 });
  const failed = rollbackServer.execute(actor, uuid(14), attachRequest, { failItemConstraint: true });
  assert.equal(failed.code, 'TRANSACTION_CONSTRAINT_FAILED');
  assert.equal(rollbackServer.items.size, 0);
  assert.equal(rollbackServer.packages.get(packageId).version, 1);
  assert.equal(rollbackServer.requests.size, 0);

  const invalidPackageServer = new AtomicJapanPackageServer();
  assert.equal(invalidPackageServer.execute(actor, uuid(16), attachRequest).code, 'RECORD_DELETED_OR_MISSING');
  assert.equal(server.execute('', uuid(17), attachRequest).code, 'FORBIDDEN');

  const invalidPurchaseServer = new AtomicJapanPackageServer();
  invalidPurchaseServer.packages.set(packageId, { ...canonicalPackage, version: 1 });
  assert.equal(invalidPurchaseServer.execute(actor, uuid(18), attachRequest, { invalidPurchaseItem: true }).code, 'PURCHASE_ITEM_RELATION_INVALID');
  assert.equal(invalidPurchaseServer.items.size, 0);

  const duplicateRelationCommand = {
    idempotencyKey: uuid(19), transactionType: 'attach-items', packageId,
    items: [{ ...itemRow, id: uuid(9) }],
  };
  const duplicateRelationRequest = buildJapanPackageTransactionRequest(attached.package, attached.items, duplicateRelationCommand);
  const duplicateRelationServer = new AtomicJapanPackageServer();
  duplicateRelationServer.packages.set(packageId, { ...attached.package });
  duplicateRelationServer.items.set(itemId, { ...attached.items[0] });
  assert.equal(duplicateRelationServer.execute(actor, duplicateRelationCommand.idempotencyKey, duplicateRelationRequest).code, 'DUPLICATE_RELATION');

  const partialServer = new AtomicJapanPackageServer();
  partialServer.packages.set(packageId, { ...attached.package });
  partialServer.items.set(itemId, { ...attached.items[0] });
  const secondItem = { ...attached.items[0], id: uuid(21), purchase_batch_item_id: uuid(22), sku: 'F3-SECOND' };
  partialServer.items.set(secondItem.id, secondItem);
  const checkFirst = {
    idempotencyKey: uuid(23), transactionType: 'set-receiving', packageId,
    updates: [{ itemId, checked: true, checkedAt: '2026-09-19T03:00:00.000Z' }],
  };
  const firstChecked = partialServer.execute(actor, checkFirst.idempotencyKey,
    buildJapanPackageTransactionRequest(partialServer.packages.get(packageId), [...partialServer.items.values()], checkFirst));
  assert.equal(firstChecked.package.status, 'registered', 'Partial receiving does not prematurely confirm the Package');
  const checkSecond = {
    idempotencyKey: uuid(24), transactionType: 'set-receiving', packageId,
    updates: [{ itemId: secondItem.id, checked: true, checkedAt: '2026-09-19T03:01:00.000Z' }],
  };
  const allChecked = partialServer.execute(actor, checkSecond.idempotencyKey,
    buildJapanPackageTransactionRequest(firstChecked.package, firstChecked.items, checkSecond));
  assert.equal(allChecked.package.status, 'confirmed');
  const uncheck = {
    idempotencyKey: uuid(25), transactionType: 'set-receiving', packageId,
    updates: [{ itemId, checked: false }],
  };
  const unchecked = partialServer.execute(actor, uncheck.idempotencyKey,
    buildJapanPackageTransactionRequest(allChecked.package, allChecked.items, uncheck));
  assert.equal(unchecked.package.status, 'arrived');
  assert.equal(unchecked.items.find(item => item.id === itemId).checked_at, null);

  const concurrentServer = new AtomicJapanPackageServer();
  concurrentServer.packages.set(packageId, { ...attached.package });
  concurrentServer.items.set(itemId, { ...attached.items[0] });
  const concurrentCommandA = { ...receivingCommand, idempotencyKey: uuid(26) };
  const concurrentCommandB = { ...receivingCommand, idempotencyKey: uuid(27) };
  const concurrentRequestA = buildJapanPackageTransactionRequest(attached.package, attached.items, concurrentCommandA);
  const concurrentRequestB = buildJapanPackageTransactionRequest(attached.package, attached.items, concurrentCommandB);
  assert.equal(concurrentServer.execute(actor, concurrentCommandA.idempotencyKey, concurrentRequestA).ok, true);
  assert.equal(concurrentServer.execute(actor, concurrentCommandB.idempotencyKey, concurrentRequestB).code, 'FIELD_CONFLICT');

  const problemServer = new AtomicJapanPackageServer();
  problemServer.packages.set(packageId, { ...attached.package, status: 'problem' });
  problemServer.items.set(itemId, { ...attached.items[0] });
  const problemRequest = buildJapanPackageTransactionRequest(
    problemServer.packages.get(packageId),
    [problemServer.items.get(itemId)],
    { ...receivingCommand, idempotencyKey: uuid(15) },
  );
  const problemResult = problemServer.execute(actor, uuid(15), problemRequest);
  assert.equal(problemResult.package.status, 'problem', 'Receiving never overwrites problem status');

  const storage = new MemoryStorage();
  let sequence = 30;
  const createUuid = () => uuid(sequence++);
  const firstCoordinator = new JapanPackageIntentCoordinator(storage, createUuid);
  const draft = { packageId, itemIds: [itemId], checked: true };
  const commandFactory = key => ({ idempotencyKey: key, transactionType: 'set-receiving', packageId, updates: [{ itemId, checked: true }] });
  const firstIntent = firstCoordinator.resolve('receiving', draft, commandFactory);
  const afterRemount = new JapanPackageIntentCoordinator(storage, createUuid).resolve('receiving', draft, commandFactory);
  assert.equal(firstIntent.idempotencyKey, afterRemount.idempotencyKey);
  assert.notEqual(
    firstCoordinator.resolve('receiving', { ...draft, checked: false }, commandFactory).idempotencyKey,
    firstIntent.idempotencyKey,
  );
  assert.equal(stableJapanPackagePayload({ b: 2, a: 1 }), stableJapanPackagePayload({ a: 1, b: 2 }));

  const [sql, provider, detail, list] = await Promise.all([
    readFile(SQL_PATH, 'utf8'),
    readFile(PROVIDER_PATH, 'utf8'),
    readFile(DETAIL_PATH, 'utf8'),
    readFile(LIST_PATH, 'utf8'),
  ]);
  assert.match(sql, /BEGIN;[\s\S]+COMMIT;\s*$/u);
  assert.match(sql, /SECURITY DEFINER[\s\S]+SET search_path = ''/u);
  assert.match(sql, /p_request->>'targetProjectRef' IS DISTINCT FROM 'rhfdjsklfrgpoqsaqpkn'/u);
  assert.match(sql, /NOT public\.is_editor\(v_actor\)/u);
  assert.match(sql, /ON CONFLICT \(actor_id, idempotency_key\) DO NOTHING/u);
  assert.match(sql, /request_payload IS DISTINCT FROM p_request/u);
  assert.match(sql, /FOR UPDATE/u);
  assert.match(sql, /pg_advisory_xact_lock/u);
  assert.match(sql, /public\.erp_apply_field_mutations\('japan_packages'/u);
  assert.match(sql, /public\.erp_apply_field_mutations\('japan_package_items'/u);
  assert.match(sql, /v_current_package\.status <> 'problem'/u);
  assert.match(sql, /v_transaction_type = 'attach-items'[\s\S]+version = version \+ 1/u);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.erp_apply_japan_package_transaction\(uuid, jsonb\) FROM PUBLIC/u);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.erp_apply_japan_package_transaction\(uuid, jsonb\) TO authenticated/u);
  assert.doesNotMatch(sql, /twzpqyesbtnfxdkorluf|service_role|ALTER TABLE public\.(?:japan_packages|japan_package_items)/u);

  assert.match(provider, /supabase\.rpc\(JAPAN_PACKAGE_TRANSACTION_RPC/u);
  assert.match(provider, /saveJapanPackageTransaction\(nextPackages, nextItems\)/u);
  assert.match(provider, /JapanPackageSubmitBoundaryError\('result-unknown'\)/u);
  assert.match(provider, /syncPending: true/u);
  assert.match(detail, /applyJapanPackageTransaction\(command\)/u);
  assert.match(detail, /transactionInFlightRef\.current\.has/u);
  assert.match(list, /transactionType: 'create-package'/u);
  const bulkReceivingHandler = detail.match(/const handleBulkToggleCheck[\s\S]+?const handleGroupBulkCheck/u)?.[0] ?? '';
  assert.ok(bulkReceivingHandler, 'The real receiving handler must remain inspectable');
  assert.doesNotMatch(bulkReceivingHandler, /saveJapanPackageItems/u);

  console.log('PASS A1 create, A2 attach, B receiving/status transaction models and canonical results');
  console.log('PASS rollback, CAS conflict, exact replay, payload mismatch, and problem-status preservation');
  console.log('PASS invalid Package/Purchase Item, duplicate relation, partial/final receiving, uncheck, and concurrent stale CAS');
  console.log('PASS stable intent across remount, single provider RPC, and atomic two-store cache commit');
  console.log('PASS 031 owner/target/ACL/search_path/lock/field-CAS contract; PostgreSQL apply remains pending');
} finally {
  await vite.close();
}
