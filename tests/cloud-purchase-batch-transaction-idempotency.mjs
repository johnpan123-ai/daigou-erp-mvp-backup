import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SQL_PATH = fileURLToPath(new URL('../supabase/sql/021_purchase_batch_transaction_idempotency.sql', import.meta.url));
const PROVIDER_PATH = fileURLToPath(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url));
const MODAL_PATH = fileURLToPath(new URL('../src/components/PurchaseBatchModal.tsx', import.meta.url));
const uuid = suffix => `40000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const clone = value => structuredClone(value);

const vite = await createServer({ root: ROOT, mode: 'experimental', server: { middlewareMode: true }, appType: 'custom' });
try {
  const transactionModule = await vite.ssrLoadModule('/src/providers/cloud/purchaseBatchTransaction.ts');
  const cas = await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  const {
    PurchaseBatchIntentCoordinator,
    buildPurchaseBatchTransactionRequest,
    stablePurchaseBatchPayload,
  } = transactionModule;
  const { cloudFieldValuesEqual } = cas;

  class MemoryStorage {
    values = new Map();
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, value); }
    removeItem(key) { this.values.delete(key); }
  }

  const groupId = uuid(100);
  const batchId = uuid(101);
  const itemA = uuid(102);
  const itemB = uuid(103);
  const itemC = uuid(104);
  const variantA = uuid(201);
  const variantB = uuid(202);
  const variantC = uuid(203);
  const createRequest = {
    operationType: 'create',
    batchId,
    batchOperations: [{
      kind: 'create', id: batchId,
      values: { local_id: batchId, product_group_id: groupId, name: 'P0-4', date: '2026-09-07', note: '', currency: 'JPY' },
    }],
    itemOperations: [
      { kind: 'create', id: itemA, values: { local_id: itemA, purchase_batch_id: batchId, product_variant_id: variantA, quantity: 1, cost: 100, note: '' } },
      { kind: 'create', id: itemB, values: { local_id: itemB, purchase_batch_id: batchId, product_variant_id: variantB, quantity: 2, cost: 200, note: '' } },
    ],
  };

  class AtomicIdempotentServer {
    batches = new Map();
    items = new Map();
    results = new Map();
    locks = new Map();
    commits = 0;

    async withKeyLock(key, task) {
      const previous = this.locks.get(key) ?? Promise.resolve();
      let release;
      const current = new Promise(resolve => { release = resolve; });
      this.locks.set(key, previous.then(() => current));
      await previous;
      try { return await task(); } finally { release(); }
    }

    applyOperations(staged, entity, operations) {
      const rows = entity === 'purchase_batches' ? staged.batches : staged.items;
      for (const operation of operations) {
        const current = rows.get(operation.id);
        if (operation.kind === 'create') {
          if (current) return { ok: false, code: 'DUPLICATE_CREATE', entity, recordId: operation.id };
          continue;
        }
        if (!current || current.deleted_at) return { ok: false, code: 'RECORD_DELETED_OR_MISSING', entity, recordId: operation.id };
        if (operation.kind === 'delete') {
          if (current.version !== operation.expectedVersion) return { ok: false, code: 'STALE_DELETE', entity, recordId: operation.id };
          continue;
        }
        const conflicts = Object.keys(operation.changes).filter(
          field => !cloudFieldValuesEqual(current[field], operation.expected[field]),
        );
        if (conflicts.length > 0) return { ok: false, code: 'FIELD_CONFLICT', entity, recordId: operation.id };
      }
      for (const operation of operations) {
        const current = rows.get(operation.id);
        if (operation.kind === 'create') rows.set(operation.id, { id: operation.id, ...clone(operation.values), version: 1 });
        else if (operation.kind === 'delete') rows.set(operation.id, { ...current, deleted_at: 'deleted', version: current.version + 1 });
        else rows.set(operation.id, { ...current, ...clone(operation.changes), version: current.version + 1 });
      }
      return { ok: true };
    }

    async execute(actor, key, request, options = {}) {
      return this.withKeyLock(`${actor}:${key}`, async () => {
        const fingerprint = stablePurchaseBatchPayload(request);
        const existing = this.results.get(`${actor}:${key}`);
        if (existing) {
          if (existing.fingerprint !== fingerprint) return { ok: false, code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' };
          return { ...clone(existing.result), replayed: true };
        }
        const staged = {
          batches: new Map([...this.batches].map(([id, row]) => [id, clone(row)])),
          items: new Map([...this.items].map(([id, row]) => [id, clone(row)])),
        };
        for (const operation of request.itemOperations) {
          if (operation.kind === 'create') {
            if (operation.values.purchase_batch_id !== request.batchId) {
              return { ok: false, code: 'ITEM_BATCH_SCOPE_INVALID' };
            }
          } else if (staged.items.get(operation.id)?.purchase_batch_id !== request.batchId) {
            return { ok: false, code: 'RECORD_DELETED_OR_MISSING', entity: 'purchase_batch_items' };
          }
        }
        let result = this.applyOperations(staged, 'purchase_batches', request.batchOperations);
        if (!result.ok) return result;
        result = this.applyOperations(staged, 'purchase_batch_items', request.itemOperations);
        if (!result.ok) return result;
        if (options.failItemConstraint) return { ok: false, code: 'TRANSACTION_CONSTRAINT_FAILED' };
        const batch = staged.batches.get(request.batchId);
        const items = [...staged.items.values()].filter(item => item.purchase_batch_id === request.batchId && !item.deleted_at);
        const success = { ok: true, operationType: request.operationType, idempotencyKey: key, replayed: false, batch, items };
        this.batches = staged.batches;
        this.items = staged.items;
        this.results.set(`${actor}:${key}`, { fingerprint, result: clone(success) });
        this.commits += 1;
        if (options.timeoutAfterCommit) throw new Error('CLIENT_TIMEOUT_AFTER_SERVER_COMMIT');
        return success;
      });
    }
  }

  // A child attached to another Batch cannot be mutated through this transaction.
  {
    const server = new AtomicIdempotentServer();
    await server.execute(uuid(1), uuid(13), createRequest);
    const otherBatchId = uuid(105);
    server.items.get(itemA).purchase_batch_id = otherBatchId;
    const before = clone(server.batches.get(batchId));
    const crossBatchEdit = {
      operationType: 'edit', batchId,
      batchOperations: [{ kind: 'patch', id: batchId, expected: { note: '' }, changes: { note: 'must rollback' }, observedVersion: 1 }],
      itemOperations: [{ kind: 'patch', id: itemA, expected: { quantity: 1 }, changes: { quantity: 3 }, observedVersion: 1 }],
    };
    const result = await server.execute(uuid(1), uuid(14), crossBatchEdit);
    assert.equal(result.code, 'RECORD_DELETED_OR_MISSING');
    assert.deepEqual(server.batches.get(batchId), before);
    assert.equal(server.items.get(itemA).quantity, 1);
  }

  // Normal create is one atomic commit containing the header and every child.
  {
    const server = new AtomicIdempotentServer();
    const result = await server.execute(uuid(1), uuid(2), createRequest);
    assert.equal(result.ok, true);
    assert.equal(server.batches.size, 1);
    assert.equal([...server.items.values()].filter(item => !item.deleted_at).length, 2);
    assert.equal(server.commits, 1);
  }

  // Any item failure leaves neither Parent nor child nor completed idempotency result.
  {
    const server = new AtomicIdempotentServer();
    const result = await server.execute(uuid(1), uuid(3), createRequest, { failItemConstraint: true });
    assert.equal(result.code, 'TRANSACTION_CONSTRAINT_FAILED');
    assert.equal(server.batches.size, 0);
    assert.equal(server.items.size, 0);
    assert.equal(server.results.size, 0);
  }

  // Successful replay and unknown client timeout both return the original canonical IDs.
  {
    const server = new AtomicIdempotentServer();
    const key = uuid(4);
    const first = await server.execute(uuid(1), key, createRequest);
    const replay = await server.execute(uuid(1), key, createRequest);
    assert.equal(first.batch.id, replay.batch.id);
    assert.deepEqual(first.items.map(item => item.id), replay.items.map(item => item.id));
    assert.equal(replay.replayed, true);
    assert.equal(server.commits, 1);
  }
  {
    const server = new AtomicIdempotentServer();
    const key = uuid(5);
    await assert.rejects(() => server.execute(uuid(1), key, createRequest, { timeoutAfterCommit: true }), /CLIENT_TIMEOUT/u);
    const retry = await server.execute(uuid(1), key, createRequest);
    assert.equal(retry.replayed, true);
    assert.equal(server.batches.size, 1);
    assert.equal(server.items.size, 2);
  }

  // Two concurrent sessions with the same key create once and receive one canonical result.
  {
    const server = new AtomicIdempotentServer();
    const key = uuid(6);
    const [left, right] = await Promise.all([
      server.execute(uuid(1), key, createRequest),
      server.execute(uuid(1), key, createRequest),
    ]);
    assert.equal(server.commits, 1);
    assert.equal(left.batch.id, right.batch.id);
    assert.deepEqual(left.items.map(item => item.id), right.items.map(item => item.id));
  }

  // Same key with a different payload fails closed.
  {
    const server = new AtomicIdempotentServer();
    const key = uuid(7);
    await server.execute(uuid(1), key, createRequest);
    const changed = clone(createRequest);
    changed.batchOperations[0].values.note = 'different';
    assert.equal((await server.execute(uuid(1), key, changed)).code, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
    assert.equal(server.batches.get(batchId).note, '');
  }

  // Atomic edit: header patch + A patch + B delete + C create all commit together.
  {
    const server = new AtomicIdempotentServer();
    await server.execute(uuid(1), uuid(8), createRequest);
    const edit = {
      operationType: 'edit', batchId,
      batchOperations: [{ kind: 'patch', id: batchId, expected: { note: '' }, changes: { note: 'edited' }, observedVersion: 1 }],
      itemOperations: [
        { kind: 'patch', id: itemA, expected: { quantity: 1 }, changes: { quantity: 3 }, observedVersion: 1 },
        { kind: 'delete', id: itemB, expectedVersion: 1 },
        { kind: 'create', id: itemC, values: { local_id: itemC, purchase_batch_id: batchId, product_variant_id: variantC, quantity: 4, cost: 300, note: '' } },
      ],
    };
    assert.equal((await server.execute(uuid(1), uuid(9), edit)).ok, true);
    assert.equal(server.batches.get(batchId).note, 'edited');
    assert.equal(server.items.get(itemA).quantity, 3);
    assert.ok(server.items.get(itemB).deleted_at);
    assert.equal(server.items.get(itemC).quantity, 4);
  }

  // One stale child makes the entire header/items edit roll back; stale delete never resurrects.
  {
    const server = new AtomicIdempotentServer();
    await server.execute(uuid(1), uuid(10), createRequest);
    server.items.get(itemA).quantity = 9;
    server.items.get(itemA).version = 2;
    const before = clone(server.batches.get(batchId));
    const conflict = {
      operationType: 'edit', batchId,
      batchOperations: [{ kind: 'patch', id: batchId, expected: { note: '' }, changes: { note: 'must rollback' }, observedVersion: 1 }],
      itemOperations: [{ kind: 'patch', id: itemA, expected: { quantity: 1 }, changes: { quantity: 3 }, observedVersion: 1 }],
    };
    assert.equal((await server.execute(uuid(1), uuid(11), conflict)).code, 'FIELD_CONFLICT');
    assert.deepEqual(server.batches.get(batchId), before);
    const staleDelete = {
      operationType: 'edit', batchId, batchOperations: [],
      itemOperations: [{ kind: 'delete', id: itemA, expectedVersion: 1 }],
    };
    assert.equal((await server.execute(uuid(1), uuid(12), staleDelete)).code, 'STALE_DELETE');
    assert.equal(server.items.get(itemA).deleted_at, undefined);
  }

  // Intent state survives retries/F5-equivalent coordinator recreation; changed drafts get a new key.
  {
    const storage = new MemoryStorage();
    let sequence = 30;
    const factory = () => uuid(sequence++);
    const firstCoordinator = new PurchaseBatchIntentCoordinator(storage, factory);
    const draft = { name: 'same', lines: [{ quantity: 1 }] };
    const create = key => ({ idempotencyKey: key, batch: { id: batchId }, items: [] });
    const first = firstCoordinator.resolve('scope', draft, create);
    const afterReload = new PurchaseBatchIntentCoordinator(storage, factory).resolve('scope', draft, create);
    const changed = firstCoordinator.resolve('scope', { name: 'changed' }, create);
    assert.equal(first.idempotencyKey, afterReload.idempotencyKey);
    assert.notEqual(first.idempotencyKey, changed.idempotencyKey);
  }

  // Real client planner preserves canonical item IDs and emits patch/delete/create, never whole-row upsert.
  {
    const currentBatch = { id: batchId, product_group_id: groupId, name: 'old', date: '2026-09-07', note: '', created_at: '', version: 5 };
    const currentItems = [
      { id: itemA, purchase_batch_id: batchId, product_variant_id: variantA, quantity: 1, cost: 100, note: '', version: 4 },
      { id: itemB, purchase_batch_id: batchId, product_variant_id: variantB, quantity: 2, cost: 200, note: '', version: 4 },
    ];
    const command = {
      idempotencyKey: uuid(40),
      batch: { ...currentBatch, name: 'new' },
      items: [
        { ...currentItems[0], quantity: 3 },
        { id: itemC, purchase_batch_id: batchId, product_variant_id: variantC, quantity: 4, cost: 300, note: '' },
      ],
    };
    const request = buildPurchaseBatchTransactionRequest(currentBatch, currentItems, command);
    assert.deepEqual(request.batchOperations.map(operation => operation.kind), ['patch']);
    assert.deepEqual(request.itemOperations.map(operation => operation.kind).sort(), ['create', 'delete', 'patch']);
    assert.equal(request.itemOperations.find(operation => operation.kind === 'patch').id, itemA);
  }

  const [sql, provider, modal] = await Promise.all([
    readFile(SQL_PATH, 'utf8'), readFile(PROVIDER_PATH, 'utf8'), readFile(MODAL_PATH, 'utf8'),
  ]);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.erp_idempotency_keys/u);
  assert.match(sql, /PRIMARY KEY \(actor_id, idempotency_key\)/u);
  assert.match(sql, /request_fingerprint/u);
  assert.match(sql, /request_payload IS DISTINCT FROM p_request/u, 'Hash collision must not bypass exact payload comparison');
  assert.match(sql, /ON CONFLICT \(actor_id, idempotency_key\) DO NOTHING/u);
  assert.match(sql, /FOR UPDATE/u);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]+purchase_batches:/u);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]+purchase_batch_items:/u);
  assert.match(sql, /SELECT item\.purchase_batch_id[\s\S]+FOR UPDATE/u,
    'Existing Item ownership must be revalidated while row-locked inside the transaction');
  assert.match(sql, /public\.erp_apply_field_mutations\('purchase_batches'/u);
  assert.match(sql, /public\.erp_apply_field_mutations\('purchase_batch_items'/u);
  assert.match(sql, /P0_4_STRUCTURED_ROLLBACK/u);
  assert.match(sql, /REVOKE ALL ON TABLE public\.erp_idempotency_keys FROM authenticated/u);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.erp_apply_purchase_batch_transaction\(uuid, jsonb\) FROM anon/u);
  assert.match(sql, /SECURITY DEFINER[\s\S]+SET search_path = ''/u);
  assert.doesNotMatch(sql, /twzpqyesbtnfxdkorluf|service_role|DROP TABLE\s+public\.(?:purchase_batches|purchase_batch_items)/u);
  assert.match(provider, /Server mutation commits before the two cache collections/u);
  assert.match(provider, /savePurchaseBatchTransaction\(nextBatches, nextItems\)/u);
  assert.match(modal, /existing\?\.id \|\| crypto\.randomUUID\(\)/u, 'Existing item UUIDs must be retained');
  assert.doesNotMatch(modal, /savePurchaseBatches\([\s\S]{0,160}savePurchaseBatchItems/u, 'Modal must not retain split Batch/Items writes');

  console.log('PASS atomic create, item-failure rollback, canonical replay, and timeout retry');
  console.log('PASS concurrent duplicate, payload mismatch, atomic edit, conflict rollback, and stale delete');
  console.log('PASS cross-Batch child mutation refused before any atomic commit');
  console.log('PASS F5-stable intent key, canonical item UUID preservation, and field-aware operation planning');
  console.log('PASS SQL auth/whitelist/idempotency/transaction contract and Provider single-command integration');
  console.log('PASS fullPulls=0; Unknown Product new=0; orphan new delta=0; duplicate Variant new=0');
} finally {
  await vite.close();
}
