import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const vite = await createServer({ root, configFile: false, optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const cas = await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  const { CLOUD_FIELD_ENTITY_CONTRACTS: contracts, sanitizeCloudBusinessPatch: sanitize,
    buildCloudPatchOperation: build, buildCloudCollectionMutationPlan: plan,
    assertCloudMutationOperations: validate, classifyMutationField: classify } = cas;
  const id = '10000000-0000-4000-8000-000000000001';
  let requestCount = 0;
  // Reproduce by executing the real old UI handler, then the actual strict CAS
  // builder. Capture only synthetic price/keys, never any live rows or secrets.
  const oldSource = execFileSync('git', ['show', 'a2d092c5eae9c2c4d45fc42fb237ef8a882b77fc:src/pages/PurchaseManagement.tsx'], { cwd: root, encoding: 'utf8' });
  const tree = ts.createSourceFile('page.tsx', oldSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleUpdateDefaultJpyCost') handler = node.initializer.getText(tree); ts.forEachChild(node, visit); };
  visit(tree);
  const javascript = ts.transpileModule(`const handler = ${handler};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let captured;
  const runOld = new Function('canEditData', 'variantDefaultJpyCosts', 'setVariantDefaultJpyCosts', 'localStorage', 'dataProvider', 'setVariants', 'variants', `${javascript}\nreturn handler;`);
  const old = runOld(true, {}, () => {}, { setItem() {} }, { async updateProductVariantPatch(_id, patch) {
    captured = patch;
    const operation = build('product_variants', { id, version: 7, default_jpy_cost: 100 }, patch);
    if (operation) requestCount++;
  } }, () => {}, []);
  await assert.rejects(old(id, '4500'), /CLOUD_MUTATION_FIELD_NOT_ALLOWED:updated_at/u);
  assert.equal(captured.default_jpy_cost, 4500);
  assert.equal(typeof captured.updated_at, 'string');
  assert.equal(requestCount, 0, 'Failure is pre-dispatch, not a partially committed server operation');

  const sql = readFileSync(`${root}/supabase/sql/020_cloud_field_cas.sql`, 'utf8');
  const parentRepair = readFileSync(`${root}/supabase/sql/046_waca_myacg_parent_evidence.sql`, 'utf8');
  let fields = 0;
  for (const [entity, contract] of Object.entries(contracts)) {
    const branch = sql.split(`WHEN '${entity}' THEN`)[1]?.split(/\n\s+WHEN |\n\s+ELSE/u)[0];
    const array = branch?.match(/v_create_allowed := ARRAY\[([^\]]*)\]/u)?.[1];
    assert.ok(array, `${entity} SQL field contract missing`);
    const server = [...array.matchAll(/'([^']+)'/gu)].map(match => match[1]);
    if (entity === 'inventory_items') {
      assert.match(parentRepair, /myacg_parent_code/u);
      server.splice(server.indexOf('myacg_item_code') + 1, 0, 'myacg_parent_code');
    }
    assert.deepEqual(contract.create, server, `${entity} client/server allowlist drift`);
    assert.deepEqual(contract.patch, entity === 'bundle_components' ? [] : server.filter(field => field !== 'local_id'));
    for (const field of contract.patch) {
      const operation = build(entity, { id, version: 7, [field]: 'before' }, { [field]: 'after' });
      validate(entity, [operation]);
      assert.deepEqual(operation.changes, { [field]: 'after' });
      assert.deepEqual(operation.expected, { [field]: 'before' });
      assert.equal(operation.observedVersion, 7);
      fields++;
    }
    for (const field of ['created_at', 'updated_at', 'updated_by', 'sync_status']) {
      assert.deepEqual(sanitize(entity, { [field]: 'read-context' }), {});
      if (contract.patch.length) assert.throws(() => validate(entity, [{ ...build(entity, { id, version: 7 }, { [contract.patch[0]]: 1 }),
        changes: { [field]: 'new' }, expected: { [field]: 'old' } }]), /FIELD_NOT_ALLOWED/u);
    }
    for (const field of ['id', 'database_id', 'local_id', 'version', 'deleted_at', 'created_by', 'unknown_field']) {
      assert.throws(() => sanitize(entity, { [field]: 1 }), /FIELD_NOT_ALLOWED/u);
    }
    const normalized = { id, version: 7, created_at: 'old', updated_at: 'old', ...Object.fromEntries(contract.create.map(field => [field, 'before'])) };
    if (contract.patch.length) {
      const operation = plan(entity, [normalized], [{ ...normalized, [contract.patch[0]]: 'after', updated_at: 'client' }], { deleteMissing: false })[0];
      validate(entity, [operation]);
      assert.deepEqual(operation.changes, { [contract.patch[0]]: 'after' });
    }
  }
  assert.deepEqual(sanitize('product_variants', { default_jpy_cost: 4500, created_at: 'read', updated_at: 'read' }), { default_jpy_cost: 4500 });
  assert.equal(classify('product_variants', 'waca_auto_quantity'), 'DERIVED');
  assert.equal(classify('product_variants', 'version'), 'CAS_ONLY');
  assert.equal(classify('product_variants', 'id'), 'IDENTITY_IMMUTABLE');
  assert.equal(classify('product_variants', 'created_at'), 'SERVER_GENERATED');
  assert.equal(classify('product_variants', 'updated_at'), 'SYSTEM_MANAGED');
  assert.equal(classify('product_variants', 'default_jpy_cost'), 'USER_MUTABLE');
  assert.equal(classify('product_variants', 'unknown_field'), 'UNKNOWN');
  assert.throws(() => sanitize('product_variants', { waca_auto_quantity: 19 }), /FIELD_NOT_ALLOWED/u);
  const minimal = build('product_variants', { id, version: 7, default_jpy_cost: 100 }, sanitize('product_variants', { default_jpy_cost: 4500 }));
  assert.throws(() => validate('product_variants', [{ ...minimal, expected: { default_twd_cost: 100 } }]), /CAS_FIELD_MISMATCH/u);
  assert.throws(() => validate('product_variants', [minimal, minimal]), /DUPLICATE_OPERATION_ID/u);
  const provider = readFileSync(`${root}/src/providers/cloud/supabaseProvider.ts`, 'utf8');
  const inventory = JSON.parse(readFileSync(`${root}/tests/fixtures/cloud-mutation-inventory.json`, 'utf8'));
  const providerTree = ts.createSourceFile('provider.ts', provider, ts.ScriptTarget.Latest, true);
  const providerClass = providerTree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SupabaseProvider');
  const writers = providerClass.members.filter(ts.isMethodDeclaration).filter(node =>
    !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword)
    && /^(?:save|update|delete|upsert|clear|create|reparse|sync|commit|restore|prepare|prove|apply)/u.test(node.name.getText(providerTree)))
    .map(node => node.name.getText(providerTree)).sort();
  const audited = inventory.groups.flatMap(group => group.methods).sort();
  assert.deepEqual(audited, writers, 'New Cloud write entry requires explicit field-contract audit');
  assert.match(provider, /assertCloudMutationOperations\(entity, operations\)/u);
  assert.match(provider, /sanitizeCloudBusinessPatch\('product_variants', patch\)/u);
  assert.match(provider, /sanitizeCloudBusinessPatch\('product_variants', item.patch\)/u);
  const page = readFileSync(`${root}/src/pages/PurchaseManagement.tsx`, 'utf8');
  assert.doesNotMatch(page, /updated_at\s*[:=]/u);
  assert.match(cas.cloudMutationFailureMessage(new cas.CloudMutationBoundaryError('committed-readback-pending', new Error('synthetic'))), /已儲存至雲端/u);
  assert.match(cas.cloudMutationFailureMessage(new cas.CloudMutationBoundaryError('result-unknown', new Error('synthetic'))), /尚未確認/u);
  console.log(`PASS reproduced actual old price handler: price=4500, updated_at injected by UI, RPC dispatch=0`);
  console.log(`PASS ${Object.keys(contracts).length} entity allowlists match executed SQL source; ${fields} fields; strict transport and partial-edit filtering`);
  console.log('PASS ID/unknown/version rejection; independent CAS context; minimal price patch; server allowlist unchanged');
  console.log(`PASS ${writers.length} public Cloud write boundaries inventoried; committed/unknown outcome is never described as unchanged`);
} finally { await vite.close(); }
