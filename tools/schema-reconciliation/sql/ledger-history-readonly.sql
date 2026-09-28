-- POST-ADOPTION ONLY. Run after the presence query confirms the project-owned
-- ledger exists. This reads environment-local operational evidence, not data.
select jsonb_agg(jsonb_build_object(
  'eventType',event_type,'eventKey',event_key,'sourceChecksum',source_checksum,
  'sourceHead',source_head,'checkpoint',checkpoint,
  'schemaFingerprintBefore',schema_fingerprint_before,'schemaFingerprintAfter',schema_fingerprint_after,
  'environmentRole',environment_role,'supabaseProjectRef',supabase_project_ref,
  'recordedAt',recorded_at,'result',result,'metadata',metadata
) order by recorded_at,id) as erp_schema_migration_history
from public.erp_schema_migration_ledger;
