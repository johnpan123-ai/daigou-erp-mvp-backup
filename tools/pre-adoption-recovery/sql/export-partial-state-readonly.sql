-- ERP 2.0 PRE-ADOPTION PARTIAL-STATE RECOVERY EXPORT v1
-- SELECT-only. This query performs no DDL, DML, RPC mutation or restore.
-- Export the single JSON result cell without saving it in the repository.
with core as (
  select public.erp_cloud_restore_snapshot() as snapshot
), supplement as (
  select jsonb_build_object(
    'import_batches', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.import_batches t), '[]'::jsonb),
    'waca_orders', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_orders t), '[]'::jsonb),
    'waca_order_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_order_items t), '[]'::jsonb),
    'waca_mappings', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_mappings t), '[]'::jsonb),
    'waca_master_links', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_master_links t), '[]'::jsonb),
    'waca_import_batches', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_import_batches t), '[]'::jsonb),
    'waca_cutover_audit', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_cutover_audit t), '[]'::jsonb),
    'waca_state', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_state t), '[]'::jsonb)
  ) as data
), evidence as (
  select jsonb_build_object(
    'current_database', current_database(),
    'core_resource_count', (select count(*) from jsonb_object_keys(core.snapshot)),
    'inventory_integrity', jsonb_build_object(
      'rows', (select count(*) from public.inventory_items),
      'null_id', (select count(*) from public.inventory_items where id is null),
      'invalid_uuid', (select count(*) from public.inventory_items where id::text !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
      'duplicate_id', (select count(*) - count(distinct id) from public.inventory_items),
      'null_inventory_key', (select count(*) from public.inventory_items where inventory_key is null),
      'duplicate_inventory_key', (select count(*) - count(distinct inventory_key) from public.inventory_items)
    ),
    'partial_contract', jsonb_build_object(
      'import_batches_present', to_regclass('public.import_batches') is not null,
      'waca_state_present', to_regclass('public.waca_state') is not null,
      'waca_validator_absent', to_regprocedure('public.erp_cloud_restore_validate_waca_dataset(jsonb)') is null,
      'waca_recompute_absent', to_regprocedure('public.erp_cloud_restore_recompute_waca_quantities()') is null,
      'migration_ledger_absent', to_regclass('public.erp_schema_migration_ledger') is null
    )
  ) as data
  from core
)
select jsonb_build_object(
  'exportContractVersion', 1,
  'recoveryKind', 'PRE_ADOPTION_PARTIAL_STATE',
  'capturedAt', clock_timestamp(),
  'coreLegacySnapshot', core.snapshot,
  'partialStateSupplement', supplement.data,
  'captureEvidence', evidence.data
) as erp2_pre_adoption_partial_state_export
from core, supplement, evidence;
