-- SELECT-only compatibility evidence for 045b. No business rows are returned.
with
  signatures(signature,contract,required_markers) as (values
    ('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)','041/042',array['erp_cloud_restore_failures','execution_started_at']::text[]),
    ('public.erp_reconcile_cloud_restore_attempt(uuid,uuid)','041/042',array['execution_id','not_committed']::text[]),
    ('public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)','043',array['erp_prove_cloud_restore_candidate','erp_cloud_restore_build_effective_snapshot','proof_id']::text[]),
    ('public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)','043',array['p_proof_id','rpc=executeevent=db-entry']::text[]),
    ('public.erp_cloud_restore_audit_dataset(jsonb)','045-base',array['outbound_shipment_items']::text[])
  ),
  observed as (
    select signature,contract,required_markers,to_regprocedure(signature) oid,
      case when to_regprocedure(signature) is null then null else
        lower(regexp_replace(pg_get_functiondef(to_regprocedure(signature)),'[[:space:]]+','','g')) end definition
    from signatures
  ),
  checks as (
    select signature,contract,oid is not null function_exists,
      coalesce((select bool_and(strpos(definition,marker)>0) from unnest(required_markers) marker),false) markers_match
    from observed
  ),
  state as (
    select
      to_regprocedure('public.erp_cloud_restore_validate_waca_dataset(jsonb)') is not null validate_exists,
      to_regprocedure('public.erp_cloud_restore_recompute_waca_quantities()') is not null recompute_exists,
      lower(regexp_replace(coalesce(pg_get_functiondef(
        to_regprocedure('public.erp_cloud_restore_audit_dataset(jsonb)')),''),'[[:space:]]+','','g')) audit_definition
  )
select jsonb_build_object(
  'compatibilityState',case
    when not validate_exists and not recompute_exists
      and strpos(audit_definition,'<>15')>0 and strpos(audit_definition,'waca_order_items')=0
      and not exists(select 1 from checks where not function_exists or not markers_match)
      then 'PRE_045_SUPPORTED'
    when validate_exists and recompute_exists
      and strpos(audit_definition,'<>24')>0 and strpos(audit_definition,'waca_order_items')>0
      and not exists(select 1 from checks where not function_exists or not markers_match)
      then 'POST_045_SUPPORTED'
    else 'CONFLICT'
  end,
  'validateExists',validate_exists,
  'recomputeExists',recompute_exists,
  'functions',(select jsonb_agg(jsonb_build_object(
    'signature',signature,'contract',contract,'exists',function_exists,'markersMatch',markers_match
  ) order by signature) from checks)
) as waca_045b_compatibility
from state;
