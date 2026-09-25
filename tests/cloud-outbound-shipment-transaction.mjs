import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const uuid = suffix => `82000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

class AtomicDeleteServer {
  constructor(shipment, items, projectRef = 'rhfdjsklfrgpoqsaqpkn') {
    this.shipment = structuredClone(shipment);
    this.items = structuredClone(items);
    this.projectRef = projectRef;
    this.requests = new Map();
    this.commits = 0;
  }
  execute(actor, key, request, { failAfterItems = false } = {}) {
    if (!actor) return { ok: false, code: 'FORBIDDEN' };
    const fingerprint = JSON.stringify(request);
    const requestKey = `${actor}:${key}`;
    const previous = this.requests.get(requestKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { ok: false, code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' };
      return { ...structuredClone(previous.result), replayed: true };
    }
    if (request.targetProjectRef !== this.projectRef) return { ok: false, code: 'TARGET_PROJECT_FORBIDDEN' };
    if (!this.shipment || this.shipment.deleted_at || request.shipmentOperation.expectedVersion !== this.shipment.version) {
      return { ok: false, code: 'STALE_DELETE' };
    }
    const activeItems = this.items.filter(item => !item.deleted_at).sort((a, b) => a.id.localeCompare(b.id));
    if (request.itemOperations.map(operation => operation.id).join(',') !== activeItems.map(item => item.id).join(',')) {
      return { ok: false, code: 'ITEM_SCOPE_MISMATCH' };
    }
    for (const operation of request.itemOperations) {
      const item = activeItems.find(entry => entry.id === operation.id);
      if (!item || item.version !== operation.expectedVersion) return { ok: false, code: 'STALE_DELETE' };
    }
    const stagedShipment = { ...this.shipment, deleted_at: '2026-09-19T00:00:00.000Z' };
    const stagedItems = this.items.map(item => ({ ...item, deleted_at: '2026-09-19T00:00:00.000Z' }));
    if (failAfterItems) return { ok: false, code: 'TRANSACTION_CONSTRAINT_FAILED' };
    const result = {
      ok: true, transactionType: 'delete-shipment', idempotencyKey: key, replayed: false,
      shipmentId: this.shipment.id, itemIds: activeItems.map(item => item.id),
    };
    this.shipment = stagedShipment;
    this.items = stagedItems;
    this.requests.set(requestKey, { fingerprint, result: structuredClone(result) });
    this.commits += 1;
    return result;
  }
}

const vite = await createServer({ root: ROOT, mode: 'experimental', server: { middlewareMode: true }, appType: 'custom' });
try {
  const module = await vite.ssrLoadModule('/src/providers/cloud/outboundShipmentTransaction.ts');
  const { buildOutboundShipmentDeleteRequest, OutboundShipmentDeleteIntentCoordinator } = module;
  const shipment = { id: uuid(1), title: 'F4', status: 'draft', version: 3 };
  const items = [
    { id: uuid(2), outbound_shipment_id: shipment.id, quantity: 1, checked: false, version: 2 },
    { id: uuid(3), outbound_shipment_id: shipment.id, quantity: 2, checked: true, version: 4 },
  ];
  const request = buildOutboundShipmentDeleteRequest(shipment, items, 'rhfdjsklfrgpoqsaqpkn');
  assert.equal(request.shipmentOperation.kind, 'delete');
  assert.deepEqual(request.itemOperations.map(operation => operation.kind), ['delete', 'delete']);
  assert.throws(() => buildOutboundShipmentDeleteRequest(shipment, items, ''), /OUTBOUND_TARGET_PROJECT_REF_REQUIRED/u);

  const server = new AtomicDeleteServer(shipment, items);
  const actor = uuid(9);
  const key = uuid(10);
  const result = server.execute(actor, key, request);
  assert.equal(result.ok, true);
  assert.equal(server.shipment.deleted_at !== undefined, true);
  assert.equal(server.items.every(item => item.deleted_at), true);
  assert.equal(server.execute(actor, key, request).replayed, true);
  assert.equal(server.commits, 1);
  const mismatch = structuredClone(request);
  mismatch.itemOperations[0].expectedVersion += 1;
  assert.equal(server.execute(actor, key, mismatch).code, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');

  const rollback = new AtomicDeleteServer(shipment, items);
  assert.equal(rollback.execute(actor, uuid(11), request, { failAfterItems: true }).ok, false);
  assert.equal(rollback.shipment.deleted_at, undefined);
  assert.equal(rollback.items.every(item => item.deleted_at === undefined), true);
  assert.equal(rollback.requests.size, 0);
  const stale = structuredClone(request);
  stale.shipmentOperation.expectedVersion -= 1;
  assert.equal(new AtomicDeleteServer(shipment, items).execute(actor, uuid(12), stale).code, 'STALE_DELETE');
  const incomplete = structuredClone(request);
  incomplete.itemOperations.pop();
  assert.equal(new AtomicDeleteServer(shipment, items).execute(actor, uuid(13), incomplete).code, 'ITEM_SCOPE_MISMATCH');

  const storage = new MemoryStorage();
  let sequence = 20;
  const coordinator = new OutboundShipmentDeleteIntentCoordinator(storage, () => uuid(sequence++));
  const first = coordinator.resolve(shipment.id);
  const remount = new OutboundShipmentDeleteIntentCoordinator(storage, () => uuid(sequence++)).resolve(shipment.id);
  assert.equal(first.idempotencyKey, remount.idempotencyKey);
  coordinator.complete(first);
  assert.notEqual(coordinator.resolve(shipment.id).idempotencyKey, first.idempotencyKey);

  const [detail, provider, localProvider, db] = await Promise.all([
    readFile(new URL('../src/pages/OutboundShipmentDetail.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/providers/localProvider.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/db.ts', import.meta.url), 'utf8'),
  ]);
  const deleteHandler = detail.match(/const deleteShipment = async \(\) => \{[\s\S]+?\n  \};/u)?.[0] ?? '';
  assert.match(deleteHandler, /deleteInFlightRef\.current/u);
  assert.match(deleteHandler, /deleteOutboundShipmentTransaction\(command\)/u);
  assert.doesNotMatch(deleteHandler, /saveOutboundShipments|saveOutboundShipmentItems/u);
  assert.match(provider, /supabase\.rpc\(OUTBOUND_SHIPMENT_TRANSACTION_RPC/u);
  assert.match(provider, /saveOutboundShipmentTransaction\(nextShipments, nextItems\)/u);
  assert.match(localProvider, /saveOutboundShipmentTransaction/u);
  assert.match(db, /database\.transaction\('kv', 'readwrite'\)[\s\S]+erp_outbound_shipments[\s\S]+erp_outbound_shipment_items/u);
  console.log('PASS F4 atomic delete, CAS, replay, payload mismatch, scope rejection and rollback model');
  console.log('PASS stable delete intent, single UI transaction entry and two-store cache transaction');
} finally {
  await vite.close();
}
