-- Read-only WACA / Restore presence summary. It returns structural names only.
with expected(kind,name) as (values
  ('table','import_batches'),('table','waca_orders'),('table','waca_order_items'),('table','waca_mappings'),
  ('table','waca_master_links'),('table','waca_import_batches'),('table','waca_cutover_audit'),('table','waca_state'),
  ('function','erp_waca_variant_id(text)'),('function','erp_read_waca_snapshot()'),
  ('function','erp_commit_waca_snapshot(jsonb,bigint,boolean)'),
  ('function','erp_cloud_restore_validate_waca_dataset(jsonb)'),
  ('function','erp_cloud_restore_recompute_waca_quantities()'),
  ('function','erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)'),
  ('function','erp_reconcile_cloud_restore_attempt(uuid,uuid)'),
  ('function','erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)'),
  ('function','erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)')
)
select jsonb_agg(jsonb_build_object(
  'kind',kind,'name',name,'present',case when kind='table' then to_regclass('public.'||name) is not null
    else to_regprocedure('public.'||name) is not null end
) order by kind,name) as waca_restore_presence from expected;
