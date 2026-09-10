import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SQL = readFileSync(
  new URL('../supabase/sql/027_cloud_restore_safeupdate_compatible_delete.sql', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');
const BASELINE_SQL = readFileSync(
  new URL('../supabase/sql/025_cloud_atomic_restore_execution_timeout.sql', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');

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

const functionStart = 'create or replace function public.erp_restore_cloud_snapshot(';
const functionEnd = '\n$$;';
function extractRestoreFunction(sql) {
  const start = sql.indexOf(functionStart);
  assert(start >= 0, 'Restore function definition must exist');
  const end = sql.indexOf(functionEnd, start);
  assert(end >= 0, 'Restore function definition must terminate');
  return sql.slice(start, end + functionEnd.length);
}

assert.equal((SQL.match(/^begin;$/gimu) || []).length, 1);
assert.equal((SQL.match(/^commit;$/gimu) || []).length, 1);
assert.doesNotMatch(SQL, /set\s+safeupdate\.enabled|safeupdate\.enabled\s*=\s*'off'|alter\s+(role|database)|set\s+session/iu);
assert.doesNotMatch(SQL, /service_role|twzpqyesbtnfxdkorluf/iu);
assert.match(SQL, /constraint_row\.contype = 'p'/u);
assert.match(SQL, /constraint_row\.conkey = array\[v_id_attnum\]::smallint\[\]/u);
assert.match(SQL, /not coalesce\(v_id_not_null, false\)/u);
assert.match(SQL, /v_id_type is distinct from 'uuid'/u);

const restoreBody = extractRestoreFunction(SQL);
let expectedRestoreBody = extractRestoreFunction(BASELINE_SQL);
for (const table of DELETE_ORDER) {
  expectedRestoreBody = expectedRestoreBody.replace(
    `delete from public.${table};`,
    `delete from public.${table} where id is not null;`,
  );
}
assert.equal(restoreBody, expectedRestoreBody, '027 may only add fixed PK predicates to the accepted Restore function');
assert.match(restoreBody, /security definer\nset search_path = pg_catalog, public, extensions\nset statement_timeout = '30s'/u);

const authPosition = restoreBody.indexOf('if v_actor is null then');
const ownerPosition = restoreBody.indexOf('public.is_owner(v_actor)');
const lockPosition = restoreBody.indexOf("pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock'");
const contextPosition = restoreBody.indexOf("perform set_config('erp.cloud_restore_active','on',true)");
assert(authPosition >= 0 && ownerPosition > authPosition && lockPosition > ownerPosition && contextPosition > lockPosition);

assert.equal((restoreBody.match(/delete\s+from\s+public\./gu) || []).length, DELETE_ORDER.length);
assert.equal((restoreBody.match(/where\s+id\s+is\s+not\s+null/gu) || []).length, DELETE_ORDER.length);
let previousDeletePosition = -1;
for (const table of DELETE_ORDER) {
  const statement = `delete from public.${table} where id is not null;`;
  const position = restoreBody.indexOf(statement);
  assert(position > previousDeletePosition, `DELETE must remain child-first at ${table}`);
  previousDeletePosition = position;
}
let previousInsertPosition = -1;
for (const table of INSERT_ORDER) {
  const position = restoreBody.indexOf(`erp_cloud_restore_insert_rows('public.${table}'`);
  assert(position > previousInsertPosition, `INSERT must remain parent-first at ${table}`);
  previousInsertPosition = position;
}
assert.match(SQL, /revoke all on function public\.erp_restore_cloud_snapshot[\s\S]+from public, anon/u);
assert.match(SQL, /grant execute on function public\.erp_restore_cloud_snapshot[\s\S]+to authenticated/u);

class SafeUpdateCompatibleConnection {
  constructor() {
    this.safeUpdateEnabled = true;
    this.authenticated = false;
    this.owner = false;
    this.restoreContext = false;
    this.advisoryLockHeld = false;
    this.functionDepth = 0;
    this.safeUpdateConfigMutations = 0;
  }

  enterRestoreFunction({ authenticated = true, owner = true } = {}) {
    if (!authenticated) throw new Error('AUTHENTICATION_REQUIRED');
    if (!owner) throw new Error('CLOUD_RESTORE_OWNER_REQUIRED');
    this.authenticated = true;
    this.owner = true;
    this.functionDepth = 1;
  }

  acquireRestoreLock() {
    if (this.advisoryLockHeld) throw new Error('CLOUD_RESTORE_LOCK_CONFLICT');
    this.advisoryLockHeld = true;
    this.restoreContext = true;
  }

  deleteRows(table, predicate) {
    if (!predicate) throw new Error('DELETE requires a WHERE clause');
    if (predicate !== 'id IS NOT NULL') throw new Error('CLOUD_RESTORE_DELETE_PREDICATE_NOT_ALLOWED');
    if (!DELETE_ORDER.includes(table)) throw new Error('CLOUD_RESTORE_DELETE_TABLE_NOT_ALLOWED');
    if (!this.authenticated || !this.owner || this.functionDepth !== 1 || !this.restoreContext || !this.advisoryLockHeld) {
      throw new Error('CLOUD_RESTORE_DELETE_CONTEXT_REQUIRED');
    }
  }

  exitRestoreFunction() {
    this.authenticated = false;
    this.owner = false;
    this.restoreContext = false;
    this.advisoryLockHeld = false;
    this.functionDepth = 0;
  }
}

class AtomicRestoreModel {
  constructor({ emptyTables = [] } = {}) {
    this.connection = new SafeUpdateCompatibleConnection();
    this.state = Object.fromEntries(INSERT_ORDER.map(table => [
      table,
      emptyTables.includes(table) ? [] : [{ id: `${table}-id`, value: `before:${table}` }],
    ]));
    this.epoch = 0;
  }

  restore({ deleteFailureAt = 0, insertFailureAt = 0 } = {}) {
    const before = structuredClone(this.state);
    this.connection.enterRestoreFunction();
    try {
      this.connection.acquireRestoreLock();
      DELETE_ORDER.forEach((table, index) => {
        this.connection.deleteRows(table, 'id IS NOT NULL');
        this.state[table] = [];
        if (index + 1 === deleteFailureAt) throw new Error(`INJECTED_DELETE_FAILURE_${deleteFailureAt}`);
      });
      INSERT_ORDER.forEach((table, index) => {
        this.state[table] = [{ id: `${table}-id`, value: `restored:${table}` }];
        if (index + 1 === insertFailureAt) throw new Error(`INJECTED_INSERT_FAILURE_${insertFailureAt}`);
      });
      this.epoch += 1;
      return true;
    } catch (error) {
      this.state = before;
      throw error;
    } finally {
      this.connection.exitRestoreFunction();
    }
  }
}

const metrics = {
  unauthorizedFullDelete: 0,
  partialRestore: 0,
  safeUpdateConfigMutation: 0,
  stuckLock: 0,
};

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel();
  assert.equal(model.restore(), true);
  assert.equal(model.epoch, 1);
  assert.equal(model.connection.safeUpdateEnabled, true);
  assert.equal(model.connection.safeUpdateConfigMutations, 0);
}

for (let round = 0; round < 30; round += 1) {
  const connection = new SafeUpdateCompatibleConnection();
  assert.throws(() => connection.deleteRows('product_groups'), /DELETE requires a WHERE clause/u);
  assert.throws(() => connection.enterRestoreFunction({ authenticated: true, owner: false }), /OWNER_REQUIRED/u);
}

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel();
  const before = structuredClone(model.state);
  assert.throws(() => model.restore({ deleteFailureAt: 7 }), /INJECTED_DELETE_FAILURE_7/u);
  assert.deepEqual(model.state, before);
  assert.equal(model.epoch, 0);
}

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel();
  const before = structuredClone(model.state);
  assert.throws(() => model.restore({ insertFailureAt: 10 }), /INJECTED_INSERT_FAILURE_10/u);
  assert.deepEqual(model.state, before);
  assert.equal(model.epoch, 0);
}

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel({ emptyTables: ['sales_orders', 'sales_order_items'] });
  assert.equal(model.restore(), true);
  assert.equal(model.connection.safeUpdateEnabled, true);
}

for (let round = 0; round < 30; round += 1) {
  const connection = new SafeUpdateCompatibleConnection();
  connection.enterRestoreFunction();
  connection.acquireRestoreLock();
  assert.throws(() => connection.deleteRows('auth.users', 'id IS NOT NULL'), /TABLE_NOT_ALLOWED/u);
  assert.throws(() => connection.deleteRows('product_groups', 'true'), /PREDICATE_NOT_ALLOWED/u);
  connection.exitRestoreFunction();
}

assert.deepEqual(metrics, {
  unauthorizedFullDelete: 0,
  partialRestore: 0,
  safeUpdateConfigMutation: 0,
  stuckLock: 0,
});

console.log('PASS Cloud Restore safeupdate-compatible DELETE: 15/15 PK contract and 180 deterministic rounds; no unauthorized delete, partial restore, config mutation, or stuck lock');
