import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ERP2_MIGRATION_SOURCE_ORDER_V3 } from '../../supabase/canonicalFreshInstallV3.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const q = (kind, object, expected = true, extra = {}) => Object.freeze({ kind, object, expected, ...extra });
const fn = (signature, extra = {}) => q('function', `public.${signature}`, true, { mismatchIsMissing: true, ...extra });
const table = (name, extra = {}) => q('table', `public.${name}`, true, extra);
const index = (name, extra = {}) => q('index', `public.${name}`, true, extra);
const column = (tableName, name, dataType, extra = {}) => q('column', `public.${tableName}.${name}`, dataType, extra);
const inventoryParentColumn = extra => column('inventory_items', 'myacg_parent_code', 'text', {
  nullable: true, default: null, ...extra,
});
const inventoryParentIndex = extra => index('inventory_items_myacg_parent_code_idx', {
  unique: false, primary: false, valid: true,
  definitionIncludes: ['myacg_parent_code', 'myacg_parent_code is not null', 'deleted_at is null'],
  ...extra,
});
const inventoryParentFunction = extra => fn('erp_apply_field_mutations(text,jsonb)', {
  owner: 'postgres', returnType: 'jsonb', publicExecute: false,
  securityDefiner: true, authenticatedExecute: true, anonExecute: false,
  requiredConfig: ['search_path=""'],
  definitionIncludes: ['myacg_parent_code'], ...extra,
});

const RESTORE_TABLES = Object.freeze([
  'inventory_items', 'product_groups', 'product_categories', 'product_variants', 'bundle_components',
  'purchase_batches', 'purchase_batch_items', 'private_orders', 'private_order_items', 'sales_orders',
  'sales_order_items', 'japan_packages', 'japan_package_items', 'outbound_shipments', 'outbound_shipment_items',
]);
const WACA_TABLES = Object.freeze([
  'waca_orders', 'waca_order_items', 'waca_mappings', 'waca_master_links',
  'waca_import_batches', 'waca_cutover_audit', 'waca_state',
]);
const DEPENDENCY_SOURCE_FILES = Object.freeze({
  '001': '001_profiles.sql', '002-core': '002_core_erp_tables_mvp.sql', '011': '011_fix_rls_helper_functions.sql',
  '014': '014_upgrade_inventory_items_composite_key.sql', '020': '020_cloud_field_cas.sql',
  '023': '023_cloud_atomic_json_restore.sql', '025': '025_cloud_atomic_restore_execution_timeout.sql',
  '026': '026_cloud_restore_guarded_full_delete.sql', '040': '040_cloud_restore_owner_builder_proof.sql',
});

export const MIGRATION_EFFECT_SPECS = Object.freeze({
  '018': {
    sourceFile: '018_cloud_import_batch_canonical.sql', dependencies: ['001', '002-core', '011'],
    risk: 'LOW_ADDITIVE', idempotency: 'RERUN_SAFE_WITH_CANONICAL_SHAPE_ONLY', repairClosure: '018b',
    preconditions: [fn('is_owner(uuid)'), fn('is_editor(uuid)')],
    postconditions: [
      table('import_batches', { rls: true }), column('import_batches', 'id', 'uuid', { nullable: false }),
      column('import_batches', 'platform', 'text', { nullable: false }),
      column('import_batches', 'file_name', 'text', { nullable: false }),
      column('import_batches', 'details', 'jsonb'), column('import_batches', 'updated_by', 'uuid'),
      column('import_batches', 'version', 'integer', { nullable: false }),
      column('import_batches', 'sync_status', 'text', { nullable: false }),
      q('primaryKey', 'public.import_batches', ['id']), index('idx_import_batches_local_id'),
      ...['select_policy', 'insert_policy', 'update_policy', 'delete_policy']
        .map(name => q('policy', `public.import_batches.${name}`)),
      q('tableGrant', 'public.import_batches.authenticated', ['DELETE', 'INSERT', 'SELECT', 'UPDATE']),
    ],
  },
  '018b': {
    sourceFile: '018b_cloud_import_batch_acl_compatibility_repair.sql', dependencies: ['001', '002-core', '011'],
    risk: 'LOW_TARGETED_ACL_REPAIR', idempotency: 'STATE_GUARDED_RERUN_SAFE', repairs: ['018'],
    allowPartialApply: true,
    preconditions: [
      table('import_batches', { rls: true }), q('tableOwner', 'public.import_batches', 'postgres'),
      q('primaryKey', 'public.import_batches', ['id']),
      ...['select_policy', 'insert_policy', 'update_policy', 'delete_policy']
        .map(name => q('policy', `public.import_batches.${name}`)),
      q('tableGrantSubset', 'public.import_batches.anon', ['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE']),
      q('tableGrantSubset', 'public.import_batches.authenticated',
        ['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']),
      q('tableGrantContains', 'public.import_batches.authenticated', ['DELETE','INSERT','SELECT','UPDATE']),
      q('tableGrant', 'public.import_batches.public', []),
    ],
    postconditions: [
      q('tableGrant', 'public.import_batches.authenticated', ['DELETE','INSERT','SELECT','UPDATE'], { mismatchIsMissing: true }),
      q('tableGrant', 'public.import_batches.anon', [], { mismatchIsMissing: true }),
      q('tableGrant', 'public.import_batches.public', []),
    ],
  },
  '026b': {
    sourceFile: '026b_cloud_inventory_uuid_identity_bridge.sql', dependencies: ['014'],
    risk: 'HIGH_PK_REPLACEMENT_AND_BACKFILL', idempotency: 'STATE_GUARDED', detector: 'inventoryUuidBridge',
    preconditions: [table('inventory_items'), q('inventoryIntegrity', 'inventory_items', 'PASS')],
    postconditions: [
      column('inventory_items', 'id', 'uuid', { nullable: false }),
      column('inventory_items', 'inventory_key', 'text', { nullable: false }),
      column('inventory_items', 'latest_catalog_import_id', 'text'),
      column('inventory_items', 'catalog_last_seen_at', 'timestamp with time zone'),
      q('primaryKey', 'public.inventory_items', ['id']),
      q('unique', 'public.inventory_items', ['inventory_key']),
      index('inventory_items_catalog_last_seen_at_idx'),
    ],
  },
  '027': {
    sourceFile: '027_cloud_restore_safeupdate_compatible_delete.sql', dependencies: ['025', '026', '026b'],
    risk: 'HIGH_RESTORE_WRITER_REPLACEMENT', idempotency: 'POSTCONDITION_GUARDED',
    preconditions: [
      ...RESTORE_TABLES.map(name => q('primaryKey', `public.${name}`, ['id'])),
      q('unique', 'public.inventory_items', ['inventory_key']),
    ],
    postconditions: [fn('erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', {
      securityDefiner: true, requiredConfig: ['search_path=pg_catalog, public, extensions'],
      anonExecute: false, definitionIncludes: ['where id is not null'],
    })],
  },
  '029': {
    sourceFile: '029_cloud_restore_live_schema_alignment.sql', dependencies: ['026b', '027'],
    risk: 'HIGH_RESTORE_WRITER_PATCH', idempotency: 'STATE_GUARDED',
    preconditions: [...RESTORE_TABLES.map(name => q('primaryKey', `public.${name}`, ['id']))],
    postconditions: [
      fn('erp_cloud_restore_table_profile(regclass,jsonb)', {
        securityDefiner: true, anonExecute: false,
        definitionIncludes: ['row_value.id::text', "row_value->>'id'"],
      }),
      fn('erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', {
        securityDefiner: true, anonExecute: false,
        requiredConfig: ['search_path=pg_catalog, public, extensions'],
        definitionIncludes: ['where id is not null'],
      }),
    ],
  },
  '030': {
    sourceFile: '030_cloud_restore_cross_environment_audit_identity_portability.sql', dependencies: ['029'],
    risk: 'MEDIUM_RESTORE_PORTABILITY_PATCH', idempotency: 'POSTCONDITION_GUARDED',
    preconditions: [fn('erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)')],
    postconditions: [
      fn('erp_cloud_restore_validate_portability(jsonb,jsonb,text)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
        requiredConfig: ['search_path=pg_catalog, public, extensions'],
      }),
      fn('erp_cloud_restore_idempotency_fingerprint(jsonb,jsonb)', {
        securityDefiner: true, authenticatedExecute: false, anonExecute: false,
        requiredConfig: ['search_path=pg_catalog, public, extensions'],
      }),
      fn('erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', {
        definitionIncludes: ['erp_cloud_restore_idempotency_fingerprint'],
      }),
    ],
  },
  '041': {
    sourceFile: '041_cloud_restore_durable_failure_recovery.sql', dependencies: ['040'],
    risk: 'MEDIUM_RESTORE_CONTROL_PLANE', idempotency: 'COLLISION_GUARDED',
    preconditions: [table('erp_cloud_restore_attempts')],
    postconditions: [
      table('erp_cloud_restore_failures', { rls: true }),
      q('primaryKey', 'public.erp_cloud_restore_failures', ['attempt_id']),
      q('policy', 'public.erp_cloud_restore_failures.cloud restore own failure read'),
      q('tableGrant', 'public.erp_cloud_restore_failures.authenticated', ['SELECT']),
      fn('erp_cloud_restore_failure_category(text,text)', { authenticatedExecute: false, anonExecute: false }),
      fn('erp_cloud_restore_failure_result(uuid)', { authenticatedExecute: false, anonExecute: false }),
      fn('erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
      }),
      fn('erp_reconcile_cloud_restore_attempt(uuid,uuid)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
      }),
    ],
  },
  '042': {
    sourceFile: '042_cloud_restore_durable_execution_closure.sql', dependencies: ['041'],
    risk: 'MEDIUM_RESTORE_LIFECYCLE_PATCH', idempotency: 'POSTCONDITION_GUARDED',
    preconditions: [table('erp_cloud_restore_failures')],
    postconditions: [
      fn('erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
        definitionIncludes: ["status='executing'", 'execution_started_at', 'erp_cloud_restore_failures'],
      }),
      fn('erp_reconcile_cloud_restore_attempt(uuid,uuid)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
        definitionIncludes: ['execution_id', 'not_committed'],
      }),
    ],
  },
  '043': {
    sourceFile: '043_cloud_restore_execute_dispatch_boundary.sql', dependencies: ['042'],
    risk: 'MEDIUM_RESTORE_TRANSPORT_BOUNDARY', idempotency: 'COLLISION_GUARDED',
    preconditions: [table('erp_cloud_restore_attempts'), table('erp_cloud_restore_failures')],
    postconditions: [
      table('erp_cloud_restore_candidate_proofs', { rls: true, forceRls: true }),
      q('primaryKey', 'public.erp_cloud_restore_candidate_proofs', ['proof_id']),
      index('erp_cloud_restore_candidate_proofs_expiry_idx'),
      q('tableGrant', 'public.erp_cloud_restore_candidate_proofs.authenticated', []),
      fn('erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
        requiredConfig: ['search_path=pg_catalog, public, extensions', 'statement_timeout=120s'],
      }),
      fn('erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
        requiredConfig: ['search_path=pg_catalog, public, extensions', 'statement_timeout=120s'],
        definitionIncludes: ['rpc=execute event=db-entry', 'p_proof_id'],
      }),
    ],
  },
  '044': {
    sourceFile: '044_waca_cloud_ledger.sql', dependencies: ['002-core', '011', '023'],
    risk: 'MEDIUM_ADDITIVE_LEDGER_AND_TRANSACTION', idempotency: 'COLLISION_GUARDED',
    preconditions: [table('product_variants'), fn('is_owner(uuid)'), fn('erp_assert_cloud_restore_unlocked()')],
    postconditions: [
      ...WACA_TABLES.map(name => table(name, { rls: true, forceRls: false })),
      index('waca_order_items_order_id_idx'), index('waca_order_items_variant_id_idx'),
      index('waca_order_items_feature_idx'), index('waca_mappings_variant_id_idx'),
      index('waca_master_links_variant_id_idx'),
      fn('erp_waca_variant_id(text)', { authenticatedExecute: false, anonExecute: false }),
      fn('erp_read_waca_snapshot()', { securityDefiner: true, authenticatedExecute: true, anonExecute: false }),
      fn('erp_commit_waca_snapshot(jsonb,bigint,boolean)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
        definitionIncludes: ['waca_auto_quantity'],
      }),
    ],
  },
  '045': {
    sourceFile: '045_waca_cloud_atomic_restore_closure.sql', dependencies: ['043', '044'],
    risk: 'HIGH_ATOMIC_RESTORE_PATCH', idempotency: 'FAILED_HISTORY_IMMUTABLE', repairClosure: '045c',
    historicalAttempt: Object.freeze({ result: 'FAILED_ROLLED_BACK', code: 'WACA_PATCH_ANCHOR_DRIFT' }),
    preconditions: [...WACA_TABLES.map(name => table(name)), fn('erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)')],
    postconditions: [
      q('trigger', 'public.waca_state.erp_cloud_restore_maintenance_guard'),
      fn('erp_cloud_restore_validate_waca_dataset(jsonb)', { authenticatedExecute: false, anonExecute: false }),
      fn('erp_cloud_restore_recompute_waca_quantities()', {
        authenticatedExecute: false, anonExecute: false, definitionIncludes: ['waca_auto_quantity'],
      }),
      fn('erp_cloud_restore_snapshot()', { definitionIncludes: ['waca_orders', 'waca_state'] }),
      fn('erp_cloud_restore_audit_dataset(jsonb)', { definitionIncludes: ['waca_order_items', 'waca_mappings'] }),
      fn('erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', { definitionIncludes: ['resourcecount', '24'] }),
    ],
  },
  '045b': {
    sourceFile: '045b_waca_cloud_atomic_restore_compatibility_repair.sql', dependencies: ['043', '044'],
    risk: 'HIGH_STATE_GUARDED_ATOMIC_RESTORE_REPAIR', idempotency: 'FAILED_HISTORY_IMMUTABLE',
    repairs: ['045'], repairClosure: '045c',
    historicalAttempt: Object.freeze({ result: 'FAILED_ROLLED_BACK',
      code: 'WACA_045B_SEMANTIC_SOURCE_CONFLICT',
      target: 'public.erp_cloud_restore_audit_dataset(jsonb)' }),
    allowPartialApply: true,
    preconditions: [
      ...WACA_TABLES.map(name => table(name)), table('import_batches'), table('dashboard_category_images'),
      fn('erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)', {
        definitionIncludes: ['p_proof_id', 'rpc=execute event=db-entry'],
      }),
      q('functionDefinitionCompatible', 'public.erp_cloud_restore_audit_dataset(jsonb)', true, {
        variants: ['jsonb_object_keys(p_data)) <> 15', 'jsonb_object_keys(p_data)) <> 24'],
      }),
    ],
    postconditions: [
      q('trigger', 'public.import_batches.erp_cloud_restore_maintenance_guard'),
      q('trigger', 'public.waca_state.erp_cloud_restore_maintenance_guard'),
      fn('erp_cloud_restore_validate_waca_dataset(jsonb)', { authenticatedExecute: false, anonExecute: false }),
      fn('erp_cloud_restore_recompute_waca_quantities()', {
        authenticatedExecute: false, anonExecute: false, definitionIncludes: ['waca_auto_quantity'],
      }),
      fn('erp_cloud_restore_snapshot()', { definitionIncludes: ['waca_orders', 'waca_state'] }),
      fn('erp_cloud_restore_audit_dataset(jsonb)', { definitionIncludes: ['waca_order_items', 'waca_mappings'] }),
      fn('erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', { definitionIncludes: ['resourcecount', '24'] }),
    ],
  },
  '045c': {
    sourceFile: '045c_waca_cloud_atomic_restore_semantic_closure.sql', dependencies: ['043', '044'],
    risk: 'HIGH_SEMANTIC_STATE_GUARDED_ATOMIC_RESTORE_REPAIR',
    idempotency: 'SEMANTIC_STATE_GUARDED_COMPLETE_REPLACEMENT', repairs: ['045', '045b'],
    allowPartialApply: true, detector: 'wacaRestoreSemanticState',
    preconditions: [
      ...WACA_TABLES.map(name => table(name)), table('import_batches'), table('dashboard_category_images'),
      fn('erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
        requiredConfig: ['search_path=pg_catalog, public, extensions', 'statement_timeout=120s'],
      }),
      fn('erp_reconcile_cloud_restore_attempt(uuid,uuid)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
        requiredConfig: ['search_path=pg_catalog, public, extensions', 'statement_timeout=10s'],
      }),
      fn('erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
        requiredConfig: ['search_path=pg_catalog, public, extensions', 'statement_timeout=120s'],
      }),
      fn('erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
        requiredConfig: ['search_path=pg_catalog, public, extensions', 'statement_timeout=120s'],
      }),
    ],
    postconditions: [
      q('trigger', 'public.import_batches.erp_cloud_restore_maintenance_guard'),
      q('trigger', 'public.waca_state.erp_cloud_restore_maintenance_guard'),
      fn('erp_cloud_restore_validate_waca_dataset(jsonb)', { authenticatedExecute: false, anonExecute: false }),
      fn('erp_cloud_restore_recompute_waca_quantities()', {
        authenticatedExecute: false, anonExecute: false, definitionIncludes: ['waca_auto_quantity'],
      }),
      fn('erp_cloud_restore_snapshot()', { definitionIncludes: ['waca_orders', 'waca_state'] }),
      fn('erp_cloud_restore_audit_dataset(jsonb)', { definitionIncludes: ['waca_order_items', 'waca_mappings'] }),
      fn('erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', { definitionIncludes: ['resourcecount', '24'] }),
    ],
  },
  '046': {
    sourceFile: '046_waca_myacg_parent_evidence.sql', dependencies: ['020', '044', '045c'],
    risk: 'LOW_ADDITIVE_EVIDENCE_COLUMN', idempotency: 'SOURCE_DRIFT_GUARDED_ONE_TIME', repairClosure: '046b',
    preconditions: [table('inventory_items'), fn('erp_apply_field_mutations(text,jsonb)')],
    postconditions: [
      inventoryParentColumn(), inventoryParentIndex(), inventoryParentFunction(),
      q('tableGrantContains', 'public.inventory_items.authenticated', ['SELECT']),
      q('tableGrantContains', 'public.inventory_items.anon', [], { exact: true }),
    ],
  },
  '046b': {
    sourceFile: '046b_waca_myacg_parent_compatibility_repair.sql', dependencies: ['020', '044', '045c'],
    risk: 'LOW_STATE_GUARDED_ACL_REPAIR', idempotency: 'STATE_GUARDED_RERUN_SAFE', repairs: ['046'],
    allowPartialApply: true,
    preconditions: [
      table('inventory_items'), q('tableOwner', 'public.inventory_items', 'postgres'),
      q('primaryKey', 'public.inventory_items', ['id']),
      column('inventory_items', 'id', 'uuid', { nullable: false }),
      column('inventory_items', 'inventory_key', 'text', { nullable: false }),
      q('unique', 'public.inventory_items', ['inventory_key']),
      q('inventoryIntegrity', 'inventory_items', 'PASS'),
      q('columnCompatible', 'public.inventory_items.myacg_parent_code', 'text', { nullable: true, default: null }),
      q('indexCompatible', 'public.inventory_items_myacg_parent_code_idx', true, {
        unique: false, primary: false, valid: true,
        definitionIncludes: ['myacg_parent_code', 'myacg_parent_code is not null', 'deleted_at is null'],
      }),
      q('functionSignatureSet', 'public.erp_apply_field_mutations', ['public.erp_apply_field_mutations(text,jsonb)']),
      q('functionDefinitionCompatible', 'public.erp_apply_field_mutations(text,jsonb)', true, {
        variants: [
          "v_create_allowed := ARRAY['inventory_key','myacg_item_code','product_id'",
          "v_create_allowed := ARRAY['inventory_key','myacg_item_code','myacg_parent_code','product_id'",
        ],
      }),
      q('tableGrantSubset', 'public.inventory_items.anon', ['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE']),
      q('tableGrantSubset', 'public.inventory_items.authenticated',
        ['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']),
      q('tableGrantContains', 'public.inventory_items.authenticated', ['SELECT']),
      q('tableGrant', 'public.inventory_items.public', []),
    ],
    postconditions: [
      inventoryParentColumn(), inventoryParentIndex(), inventoryParentFunction(),
      q('tableGrant', 'public.inventory_items.authenticated', ['SELECT'], { mismatchIsMissing: true }),
      q('tableGrant', 'public.inventory_items.anon', [], { mismatchIsMissing: true }),
      q('tableGrant', 'public.inventory_items.public', []),
    ],
  },
  '047': {
    sourceFile: '047_erp_schema_migration_ledger.sql', dependencies: ['011', '046b'],
    risk: 'LOW_ENVIRONMENT_LOCAL_METADATA', idempotency: 'RERUN_SAFE_WITH_CANONICAL_SHAPE_ONLY',
    classification: 'ENVIRONMENT_LOCAL_NON_PORTABLE_OPS_METADATA',
    preconditions: [fn('is_owner(uuid)')],
    postconditions: [
      table('erp_schema_migration_ledger', { rls: true, forceRls: true }),
      q('primaryKey', 'public.erp_schema_migration_ledger', ['id']),
      index('erp_schema_migration_ledger_recorded_at_idx'),
      q('policy', 'public.erp_schema_migration_ledger.erp schema ledger owner read'),
      fn('erp_record_schema_migration_event(text,text,text,text,text,text,text,text,text,text,jsonb)', {
        securityDefiner: true, authenticatedExecute: true, anonExecute: false,
      }),
    ],
  },
});

const extractBalanced = (sql, start) => {
  let depth = 0;
  for (let index = start; index < sql.length; index += 1) {
    if (sql[index] === '(') depth += 1;
    else if (sql[index] === ')' && --depth === 0) return sql.slice(start + 1, index);
  }
  return '';
};

const splitTopLevel = body => {
  const parts = []; let depth = 0; let quote = false; let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "'" && body[index - 1] !== '\\') quote = !quote;
    if (!quote && char === '(') depth += 1;
    if (!quote && char === ')') depth -= 1;
    if (!quote && depth === 0 && char === ',') { parts.push(body.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(body.slice(start).trim());
  return parts.filter(Boolean);
};

const normalizeColumnType = value => ({
  timestamptz: 'timestamp with time zone', int: 'integer', int4: 'integer', int8: 'bigint',
}[value.toLowerCase()] ?? value.toLowerCase());

const identifierList = value => value.split(',').map(item => item.trim().replace(/^"|"$/gu, '')).filter(Boolean);

const parseCreatedTableContract = (name, entries) => {
  const columns = []; const primaryKeys = []; const uniques = []; const foreignKeys = []; const checks = [];
  for (const entry of entries) {
    const normalized = entry.replace(/\s+/gu, ' ').trim();
    const tablePrimary = normalized.match(/^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]+)\)/iu);
    const tableUnique = normalized.match(/^(?:constraint\s+\S+\s+)?unique\s*\(([^)]+)\)/iu);
    if (tablePrimary) { primaryKeys.push(identifierList(tablePrimary[1])); continue; }
    if (tableUnique) { uniques.push(identifierList(tableUnique[1])); continue; }
    if (/^(?:constraint\s+\S+\s+)?check\s*\(/iu.test(normalized)) { checks.push(normalized); continue; }
    if (/^(?:constraint|foreign)\b/iu.test(normalized)) continue;
    const column = normalized.match(/^"?([a-z0-9_]+)"?\s+(uuid|text|jsonb|bigint|integer|int4|int8|boolean|timestamptz|timestamp\s+(?:with|without)\s+time\s+zone|date|numeric(?:\([^)]*\))?)/iu);
    if (!column) continue;
    const definition = normalized.slice(column[0].length).trim();
    const inlinePrimaryKey = /\bprimary\s+key\b/iu.test(definition);
    const contract = {
      name: column[1].toLowerCase(), dataType: normalizeColumnType(column[2]),
      nullable: !inlinePrimaryKey && !/\bnot\s+null\b/iu.test(definition), definition: normalized,
    };
    columns.push(contract);
    if (inlinePrimaryKey) primaryKeys.push([contract.name]);
    if (/\bunique\b/iu.test(definition)) uniques.push([contract.name]);
    const reference = definition.match(/\breferences\s+(?:public\.)?([a-z0-9_]+)\s*\(([^)]+)\)(?:\s+on\s+delete\s+([a-z ]+?))?(?=\s+(?:check|default|not|null|unique|primary|references)\b|$)/iu);
    if (reference) foreignKeys.push({
      columns: [contract.name], referencedTable: `public.${reference[1].toLowerCase()}`,
      referencedColumns: identifierList(reference[2]), onDelete: reference[3]?.trim().toUpperCase() ?? null,
    });
    if (/\bcheck\s*\(/iu.test(definition)) checks.push(normalized);
  }
  return { name: name.toLowerCase(), entries, columns, primaryKeys, uniques, foreignKeys, checks };
};

export function extractSqlEffects(sql) {
  const normalized = sql.replace(/--[^\r\n]*/gu, ' ');
  const tables = [];
  for (const match of normalized.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)\s*\(/giu)) {
    const body = extractBalanced(normalized, match.index + match[0].lastIndexOf('('));
    const entries = splitTopLevel(body);
    tables.push(parseCreatedTableContract(match[1], entries));
  }
  const capture = regex => [...normalized.matchAll(regex)].map(match => match.slice(1).filter(value => value !== undefined));
  return {
    tables,
    alteredTables: [...new Set(capture(/alter\s+table\s+(?:if\s+exists\s+)?public\.([a-z0-9_]+)/giu).flat())].sort(),
    addedColumns: capture(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s+([^,;\r\n]+)/giu),
    indexes: capture(/create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/giu).flat().sort(),
    functions: capture(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(([^)]*)\)/giu)
      .map(([name, args]) => ({ name: name.toLowerCase(), arguments: args.replace(/\s+/gu, ' ').trim() })),
    triggers: capture(/create\s+trigger\s+([a-z0-9_]+)/giu).flat().sort(),
    policies: capture(/create\s+policy\s+(?:"([^"]+)"|([a-z0-9_]+))/giu).map(parts => parts.find(Boolean)).sort(),
    rlsTables: capture(/alter\s+table\s+public\.([a-z0-9_]+)\s+(?:force\s+)?enable\s+row\s+level\s+security/giu).flat().sort(),
    grants: capture(/grant\s+([^;]+?)\s+on\s+(?:table\s+)?(?:public\.)?([a-z0-9_]+)[^;]*\s+to\s+([a-z0-9_]+)/giu),
    revokes: capture(/revoke\s+([^;]+?)\s+on\s+([^;]+?)\s+from\s+([^;]+)/giu),
    functionAcl: capture(/(grant|revoke)\s+execute\s+on\s+function\s+([^;]+?)\s+(?:to|from)\s+([^;]+)/giu)
      .map(([action, signature, roles]) => ({ action: action.toUpperCase(), signature: signature.replace(/\s+/gu, ' ').trim(),
        roles: identifierList(roles).map(role => role.toLowerCase()) })),
    identityRewrites: capture(/alter\s+table\s+public\.([a-z0-9_]+)\s+([^;]*(?:primary\s+key|drop\s+constraint|add\s+column\s+id\s+uuid)[^;]*);/giu)
      .map(([tableName, operation]) => ({ table: tableName.toLowerCase(), operation: operation.replace(/\s+/gu, ' ').trim() })),
    transactionWrapped: /^\s*(?:--[^\r\n]*[\r\n]\s*)*begin\s*;/iu.test(sql) && /commit\s*;\s*$/iu.test(sql),
  };
}

export async function buildMigrationEffectRegistry() {
  const order = new Map(ERP2_MIGRATION_SOURCE_ORDER_V3.map((file, index) => [file, index]));
  const result = {};
  for (const [migrationId, spec] of Object.entries(MIGRATION_EFFECT_SPECS)) {
    const path = new URL(`../../supabase/sql/${spec.sourceFile}`, import.meta.url);
    const sql = await readFile(path, 'utf8');
    if (!order.has(spec.sourceFile)) throw new Error(`MIGRATION_NOT_IN_CANONICAL_CHAIN:${spec.sourceFile}`);
    const extracted = extractSqlEffects(sql);
    if (!extracted.transactionWrapped) throw new Error(`MIGRATION_NOT_TRANSACTION_WRAPPED:${migrationId}`);
    const derivedConditions = extracted.tables.flatMap(created => [
      table(created.name),
      ...created.columns.map(value => column(created.name, value.name, value.dataType, { nullable: value.nullable })),
      ...created.primaryKeys.map(value => q('primaryKey', `public.${created.name}`, value)),
      ...created.uniques.map(value => q('unique', `public.${created.name}`, value)),
      ...created.foreignKeys.map(value => q('foreignKey', `public.${created.name}`, true, value)),
    ]);
    const postconditions = [...spec.postconditions, ...derivedConditions]
      .filter((value, index, values) => values.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(value)) === index);
    const dependencySources = [];
    for (const dependency of spec.dependencies) {
      const dependencyFile = MIGRATION_EFFECT_SPECS[dependency]?.sourceFile ?? DEPENDENCY_SOURCE_FILES[dependency];
      if (!dependencyFile || !order.has(dependencyFile)) throw new Error(`MIGRATION_DEPENDENCY_SOURCE_UNKNOWN:${migrationId}:${dependency}`);
      const dependencySql = await readFile(new URL(`../../supabase/sql/${dependencyFile}`, import.meta.url), 'utf8');
      dependencySources.push({ migrationId: dependency, sourceFile: dependencyFile,
        sourceChecksum: createHash('sha256').update(dependencySql).digest('hex') });
    }
    result[migrationId] = Object.freeze({
      migrationId, ...spec,
      sourceChecksum: createHash('sha256').update(sql).digest('hex'),
      canonicalOrder: order.get(spec.sourceFile),
      sourceEffects: extracted,
      dependencySources,
      postconditions,
    });
  }
  return Object.freeze(result);
}

export const inventoryRestoreTables = RESTORE_TABLES;
export const wacaTables = WACA_TABLES;
