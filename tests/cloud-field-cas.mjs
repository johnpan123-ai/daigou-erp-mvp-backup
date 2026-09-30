import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SQL_PATH = fileURLToPath(new URL('../supabase/sql/020_cloud_field_cas.sql', import.meta.url));
const PROVIDER_PATH = fileURLToPath(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url));
const uuid = suffix => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const clone = value => structuredClone(value);

const vite = await createServer({ root: ROOT, configFile: false, cacheDir: `${ROOT}/.vite-cache/cloud-field-cas-test`,
  mode: 'experimental',
  // SSR-only unit harness has no browser entries. Do not start a background
  // HTML dependency scan that races teardown after every assertion passed.
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true }, appType: 'custom' });
try {
  const cas = await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  const {
    CLOUD_FIELD_ENTITY_CONTRACTS,
    buildCloudCollectionMutationPlan,
    buildCloudPatchOperation,
    buildCloudReorderOperations,
    cloudFieldValuesEqual,
  } = cas;

  class DeterministicServer {
    constructor(entity, rows) {
      this.entity = entity;
      this.rows = new Map(rows.map(row => [row.id, clone(row)]));
    }

    result(id) { return clone(this.rows.get(id)); }

    apply(operations) {
      const staged = new Map([...this.rows].map(([id, row]) => [id, clone(row)]));
      for (const operation of operations) {
        const current = staged.get(operation.id);
        if (operation.kind === 'create') {
          if (current) return { ok: false, code: 'DUPLICATE_CREATE', entity: this.entity, recordId: operation.id };
          continue;
        }
        if (!current || current.deleted_at) {
          return { ok: false, code: 'RECORD_DELETED_OR_MISSING', entity: this.entity, recordId: operation.id };
        }
        if (operation.kind === 'delete') {
          if (current.version !== operation.expectedVersion) {
            return { ok: false, code: 'STALE_DELETE', entity: this.entity, recordId: operation.id };
          }
          continue;
        }
        if (operation.kind === 'reorder' && current.version !== operation.expectedVersion) {
          return { ok: false, code: 'REORDER_CONFLICT', entity: this.entity, recordId: operation.id };
        }
        const conflicts = Object.keys(operation.changes).filter(
          field => !cloudFieldValuesEqual(current[field], operation.expected[field]),
        ).map(field => ({ field, expected: operation.expected[field], current: current[field] }));
        if (conflicts.length) {
          return {
            ok: false,
            code: operation.kind === 'reorder' ? 'REORDER_CONFLICT' : 'FIELD_CONFLICT',
            entity: this.entity,
            recordId: operation.id,
            conflicts,
          };
        }
      }

      for (const operation of operations) {
        const current = staged.get(operation.id);
        if (operation.kind === 'create') {
          staged.set(operation.id, { id: operation.id, ...clone(operation.values), version: 1 });
        } else if (operation.kind === 'delete') {
          staged.set(operation.id, { ...current, deleted_at: 'fixture-deleted', version: current.version + 1 });
        } else {
          staged.set(operation.id, { ...current, ...clone(operation.changes), version: current.version + 1 });
        }
      }
      this.rows = staged;
      return { ok: true, entity: this.entity, rows: operations.map(operation => this.result(operation.id)) };
    }
  }

  const base = { id: uuid(1), local_id: 'local-metadata', note: 'A', quantity: 5, version: 10 };

  // Case 1: different touched fields from the same base merge despite row version advancing.
  {
    const server = new DeterministicServer('purchase_batch_items', [base]);
    const note = buildCloudPatchOperation('purchase_batch_items', base, { note: 'B' });
    const quantity = buildCloudPatchOperation('purchase_batch_items', base, { quantity: 7 });
    assert.deepEqual(Object.keys(note.changes), ['note']);
    assert.deepEqual(Object.keys(quantity.changes), ['quantity']);
    assert.equal(server.apply([note]).ok, true);
    assert.equal(server.apply([quantity]).ok, true);
    assert.deepEqual(server.result(base.id), { ...base, note: 'B', quantity: 7, version: 12 });
  }

  // Case 2: same field conflicts with structured expected/current evidence.
  {
    const server = new DeterministicServer('purchase_batch_items', [base]);
    const first = buildCloudPatchOperation('purchase_batch_items', base, { quantity: 7 });
    const second = buildCloudPatchOperation('purchase_batch_items', base, { quantity: 8 });
    assert.equal(server.apply([first]).ok, true);
    const conflict = server.apply([second]);
    assert.deepEqual(conflict, {
      ok: false,
      code: 'FIELD_CONFLICT',
      entity: 'purchase_batch_items',
      recordId: base.id,
      conflicts: [{ field: 'quantity', expected: 5, current: 7 }],
    });
    assert.equal(server.result(base.id).quantity, 7);
  }

  // Cases 3/4: three independent clients merge; a fourth colliding field is rejected.
  {
    const threeFieldBase = { ...base, cost: 100, note: 'A' };
    const server = new DeterministicServer('purchase_batch_items', [threeFieldBase]);
    for (const operation of [
      buildCloudPatchOperation('purchase_batch_items', threeFieldBase, { note: 'home' }),
      buildCloudPatchOperation('purchase_batch_items', threeFieldBase, { quantity: 9 }),
      buildCloudPatchOperation('purchase_batch_items', threeFieldBase, { cost: 120 }),
    ]) assert.equal(server.apply([operation]).ok, true);
    assert.deepEqual(server.result(base.id), { ...threeFieldBase, note: 'home', quantity: 9, cost: 120, version: 13 });
    const collision = server.apply([buildCloudPatchOperation('purchase_batch_items', threeFieldBase, { note: 'office' })]);
    assert.equal(collision.code, 'FIELD_CONFLICT');
    assert.equal(server.result(base.id).quantity, 9, 'Unrelated merged field was lost after a conflict');
  }

  // Cases 5/6: delete-vs-edit cannot resurrect; stale destructive delete is rejected.
  {
    const server = new DeterministicServer('purchase_batch_items', [base]);
    assert.equal(server.apply([{ kind: 'delete', id: base.id, expectedVersion: 10 }]).ok, true);
    assert.equal(server.apply([buildCloudPatchOperation('purchase_batch_items', base, { note: 'draft' })]).code, 'RECORD_DELETED_OR_MISSING');
    assert.equal(server.result(base.id).deleted_at, 'fixture-deleted');
  }
  {
    const server = new DeterministicServer('purchase_batch_items', [base]);
    assert.equal(server.apply([buildCloudPatchOperation('purchase_batch_items', base, { note: 'new' })]).ok, true);
    assert.equal(server.apply([{ kind: 'delete', id: base.id, expectedVersion: 10 }]).code, 'STALE_DELETE');
    assert.equal(server.result(base.id).deleted_at, undefined);
  }

  // Case 7: reorder is a collection transaction; one stale row prevents every write.
  {
    const rows = [
      { id: uuid(2), local_id: 'a', product_group_id: uuid(20), title: 'A', sort_order: 1, version: 3 },
      { id: uuid(3), local_id: 'b', product_group_id: uuid(20), title: 'B', sort_order: 2, version: 3 },
    ];
    const operations = buildCloudReorderOperations('product_categories', rows, {
      [uuid(2)]: { sort_order: 2 },
      [uuid(3)]: { sort_order: 1 },
    });
    const server = new DeterministicServer('product_categories', [{ ...rows[0], version: 4 }, rows[1]]);
    assert.equal(server.apply(operations).code, 'REORDER_CONFLICT');
    assert.equal(server.result(uuid(2)).sort_order, 1);
    assert.equal(server.result(uuid(3)).sort_order, 2);
  }

  // Case 8: a canonical readback/base permits the user's second save.
  {
    const server = new DeterministicServer('purchase_batch_items', [base]);
    assert.equal(server.apply([buildCloudPatchOperation('purchase_batch_items', base, { quantity: 20 })]).ok, true);
    const canonical20 = server.result(base.id);
    assert.equal(server.apply([buildCloudPatchOperation('purchase_batch_items', canonical20, { quantity: 21 })]).ok, true);
    assert.equal(server.result(base.id).quantity, 21);
  }

  // Create is insert-only, and normalized immutable local_id never enters an update patch.
  {
    const server = new DeterministicServer('purchase_batch_items', [base]);
    const duplicate = { kind: 'create', id: base.id, values: { quantity: 99 } };
    assert.equal(server.apply([duplicate]).code, 'DUPLICATE_CREATE');
    assert.equal(server.result(base.id).quantity, 5);
    const plan = buildCloudCollectionMutationPlan(
      'purchase_batch_items',
      [base],
      [{ ...base, local_id: 'must-remain-metadata', note: 'only-this-field' }],
      { deleteMissing: false },
    );
    assert.deepEqual(plan[0].changes, { note: 'only-this-field' });
    assert.deepEqual(plan[0].expected, { note: 'A' });
    assert.throws(
      () => buildCloudPatchOperation('purchase_batch_items', base, { local_id: 'forbidden' }),
      /CLOUD_MUTATION_FIELD_NOT_ALLOWED:local_id/u,
    );
    assert.throws(
      () => buildCloudPatchOperation('purchase_batch_items', base, { version: 99 }),
      /CLOUD_MUTATION_FIELD_NOT_ALLOWED:version/u,
    );
  }

  // A ProductVariant read model may carry server metadata, but an agency-order
  // quantity write sends only the business field. Version remains CAS context;
  // updated_at remains server-owned and is still rejected if supplied as a new value.
  {
    const variantBase = {
      id: uuid(90), product_group_id: uuid(91), product_category_id: uuid(92),
      purchased_manual_adjustment: 2, version: 7,
      updated_at: '2026-09-23T00:00:00.000Z', updated_by: uuid(93),
    };
    const operation = buildCloudPatchOperation(
      'product_variants',
      variantBase,
      { purchased_manual_adjustment: 8 },
    );
    assert.deepEqual(operation.changes, { purchased_manual_adjustment: 8 });
    assert.deepEqual(operation.expected, { purchased_manual_adjustment: 2 });
    assert.equal(operation.observedVersion, 7);
    assert.throws(
      () => buildCloudPatchOperation('product_variants', variantBase, {
        purchased_manual_adjustment: 8,
        updated_at: 'client-owned-value',
      }),
      /CLOUD_MUTATION_FIELD_NOT_ALLOWED:updated_at/u,
    );
  }

  const sql = await readFile(SQL_PATH, 'utf8');
  const provider = await readFile(PROVIDER_PATH, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.erp_apply_field_mutations/u);
  assert.match(sql, /CASE p_entity[\s\S]+WHEN 'bundle_components'/u, 'Missing server entity whitelist');
  assert.match(sql, /pg_advisory_xact_lock/u);
  assert.match(sql, /FOR UPDATE/u);
  assert.match(sql, /IS NOT DISTINCT FROM/u);
  assert.match(sql, /-- Phase 1:[\s\S]+-- Phase 2:/u, 'Mutation SQL must validate every operation before DML');
  assert.ok(sql.indexOf('-- Phase 2:') < sql.indexOf("EXECUTE format('INSERT INTO"), 'Insert occurs before validation phase completes');
  assert.match(sql, /'DUPLICATE_CREATE'/u);
  assert.match(sql, /'STALE_DELETE'/u);
  assert.match(sql, /'RECORD_DELETED_OR_MISSING'/u);
  assert.match(sql, /version = target\.version \+ 1/u, 'Patch/delete must advance version without relying on a table trigger');
  assert.match(sql, /updated_by = auth\.uid\(\)/u, 'Server must own audit attribution');
  assert.match(sql, /v_protected constant text\[\][\s\S]+'id'[\s\S]+'version'[\s\S]+'deleted_at'/u);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.erp_delete_product_group_trees/u);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.erp_apply_field_mutations\(text, jsonb\) FROM PUBLIC/u);
  assert.doesNotMatch(sql, /ON CONFLICT|\bUPSERT\b/iu, 'Create must remain insert-only');
  assert.doesNotMatch(sql, /018|019/u, 'P0-3 artifact must not include excluded migrations');

  const entities = Object.keys(CLOUD_FIELD_ENTITY_CONTRACTS);
  assert.equal(entities.length, 15);
  for (const entity of entities) {
    assert.match(sql, new RegExp(`WHEN '${entity}'`), `${entity} missing from SQL whitelist`);
    assert.match(provider, new RegExp(`applyCloud(?:Collection|FieldMutations)\\('${entity}'`), `${entity} missing from provider CAS path`);
    const directDml = new RegExp(`\\.from\\('${entity}'\\)\\s*\\.\\s*(?:upsert|update|delete)\\s*\\(`, 'u');
    const activeProvider = provider.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
    assert.doesNotMatch(activeProvider, directDml, `${entity} retains an active direct whole-row DML path`);
  }

  console.log('PASS different-field merge, same-field structured conflict, and three-client merge');
  console.log('PASS delete-vs-edit, stale delete, atomic reorder conflict, and second save');
  console.log('PASS insert-only create and protected/system/canonical field boundary');
  console.log('PASS 15-entity server whitelist and provider field-CAS coverage');
  console.log('PASS SQL contract uses atomic lock/preflight/field comparison before DML');
} finally {
  await vite.close();
}
