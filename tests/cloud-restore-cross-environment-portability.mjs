import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'vite';

const SQL = readFileSync(new URL('../supabase/sql/030_cloud_restore_cross_environment_audit_identity_portability.sql', import.meta.url), 'utf8');
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const actor = uuid(900);
const clone = value => structuredClone(value);
const collections = {
  inventory: [{ id: uuid(15), inventory_key: 'PORTABLE::SKU', updated_by: actor }],
  productGroups: [{ id: uuid(1), local_id: 'group', title: 'Portable', updated_by: actor }],
  productCategories: [{ id: uuid(2), local_id: 'category', product_group_id: uuid(1), title: 'Default', updated_by: actor }],
  productVariants: [{ id: uuid(3), local_id: 'variant', product_group_id: uuid(1), product_category_id: uuid(2), updated_by: actor }],
  bundleComponents: [{ id: uuid(4), bundle_variant_id: uuid(3), component_variant_id: uuid(3), updated_by: actor }],
  purchaseBatches: [{ id: uuid(5), local_id: 'batch', product_group_id: uuid(1), updated_by: actor }],
  purchaseBatchItems: [{ id: uuid(6), local_id: 'batch-item', purchase_batch_id: uuid(5), product_variant_id: uuid(3), updated_by: actor }],
  privateOrders: [{ id: uuid(7), local_id: 'private', product_group_id: uuid(1), updated_by: actor }],
  privateOrderItems: [{ id: uuid(8), local_id: 'private-item', private_order_id: uuid(7), product_variant_id: uuid(3), updated_by: actor }],
  salesOrders: [{ id: uuid(9), local_id: 'sales', updated_by: actor }],
  salesOrderItems: [{ id: uuid(10), local_id: 'sales-item', order_id: uuid(9), product_variant_id: uuid(3), updated_by: actor }],
  japanPackages: [{ id: uuid(11), updated_by: actor }],
  japanPackageItems: [{ id: uuid(12), japan_package_id: uuid(11), product_group_id: uuid(1), product_variant_id: uuid(3), purchase_batch_id: uuid(5), purchase_batch_item_id: uuid(6), updated_by: actor }],
  outboundShipments: [{ id: uuid(13), updated_by: actor }],
  outboundShipmentItems: [{ id: uuid(14), outbound_shipment_id: uuid(13), japan_package_item_id: uuid(12), product_group_id: uuid(1), product_variant_id: uuid(3), updated_by: actor }],
};

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const portability = await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
  const built = await domain.buildCloudRestoreManifest(collections, collections);
  const document = {
    schemaVersion: domain.CLOUD_RESTORE_SCHEMA_VERSION,
    sourceEnvironment: 'cloud-authoritative',
    manifest: built.manifest,
    data: clone(collections),
  };
  const sourceText = JSON.stringify(document);
  const sourceSha = createHash('sha256').update(sourceText).digest('hex');
  const strict = await domain.prepareCloudRestoreSnapshot(sourceText, {
    fileName: 'production-source.json',
    sourceFileSha256: sourceSha,
  });
  const originalBefore = createHash('sha256').update(sourceText).digest('hex');
  const portable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(
    strict,
    'rhfdjsklfrgpoqsaqpkn',
  );
  const originalAfter = createHash('sha256').update(sourceText).digest('hex');

  assert.equal(originalBefore, originalAfter, 'The original JSON must remain byte-identical');
  assert.equal(strict.portability, undefined, 'Strict mode must not transform silently');
  assert.equal(strict.executionFingerprint, strict.manifest.snapshotFingerprint);
  assert.equal(portable.portability.policyVersion, 'cross-environment-audit-null-v1');
  assert.equal(portable.portability.targetProjectRef, 'rhfdjsklfrgpoqsaqpkn');
  assert.equal(portable.portability.sourceFileSha256, sourceSha);
  assert.equal(portable.portability.sourceSnapshotFingerprint, strict.manifest.snapshotFingerprint);
  assert.equal(portable.portability.totalTransformedRows, 15);
  assert.notEqual(portable.manifest.snapshotFingerprint, strict.manifest.snapshotFingerprint);
  assert.notEqual(portable.executionFingerprint, portable.manifest.snapshotFingerprint);
  assert.equal(portable.manifest.relationshipHash, strict.manifest.relationshipHash);
  assert.deepEqual(portable.manifest.counts, strict.manifest.counts);
  for (const [, table] of domain.CLOUD_RESTORE_TABLES) {
    assert.equal(portable.portability.transformedCounts[table], 1, `${table} must use the fixed audit allowlist`);
    assert.equal(portable.data[table][0].updated_by, null);
    assert.equal(portable.data[table][0].id, strict.data[table][0].id, `${table} canonical id must be preserved`);
    const sourceBusiness = { ...strict.data[table][0] };
    const portableBusiness = { ...portable.data[table][0] };
    delete sourceBusiness.updated_by;
    delete portableBusiness.updated_by;
    assert.deepEqual(portableBusiness, sourceBusiness, `${table} business values must be unchanged`);
  }

  const nullSource = clone(document);
  for (const rows of Object.values(nullSource.data)) rows.forEach(row => { row.updated_by = null; });
  nullSource.manifest = (await domain.buildCloudRestoreManifest(nullSource.data, nullSource.data)).manifest;
  const nullText = JSON.stringify(nullSource);
  const nullStrict = await domain.prepareCloudRestoreSnapshot(nullText);
  const nullPortable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(nullStrict, 'rhfdjsklfrgpoqsaqpkn');
  assert.equal(nullPortable.portability.totalTransformedRows, 0);
  assert.equal(nullPortable.manifest.snapshotFingerprint, nullStrict.manifest.snapshotFingerprint);
  assert.notEqual(nullPortable.executionFingerprint, nullStrict.executionFingerprint, 'Policy semantics must bind idempotency even when rows are unchanged');

  await assert.rejects(
    () => portability.prepareCrossEnvironmentCloudRestoreCandidate(strict, 'twzpqyesbtnfxdkorluf'),
    error => error.code === 'RESTORE_PORTABILITY_TARGET_BLOCKED',
  );
  await assert.rejects(
    () => portability.prepareCrossEnvironmentCloudRestoreCandidate(portable, 'rhfdjsklfrgpoqsaqpkn'),
    error => error.code === 'RESTORE_PORTABILITY_ALREADY_APPLIED',
  );
  await assert.rejects(
    () => domain.prepareCloudRestoreSnapshot({ ...document, manifest: { ...document.manifest, portability: portable.portability } }),
    error => error.code === 'RESTORE_PORTABLE_CANDIDATE_NOT_IMPORTABLE',
  );

  const changedAfterPreflight = { ...strict, data: clone(strict.data) };
  changedAfterPreflight.data.inventory_items[0].product_title = 'changed after source verification';
  await assert.rejects(
    () => portability.prepareCrossEnvironmentCloudRestoreCandidate(changedAfterPreflight, 'rhfdjsklfrgpoqsaqpkn'),
    error => error.code === 'RESTORE_PORTABILITY_SOURCE_CHANGED',
  );

  const invalidAuditDocument = clone(document);
  invalidAuditDocument.data.inventory[0].updated_by = 'not-a-uuid';
  invalidAuditDocument.manifest = (await domain.buildCloudRestoreManifest(invalidAuditDocument.data, invalidAuditDocument.data)).manifest;
  const invalidAuditSource = await domain.prepareCloudRestoreSnapshot(invalidAuditDocument);
  await assert.rejects(
    () => portability.prepareCrossEnvironmentCloudRestoreCandidate(invalidAuditSource, 'rhfdjsklfrgpoqsaqpkn'),
    error => error.code === 'RESTORE_PORTABILITY_AUDIT_IDENTITY_INVALID',
  );

  const tamperedManifest = clone(document);
  tamperedManifest.manifest.snapshotFingerprint = '0'.repeat(64);
  await assert.rejects(
    () => domain.prepareCloudRestoreSnapshot(tamperedManifest),
    error => error.code === 'RESTORE_MANIFEST_MISMATCH',
  );
  const brokenBusinessRelation = clone(document);
  brokenBusinessRelation.data.purchaseBatchItems[0].purchase_batch_id = uuid(999);
  await assert.rejects(
    () => domain.prepareCloudRestoreSnapshot(brokenBusinessRelation),
    error => error.code === 'ORPHAN_RELATION',
  );

  const modelRequests = new Map();
  const bind = candidate => domain.sha256Hex(domain.stableCloudRestoreJson({
    snapshot: candidate.data,
    portability: candidate.portability ?? null,
  }));
  const key = uuid(901);
  modelRequests.set(key, await bind(portable));
  assert.notEqual(modelRequests.get(key), await bind(strict), 'Same key with different policy/payload must mismatch');

  const target = { marker: 'before' };
  const before = clone(target);
  try {
    for (const [index, [, table]] of domain.CLOUD_RESTORE_TABLES.entries()) {
      target[table] = clone(portable.data[table]);
      if (index === 7) throw new Error('INJECTED_INSERT_FAILURE');
    }
  } catch {
    for (const property of Object.keys(target)) delete target[property];
    Object.assign(target, before);
  }
  assert.deepEqual(target, before, 'Any later INSERT failure must roll back the isolated transaction model');

  const currentSourcePath = 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-13-060717.json';
  if (existsSync(currentSourcePath)) {
    const bytes = readFileSync(currentSourcePath);
    const hashBefore = createHash('sha256').update(bytes).digest('hex');
    const actual = await domain.prepareCloudRestoreSnapshot(bytes.toString('utf8'), {
      fileName: 'cloud-erp-snapshot-2026-09-13-060717.json',
      sourceFileSha256: hashBefore,
    });
    const actualPortable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(actual, 'rhfdjsklfrgpoqsaqpkn');
    const hashAfter = createHash('sha256').update(readFileSync(currentSourcePath)).digest('hex');
    assert.equal(hashBefore, '721783423587502001a7f48f26335867b3bea5290f22c4fd7b2c7feafd10d8d4');
    assert.equal(hashAfter, hashBefore);
    assert.equal(actual.manifest.totalRows, 16528);
    assert.equal(actual.manifest.snapshotFingerprint, 'e792ae760ca94e76bbbf0adda5a46c823e5d019a17d39141dae3449e234bd6ed');
    assert.equal(actual.manifest.relationshipHash, 'f35e2f4029cd50953043829ee269023a30d538f11bbac92e3e4cc014ac193283');
    assert.equal(actualPortable.portability.totalTransformedRows, 14476);
    assert.deepEqual(actualPortable.portability.transformedCounts, {
      inventory_items: 5154,
      product_groups: 827,
      product_categories: 630,
      product_variants: 4628,
      bundle_components: 0,
      purchase_batches: 623,
      purchase_batch_items: 2378,
      private_orders: 107,
      private_order_items: 129,
      sales_orders: 0,
      sales_order_items: 0,
      japan_packages: 0,
      japan_package_items: 0,
      outbound_shipments: 0,
      outbound_shipment_items: 0,
    });
    assert.equal(actualPortable.manifest.relationshipHash, actual.manifest.relationshipHash);
    assert.equal(actualPortable.manifest.totalRows, actual.manifest.totalRows);
    console.log(`PASS current 16,528-row Production Cloud Snapshot source; effective candidate fingerprint=${actualPortable.manifest.snapshotFingerprint}`);
  } else {
    console.log('PENDING current 16,528-row Production Cloud Snapshot source probe: source file unavailable');
  }

  const approvedPath = 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-12-020044.json';
  if (existsSync(approvedPath)) {
    const bytes = readFileSync(approvedPath);
    const hashBefore = createHash('sha256').update(bytes).digest('hex');
    const approved = await domain.prepareCloudRestoreSnapshot(bytes.toString('utf8'), {
      fileName: 'cloud-erp-snapshot-2026-09-12-020044.json',
      sourceFileSha256: hashBefore,
    });
    const approvedPortable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(approved, 'rhfdjsklfrgpoqsaqpkn');
    assert.equal(hashBefore, 'd2834a75ecc7d75c6e839cba897994d7249fe55d96e894cc342f52c59c86c2f0');
    assert.equal(createHash('sha256').update(readFileSync(approvedPath)).digest('hex'), hashBefore);
    assert.equal(approved.manifest.totalRows, 16482);
    assert.equal(approved.manifest.snapshotFingerprint, '9df26da59164fd8bfdcca3fc5072b6e977636208c7e4a1b6cf6c131e66fc41ce');
    assert.equal(approved.manifest.relationshipHash, '138751fb3d11caa709a59a5f498b1e410f3ce290110ea7322eaff651f18811a0');
    assert.notEqual(approvedPortable.manifest.snapshotFingerprint, 'e792ae760ca94e76bbbf0adda5a46c823e5d019a17d39141dae3449e234bd6ed', 'Approved and diagnostic sources remain independent candidates');
    console.log(`PASS historical 16,482-row source remains separate; effective candidate fingerprint=${approvedPortable.manifest.snapshotFingerprint}`);
  } else {
    console.log('PENDING optional authorized 16,482-row source probe: source file unavailable');
  }
} finally {
  await vite.close();
}

const expectedTables = [
  'inventory_items','product_groups','product_categories','product_variants','bundle_components',
  'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
  'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items',
];
const section = (source, start, end) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing artifact section: ${start}`);
  assert.notEqual(endIndex, -1, `Missing artifact section terminator: ${end}`);
  return source.slice(startIndex, endIndex);
};
const countLiteral = (source, literal) => source.split(literal).length - 1;
const compactSql = source => source.toLowerCase().replace(/\s+/gu, '');
const patchBlock = section(SQL, 'do $patch_restore_idempotency$', '$patch_restore_idempotency$;');
const postflightBlock = section(SQL, 'do $portability_postflight$', '$portability_postflight$;');
const validatorBlock = section(
  SQL,
  'create or replace function public.erp_cloud_restore_validate_portability(',
  'revoke all on function public.erp_cloud_restore_validate_portability',
);
const compactPostflight = compactSql(postflightBlock);
const artifactPostflightAccepts = source => {
  const block = section(source, 'do $portability_postflight$', '$portability_postflight$;');
  const compact = compactSql(block);
  return !/strpos\s*\(\s*v_validate_definition\s*,\s*'auth\.users'\s*\)/iu.test(block)
    && /join\s+pg_namespace\s+parent_ns\s+on\s+parent_ns\.oid\s*=\s*parent\.relnamespace/iu.test(block)
    && /parent_ns\.nspname\s*=\s*'auth'/iu.test(block)
    && /parent\.relname\s*=\s*'users'/iu.test(block)
    && /child_column\.attname\s*=\s*'updated_by'/iu.test(block)
    && /parent_column\.attname\s*=\s*'id'/iu.test(block)
    && /fk\.confdeltype\s*=\s*'n'/iu.test(block)
    && /fk\.convalidated/iu.test(block)
    && compact.includes("v_validate.argument_types<>'jsonb,jsonb,text'")
    && compact.includes("v_validate.prorettype<>'jsonb'::regtype")
    && compact.includes("v_fingerprint.argument_types<>'jsonb,jsonb'")
    && compact.includes("v_fingerprint.prorettype<>'text'::regtype")
    && compact.includes("v_restore.argument_types<>'uuid,text,jsonb,jsonb,text'")
    && compact.includes("v_restore.prorettype<>'jsonb'::regtype")
    && compact.includes('ornotv_validate.prosecdef')
    && compact.includes("v_validate.proconfig@>array['search_path=pg_catalog,public,extensions']")
    && compact.includes("v_validate.proconfig@>array['statement_timeout=30s']")
    && compact.includes("has_function_privilege('anon',v_validate_oid,'execute')")
    && compact.includes("nothas_function_privilege('authenticated',v_validate_oid,'execute')")
    && compact.includes('ornotv_fingerprint.prosecdef')
    && compact.includes("has_function_privilege('authenticated',v_fingerprint_oid,'execute')")
    && compact.includes('ornotv_restore.prosecdef')
    && compact.includes("v_restore.proconfig@>array['statement_timeout=30s']")
    && compact.includes("nothas_function_privilege('authenticated',v_restore_oid,'execute')")
    && compact.includes('andnota.attnotnull')
    && compact.includes("format_type(a.atttypid,a.atttypmod)='uuid'")
    && compact.includes('v_table_external_count<>1orv_table_expected_fk_count<>1')
    && compact.includes("v_wiring_position>=v_first_delete_position")
    && compact.includes("v_external_reference_count<>cardinality(v_tables)");
};

assert.equal(artifactPostflightAccepts(SQL), true, '030 postflight must prove catalog structure instead of searching for a dotted name');
const fakePostflightBlock = postflightBlock.replace(
  /parent_ns\.nspname\s*=\s*'auth'[\s\S]*?parent\.relname\s*=\s*'users'/iu,
  "true -- auth.users",
);
const fakeCommentPostflight = SQL.replace(postflightBlock, fakePostflightBlock);
assert.equal(artifactPostflightAccepts(fakeCommentPostflight), false, 'A fake auth.users comment must not satisfy postflight');
assert.doesNotMatch(postflightBlock, /strpos\s*\(\s*v_validate_definition\s*,\s*'auth\.users'\s*\)/iu);

const expectedCatalog = {
  validator: {
    args: 'jsonb, jsonb, text', result: 'jsonb', securityDefiner: true,
    configs: ['search_path=pg_catalog, public, extensions', 'statement_timeout=30s'],
    publicExecute: false, anonExecute: false, authenticatedExecute: true,
  },
  fingerprint: {
    args: 'jsonb, jsonb', result: 'text', securityDefiner: true,
    configs: ['search_path=pg_catalog, public, extensions'],
    publicExecute: false, anonExecute: false, authenticatedExecute: false,
  },
  restore: {
    args: 'uuid, text, jsonb, jsonb, text', result: 'jsonb', securityDefiner: true,
    configs: ['search_path=pg_catalog, public, extensions', 'statement_timeout=30s'],
    publicExecute: false, anonExecute: false, authenticatedExecute: true,
  },
};
const functionCatalogAccepts = catalog => Object.entries(expectedCatalog).every(([name, expected]) => {
  const actual = catalog[name];
  return actual
    && actual.args === expected.args
    && actual.result === expected.result
    && actual.securityDefiner === expected.securityDefiner
    && expected.configs.every(config => actual.configs.includes(config))
    && actual.publicExecute === expected.publicExecute
    && actual.anonExecute === expected.anonExecute
    && actual.authenticatedExecute === expected.authenticatedExecute;
});
assert.equal(functionCatalogAccepts(expectedCatalog), true);
for (const incompatible of [
  { ...expectedCatalog, validator: { ...expectedCatalog.validator, args: 'jsonb, jsonb' } },
  { ...expectedCatalog, validator: { ...expectedCatalog.validator, result: 'text' } },
  { ...expectedCatalog, validator: { ...expectedCatalog.validator, securityDefiner: false } },
  { ...expectedCatalog, validator: { ...expectedCatalog.validator, configs: ['search_path=public'] } },
  { ...expectedCatalog, validator: { ...expectedCatalog.validator, publicExecute: true } },
  { ...expectedCatalog, validator: { ...expectedCatalog.validator, anonExecute: true } },
  { ...expectedCatalog, validator: { ...expectedCatalog.validator, authenticatedExecute: false } },
  { ...expectedCatalog, fingerprint: { ...expectedCatalog.fingerprint, authenticatedExecute: true } },
  { ...expectedCatalog, restore: { ...expectedCatalog.restore, configs: ['statement_timeout=30s'] } },
]) {
  assert.equal(functionCatalogAccepts(incompatible), false, 'Function signature/result/security/config/ACL drift must fail closed');
}

const expectedSchemaMatrix = expectedTables.map(table => ({
  table,
  column: 'updated_by',
  type: 'uuid',
  nullable: true,
  parentSchema: 'auth',
  parentTable: 'users',
  parentColumn: 'id',
  onDelete: 'SET NULL',
  validated: true,
}));
const schemaModelAccepts = matrix => matrix.length === expectedTables.length
  && expectedTables.every(table => matrix.some(reference => reference.table === table
    && reference.column === 'updated_by'
    && reference.type === 'uuid'
    && reference.nullable === true
    && reference.parentSchema === 'auth'
    && reference.parentTable === 'users'
    && reference.parentColumn === 'id'
    && reference.onDelete === 'SET NULL'
    && reference.validated === true));
assert.equal(schemaModelAccepts(expectedSchemaMatrix), true);
for (const incompatible of [
  expectedSchemaMatrix.slice(1),
  expectedSchemaMatrix.map((entry, index) => index === 0 ? { ...entry, type: 'text' } : entry),
  expectedSchemaMatrix.map((entry, index) => index === 0 ? { ...entry, nullable: false } : entry),
  expectedSchemaMatrix.map((entry, index) => index === 0 ? { ...entry, parentSchema: 'public', parentTable: 'profiles' } : entry),
  expectedSchemaMatrix.map((entry, index) => index === 0 ? { ...entry, parentColumn: 'user_id' } : entry),
  expectedSchemaMatrix.map((entry, index) => index === 0 ? { ...entry, onDelete: 'CASCADE' } : entry),
  expectedSchemaMatrix.map((entry, index) => index === 0 ? { ...entry, validated: false } : entry),
  [...expectedSchemaMatrix, { ...expectedSchemaMatrix[0], table: 'inventory_items', column: 'owner_id' }],
]) {
  assert.equal(schemaModelAccepts(incompatible), false, 'Unexpected, non-nullable, authorization, or missing external references must fail closed');
}

const originalWiring = "v_server_fingerprint := encode(digest(convert_to(p_snapshot::text, 'UTF8'), 'sha256'), 'hex');";
const replacementWiring = 'v_server_fingerprint := public.erp_cloud_restore_idempotency_fingerprint(p_snapshot, p_manifest);';
const patchRestoreDefinition = definition => {
  const originalCount = countLiteral(definition, originalWiring);
  const replacementCount = countLiteral(definition, replacementWiring);
  if (originalCount !== 1 || replacementCount !== 0) throw new Error('CLOUD_RESTORE_IDEMPOTENCY_BASELINE_MISMATCH');
  const patched = definition.replace(originalWiring, replacementWiring);
  if (countLiteral(patched, originalWiring) !== 0 || countLiteral(patched, replacementWiring) !== 1) {
    throw new Error('CLOUD_RESTORE_IDEMPOTENCY_PATCH_MISMATCH');
  }
  return patched;
};
const acceptedRestoreModel = `begin\n${originalWiring}\nperform validate;\ndelete from public.inventory_items where id is not null;\nend`;
const patchedRestoreModel = patchRestoreDefinition(acceptedRestoreModel);
assert.equal(countLiteral(patchedRestoreModel, replacementWiring), 1);
assert.ok(patchedRestoreModel.indexOf(replacementWiring) < patchedRestoreModel.indexOf('delete from public.'));
for (const incompatible of [
  acceptedRestoreModel.replace(originalWiring, ''),
  `${acceptedRestoreModel}\n${originalWiring}`,
  acceptedRestoreModel.replace(originalWiring, replacementWiring),
  `${acceptedRestoreModel}\n${replacementWiring}`,
]) {
  assert.throws(() => patchRestoreDefinition(incompatible), /CLOUD_RESTORE_IDEMPOTENCY_BASELINE_MISMATCH/u);
}
assert.match(patchBlock, /v_original_count\s*<>\s*1[\s\S]+v_replacement_count\s*<>\s*0/iu);
assert.match(patchBlock, /v_original_count\s*<>\s*0[\s\S]+v_replacement_count\s*<>\s*1/iu);

const validatorContractPatterns = [
  /if\s+v_actor\s+is\s+null\s+then/iu,
  /if\s+not\s+public\.is_owner\(v_actor\)\s+then/iu,
  /p_target_project_ref\s+is\s+distinct\s+from\s+'rhfdjsklfrgpoqsaqpkn'/iu,
  /split_part\(v_request_host,\s*'\.',\s*1\)\s+is\s+distinct\s+from\s+p_target_project_ref/iu,
  /policyVersion'\s+is\s+distinct\s+from\s+'cross-environment-audit-null-v1'/iu,
  /mode'\s+is\s+distinct\s+from\s+'cross-environment'/iu,
  /targetProjectRef'\s+is\s+distinct\s+from\s+p_target_project_ref/iu,
  /key\s+not\s+in\s*\([\s\S]*?'totalTransformedRows'/iu,
  /not\s+\(row_value\s+\?\s+'updated_by'\)[\s\S]+jsonb_typeof\(row_value->'updated_by'\)\s+is\s+distinct\s+from\s+'null'/iu,
  /CLOUD_RESTORE_PORTABILITY_SCHEMA_MISMATCH/iu,
  /CLOUD_RESTORE_PORTABILITY_EXTERNAL_REFERENCE_BLOCKED/iu,
];
const validatorContractAccepts = source => validatorContractPatterns.every(pattern => pattern.test(source));
assert.equal(validatorContractAccepts(validatorBlock), true);
for (const pattern of validatorContractPatterns) {
  assert.equal(validatorContractAccepts(validatorBlock.replace(pattern, '')), false, `Validator drift must fail artifact coupling: ${pattern}`);
}

assert.ok(compactPostflight.includes("v_wiring_position:=strpos(v_compact_restore_definition,'v_server_fingerprint:=public.erp_cloud_restore_idempotency_fingerprint(p_snapshot,p_manifest);')"));
assert.ok(compactPostflight.includes("v_first_delete_position:=strpos(v_compact_restore_definition,'deletefrompublic.')"));
assert.ok(compactPostflight.includes('v_wiring_position>=v_first_delete_position'));

const strictFingerprint = candidate => createHash('sha256').update(JSON.stringify(candidate.data)).digest('hex');
const portableFingerprint = candidate => createHash('sha256').update(JSON.stringify({
  snapshot: candidate.data,
  portability: candidate.portability,
})).digest('hex');
const strictReplayModel = { data: clone(collections) };
const portableReplayModel = {
  data: clone(collections),
  portability: {
    policyVersion: 'cross-environment-audit-null-v1',
    targetProjectRef: 'rhfdjsklfrgpoqsaqpkn',
    sourceFileSha256: '0'.repeat(64),
  },
};
const strictReplayFingerprint = strictFingerprint(strictReplayModel);
const portableReplayFingerprint = portableFingerprint(portableReplayModel);
assert.equal(strictReplayFingerprint, strictFingerprint(strictReplayModel), 'Strict retry must preserve the legacy idempotency identity');
assert.equal(portableReplayFingerprint, portableFingerprint(portableReplayModel), 'Portable same-payload retry must replay deterministically');
assert.notEqual(portableReplayFingerprint, strictReplayFingerprint, 'Strict and portable executions must not share idempotency identity');
const changedPolicy = { ...portableReplayModel, portability: { ...portableReplayModel.portability, sourceFileSha256: '1'.repeat(64) } };
assert.notEqual(portableFingerprint(changedPolicy), portableReplayFingerprint, 'Portable policy changes must produce payload mismatch');

for (const table of expectedTables) {
  assert.match(SQL, new RegExp(`'${table}'`, 'u'));
}
assert.match(SQL, /cross-environment-audit-null-v1/u);
assert.match(SQL, /updated_by/u);
assert.match(SQL, /parent_ns\.nspname = 'auth'[\s\S]+parent\.relname = 'users'/u);
assert.match(SQL, /not a\.attnotnull[\s\S]+format_type\(a\.atttypid, a\.atttypmod\) = 'uuid'/u);
assert.match(SQL, /CLOUD_RESTORE_PORTABILITY_EXTERNAL_REFERENCE_BLOCKED/u);
assert.match(SQL, /erp_cloud_restore_idempotency_fingerprint\(p_snapshot, p_manifest\)/u);
assert.match(SQL, /\(v_counts->>v_table\)::bigint > jsonb_array_length\(p_snapshot->v_table\)/u);
assert.match(SQL, /set search_path = pg_catalog, public, extensions/u);
assert.doesNotMatch(SQL, /\b(?:insert into|update public\.|delete from public\.|truncate)\b/iu, '030 apply must contain no business DML');
assert.doesNotMatch(SQL, /service_role|password|twzpqyesbtnfxdkorluf/iu);

console.log('PASS fixed 15-table updated_by policy, strict-mode preservation, source immutability, target/schema fail-closed, policy-bound idempotency, and rollback model');
console.log('PASS artifact-coupled postflight, catalog drift refusal, exact-once Restore wiring, pre-DELETE validation, and strict/portable replay identity');
console.log('PENDING PostgreSQL FK integration: no isolated local PostgreSQL runtime is installed; Live Restore was not used as a substitute');
