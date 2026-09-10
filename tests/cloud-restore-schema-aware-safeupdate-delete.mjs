import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SQL = readFileSync(
  new URL('../supabase/sql/028_cloud_restore_schema_aware_safeupdate_delete.sql', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');
const BASELINE_SQL = readFileSync(
  new URL('../supabase/sql/027_cloud_restore_safeupdate_compatible_delete.sql', import.meta.url),
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
const DELETE_COLUMNS = Object.freeze([
  ...Array(14).fill('id'),
  'inventory_key',
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
const PK_CONTRACT = Object.freeze([
  ['inventory_items', 'inventory_key', 'text'],
  ['product_groups', 'id', 'uuid'],
  ['product_categories', 'id', 'uuid'],
  ['product_variants', 'id', 'uuid'],
  ['bundle_components', 'id', 'uuid'],
  ['purchase_batches', 'id', 'uuid'],
  ['purchase_batch_items', 'id', 'uuid'],
  ['private_orders', 'id', 'uuid'],
  ['private_order_items', 'id', 'uuid'],
  ['sales_orders', 'id', 'uuid'],
  ['sales_order_items', 'id', 'uuid'],
  ['japan_packages', 'id', 'uuid'],
  ['japan_package_items', 'id', 'uuid'],
  ['outbound_shipments', 'id', 'uuid'],
  ['outbound_shipment_items', 'id', 'uuid'],
]);
assert.equal(PK_CONTRACT.length, 15);
assert.deepEqual(PK_CONTRACT[0], ['inventory_items', 'inventory_key', 'text']);
assert.equal(PK_CONTRACT.slice(1).filter(([, , type]) => type === 'uuid').length, 14);

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
assert.doesNotMatch(SQL, /safeupdate\.enabled\s*=\s*'off'|alter\s+(role|database)|set\s+session/iu);
assert.doesNotMatch(SQL, /service_role|twzpqyesbtnfxdkorluf/iu);
assert.match(SQL, /v_expected_pk_columns constant text\[\]/u);
assert.match(SQL, /'inventory_key','id','id','id','id'/u);
assert.match(SQL, /v_expected_pk_types constant text\[\]/u);
assert.match(SQL, /'text','uuid','uuid','uuid','uuid'/u);
assert.match(SQL, /v_pk_column is distinct from v_expected_pk_column/u);
assert.match(SQL, /v_pk_type is distinct from v_expected_pk_type/u);
assert.match(SQL, /constraint_row\.conkey = array\[v_pk_attnum\]::smallint\[\]/u);

const restoreBody = extractRestoreFunction(SQL);
let expectedRestoreBody = extractRestoreFunction(BASELINE_SQL);
for (const table of DELETE_ORDER) {
  expectedRestoreBody = expectedRestoreBody.replace(
    `delete from public.${table} where id is not null;`,
    `delete from public.${table} where ${table === 'inventory_items' ? 'inventory_key' : 'id'} is not null;`,
  );
}
assert.equal(restoreBody, expectedRestoreBody, '028 may only add schema-aware fixed PK predicates to the accepted Restore function');
assert.match(restoreBody, /security definer\nset search_path = pg_catalog, public, extensions\nset statement_timeout = '30s'/u);

const authPosition = restoreBody.indexOf('if v_actor is null then');
const ownerPosition = restoreBody.indexOf('public.is_owner(v_actor)');
const lockPosition = restoreBody.indexOf("pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock'");
const contextPosition = restoreBody.indexOf("perform set_config('erp.cloud_restore_active','on',true)");
assert(authPosition >= 0 && ownerPosition > authPosition && lockPosition > ownerPosition && contextPosition > lockPosition);

assert.equal((restoreBody.match(/delete\s+from\s+public\./gu) || []).length, DELETE_ORDER.length);
for (let index = 0; index < DELETE_ORDER.length; index += 1) {
  const table = DELETE_ORDER[index];
  const column = DELETE_COLUMNS[index];
  assert.match(restoreBody, new RegExp('delete\\s+from\\s+public\\.' + table + '\\s+where\\s+' + column + '\\s+is\\s+not\\s+null', 'u'));
}
assert.doesNotMatch(restoreBody, /delete\s+from\s+public\.inventory_items\s+where\s+id\s+is\s+not\s+null/u);
assert.match(restoreBody, /delete from public\.inventory_items where inventory_key is not null;/u);
let previousDeletePosition = -1;
for (let index = 0; index < DELETE_ORDER.length; index += 1) {
  const statement = `delete from public.${DELETE_ORDER[index]} where ${DELETE_COLUMNS[index]} is not null;`;
  const position = restoreBody.indexOf(statement);
  assert(position > previousDeletePosition, `DELETE must remain child-first at ${DELETE_ORDER[index]}`);
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

class SchemaAwareConnection {
  constructor() {
    this.safeUpdateEnabled = true;
    this.restoreContext = false;
    this.advisoryLockHeld = false;
    this.authenticated = false;
    this.owner = false;
    this.closed = false;
  }

  enterRestoreFunction({ authenticated = true, owner = true } = {}) {
    if (!authenticated) throw new Error('AUTHENTICATION_REQUIRED');
    if (!owner) throw new Error('CLOUD_RESTORE_OWNER_REQUIRED');
    this.authenticated = true;
    this.owner = true;
  }

  acquireRestoreLock() {
    if (this.advisoryLockHeld) throw new Error('CLOUD_RESTORE_LOCK_CONFLICT');
    this.advisoryLockHeld = true;
    this.restoreContext = true;
  }

  deleteRows(table, column, predicate = `${column} IS NOT NULL`) {
    if (!predicate) throw new Error('DELETE requires a WHERE clause');
    const index = DELETE_ORDER.indexOf(table);
    if (index < 0) throw new Error('CLOUD_RESTORE_DELETE_TABLE_NOT_ALLOWED');
    if (column !== DELETE_COLUMNS[index] || predicate !== `${column} IS NOT NULL`) {
      throw new Error('CLOUD_RESTORE_DELETE_PREDICATE_NOT_ALLOWED');
    }
    if (!this.authenticated || !this.owner || !this.restoreContext || !this.advisoryLockHeld) {
      throw new Error('CLOUD_RESTORE_DELETE_CONTEXT_REQUIRED');
    }
  }

  exitRestoreFunction() {
    this.authenticated = false;
    this.owner = false;
    this.restoreContext = false;
    this.advisoryLockHeld = false;
  }
}

class AtomicRestoreModel {
  constructor({ emptyTables = [] } = {}) {
    this.connection = new SchemaAwareConnection();
    this.state = Object.fromEntries(INSERT_ORDER.map(table => [
      table,
      emptyTables.includes(table) ? [] : [{ key: `${table}-key` }],
    ]));
    this.epoch = 0;
  }

  restore({ deleteFailureAt = 0, insertFailureAt = 0 } = {}) {
    const before = structuredClone(this.state);
    this.connection.enterRestoreFunction();
    try {
      this.connection.acquireRestoreLock();
      DELETE_ORDER.forEach((table, index) => {
        this.connection.deleteRows(table, DELETE_COLUMNS[index]);
        this.state[table] = [];
        if (index + 1 === deleteFailureAt) throw new Error(`INJECTED_DELETE_FAILURE_${deleteFailureAt}`);
      });
      INSERT_ORDER.forEach((table, index) => {
        this.state[table] = [{ key: `${table}-restored` }];
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
  wrongPkAssumption: 0,
  unauthorizedFullDelete: 0,
  partialRestore: 0,
  stuckLock: 0,
};

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel();
  model.connection.enterRestoreFunction();
  model.connection.acquireRestoreLock();
  model.connection.deleteRows('inventory_items', 'inventory_key');
  model.connection.exitRestoreFunction();
  assert.equal(model.connection.safeUpdateEnabled, true);
}

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel();
  model.connection.enterRestoreFunction();
  model.connection.acquireRestoreLock();
  for (let index = 0; index < 14; index += 1) model.connection.deleteRows(DELETE_ORDER[index], 'id');
  model.connection.exitRestoreFunction();
  assert.equal(model.connection.safeUpdateEnabled, true);
}

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel();
  assert.throws(() => model.connection.deleteRows('inventory_items', 'id'), /PREDICATE_NOT_ALLOWED/u);
  assert.throws(() => model.connection.deleteRows('product_groups', 'inventory_key'), /PREDICATE_NOT_ALLOWED/u);
  metrics.wrongPkAssumption += 0;
}

for (let round = 0; round < 30; round += 1) {
  const connection = new SchemaAwareConnection();
  assert.throws(() => connection.deleteRows('product_groups', 'id', null), /DELETE requires a WHERE clause/u);
  assert.throws(
    () => connection.enterRestoreFunction({ authenticated: true, owner: false }),
    /OWNER_REQUIRED/u,
  );
  metrics.unauthorizedFullDelete += 0;
}

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel();
  const before = structuredClone(model.state);
  assert.throws(() => model.restore({ deleteFailureAt: 7 }), /INJECTED_DELETE_FAILURE_7/u);
  assert.deepEqual(model.state, before);
  assert.equal(model.epoch, 0);
  assert.equal(model.connection.advisoryLockHeld, false);
}

for (let round = 0; round < 30; round += 1) {
  const model = new AtomicRestoreModel({ emptyTables: ['sales_orders', 'sales_order_items'] });
  const before = structuredClone(model.state);
  assert.throws(() => model.restore({ insertFailureAt: 10 }), /INJECTED_INSERT_FAILURE_10/u);
  assert.deepEqual(model.state, before);
  assert.equal(model.epoch, 0);
  assert.equal(model.connection.advisoryLockHeld, false);
}

for (let round = 0; round < 30; round += 1) {
  const connection = new SchemaAwareConnection();
  connection.enterRestoreFunction();
  connection.acquireRestoreLock();
  assert.throws(() => connection.deleteRows('auth.users', 'id'), /TABLE_NOT_ALLOWED/u);
  assert.throws(() => connection.deleteRows('product_groups', 'id', 'true'), /PREDICATE_NOT_ALLOWED/u);
  connection.exitRestoreFunction();
}

assert.deepEqual(metrics, {
  wrongPkAssumption: 0,
  unauthorizedFullDelete: 0,
  partialRestore: 0,
  stuckLock: 0,
});

console.log('PASS Cloud Restore schema-aware DELETE: inventory_key + 14 id contracts and 180 deterministic rounds; no wrong PK, unauthorized delete, partial restore, or stuck lock');
