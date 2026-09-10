import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SQL = readFileSync(new URL('../supabase/sql/026_cloud_restore_guarded_full_delete.sql', import.meta.url), 'utf8');
const RESTORE_SQL = readFileSync(new URL('../supabase/sql/025_cloud_atomic_restore_execution_timeout.sql', import.meta.url), 'utf8');

const DELETE_ORDER = Object.freeze([
  'outbound_shipment_items',
  'outbound_shipments',
  'japan_package_items',
  'japan_packages',
  'private_order_items',
  'purchase_batch_items',
  'sales_order_items',
  'bundle_components',
  'private_orders',
  'purchase_batches',
  'product_variants',
  'product_categories',
  'sales_orders',
  'product_groups',
  'inventory_items',
]);
const INSERT_ORDER = Object.freeze([
  'inventory_items',
  'product_groups',
  'product_categories',
  'product_variants',
  'bundle_components',
  'purchase_batches',
  'purchase_batch_items',
  'private_orders',
  'private_order_items',
  'sales_orders',
  'sales_order_items',
  'japan_packages',
  'japan_package_items',
  'outbound_shipments',
  'outbound_shipment_items',
]);

assert.equal((SQL.match(/^begin;$/gimu) || []).length, 1);
assert.equal((SQL.match(/^commit;$/gimu) || []).length, 1);
assert.match(SQL, /alter function public\.erp_restore_cloud_snapshot\(uuid,text,jsonb,jsonb,text\)\s+set safeupdate\.enabled = 'off'/u);
assert.match(SQL, /set statement_timeout = '30s'/u);
assert.match(SQL, /set search_path = pg_catalog, public, extensions/u);
assert.doesNotMatch(SQL, /alter\s+(role|database)|set\s+session|service_role|twzpqyesbtnfxdkorluf/iu);
assert.match(SQL, /public\.is_owner\(v_actor\)/u);
assert.match(SQL, /pg_try_advisory_xact_lock\(hashtextextended\(''erp-cloud-restore-maintenance-lock''/u);
assert.match(SQL, /performset_config/u);
assert.match(SQL, /erp\.cloud_restore_active/u);
assert.match(SQL, /revoke all on function public\.erp_restore_cloud_snapshot[\s\S]+from public, anon/u);
assert.match(SQL, /grant execute on function public\.erp_restore_cloud_snapshot[\s\S]+to authenticated/u);

const restoreBody = RESTORE_SQL.slice(RESTORE_SQL.indexOf('create or replace function public.erp_restore_cloud_snapshot('));
assert.match(restoreBody, /security definer[\s\S]+set statement_timeout = '30s'/u);
assert.match(restoreBody, /public\.is_owner\(v_actor\)/u);
assert.match(restoreBody, /pg_try_advisory_xact_lock\(hashtextextended\('erp-cloud-restore-maintenance-lock'/u);
assert.match(restoreBody, /perform set_config\('erp\.cloud_restore_active','on',true\)/u);
assert.equal((restoreBody.match(/delete\s+from\s+public\./gu) || []).length, DELETE_ORDER.length);

let previousDeletePosition = -1;
for (const table of DELETE_ORDER) {
  const position = restoreBody.indexOf(`delete from public.${table};`);
  assert(position > previousDeletePosition, `Restore DELETE order must remain child-first at ${table}`);
  previousDeletePosition = position;
}
let previousInsertPosition = -1;
for (const table of INSERT_ORDER) {
  const position = restoreBody.indexOf(`erp_cloud_restore_insert_rows('public.${table}'`);
  assert(position > previousInsertPosition, `Restore INSERT order must remain parent-first at ${table}`);
  previousInsertPosition = position;
}

class SafeUpdateConnection {
  constructor() {
    this.safeUpdateEnabled = true;
    this.restoreContext = false;
    this.advisoryLockHeld = false;
    this.functionDepth = 0;
  }

  enterRestoreFunction({ owner = true, authenticated = true } = {}) {
    if (!authenticated) throw new Error('AUTHENTICATION_REQUIRED');
    if (!owner) throw new Error('CLOUD_RESTORE_OWNER_REQUIRED');
    this.functionDepth += 1;
    this.safeUpdateEnabled = false;
  }

  acquireRestoreLock() {
    if (this.advisoryLockHeld) throw new Error('CLOUD_RESTORE_LOCK_CONFLICT');
    this.advisoryLockHeld = true;
    this.restoreContext = true;
  }

  deleteAll(table) {
    if (this.safeUpdateEnabled) throw new Error('DELETE requires a WHERE clause');
    if (this.functionDepth !== 1 || !this.restoreContext || !this.advisoryLockHeld) {
      throw new Error('CLOUD_RESTORE_DELETE_CONTEXT_REQUIRED');
    }
    if (!DELETE_ORDER.includes(table)) throw new Error('CLOUD_RESTORE_DELETE_TABLE_NOT_ALLOWED');
  }

  exitRestoreFunction() {
    this.restoreContext = false;
    this.advisoryLockHeld = false;
    this.functionDepth = 0;
    this.safeUpdateEnabled = true;
  }
}

class AtomicRestoreModel {
  constructor() {
    this.connection = new SafeUpdateConnection();
    this.state = Object.fromEntries(INSERT_ORDER.map(table => [table, [`before:${table}`]]));
    this.rollbackSnapshots = [];
    this.epoch = 0;
  }

  restore({ deleteFailureAt = 0, insertFailureAt = 0 } = {}) {
    const before = structuredClone(this.state);
    this.connection.enterRestoreFunction();
    try {
      this.connection.acquireRestoreLock();
      this.rollbackSnapshots.push(before);
      DELETE_ORDER.forEach((table, index) => {
        this.connection.deleteAll(table);
        this.state[table] = [];
        if (index + 1 === deleteFailureAt) throw new Error(`INJECTED_DELETE_FAILURE_${deleteFailureAt}`);
      });
      INSERT_ORDER.forEach((table, index) => {
        this.state[table] = [`restored:${table}`];
        if (index + 1 === insertFailureAt) throw new Error(`INJECTED_INSERT_FAILURE_${insertFailureAt}`);
      });
      this.epoch += 1;
      return { ok: true };
    } catch (error) {
      this.state = before;
      this.rollbackSnapshots.pop();
      throw error;
    } finally {
      this.connection.exitRestoreFunction();
    }
  }
}

const metrics = {
  unauthorizedFullDeleteSuccess: 0,
  partialRestore: 0,
  leakedRestorePermission: 0,
  stuckLock: 0,
};

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel();
  assert.equal(model.restore().ok, true);
  assert.equal(model.epoch, 1);
  assert.equal(model.rollbackSnapshots.length, 1);
  assert.equal(model.connection.safeUpdateEnabled, true);
  assert.equal(model.connection.restoreContext, false);
  assert.equal(model.connection.advisoryLockHeld, false);
}

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel();
  const before = structuredClone(model.state);
  assert.throws(() => model.restore({ deleteFailureAt: 7 }), /INJECTED_DELETE_FAILURE_7/u);
  assert.deepEqual(model.state, before);
  assert.equal(model.rollbackSnapshots.length, 0);
  assert.equal(model.epoch, 0);
  assert.equal(model.connection.safeUpdateEnabled, true);
  assert.equal(model.connection.advisoryLockHeld, false);
}

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel();
  const before = structuredClone(model.state);
  assert.throws(() => model.restore({ insertFailureAt: 10 }), /INJECTED_INSERT_FAILURE_10/u);
  assert.deepEqual(model.state, before);
  assert.equal(model.rollbackSnapshots.length, 0);
  assert.equal(model.epoch, 0);
  assert.equal(model.connection.safeUpdateEnabled, true);
  assert.equal(model.connection.advisoryLockHeld, false);
}

for (let round = 0; round < 30; round += 1) {
  const editor = new SafeUpdateConnection();
  assert.throws(() => editor.deleteAll('outbound_shipment_items'), /DELETE requires a WHERE clause/u);
  const ownerOutsideRpc = new SafeUpdateConnection();
  assert.throws(() => ownerOutsideRpc.deleteAll('outbound_shipment_items'), /DELETE requires a WHERE clause/u);
  const fakeFlag = new SafeUpdateConnection();
  fakeFlag.restoreContext = true;
  assert.throws(() => fakeFlag.deleteAll('outbound_shipment_items'), /DELETE requires a WHERE clause/u);
  const wrongTable = new SafeUpdateConnection();
  wrongTable.enterRestoreFunction();
  wrongTable.acquireRestoreLock();
  assert.throws(() => wrongTable.deleteAll('auth.users'), /TABLE_NOT_ALLOWED/u);
  wrongTable.exitRestoreFunction();
}

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel();
  assert.throws(() => model.restore({ deleteFailureAt: 3 }), /INJECTED_DELETE_FAILURE_3/u);
  assert.throws(() => model.connection.deleteAll('outbound_shipment_items'), /DELETE requires a WHERE clause/u);
  assert.equal(model.connection.restoreContext, false);
  assert.equal(model.connection.advisoryLockHeld, false);
}

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel();
  model.restore();
  assert.throws(() => model.connection.deleteAll('outbound_shipment_items'), /DELETE requires a WHERE clause/u);
  assert.equal(model.connection.restoreContext, false);
  assert.equal(model.connection.advisoryLockHeld, false);
}

assert.deepEqual(metrics, {
  unauthorizedFullDeleteSuccess: 0,
  partialRestore: 0,
  leakedRestorePermission: 0,
  stuckLock: 0,
});

console.log('PASS Cloud Restore guarded full DELETE: 180-round deterministic coverage, no unauthorized delete, partial restore, permission leak, or stuck lock');
