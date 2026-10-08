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
  '069': {
    sourceFile:'069_restore_finalize_server_resource_semantic_proof.sql',dependencies:['066','068'],
    risk:'LOW_PREPARE_FINALIZE_SEMANTIC_PROOF',idempotency:'EXACT_FUNCTION_REPLACEMENT',
    classification:'OPS_EPHEMERAL_PREPARED_RESTORE_STATE',
    preconditions:[fn('erp_finalize_restore_upload(uuid)'),table('erp_restore_upload_resource_proofs')],
    postconditions:[fn('erp_restore_upload_semantic_audit(uuid)',{
      owner:'postgres',securityDefiner:false,authenticatedExecute:false,anonExecute:false,publicExecute:false,
      requiredConfig:['search_path=pg_catalog, public, extensions'],
      definitionIncludes:['rows as materialized','rp.request_id=p_request_id','execute_relationship_hash','optional_metadata_missing_reference_count'],
    }),fn('erp_finalize_restore_upload(uuid)',{
      owner:'postgres',securityDefiner:true,authenticatedExecute:true,anonExecute:false,publicExecute:false,
      requiredConfig:['search_path=pg_catalog, public, extensions','statement_timeout=25s','work_mem=16MB'],
      definitionIncludes:['erp_restore_upload_semantic_audit','erp_cloud_restore_validate_waca_dataset',
        'erp_cloud_restore_validate_portability','STALE_RESTORE_PREPARE','request-cleanup','phaseTimingsMs'],
    })],
  },
  '068': {
    sourceFile:'068_restore_ops_conservative_batch_envelope.sql',dependencies:['067'],
    risk:'LOW_PREPARE_OPS_BOUNDED_MAINTENANCE',idempotency:'EXACT_SOURCE_GUARDED_FUNCTION_PATCH',
    classification:'OPS_EPHEMERAL_PREPARED_RESTORE_STATE',
    preconditions:[fn('erp_cleanup_expired_restore_ops(uuid)')],
    postconditions:[fn('erp_cleanup_expired_restore_ops(uuid)',{
      owner:'postgres',securityDefiner:true,authenticatedExecute:true,anonExecute:false,publicExecute:false,
      requiredConfig:['search_path=pg_catalog, public, extensions','statement_timeout=4s','lock_timeout=200ms'],
      definitionIncludes:['LIMIT 4','row_budget integer:=1024','2097152',
        'clock_timestamp()-started)*1000<1000','FOR UPDATE OF u NOWAIT','p_exclude_request_id',"NOT IN('completed','not_committed')"],
    })],
  },
  '067': {
    sourceFile:'067_restore_begin_independent_bounded_ops_cleanup.sql',dependencies:['066'],
    risk:'LOW_PREPARE_OPS_BOUNDED_MAINTENANCE',idempotency:'NEW_OWNER_SCOPED_RPC',
    classification:'OPS_EPHEMERAL_PREPARED_RESTORE_STATE',
    preconditions:[fn('erp_begin_restore_upload(uuid,jsonb,text,text)'),fn('erp_restore_cleanup_expired_upload()')],
    postconditions:[fn('erp_begin_restore_upload(uuid,jsonb,text,text)',{
      owner:'postgres',securityDefiner:true,authenticatedExecute:true,anonExecute:false,publicExecute:false,
      requiredConfig:['search_path=pg_catalog, public, extensions'],
      definitionIncludes:['ON CONFLICT DO NOTHING','RESTORE_PREPARE_BEGIN_TIMEOUT','serverMs'],
    }),fn('erp_cleanup_expired_restore_ops(uuid)',{
      owner:'postgres',securityDefiner:true,authenticatedExecute:true,anonExecute:false,publicExecute:false,
      requiredConfig:['search_path=pg_catalog, public, extensions','statement_timeout=4s','lock_timeout=200ms'],
      // 068 decreases the row/chunk bounds; its exact reduced limits are checked
      // independently. Retain 067 owner, identity, expiry and concurrency gates.
      definitionIncludes:['row_budget','FOR UPDATE OF u NOWAIT','p_exclude_request_id',"NOT IN('completed','not_committed')"],
    })],
  },
  '066': {
    sourceFile:'066_restore_prepare_set_based_resource_staging.sql',dependencies:['064','065'],
    risk:'LOW_PREPARE_SET_BASED_STAGING',idempotency:'EXACT_FUNCTION_REPLACEMENT',
    classification:'OPS_EPHEMERAL_PREPARED_RESTORE_STATE',
    preconditions:[fn('erp_restore_initialize_upload_proof()'),fn('erp_cloud_restore_prepared_profile(uuid,text)')],
    postconditions:[fn('erp_stage_restore_upload_resource(uuid,text)',{
      owner:'postgres',securityDefiner:true,authenticatedExecute:true,anonExecute:false,publicExecute:false,
      requiredConfig:['search_path=pg_catalog, public, extensions','statement_timeout=25s'],
      definitionIncludes:['ch.proof_id=$1 and ch.resource=$2','phaseTimingsMs','STALE_RESTORE_PREPARE','prepared_payload_hash IS NULL'],
    }),fn('erp_finalize_restore_upload(uuid)',{
      owner:'postgres',securityDefiner:true,authenticatedExecute:true,anonExecute:false,publicExecute:false,
      requiredConfig:['search_path=pg_catalog, public, extensions','statement_timeout=25s','work_mem=16MB'],
      definitionIncludes:['erp_cloud_restore_audit_dataset','erp_cloud_restore_relationship_hash',
        'erp_cloud_restore_validate_waca_dataset','erp_cloud_restore_validate_portability','STALE_RESTORE_PREPARE'],
    })],
  },
  '065': {
    sourceFile:'065_cloud_backup_stable_readonly_execution.sql',dependencies:['055'],
    risk:'LOW_BACKUP_READ_ONLY_EXECUTION_MARKER',idempotency:'EXACT_FUNCTION_VOLATILITY_REPLACEMENT',
    preconditions:[fn('erp_export_cloud_restore_snapshot_json()',{
      owner:'postgres',returnType:'json',securityDefiner:true,publicExecute:false,
      authenticatedExecute:true,anonExecute:false,
      requiredConfig:['search_path=pg_catalog, public, extensions'],
      definitionIncludes:['json_build_object','CLOUD_RESTORE_OWNER_REQUIRED'],
    })],
    postconditions:[fn('erp_export_cloud_restore_snapshot_json()',{
      owner:'postgres',returnType:'json',securityDefiner:true,publicExecute:false,
      authenticatedExecute:true,anonExecute:false,
      requiredConfig:['search_path=pg_catalog, public, extensions'],
      definitionIncludes:['STABLE','json_build_object','json_agg(t order by t.inventory_key)',
        'json_agg(t order by t.id)','waca_state','import_batches','CLOUD_RESTORE_OWNER_REQUIRED'],
    })],
  },
  '064': {
    sourceFile:'064_restore_bounded_chunk_batch_and_identity_profile.sql',dependencies:['063'],
    risk:'LOW_PREPARE_BOUNDED_TRANSPORT_AND_PROFILE',idempotency:'FUNCTION_REPLACEMENT_AND_ADDITIVE_RPC',
    classification:'OPS_EPHEMERAL_PREPARED_RESTORE_STATE',
    preconditions:[fn('erp_restore_initialize_upload_proof()')],
    postconditions:[fn('erp_upload_restore_chunk_batch(uuid,jsonb)',{
      owner:'postgres',securityDefiner:true,authenticatedExecute:true,anonExecute:false,publicExecute:false,
      requiredConfig:['statement_timeout=25s'],definitionIncludes:['CLOUD_RESTORE_UPLOAD_BATCH_SIZE_LIMIT','BETWEEN 1 AND 4','erp_upload_restore_chunk'],
    }),fn('erp_cloud_restore_prepared_profile(uuid,text)',{
      owner:'postgres',securityDefiner:true,authenticatedExecute:false,anonExecute:false,publicExecute:false,
      definitionIncludes:['flattened AS MATERIALIZED','SELECT CASE WHEN btrim','identity_value','duplicateAuxiliaryIdentityCount'],
    })],
  },
  '063': {
    sourceFile:'063_restore_prepare_draft_proof_initialization.sql',dependencies:['062'],
    risk:'LOW_PREPARE_DRAFT_INITIALIZATION',idempotency:'ONE_TIME_PRIVATE_OPS_TRIGGER',
    classification:'OPS_EPHEMERAL_PREPARED_RESTORE_STATE',
    preconditions:[table('erp_restore_upload_resource_proofs'),fn('erp_stage_restore_upload_resource(uuid,text)')],
    postconditions:[fn('erp_restore_initialize_upload_proof()',{
      owner:'postgres',securityDefiner:true,authenticatedExecute:false,anonExecute:false,publicExecute:false,
      requiredConfig:['search_path=pg_catalog, public, extensions'],
      definitionIncludes:['NEW.request_id','STAGING','candidate_valid'],
    }),q('trigger','public.erp_restore_upload_requests.erp_restore_initialize_upload_proof',true,
      {definitionIncludes:['AFTER INSERT','erp_restore_initialize_upload_proof']})],
  },
  '062': {
    sourceFile:'062_restore_resource_stage_and_projected_proof.sql',dependencies:['061'],
    risk:'MEDIUM_PREPARE_RESOURCE_STAGING',idempotency:'ONE_TIME_OPS_TABLE_AND_FUNCTION_REPLACEMENT',
    classification:'OPS_EPHEMERAL_PREPARED_RESTORE_STATE',
    preconditions:[table('erp_restore_upload_chunks'),fn('erp_finalize_restore_upload(uuid)')],
    postconditions:[table('erp_restore_upload_resource_proofs',{rls:true,forceRls:true}),
      fn('erp_restore_validation_projection(jsonb)',{authenticatedExecute:false,anonExecute:false,publicExecute:false}),
      fn('erp_stage_restore_upload_resource(uuid,text)',{
        owner:'postgres',securityDefiner:true,authenticatedExecute:true,anonExecute:false,publicExecute:false,
        // 063 initializes the unexecutable STAGING draft in its owner-scoped
        // trigger; 066 no longer repeats that INSERT in each resource stage.
        // Keep stage CAS/hash-null enforcement, and 063 independently requires
        // the trigger plus its STAGING/candidate_valid initialization contract.
        requiredConfig:['statement_timeout=25s'],definitionIncludes:['STALE_RESTORE_PREPARE','prepared_payload_hash IS NULL'],
      }),fn('erp_finalize_restore_upload(uuid)',{
        owner:'postgres',securityDefiner:true,authenticatedExecute:true,anonExecute:false,publicExecute:false,
        requiredConfig:['statement_timeout=25s'],definitionIncludes:['projected-semantic-proof','erp_cloud_restore_validate_waca_dataset',
          'erp_cloud_restore_audit_dataset','erp_cloud_restore_validate_portability','CLOUD_RESTORE_PREPARE_TIMEOUT'],
      })],
  },
  '061': {
    sourceFile:'061_restore_prepare_single_pass_json.sql',dependencies:['060'],
    risk:'LOW_PREPARE_ONLY_SINGLE_PASS',idempotency:'FUNCTION_REPLACEMENT',
    classification:'OPS_EPHEMERAL_PREPARED_RESTORE_STATE',
    preconditions:[table('erp_restore_stage_inventory_items'),fn('erp_finalize_restore_upload(uuid)')],
    postconditions:[fn('erp_finalize_restore_upload(uuid)',{
      owner:'postgres',securityDefiner:true,authenticatedExecute:true,anonExecute:false,publicExecute:false,
      requiredConfig:['statement_timeout=25s'],
      // 062 replaces full aggregation with resource stages; the retained safety
      // effects remain required, and 062 independently checks its replacement.
      definitionIncludes:['json_object_agg','CLOUD_RESTORE_PREPARE_TIMEOUT','STALE_RESTORE_PREPARE'],
    }),fn('erp_cloud_restore_stage_candidate(uuid,text,jsonb,timestamp with time zone)',{
      owner:'postgres',securityDefiner:true,authenticatedExecute:false,anonExecute:false,publicExecute:false,
      definitionIncludes:['supplied_columns AS MATERIALIZED','jsonb_object_keys','DUPLICATE_CANONICAL_ID'],
    })],
  },
  '060': {
    sourceFile:'060_restore_prepare_bounded_finalize.sql',dependencies:['059'],
    risk:'LOW_PREPARE_ONLY_BOUNDED_ASSEMBLY',idempotency:'FUNCTION_REPLACEMENT',
    classification:'OPS_EPHEMERAL_PREPARED_RESTORE_STATE',
    preconditions:[table('erp_restore_upload_chunks'),fn('erp_finalize_restore_upload(uuid)')],
    postconditions:[fn('erp_finalize_restore_upload(uuid)',{
      owner:'postgres',securityDefiner:true,authenticatedExecute:true,anonExecute:false,publicExecute:false,
      requiredConfig:['statement_timeout=25s'],
      definitionIncludes:['CLOUD_RESTORE_PREPARE_TIMEOUT','STALE_RESTORE_PREPARE','CLOUD_RESTORE_UPLOAD_INCOMPLETE'],
    })],
  },
  '059': {
    sourceFile:'059_restore_typed_stage_dashboard_compatibility.sql',dependencies:['058'],
    risk:'LOW_OPS_ONLY_STAGING_COMPATIBILITY',idempotency:'ADDITIVE_IF_NOT_EXISTS',
    classification:'OPS_EPHEMERAL_PREPARED_RESTORE_STATE',
    preconditions:[table('erp_restore_stage_dashboard_category_images',{rls:true,forceRls:true})],
    postconditions:[column('erp_restore_stage_dashboard_category_images','local_id','text'),
      column('erp_restore_stage_dashboard_category_images','version','integer')],
  },
  '058': {
    sourceFile:'058_restore_execute_generation_and_typed_stage.sql',dependencies:['057'],
    risk:'MEDIUM_ATOMIC_RESTORE_EXECUTION_REPLACEMENT',idempotency:'ONE_TIME_SCHEMA_AND_FUNCTION_REPLACEMENT',
    classification:'OPS_EPHEMERAL_PREPARED_RESTORE_STATE',
    preconditions:[table('erp_cloud_restore_prepared_chunks'),fn('erp_restore_staged_cloud_snapshot(uuid,uuid,text,jsonb,text)')],
    postconditions:[
      table('erp_restore_business_generation',{rls:true,forceRls:true}),
      table('erp_restore_upload_requests',{rls:true,forceRls:true}),
      table('erp_restore_upload_chunks',{rls:true,forceRls:true}),
      column('erp_cloud_restore_candidate_proofs','source_generation','bigint'),
      column('erp_cloud_restore_candidate_proofs','source_restore_epoch','bigint'),
      ...[...RESTORE_TABLES,'dashboard_category_images','import_batches',...WACA_TABLES].map(name=>
        table(`erp_restore_stage_${name}`,{rls:true,forceRls:true})),
      fn('erp_restore_track_business_generation()', {securityDefiner:true,authenticatedExecute:false,anonExecute:false}),
      fn('erp_cloud_restore_validate_live_waca()', {securityDefiner:true,authenticatedExecute:false,anonExecute:false}),
      fn('erp_begin_restore_upload(uuid,jsonb,text,text)', {securityDefiner:true,authenticatedExecute:true,anonExecute:false}),
      fn('erp_upload_restore_chunk(uuid,text,integer,jsonb)', {securityDefiner:true,authenticatedExecute:true,anonExecute:false}),
      fn('erp_finalize_restore_upload(uuid)', {securityDefiner:true,authenticatedExecute:true,anonExecute:false}),
      fn('erp_restore_audit_identity_compatibility(uuid[])', {securityDefiner:true,authenticatedExecute:true,anonExecute:false}),
      fn('erp_restore_staged_cloud_snapshot(uuid,uuid,text,jsonb,text)',{
        securityDefiner:true,authenticatedExecute:false,anonExecute:false,
        definitionIncludes:['STALE_RESTORE_PREPARE','SOURCE_GENERATION','typed-staged-generation-v2'],
      }),
      fn('erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)',{
        securityDefiner:true,authenticatedExecute:true,anonExecute:false,
        definitionIncludes:['source_generation','source_restore_epoch','prepareTimingsMs'],
      }),
    ],
  },
  '057': {
    sourceFile:'057_atomic_restore_staged_execution_and_validation.sql',dependencies:['056'],
    risk:'MEDIUM_ATOMIC_RESTORE_EXECUTION_REPLACEMENT',idempotency:'ONE_TIME_SCHEMA_AND_FUNCTION_REPLACEMENT',
    classification:'OPS_EPHEMERAL_PREPARED_RESTORE_STATE',
    preconditions:[
      table('erp_cloud_restore_candidate_proofs',{rls:true,forceRls:true}),
      fn('erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)'),
      fn('erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)'),
    ],
    postconditions:[
      table('erp_cloud_restore_prepared_chunks',{rls:true,forceRls:true}),
      q('primaryKey','public.erp_cloud_restore_prepared_chunks',['proof_id','resource','chunk_ordinal']),
      index('erp_cloud_restore_prepared_chunks_expiry_idx'),
      fn('erp_cloud_restore_validate_waca_dataset(jsonb)',{
        authenticatedExecute:false,anonExecute:false,
        definitionIncludes:['WACA_PAYLOAD_KEY_MISSING','WACA_PAYLOAD_KEY_MISMATCH'],
      }),
      fn('erp_cloud_restore_stage_candidate(uuid,text,jsonb,timestamp with time zone)',{
        securityDefiner:true,authenticatedExecute:false,anonExecute:false,
      }),
      fn('erp_restore_staged_cloud_snapshot(uuid,uuid,text,jsonb,text)',{
        securityDefiner:true,authenticatedExecute:false,anonExecute:false,
      }),
      fn('erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)',{
        securityDefiner:true,authenticatedExecute:true,anonExecute:false,
        requiredConfig:['search_path=pg_catalog, public, extensions','statement_timeout=120s'],
        definitionIncludes:['erp_restore_staged_cloud_snapshot'],
      }),
    ],
  },
  '056': {
    sourceFile:'056_catalog_materialized_purchase_projection.sql',dependencies:['055'],
    risk:'LOW_GUARDED_CATALOG_PROVENANCE_TRANSITION',idempotency:'CREATE_OR_REPLACE_WITH_EXACT_REPLAY',
    preconditions:[fn('erp_apply_catalog_transaction(uuid,jsonb)'),table('inventory_items'),
      table('product_groups'),table('product_variants'),table('erp_idempotency_keys')],
    postconditions:[fn('erp_apply_catalog_transaction(uuid,jsonb)',{
      owner:'postgres',returnType:'jsonb',securityDefiner:true,publicExecute:false,
      authenticatedExecute:true,anonExecute:false,requiredConfig:['search_path=""'],
      definitionIncludes:['CATALOG_PROVENANCE_TRANSITION_FORBIDDEN','inventory_import',
        'myacg_order_import','show_in_purchase_list','exact_replay','erp_apply_field_mutations'],
    })],
  },
  '055': {
    sourceFile:'055_authoritative_backup_json_transport.sql',dependencies:['054'],
    risk:'LOW_ADDITIVE_READ_ONLY_JSON_TRANSPORT',idempotency:'CREATE_OR_REPLACE_EXACT_OUTPUT_PARITY',
    preconditions:[fn('erp_export_cloud_restore_snapshot()'),...WACA_TABLES.map(name=>table(name))],
    postconditions:[fn('erp_export_cloud_restore_snapshot_json()',{
      owner:'postgres',returnType:'json',securityDefiner:true,publicExecute:false,
      authenticatedExecute:true,anonExecute:false,requiredConfig:['search_path=pg_catalog, public, extensions'],
      definitionIncludes:['json_build_object','json_agg(t order by t.inventory_key)',
        'json_agg(t order by t.id)','waca_state','import_batches','CLOUD_RESTORE_OWNER_REQUIRED'],
    })],
  },
  '054': {
    sourceFile:'054_authoritative_backup_json_aggregation.sql',dependencies:['053'],
    risk:'LOW_READ_ONLY_EXPORT_OPTIMIZATION',idempotency:'CREATE_OR_REPLACE_EXACT_OUTPUT_PARITY',
    preconditions:[fn('erp_export_cloud_restore_snapshot()'),...WACA_TABLES.map(name=>table(name))],
    postconditions:[fn('erp_export_cloud_restore_snapshot()',{
      owner:'postgres',returnType:'jsonb',securityDefiner:true,publicExecute:false,
      authenticatedExecute:true,anonExecute:false,requiredConfig:['search_path=pg_catalog, public, extensions'],
      definitionIncludes:['json_build_object','json_agg(t order by t.inventory_key)',
        'json_agg(t order by t.id)','waca_state','import_batches','CLOUD_RESTORE_OWNER_REQUIRED'],
    })],
  },
  '053': {
    sourceFile:'053_outbound_status_changed_at_restore_compatibility.sql',dependencies:['045c','052'],
    risk:'LOW_INTERNAL_RESTORE_WRITER_COMPATIBILITY',idempotency:'CREATE_OR_REPLACE_STATE_GUARDED',
    allowPartialApply:true,
    preconditions:[
      table('outbound_shipments'),column('outbound_shipments','status_changed_at','timestamp with time zone'),
      fn('erp_set_outbound_status_changed_at()'),fn('erp_cloud_restore_insert_rows(regclass,jsonb)'),
      fn('erp_merge_waca_master_links(uuid,jsonb)'),
    ],
    postconditions:[fn('erp_cloud_restore_insert_rows(regclass,jsonb)',{
      owner:'postgres',returnType:'bigint',securityDefiner:true,publicExecute:false,
      authenticatedExecute:false,anonExecute:false,requiredConfig:['search_path=pg_catalog, public'],
      definitionIncludes:['jsonb_to_recordset(p_rows)','status_changed_at',
        'CLOUD_RESTORE_OUTBOUND_TIMESTAMP_EVIDENCE_MISSING',
        'CLOUD_RESTORE_OUTBOUND_TIMESTAMP_ROW_COUNT_MISMATCH',
        'CLOUD_RESTORE_OUTBOUND_TIMESTAMP_MISMATCH'],
    }),fn('sync_audit_columns()',{
      owner:'postgres',returnType:'trigger',securityDefiner:true,publicExecute:false,
      authenticatedExecute:false,anonExecute:false,requiredConfig:['search_path=public'],
      definitionIncludes:['outbound_shipments','to_jsonb(new) - \'status_changed_at\''],
    }),fn('erp_set_outbound_status_changed_at()',{
      owner:'postgres',returnType:'trigger',securityDefiner:false,publicExecute:false,
      authenticatedExecute:false,anonExecute:false,requiredConfig:['search_path=pg_catalog, public'],
      definitionIncludes:['OUTBOUND_STATUS_TIMESTAMP_SYSTEM_MANAGED','current_user'],
    }),q('trigger','public.outbound_shipments.erp_outbound_status_changed_at')],
  },
  '052': {
    sourceFile:'052_waca_master_link_delta_merge.sql',dependencies:['044','051'],
    risk:'LOW_ADDITIVE_FUNCTION_ONLY',idempotency:'IDEMPOTENCY_STORE_AND_WACA_REVISION_CAS',
    preconditions:[table('waca_master_links'),table('waca_state'),table('erp_idempotency_keys'),fn('erp_waca_variant_id(text)')],
    postconditions:[fn('erp_merge_waca_master_links(uuid,jsonb)',{
      owner:'postgres',returnType:'jsonb',securityDefiner:true,publicExecute:false,
      authenticatedExecute:true,anonExecute:false,requiredConfig:['search_path=""'],
      definitionIncludes:['waca_master_links','expectedRevision','erp_idempotency_keys'],
    })],
  },
  '051': {
    sourceFile:'051_related_saveability_atomic_transactions.sql',dependencies:['050'],
    risk:'LOW_ADDITIVE',idempotency:'RERUN_SAFE_WITH_CANONICAL_SHAPE_ONLY',
    preconditions:[fn('erp_apply_field_mutations(text,jsonb)'),table('erp_idempotency_keys')],
    postconditions:[fn('erp_apply_related_transaction(uuid,jsonb)',{
      owner:'postgres',returnType:'jsonb',securityDefiner:true,publicExecute:false,
      authenticatedExecute:true,anonExecute:false,requiredConfig:['search_path=""'],
      definitionIncludes:['expectedRecords','erp_apply_field_mutations'],
    })],
  },
  '050': {
    sourceFile:'050_catalog_atomic_transaction.sql',dependencies:['049'],
    risk:'LOW_ADDITIVE',idempotency:'RERUN_SAFE_WITH_CANONICAL_SHAPE_ONLY',
    preconditions:[fn('erp_apply_field_mutations(text,jsonb)'),table('erp_idempotency_keys')],
    postconditions:[fn('erp_apply_catalog_transaction(uuid,jsonb)',{
      owner:'postgres',returnType:'jsonb',securityDefiner:true,publicExecute:false,
      authenticatedExecute:true,anonExecute:false,requiredConfig:['search_path=""'],
      definitionIncludes:['dependencies','SHARE ROW EXCLUSIVE','erp_apply_field_mutations'],
    })],
  },
  '049': {
    sourceFile:'049_private_order_atomic_transaction.sql',dependencies:['048'],
    risk:'LOW_ADDITIVE',idempotency:'RERUN_SAFE_WITH_CANONICAL_SHAPE_ONLY',
    preconditions:[fn('erp_apply_field_mutations(text,jsonb)'),table('private_orders'),table('private_order_items'),table('erp_idempotency_keys')],
    postconditions:[fn('erp_apply_private_order_transaction(uuid,jsonb)',{
      owner:'postgres',returnType:'jsonb',securityDefiner:true,publicExecute:false,
      authenticatedExecute:true,anonExecute:false,requiredConfig:['search_path=""'],
      definitionIncludes:['expectedItems','expectedParentVersion','erp_apply_field_mutations'],
    }),fn('erp_reconcile_private_order_transaction(uuid,jsonb)',{
      owner:'postgres',returnType:'jsonb',securityDefiner:true,publicExecute:false,
      authenticatedExecute:true,anonExecute:false,requiredConfig:['search_path=""'],
      definitionIncludes:['request_payload','private-order','committed'],
    })],
  },
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
  '048': {
    sourceFile: '048_erp2_live_canonical_contract_reconciliation.sql', dependencies: ['047'],
    risk: 'MEDIUM_STATE_GUARDED_SCHEMA_AND_ACL_RECONCILIATION',
    idempotency: 'STATE_GUARDED_RERUN_SAFE', allowPartialApply: true,
    preconditions: [
      ...['bundle_components','dashboard_category_images','erp_cloud_restore_epoch','japan_package_items',
        'japan_packages','outbound_shipment_items','outbound_shipments','private_order_items','private_orders',
        'product_categories','product_groups','product_variants','profiles','purchase_batch_items','purchase_batches',
        'sales_order_items','sales_orders'].map(name => table(name)),
      fn('is_owner(uuid)'), fn('is_editor(uuid)'),
      ...['bundle_components','dashboard_category_images','japan_package_items','japan_packages',
        'outbound_shipment_items','outbound_shipments','private_order_items','private_orders','product_categories',
        'product_groups','product_variants','purchase_batch_items','purchase_batches','sales_order_items','sales_orders']
        .flatMap(name => [
          q('tableGrantSubset', `public.${name}.anon`, ['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE']),
          q('tableGrantSubset', `public.${name}.authenticated`,
            ['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']),
        ]),
      q('tableGrantSubset', 'public.profiles.anon', ['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE']),
      q('tableGrantSubset', 'public.profiles.authenticated', ['MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE']),
      q('tableGrantSubset', 'public.erp_cloud_restore_epoch.anon', ['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE']),
      q('tableGrantSubset', 'public.erp_cloud_restore_epoch.authenticated', ['MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE']),
    ],
    postconditions: [
      column('product_groups','proxy_agent','text',{ nullable: true }),
      column('product_groups','show_in_purchase_list','boolean',{ nullable: false }),
      column('product_groups','purchase_date','date',{ nullable: true }),
      column('purchase_batches','date','date',{ nullable: true }),
      column('product_variants','private_manual_adjustment','integer',{ nullable: true }),
      column('product_variants','purchased_manual_adjustment','integer',{ nullable: true }),
      q('foreignKey','public.private_orders',true,{ columns:['product_group_id'], referencedTable:'public.product_groups',
        referencedColumns:['id'], onDelete:'CASCADE', mismatchIsMissing:true }),
      q('foreignKey','public.purchase_batches',true,{ columns:['product_group_id'], referencedTable:'public.product_groups',
        referencedColumns:['id'], onDelete:'CASCADE', mismatchIsMissing:true }),
      ...['inventory_items','private_order_items','product_categories','product_groups','product_variants',
        'purchase_batch_items','purchase_batches'].map(name => q('policy',`public.${name}.select_policy`)),
      ...['insert_policy','update_policy','delete_policy'].flatMap(name => [
        q('policy',`public.sales_orders.${name}`), q('policy',`public.sales_order_items.${name}`),
      ]),
      ...['bundle_components','dashboard_category_images','japan_package_items','japan_packages',
        'outbound_shipment_items','outbound_shipments','private_order_items','private_orders','product_categories',
        'product_groups','product_variants','purchase_batch_items','purchase_batches','sales_order_items','sales_orders']
        .flatMap(name => [
          q('tableGrant',`public.${name}.anon`,[],{ mismatchIsMissing:true }),
          q('tableGrant',`public.${name}.authenticated`,['DELETE','INSERT','SELECT','UPDATE'],{ mismatchIsMissing:true }),
        ]),
      q('tableGrant','public.profiles.anon',[],{ mismatchIsMissing:true }),
      q('tableGrant','public.profiles.authenticated',['SELECT'],{ mismatchIsMissing:true }),
      q('tableGrant','public.erp_cloud_restore_epoch.anon',[],{ mismatchIsMissing:true }),
      q('tableGrant','public.erp_cloud_restore_epoch.authenticated',['SELECT'],{ mismatchIsMissing:true }),
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
