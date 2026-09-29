-- SELECT-only evidence for the post-018b Restore compatibility decision.
-- It returns catalog/behavior facts only; no business rows are returned.
with
  expected as (
    select array['bundle_components','dashboard_category_images','import_batches','inventory_items',
      'japan_package_items','japan_packages','outbound_shipment_items','outbound_shipments',
      'private_order_items','private_orders','product_categories','product_groups','product_variants',
      'purchase_batch_items','purchase_batches','sales_order_items','sales_orders','waca_cutover_audit',
      'waca_import_batches','waca_mappings','waca_master_links','waca_order_items','waca_orders','waca_state']::text[] full_keys
  ),
  snapshot as (select public.erp_cloud_restore_snapshot() data),
  observed as (select array_agg(key order by key) keys from snapshot,jsonb_object_keys(data) key),
  audited as (select public.erp_cloud_restore_audit_dataset(data) result from snapshot),
  functions(signature,markers) as (values
    ('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)',array['erp_cloud_restore_failures','execution_started_at']::text[]),
    ('public.erp_reconcile_cloud_restore_attempt(uuid,uuid)',array['execution_id','not_committed']::text[]),
    ('public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)',array['erp_prove_cloud_restore_candidate','erp_cloud_restore_build_effective_snapshot','proof_id','request_id']::text[]),
    ('public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)',array['p_proof_id','rpc=executeevent=db-entry']::text[])
  ),
  function_facts as (
    select signature,p.oid is not null function_exists,r.rolname owner,p.prosecdef security_definer,
      p.proconfig,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
      has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
      has_function_privilege('public',p.oid,'EXECUTE') public_execute,
      coalesce((select bool_and(strpos(lower(regexp_replace(pg_get_functiondef(p.oid),'[[:space:]]+','','g')),marker)>0)
        from unnest(markers) marker),false) semantic_markers
    from functions left join pg_proc p on p.oid=to_regprocedure(signature)
    left join pg_roles r on r.oid=p.proowner
  ),
  state as (
    select observed.keys,(select full_keys from expected) full_keys,
      to_regprocedure('public.erp_cloud_restore_validate_waca_dataset(jsonb)') is not null validator,
      to_regprocedure('public.erp_cloud_restore_recompute_waca_quantities()') is not null recompute,
      exists(select 1 from pg_trigger where tgrelid='public.import_batches'::regclass
        and tgname='erp_cloud_restore_maintenance_guard' and not tgisinternal) import_guard,
      not exists(select 1 from function_facts where not function_exists or owner<>'postgres'
        or not security_definer or not authenticated_execute or anon_execute or public_execute
        or not semantic_markers) control_plane
    from observed,audited
  )
select jsonb_build_object(
  'compatibilityState',case
    when not control_plane then 'STATE_E_UNKNOWN_CONFLICT'
    when cardinality(keys)=15 and not validator and not recompute and not import_guard then 'STATE_A_PRE_045'
    when cardinality(keys)=15 and validator and recompute then 'STATE_B_045_PARTIAL'
    when keys=full_keys and validator and recompute and not import_guard then 'STATE_C_045B_COMPATIBLE'
    when keys=full_keys and validator and recompute and import_guard then 'STATE_D_CANONICAL'
    else 'STATE_E_UNKNOWN_CONFLICT' end,
  'snapshotKeys',to_jsonb(keys),'resourceCount',cardinality(keys),
  'validator',validator,'recompute',recompute,'importGuard',import_guard,
  'controlPlane',control_plane,
  'functions',(select jsonb_agg(to_jsonb(function_facts) order by signature) from function_facts),
  'auditSummary',(select result from audited)
) as waca_045c_semantic_state
from state;
