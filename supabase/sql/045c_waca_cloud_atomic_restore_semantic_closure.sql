begin;

-- One-shot compatibility closure for the observed post-018b live state.
-- Historical 045/045b remain immutable failed artifacts. This migration uses
-- behavior and catalog contracts for state selection, then installs complete
-- canonical definitions; it never searches or replaces function source text.
create temporary table erp_waca_restore_045c_state(state text primary key,evidence jsonb not null) on commit drop;

do $preflight$
declare
  v_core text[]:=array['bundle_components','inventory_items','japan_package_items','japan_packages','outbound_shipment_items','outbound_shipments','private_order_items','private_orders','product_categories','product_groups','product_variants','purchase_batch_items','purchase_batches','sales_order_items','sales_orders'];
  v_full text[]:=array['bundle_components','dashboard_category_images','import_batches','inventory_items','japan_package_items','japan_packages','outbound_shipment_items','outbound_shipments','private_order_items','private_orders','product_categories','product_groups','product_variants','purchase_batch_items','purchase_batches','sales_order_items','sales_orders','waca_cutover_audit','waca_import_batches','waca_mappings','waca_master_links','waca_order_items','waca_orders','waca_state'];
  v_empty_core jsonb; v_empty_full jsonb; v_snapshot_keys text[];
  v_audit_core boolean:=false; v_audit_full boolean:=false;
  v_validate boolean:=to_regprocedure('public.erp_cloud_restore_validate_waca_dataset(jsonb)') is not null;
  v_recompute boolean:=to_regprocedure('public.erp_cloud_restore_recompute_waca_quantities()') is not null;
  v_guard boolean; v_control boolean; v_control_semantics boolean;
  v_surface boolean; v_canonical_semantics boolean; v_state text;
begin
  if current_user<>'postgres' then raise exception using errcode='55000',message='WACA_045C_OWNER_REQUIRED'; end if;
  if exists(select 1 from unnest(array['public.import_batches','public.dashboard_category_images','public.waca_orders','public.waca_order_items','public.waca_mappings','public.waca_master_links','public.waca_import_batches','public.waca_cutover_audit','public.waca_state']) name where to_regclass(name) is null) then
    raise exception using errcode='55000',message='WACA_045C_REQUIRED_TABLE_MISSING';
  end if;
  if exists(select 1 from unnest(array['public.erp_cloud_restore_table_profile(regclass,jsonb)','public.erp_cloud_restore_insert_rows(regclass,jsonb)','public.erp_cloud_restore_snapshot()','public.erp_export_cloud_restore_snapshot()','public.erp_read_cloud_restore_integrity_audit()','public.erp_cloud_restore_relationship_hash(jsonb)','public.erp_cloud_restore_live_relationship_hash()','public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)','public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)','public.erp_cloud_restore_audit_dataset(jsonb)','public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)','public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)']) signature where to_regprocedure(signature) is null) then
    raise exception using errcode='55000',message='WACA_045C_RESTORE_SURFACE_MISSING';
  end if;
  if v_validate is distinct from v_recompute then raise exception using errcode='55000',message='WACA_045C_PARTIAL_HELPER_STATE'; end if;
  select jsonb_object_agg(key,'[]'::jsonb) into v_empty_core from unnest(v_core) key;
  select jsonb_object_agg(key,'[]'::jsonb) into v_empty_full from unnest(v_full) key;
  begin perform public.erp_cloud_restore_audit_dataset(v_empty_core);v_audit_core:=true;exception when sqlstate '22023' then v_audit_core:=false;end;
  begin perform public.erp_cloud_restore_audit_dataset(v_empty_full);v_audit_full:=true;exception when sqlstate '22023' then v_audit_full:=false;end;
  begin select array_agg(key order by key) into v_snapshot_keys from jsonb_object_keys(public.erp_cloud_restore_snapshot()) key;
  exception when others then raise exception using errcode='55000',message='WACA_045C_SNAPSHOT_PROBE_FAILED:'||sqlstate;end;
  select exists(select 1 from pg_trigger where tgrelid='public.import_batches'::regclass and tgname='erp_cloud_restore_maintenance_guard' and not tgisinternal) into v_guard;
  select not exists(select 1 from (values
    ('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)',array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]),
    ('public.erp_reconcile_cloud_restore_attempt(uuid,uuid)',array['search_path=pg_catalog, public, extensions','statement_timeout=10s']::text[]),
    ('public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)',array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]),
    ('public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)',array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[])
  ) e(signature,configs) left join pg_proc p on p.oid=to_regprocedure(e.signature) left join pg_roles r on r.oid=p.proowner
  where p.oid is null or r.rolname<>'postgres' or not p.prosecdef or pg_get_function_result(p.oid)<>'jsonb'
    or not (coalesce(p.proconfig,'{}'::text[])@>e.configs and coalesce(p.proconfig,'{}'::text[])<@e.configs)
    or not has_function_privilege('authenticated',p.oid,'EXECUTE')
    or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('public',p.oid,'EXECUTE')) into v_control;
  select not exists(select 1 from (values
    ('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)',array['erp_cloud_restore_failures','execution_started_at']::text[]),
    ('public.erp_reconcile_cloud_restore_attempt(uuid,uuid)',array['execution_id','not_committed']::text[]),
    ('public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)',array['erp_prove_cloud_restore_candidate','erp_cloud_restore_build_effective_snapshot','proof_id','request_id']::text[]),
    ('public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)',array['p_proof_id','rpc=executeevent=db-entry']::text[])
  ) e(signature,markers) cross join lateral(select lower(regexp_replace(
    pg_get_functiondef(to_regprocedure(e.signature)),'[[:space:]]+','','g')) definition) d
  where exists(select 1 from unnest(e.markers) marker where strpos(d.definition,marker)=0)) into v_control_semantics;
  select not exists(select 1 from unnest(array['public.erp_cloud_restore_table_profile(regclass,jsonb)','public.erp_cloud_restore_insert_rows(regclass,jsonb)','public.erp_cloud_restore_snapshot()','public.erp_export_cloud_restore_snapshot()','public.erp_read_cloud_restore_integrity_audit()','public.erp_cloud_restore_relationship_hash(jsonb)','public.erp_cloud_restore_live_relationship_hash()','public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)','public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)','public.erp_cloud_restore_audit_dataset(jsonb)','public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)','public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)']) signature join pg_proc p on p.oid=to_regprocedure(signature) join pg_roles r on r.oid=p.proowner
    where r.rolname<>'postgres' or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('public',p.oid,'EXECUTE')) into v_surface;
  select not exists(select 1 from (values
    ('public.erp_cloud_restore_table_profile(regclass,jsonb)',array['import_batches','waca_state']::text[]),
    ('public.erp_cloud_restore_insert_rows(regclass,jsonb)',array['import_batches','waca_state']::text[]),
    ('public.erp_cloud_restore_snapshot()',array['import_batches','waca_state']::text[]),
    ('public.erp_export_cloud_restore_snapshot()',array['import_batches','waca_state']::text[]),
    ('public.erp_read_cloud_restore_integrity_audit()',array['erp_cloud_restore_validate_waca_dataset','waca_state']::text[]),
    ('public.erp_cloud_restore_relationship_hash(jsonb)',array['waca_order_items','waca_mappings']::text[]),
    ('public.erp_cloud_restore_live_relationship_hash()',array['waca_order_items','waca_mappings']::text[]),
    ('public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)',array['import_batches','waca_state']::text[]),
    ('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)',array['import_batches','waca_state']::text[]),
    ('public.erp_cloud_restore_audit_dataset(jsonb)',array['waca_order_items','waca_mappings']::text[]),
    ('public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)',array['erp_cloud_restore_validate_waca_dataset','resource_count']::text[]),
    ('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)',array['erp_cloud_restore_validate_waca_dataset','erp_cloud_restore_recompute_waca_quantities','import_batches','waca_state','cloud-erp-snapshot-v2']::text[])
  ) e(signature,markers) cross join lateral(select lower(regexp_replace(
    pg_get_functiondef(to_regprocedure(e.signature)),'[[:space:]]+','','g')) definition) d
  where exists(select 1 from unnest(e.markers) marker where strpos(d.definition,marker)=0)) into v_canonical_semantics;
  if not v_control or not v_control_semantics or not v_surface then v_state:='STATE_E_UNKNOWN_CONFLICT';
  elsif v_audit_core and not v_audit_full and v_snapshot_keys=v_core and not v_validate and not v_recompute and not v_guard then v_state:='STATE_A_PRE_045';
  elsif not v_audit_core and v_audit_full and v_validate and v_recompute and v_snapshot_keys=v_core then v_state:='STATE_B_045_PARTIAL';
  elsif not v_audit_core and v_audit_full and v_validate and v_recompute and v_snapshot_keys=v_full and (not v_guard or not v_canonical_semantics) then v_state:='STATE_C_045B_COMPATIBLE';
  elsif not v_audit_core and v_audit_full and v_validate and v_recompute and v_snapshot_keys=v_full and v_guard and v_canonical_semantics then v_state:='STATE_D_CANONICAL';
  else v_state:='STATE_E_UNKNOWN_CONFLICT'; end if;
  insert into pg_temp.erp_waca_restore_045c_state values(v_state,jsonb_build_object('auditCoreAccepted',v_audit_core,'auditFullAccepted',v_audit_full,'snapshotKeys',to_jsonb(v_snapshot_keys),'validator',v_validate,'recompute',v_recompute,'importGuard',v_guard,'controlPlane',v_control,'controlSemantics',v_control_semantics,'surfaceMetadata',v_surface,'canonicalSemantics',v_canonical_semantics));
  if v_state='STATE_E_UNKNOWN_CONFLICT' then raise exception using errcode='55000',
    message='WACA_045C_UNKNOWN_SEMANTIC_STATE:'||(select evidence::text from pg_temp.erp_waca_restore_045c_state); end if;
end;$preflight$;

do $install$
declare v_state text:=(select state from pg_temp.erp_waca_restore_045c_state);
begin
  perform set_config('erp.waca_045c_detected_state',v_state,true);
  if v_state='STATE_D_CANONICAL' then return; end if;
  drop trigger if exists erp_cloud_restore_maintenance_guard on public.import_batches;
  create trigger erp_cloud_restore_maintenance_guard before insert or update or delete on public.import_batches for each statement execute function public.erp_assert_cloud_restore_unlocked();
  execute $canonical_01$CREATE OR REPLACE FUNCTION public.erp_cloud_restore_table_profile(p_table regclass, p_rows jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
declare
  v_sql text;
  v_profile jsonb;
  v_auxiliary_identity_sql text;
  v_duplicate_identity_sql text;
begin
  if p_table not in (
    'public.inventory_items'::regclass,'public.product_groups'::regclass,'public.product_categories'::regclass,
    'public.product_variants'::regclass,'public.bundle_components'::regclass,'public.purchase_batches'::regclass,
    'public.purchase_batch_items'::regclass,'public.private_orders'::regclass,'public.private_order_items'::regclass,
    'public.sales_orders'::regclass,'public.sales_order_items'::regclass,'public.japan_packages'::regclass,
    'public.japan_package_items'::regclass,'public.outbound_shipments'::regclass,'public.outbound_shipment_items'::regclass,'public.import_batches'::regclass,
    'public.dashboard_category_images'::regclass,
    'public.waca_orders'::regclass,'public.waca_order_items'::regclass,
    'public.waca_mappings'::regclass,'public.waca_master_links'::regclass,
    'public.waca_import_batches'::regclass,'public.waca_cutover_audit'::regclass,
    'public.waca_state'::regclass
  ) then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_TABLE_NOT_ALLOWED';
  end if;
  if p_rows is not null and jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_RESOURCE_NOT_ARRAY';
  end if;

  if p_rows is null then
    v_auxiliary_identity_sql := case
      when p_table = 'public.product_variants'::regclass
        then 'nullif(btrim(row_value.local_id::text), '''')'
      when p_table = 'public.inventory_items'::regclass
        then 'nullif(btrim(row_value.inventory_key::text), '''')'
      else 'null::text'
    end;
    v_duplicate_identity_sql := case
      when p_table = 'public.inventory_items'::regclass
        then '(count(identity_value) - count(distinct identity_value)) + (count(auxiliary_identity) - count(distinct auxiliary_identity))'
      else 'count(identity_value) - count(distinct identity_value)'
    end;
    v_sql := format($profile$
      with normalized_rows as (
        select
          nullif(btrim(row_value.id::text), '') as identity_value,
          %s as auxiliary_identity
        from %s row_value
      )
      select jsonb_build_object(
        'count', count(*),
        'missingIdentityCount', count(*) filter (where identity_value is null),
        'duplicateIdentityCount', %s,
        'duplicateAuxiliaryIdentityCount', count(auxiliary_identity) - count(distinct auxiliary_identity),
        'identityHash', encode(digest(convert_to(coalesce(
          string_agg(identity_value, E'\n' order by identity_value), ''
        ), 'UTF8'), 'sha256'), 'hex')
      )
      from normalized_rows
    $profile$, v_auxiliary_identity_sql, p_table, v_duplicate_identity_sql);
    execute v_sql into v_profile;
  else
    v_auxiliary_identity_sql := case
      when p_table = 'public.product_variants'::regclass
        then 'nullif(btrim(row_value->>''local_id''), '''')'
      when p_table = 'public.inventory_items'::regclass
        then 'nullif(btrim(row_value->>''inventory_key''), '''')'
      else 'null::text'
    end;
    v_duplicate_identity_sql := case
      when p_table = 'public.inventory_items'::regclass
        then '(count(identity_value) - count(distinct identity_value)) + (count(auxiliary_identity) - count(distinct auxiliary_identity))'
      else 'count(identity_value) - count(distinct identity_value)'
    end;
    v_sql := format($profile$
      with normalized_rows as (
        select
          case
            when btrim(row_value->>'id') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
              then lower(btrim(row_value->>'id'))
            else null
          end as identity_value,
          %s as auxiliary_identity
        from jsonb_array_elements($1) row_value
      )
      select jsonb_build_object(
        'count', count(*),
        'missingIdentityCount', count(*) filter (where identity_value is null),
        'duplicateIdentityCount', %s,
        'duplicateAuxiliaryIdentityCount', count(auxiliary_identity) - count(distinct auxiliary_identity),
        'identityHash', encode(digest(convert_to(coalesce(
          string_agg(identity_value, E'\n' order by identity_value), ''
        ), 'UTF8'), 'sha256'), 'hex')
      )
      from normalized_rows
    $profile$, v_auxiliary_identity_sql, v_duplicate_identity_sql);
    execute v_sql using p_rows into v_profile;
  end if;
  return v_profile;
end;
$function$
;$canonical_01$;

  execute $canonical_02$CREATE OR REPLACE FUNCTION public.erp_cloud_restore_insert_rows(p_table regclass, p_rows jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_columns text;
  v_count bigint;
begin
  if p_table not in (
    'public.inventory_items'::regclass,'public.product_groups'::regclass,'public.product_categories'::regclass,
    'public.product_variants'::regclass,'public.bundle_components'::regclass,'public.purchase_batches'::regclass,
    'public.purchase_batch_items'::regclass,'public.private_orders'::regclass,'public.private_order_items'::regclass,
    'public.sales_orders'::regclass,'public.sales_order_items'::regclass,'public.japan_packages'::regclass,
    'public.japan_package_items'::regclass,'public.outbound_shipments'::regclass,'public.outbound_shipment_items'::regclass,'public.import_batches'::regclass,
    'public.dashboard_category_images'::regclass,
    'public.waca_orders'::regclass,'public.waca_order_items'::regclass,
    'public.waca_mappings'::regclass,'public.waca_master_links'::regclass,
    'public.waca_import_batches'::regclass,'public.waca_cutover_audit'::regclass,
    'public.waca_state'::regclass
  ) then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_TABLE_NOT_ALLOWED';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_RESOURCE_NOT_ARRAY';
  end if;
  if jsonb_array_length(p_rows) = 0 then return 0; end if;
  select string_agg(quote_ident(a.attname), ',' order by a.attnum)
    into v_columns
    from pg_attribute a
   where a.attrelid = p_table and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
     and exists (select 1 from jsonb_array_elements(p_rows) row_value where row_value ? a.attname);
  if v_columns is null then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_NO_ALLOWED_COLUMNS';
  end if;
  execute format(
    'insert into %s (%s) select %s from jsonb_populate_recordset(null::%s, $1)',
    p_table, v_columns, v_columns, p_table
  ) using p_rows;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$
;$canonical_02$;

  execute $canonical_03$CREATE OR REPLACE FUNCTION public.erp_cloud_restore_snapshot()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select jsonb_build_object(
    'inventory_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.inventory_key) from public.inventory_items t), '[]'::jsonb),
    'product_groups', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.product_groups t), '[]'::jsonb),
    'product_categories', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.product_categories t), '[]'::jsonb),
    'product_variants', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.product_variants t), '[]'::jsonb),
    'bundle_components', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.bundle_components t), '[]'::jsonb),
    'purchase_batches', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.purchase_batches t), '[]'::jsonb),
    'purchase_batch_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.purchase_batch_items t), '[]'::jsonb),
    'private_orders', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.private_orders t), '[]'::jsonb),
    'private_order_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.private_order_items t), '[]'::jsonb),
    'sales_orders', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.sales_orders t), '[]'::jsonb),
    'sales_order_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.sales_order_items t), '[]'::jsonb),
    'japan_packages', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.japan_packages t), '[]'::jsonb),
    'japan_package_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.japan_package_items t), '[]'::jsonb),
    'outbound_shipments', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.outbound_shipments t), '[]'::jsonb),
    'outbound_shipment_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.outbound_shipment_items t), '[]'::jsonb),
    'dashboard_category_images', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.dashboard_category_images t), '[]'::jsonb),
    'import_batches', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.import_batches t), '[]'::jsonb),
    'waca_orders', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_orders t), '[]'::jsonb),
    'waca_order_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_order_items t), '[]'::jsonb),
    'waca_mappings', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_mappings t), '[]'::jsonb),
    'waca_master_links', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_master_links t), '[]'::jsonb),
    'waca_import_batches', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_import_batches t), '[]'::jsonb),
    'waca_cutover_audit', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_cutover_audit t), '[]'::jsonb),
    'waca_state', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_state t), '[]'::jsonb)
  );
$function$
;$canonical_03$;

  execute $canonical_04$CREATE OR REPLACE FUNCTION public.erp_export_cloud_restore_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_snapshot jsonb;
begin
  if v_actor is null then
    raise exception using errcode = 'P0001', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not public.is_owner(v_actor) then
    raise exception using errcode = 'P0001', message = 'CLOUD_RESTORE_OWNER_REQUIRED';
  end if;

  select jsonb_build_object(
    'inventory_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.inventory_key) from public.inventory_items t), '[]'::jsonb),
    'product_groups', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.product_groups t), '[]'::jsonb),
    'product_categories', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.product_categories t), '[]'::jsonb),
    'product_variants', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.product_variants t), '[]'::jsonb),
    'bundle_components', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.bundle_components t), '[]'::jsonb),
    'purchase_batches', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.purchase_batches t), '[]'::jsonb),
    'purchase_batch_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.purchase_batch_items t), '[]'::jsonb),
    'private_orders', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.private_orders t), '[]'::jsonb),
    'private_order_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.private_order_items t), '[]'::jsonb),
    'sales_orders', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.sales_orders t), '[]'::jsonb),
    'sales_order_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.sales_order_items t), '[]'::jsonb),
    'japan_packages', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.japan_packages t), '[]'::jsonb),
    'japan_package_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.japan_package_items t), '[]'::jsonb),
    'outbound_shipments', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.outbound_shipments t), '[]'::jsonb),
    'outbound_shipment_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.outbound_shipment_items t), '[]'::jsonb),
    'dashboard_category_images', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.dashboard_category_images t), '[]'::jsonb),
    'import_batches', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.import_batches t), '[]'::jsonb),
    'waca_orders', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_orders t), '[]'::jsonb),
    'waca_order_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_order_items t), '[]'::jsonb),
    'waca_mappings', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_mappings t), '[]'::jsonb),
    'waca_master_links', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_master_links t), '[]'::jsonb),
    'waca_import_batches', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_import_batches t), '[]'::jsonb),
    'waca_cutover_audit', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_cutover_audit t), '[]'::jsonb),
    'waca_state', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_state t), '[]'::jsonb)
  ) into v_snapshot;

  return v_snapshot;
end;
$function$
;$canonical_04$;

  execute $canonical_05$CREATE OR REPLACE FUNCTION public.erp_read_cloud_restore_integrity_audit()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
 SET statement_timeout TO '30s'
AS $function$
declare
  v_data jsonb;
  v_audit jsonb;
  v_epoch bigint;
  v_latest public.erp_cloud_restore_attempts%rowtype;
  v_manifest jsonb;
  v_latest_safe jsonb;
  v_pending bigint;
  v_executing bigint;
  v_processing bigint;
  v_locks bigint;
  v_inconsistent bigint := 0;
  v_counts_match boolean;
  v_hash_match boolean;
begin
  if auth.uid() is null then
    raise exception using errcode='42501', message='AUTHENTICATION_REQUIRED';
  end if;
  if public.is_owner(auth.uid()) is distinct from true then
    raise exception using errcode='42501', message='CLOUD_RESTORE_OWNER_REQUIRED';
  end if;

  -- Deliberately fixed relations, ALL rows including deleted_at != null.
  -- Neither table names nor predicates can be supplied by the caller.
  select jsonb_build_object(
    'inventory_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.inventory_items t),
    'product_groups',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.product_groups t),
    'product_categories',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.product_categories t),
    'product_variants',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.product_variants t),
    'bundle_components',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.bundle_components t),
    'purchase_batches',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.purchase_batches t),
    'purchase_batch_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.purchase_batch_items t),
    'private_orders',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.private_orders t),
    'private_order_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.private_order_items t),
    'sales_orders',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.sales_orders t),
    'sales_order_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.sales_order_items t),
    'japan_packages',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.japan_packages t),
    'japan_package_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.japan_package_items t),
    'outbound_shipments',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.outbound_shipments t),
    'outbound_shipment_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.outbound_shipment_items t),
    'dashboard_category_images',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.dashboard_category_images t),
    'import_batches',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.import_batches t),
    'waca_orders',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_orders t),
    'waca_order_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_order_items t),
    'waca_mappings',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_mappings t),
    'waca_master_links',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_master_links t),
    'waca_import_batches',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_import_batches t),
    'waca_cutover_audit',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_cutover_audit t),
    'waca_state',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_state t)
  ) into v_data;
  perform public.erp_cloud_restore_validate_waca_dataset(v_data);
  v_audit := public.erp_cloud_restore_audit_dataset(v_data);
  select epoch into strict v_epoch from public.erp_cloud_restore_epoch where singleton=true;
  select * into v_latest from public.erp_cloud_restore_attempts
    where status='completed' order by result_epoch desc,completed_at desc,attempt_id limit 1;
  if found then
    v_manifest := v_latest.canonical_result->'manifest';
    v_latest_safe := jsonb_build_object(
      'attempt_id',v_latest.attempt_id,'status',v_latest.status,
      'result_epoch',v_latest.result_epoch,'replayed',v_latest.canonical_result->'replayed',
      'source_fingerprint',v_latest.source_fingerprint,'effective_fingerprint',v_latest.effective_fingerprint,
      'completed_at',v_latest.completed_at,
      'source_transformed_updated_by_count',v_manifest->'portability'->'totalTransformedRows'
    );
    v_counts_match := v_manifest->'counts'=v_audit->'table_counts'
      and (v_manifest->>'totalRows')::bigint=(v_audit->>'total_rows')::bigint;
    v_hash_match := v_manifest->>'relationshipHash'=v_audit->>'relationship_hash';
    if v_latest.result_epoch is distinct from v_epoch
      or v_manifest->>'snapshotFingerprint' is distinct from v_latest.effective_fingerprint
      or v_latest.canonical_result->>'snapshotFingerprint' is distinct from v_latest.effective_fingerprint
      or not exists(select 1 from public.erp_cloud_restore_requests r
        join public.erp_cloud_restore_snapshots s on s.id=r.rollback_snapshot_id
        where r.idempotency_key=v_latest.attempt_id and r.status='completed'
          and r.canonical_result->>'restoreEpoch'=v_epoch::text
          and r.canonical_result->>'snapshotFingerprint'=v_latest.effective_fingerprint
          and r.completed_at is not null)
    then v_inconsistent := v_inconsistent+1; end if;
  elsif v_epoch > 0 then v_inconsistent := v_inconsistent+1;
  end if;
  select count(*) filter(where status='prepared'),count(*) filter(where status='executing')
    into v_pending,v_executing from public.erp_cloud_restore_attempts;
  select count(*) into v_processing from public.erp_cloud_restore_requests where status='processing';

  -- Observation only: never try/acquire advisory locks, never reconcile attempts.
  select count(*) into v_locks from pg_catalog.pg_locks l
    where l.locktype='advisory' and l.objsubid=1
      and l.database=(select oid from pg_catalog.pg_database where datname=current_database())
      and ((l.classid::bigint<<32)|l.objid::bigint) in (
        select hashtextextended('erp-cloud-restore-maintenance-lock',0)
        union all select hashtextextended('erp-cloud-restore-attempt:'||attempt_id::text,0)
          from public.erp_cloud_restore_attempts
      );

  return v_audit || jsonb_build_object(
    'schema_version','cloud-restore-integrity-audit-v1','audited_at',statement_timestamp(),'epoch',v_epoch,
    'audit_policy',(v_audit->'audit_policy')||jsonb_build_object('policy',v_latest.restore_policy),
    'expected_manifest',case when v_manifest is null then null else jsonb_build_object(
      'counts',v_manifest->'counts','total_rows',v_manifest->'totalRows',
      'relationship_hash',v_manifest->'relationshipHash') end,
    'comparison',jsonb_build_object('counts_match',v_counts_match,'relationship_hash_match',v_hash_match),
    'restore_state',jsonb_build_object(
      'latest_completed',v_latest_safe,'pending_count',v_pending,'executing_count',v_executing,
      'processing_request_count',v_processing,'active_lock_count',v_locks,
      'metadata_inconsistency_count',v_inconsistent,
      'partial_state',case when v_inconsistent>0 then 'inconsistent'
        when v_pending+v_executing+v_processing+v_locks>0 or v_counts_match is not true or v_hash_match is not true then 'unproven'
        else 'not_detected' end,
      'scope','statement snapshot; locks sampled separately; counts/identity/relationships, not all business values'
    )
  );
end;
$function$
;$canonical_05$;

  execute $canonical_06$CREATE OR REPLACE FUNCTION public.erp_cloud_restore_relationship_hash(p_snapshot jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
  with relations(table_name, record_id, links) as (
    select 'product_categories', row->>'id', jsonb_build_object('product_group_id',row->'product_group_id') from jsonb_array_elements(p_snapshot->'product_categories') row
    union all select 'product_variants', row->>'id', jsonb_build_object('product_group_id',row->'product_group_id','product_category_id',row->'product_category_id') from jsonb_array_elements(p_snapshot->'product_variants') row
    union all select 'bundle_components', row->>'id', jsonb_build_object('bundle_variant_id',row->'bundle_variant_id','component_variant_id',row->'component_variant_id') from jsonb_array_elements(p_snapshot->'bundle_components') row
    union all select 'purchase_batches', row->>'id', jsonb_build_object('product_group_id',row->'product_group_id') from jsonb_array_elements(p_snapshot->'purchase_batches') row
    union all select 'purchase_batch_items', row->>'id', jsonb_build_object('purchase_batch_id',row->'purchase_batch_id','product_variant_id',row->'product_variant_id') from jsonb_array_elements(p_snapshot->'purchase_batch_items') row
    union all select 'private_orders', row->>'id', jsonb_build_object('product_group_id',row->'product_group_id') from jsonb_array_elements(p_snapshot->'private_orders') row
    union all select 'private_order_items', row->>'id', jsonb_build_object('private_order_id',row->'private_order_id','product_variant_id',row->'product_variant_id') from jsonb_array_elements(p_snapshot->'private_order_items') row
    union all select 'sales_order_items', row->>'id', jsonb_build_object('order_id',row->'order_id','product_variant_id',row->'product_variant_id') from jsonb_array_elements(p_snapshot->'sales_order_items') row
    union all select 'japan_package_items', row->>'id', jsonb_build_object('japan_package_id',row->'japan_package_id','product_group_id',row->'product_group_id','product_variant_id',row->'product_variant_id','purchase_batch_id',row->'purchase_batch_id','purchase_batch_item_id',row->'purchase_batch_item_id') from jsonb_array_elements(p_snapshot->'japan_package_items') row
    union all select 'outbound_shipment_items', row->>'id', jsonb_build_object('outbound_shipment_id',row->'outbound_shipment_id','japan_package_item_id',row->'japan_package_item_id','product_group_id',row->'product_group_id','product_variant_id',row->'product_variant_id') from jsonb_array_elements(p_snapshot->'outbound_shipment_items') row
    union all select 'waca_order_items', row->>'id', jsonb_build_object('order_id',row->'order_id','product_variant_id',row->'product_variant_id') from jsonb_array_elements(p_snapshot->'waca_order_items') row
    union all select 'waca_mappings', row->>'id', jsonb_build_object('product_variant_id',row->'product_variant_id') from jsonb_array_elements(p_snapshot->'waca_mappings') row
    union all select 'waca_master_links', row->>'id', jsonb_build_object('product_variant_id',row->'product_variant_id') from jsonb_array_elements(p_snapshot->'waca_master_links') row
    union all select 'waca_cutover_audit', row->>'id', jsonb_build_object('product_variant_id',row->'product_variant_id') from jsonb_array_elements(p_snapshot->'waca_cutover_audit') row
  ), projection as (
    select coalesce(jsonb_agg(jsonb_build_object('table',table_name,'id',record_id,'relations',links) order by table_name,record_id), '[]'::jsonb) value from relations
  )
  select encode(digest(convert_to(value::text,'UTF8'),'sha256'),'hex') from projection;
$function$
;$canonical_06$;

  execute $canonical_07$CREATE OR REPLACE FUNCTION public.erp_cloud_restore_live_relationship_hash()
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
  with relations(table_name, record_id, links) as (
    select 'product_categories', t.id::text, jsonb_build_object('product_group_id',to_jsonb(t.product_group_id)) from public.product_categories t
    union all select 'product_variants', t.id::text, jsonb_build_object('product_group_id',to_jsonb(t.product_group_id),'product_category_id',to_jsonb(t.product_category_id)) from public.product_variants t
    union all select 'bundle_components', t.id::text, jsonb_build_object('bundle_variant_id',to_jsonb(t.bundle_variant_id),'component_variant_id',to_jsonb(t.component_variant_id)) from public.bundle_components t
    union all select 'purchase_batches', t.id::text, jsonb_build_object('product_group_id',to_jsonb(t.product_group_id)) from public.purchase_batches t
    union all select 'purchase_batch_items', t.id::text, jsonb_build_object('purchase_batch_id',to_jsonb(t.purchase_batch_id),'product_variant_id',to_jsonb(t.product_variant_id)) from public.purchase_batch_items t
    union all select 'private_orders', t.id::text, jsonb_build_object('product_group_id',to_jsonb(t.product_group_id)) from public.private_orders t
    union all select 'private_order_items', t.id::text, jsonb_build_object('private_order_id',to_jsonb(t.private_order_id),'product_variant_id',to_jsonb(t.product_variant_id)) from public.private_order_items t
    union all select 'sales_order_items', t.id::text, jsonb_build_object('order_id',to_jsonb(t.order_id),'product_variant_id',to_jsonb(t.product_variant_id)) from public.sales_order_items t
    union all select 'japan_package_items', t.id::text, jsonb_build_object('japan_package_id',to_jsonb(t.japan_package_id),'product_group_id',to_jsonb(t.product_group_id),'product_variant_id',to_jsonb(t.product_variant_id),'purchase_batch_id',to_jsonb(t.purchase_batch_id),'purchase_batch_item_id',to_jsonb(t.purchase_batch_item_id)) from public.japan_package_items t
    union all select 'outbound_shipment_items', t.id::text, jsonb_build_object('outbound_shipment_id',to_jsonb(t.outbound_shipment_id),'japan_package_item_id',to_jsonb(t.japan_package_item_id),'product_group_id',to_jsonb(t.product_group_id),'product_variant_id',to_jsonb(t.product_variant_id)) from public.outbound_shipment_items t
    union all select 'waca_order_items', t.id::text, jsonb_build_object('order_id',to_jsonb(t.order_id),'product_variant_id',to_jsonb(t.product_variant_id)) from public.waca_order_items t
    union all select 'waca_mappings', t.id::text, jsonb_build_object('product_variant_id',to_jsonb(t.product_variant_id)) from public.waca_mappings t
    union all select 'waca_master_links', t.id::text, jsonb_build_object('product_variant_id',to_jsonb(t.product_variant_id)) from public.waca_master_links t
    union all select 'waca_cutover_audit', t.id::text, jsonb_build_object('product_variant_id',to_jsonb(t.product_variant_id)) from public.waca_cutover_audit t
  ), projection as (
    select coalesce(jsonb_agg(
      jsonb_build_object('table',table_name,'id',record_id,'relations',links)
      order by table_name,record_id
    ), '[]'::jsonb) value
    from relations
  )
  select encode(digest(convert_to(value::text,'UTF8'),'sha256'),'hex') from projection;
$function$
;$canonical_07$;

  execute $canonical_08$CREATE OR REPLACE FUNCTION public.erp_cloud_restore_validate_portability(p_snapshot jsonb, p_manifest jsonb, p_target_project_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_policy jsonb;
  v_counts jsonb;
  v_table text;
  v_table_oid oid;
  v_column_attnum smallint;
  v_request_headers jsonb;
  v_request_host text;
  v_total_transformed bigint := 0;
  v_external_reference_count integer := 0;
  v_tables constant text[] := array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state'
  ];
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not public.is_owner(v_actor) then
    raise exception using errcode = '42501', message = 'CLOUD_RESTORE_OWNER_REQUIRED';
  end if;
  if p_target_project_ref is distinct from 'rhfdjsklfrgpoqsaqpkn' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_TARGET_MISMATCH';
  end if;

  begin
    v_request_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_TARGET_MISMATCH';
  end;
  v_request_host := lower(split_part(coalesce(v_request_headers->>'host', ''), ':', 1));
  if split_part(v_request_host, '.', 1) is distinct from p_target_project_ref then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_TARGET_MISMATCH';
  end if;

  if jsonb_typeof(p_snapshot) is distinct from 'object'
     or jsonb_typeof(p_manifest) is distinct from 'object'
     or jsonb_typeof(p_manifest->'portability') is distinct from 'object' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_POLICY_INVALID';
  end if;
  v_policy := p_manifest->'portability';
  v_counts := v_policy->'transformedCounts';
  if v_policy->>'policyVersion' is distinct from 'cross-environment-audit-null-v1'
     or v_policy->>'mode' is distinct from 'cross-environment'
     or v_policy->>'targetProjectRef' is distinct from p_target_project_ref
     or coalesce(v_policy->>'sourceFileSha256', '') !~ '^[0-9a-f]{64}$'
     or coalesce(v_policy->>'sourceSnapshotFingerprint', '') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(v_counts) is distinct from 'object'
     or jsonb_typeof(v_policy->'totalTransformedRows') is distinct from 'number'
     or (v_policy->>'totalTransformedRows') !~ '^[0-9]+$'
     or exists (
       select 1 from jsonb_object_keys(v_policy) key
        where key not in (
          'policyVersion','mode','targetProjectRef','sourceFileSha256',
          'sourceSnapshotFingerprint','transformedCounts','totalTransformedRows'
        )
     ) then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_POLICY_INVALID';
  end if;

  foreach v_table in array v_tables loop
    if jsonb_typeof(p_snapshot->v_table) is distinct from 'array'
       or not (v_counts ? v_table)
       or jsonb_typeof(v_counts->v_table) is distinct from 'number'
       or (v_counts->>v_table) !~ '^[0-9]+$'
       or (v_counts->>v_table)::bigint > jsonb_array_length(p_snapshot->v_table) then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_POLICY_INVALID:' || v_table;
    end if;
    v_total_transformed := v_total_transformed + (v_counts->>v_table)::bigint;

    select c.oid, a.attnum
      into v_table_oid, v_column_attnum
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
     where n.nspname = 'public'
       and c.relname = v_table
       and c.relkind in ('r','p')
       and a.attname = 'updated_by'
       and a.attnum > 0
       and not a.attisdropped
       and not a.attnotnull
       and format_type(a.atttypid, a.atttypmod) = 'uuid';

    if v_table_oid is null
       or not exists (
         select 1
           from pg_constraint fk
           join pg_class parent on parent.oid = fk.confrelid
           join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
          where fk.contype = 'f'
            and fk.conrelid = v_table_oid
            and fk.conkey = array[v_column_attnum]::smallint[]
            and parent_ns.nspname = 'auth'
            and parent.relname = 'users'
            and fk.confkey = array[(
              select attnum from pg_attribute
               where attrelid = fk.confrelid and attname = 'id' and attnum > 0 and not attisdropped
            )]::smallint[]
            and fk.confdeltype = 'n'
            and fk.convalidated
       ) then
      raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_SCHEMA_MISMATCH:' || v_table || '.updated_by';
    end if;

    if exists (
      select 1
        from jsonb_array_elements(p_snapshot->v_table) row_value
       where not (row_value ? 'updated_by')
          or jsonb_typeof(row_value->'updated_by') is distinct from 'null'
    ) then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_AUDIT_VALUE_NOT_NULL:' || v_table;
    end if;
  end loop;

  if (select count(*) from jsonb_object_keys(v_counts)) <> cardinality(v_tables)
     or v_total_transformed <> (v_policy->>'totalTransformedRows')::bigint then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_POLICY_INVALID';
  end if;

  select count(*)
    into v_external_reference_count
    from pg_constraint fk
    join pg_class child on child.oid = fk.conrelid
    join pg_namespace child_ns on child_ns.oid = child.relnamespace
    join pg_class parent on parent.oid = fk.confrelid
    join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
   where fk.contype = 'f'
     and child_ns.nspname = 'public'
     and child.relname = any(v_tables)
     and not (parent_ns.nspname = 'public' and parent.relname = any(v_tables));

  if v_external_reference_count <> cardinality(v_tables)
     or exists (
       select 1
         from pg_constraint fk
         join pg_class child on child.oid = fk.conrelid
         join pg_namespace child_ns on child_ns.oid = child.relnamespace
         join pg_class parent on parent.oid = fk.confrelid
         join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
         join lateral unnest(fk.conkey, fk.confkey) with ordinality key_pair(child_attnum,parent_attnum,ordinality) on true
         join pg_attribute child_column on child_column.attrelid = fk.conrelid and child_column.attnum = key_pair.child_attnum
         join pg_attribute parent_column on parent_column.attrelid = fk.confrelid and parent_column.attnum = key_pair.parent_attnum
        where fk.contype = 'f'
          and child_ns.nspname = 'public'
          and child.relname = any(v_tables)
          and not (parent_ns.nspname = 'public' and parent.relname = any(v_tables))
          and not (
            cardinality(fk.conkey) = 1
            and child_column.attname = 'updated_by'
            and parent_ns.nspname = 'auth'
            and parent.relname = 'users'
            and parent_column.attname = 'id'
            and fk.confdeltype = 'n'
            and fk.convalidated
          )
     ) then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_EXTERNAL_REFERENCE_BLOCKED';
  end if;

  return jsonb_build_object(
    'ok', true,
    'policyVersion', v_policy->>'policyVersion',
    'targetProjectRef', p_target_project_ref,
    'policyFingerprint', encode(digest(convert_to(v_policy::text, 'UTF8'), 'sha256'), 'hex'),
    'externalReferenceCount', v_external_reference_count
  );
end;
$function$
;$canonical_08$;

  execute $canonical_09$CREATE OR REPLACE FUNCTION public.erp_cloud_restore_build_effective_snapshot(p_source_snapshot jsonb, p_manifest jsonb, p_restore_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_effective jsonb := p_source_snapshot;
  v_policy jsonb;
  v_counts jsonb;
  v_table text;
  v_rows jsonb;
  v_actual_transformed bigint;
  v_total_transformed bigint := 0;
  v_tables constant text[] := array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state'
  ];
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not public.is_owner(v_actor) then
    raise exception using errcode = '42501', message = 'CLOUD_RESTORE_OWNER_REQUIRED';
  end if;
  if jsonb_typeof(p_source_snapshot) is distinct from 'object'
     or jsonb_typeof(p_manifest) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_EFFECTIVE_SOURCE_INVALID';
  end if;

  if p_restore_mode = 'strict' then
    if p_manifest ? 'portability' then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_STRICT_POLICY_MISMATCH';
    end if;
    return p_source_snapshot;
  end if;
  if p_restore_mode is distinct from 'cross-environment' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_MODE_INVALID';
  end if;

  v_policy := p_manifest->'portability';
  v_counts := v_policy->'transformedCounts';
  if jsonb_typeof(v_policy) is distinct from 'object'
     or v_policy->>'policyVersion' is distinct from 'cross-environment-audit-null-v1'
     or v_policy->>'mode' is distinct from 'cross-environment'
     or v_policy->>'targetProjectRef' is distinct from 'rhfdjsklfrgpoqsaqpkn'
     or jsonb_typeof(v_counts) is distinct from 'object'
     or jsonb_typeof(v_policy->'totalTransformedRows') is distinct from 'number'
     or (v_policy->>'totalTransformedRows') !~ '^[0-9]+$' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_POLICY_INVALID';
  end if;

  foreach v_table in array v_tables loop
    if jsonb_typeof(p_source_snapshot->v_table) is distinct from 'array'
       or not (v_counts ? v_table)
       or jsonb_typeof(v_counts->v_table) is distinct from 'number'
       or (v_counts->>v_table) !~ '^[0-9]+$' then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_COVERAGE_INVALID:' || v_table;
    end if;

    -- Count transformed values, validate row shape, and materialize the effective
    -- table in one traversal. 035 performed separate count and aggregation scans.
    select
      count(*) filter (
        where row_value ? 'updated_by'
          and jsonb_typeof(row_value->'updated_by') is distinct from 'null'
      ),
      coalesce(
        jsonb_agg(row_value || jsonb_build_object('updated_by', null) order by ordinality),
        '[]'::jsonb
      )
      into v_actual_transformed, v_rows
      from jsonb_array_elements(p_source_snapshot->v_table)
           with ordinality source_row(row_value, ordinality)
     where case
       when jsonb_typeof(row_value) = 'object' then true
       else public.erp_cloud_restore_reject_invalid_portable_row(v_table)
     end;

    if v_actual_transformed <> (v_counts->>v_table)::bigint then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_TRANSFORM_COUNT_MISMATCH:' || v_table;
    end if;
    v_total_transformed := v_total_transformed + v_actual_transformed;
    v_effective := jsonb_set(v_effective, array[v_table], v_rows, false);
  end loop;

  if (select count(*) from jsonb_object_keys(v_counts)) <> cardinality(v_tables)
     or v_total_transformed <> (v_policy->>'totalTransformedRows')::bigint then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_COVERAGE_INVALID';
  end if;

  -- Final schema/external-reference/NULL-policy validation remains authoritative
  -- in erp_cloud_restore_idempotency_fingerprint(), before the first DELETE.
  return v_effective;
end;
$function$
;$canonical_09$;

  execute $canonical_10$CREATE OR REPLACE FUNCTION public.erp_cloud_restore_audit_dataset(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
declare
  v_result jsonb;
  -- ECMAScript String.trim whitespace; match the existing TS manifest checks.
  v_ws constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if jsonb_typeof(p_data) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_data)) <> 24
     or exists (
       select 1 from unnest(array['inventory_items','product_groups','product_categories','product_variants','bundle_components','purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items','japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state']) t
       where jsonb_typeof(p_data->t) is distinct from 'array'
     ) then
    raise exception using errcode='22023', message='CLOUD_RESTORE_AUDIT_DATASET_INVALID';
  end if;
  if exists(select 1 from jsonb_each(p_data) t cross join lateral jsonb_array_elements(t.value) r
            where jsonb_typeof(r) is distinct from 'object') then
    raise exception using errcode='22023', message='CLOUD_RESTORE_AUDIT_ROW_INVALID';
  end if;
  with
    spec(table_name, fields) as (values
      ('inventory_items', array['product_id','latest_catalog_import_id']::text[]),
      ('product_groups', array[]::text[]),
      ('product_categories', array['product_group_id']::text[]),
      ('product_variants', array['product_group_id','product_category_id']::text[]),
      ('bundle_components', array['bundle_variant_id','component_variant_id']::text[]),
      ('purchase_batches', array['product_group_id']::text[]),
      ('purchase_batch_items', array['purchase_batch_id','product_variant_id']::text[]),
      ('private_orders', array['product_group_id']::text[]),
      ('private_order_items', array['private_order_id','product_variant_id']::text[]),
      ('sales_orders', array[]::text[]),
      ('sales_order_items', array['order_id','product_variant_id']::text[]),
      ('japan_packages', array[]::text[]),
      ('japan_package_items', array['japan_package_id','product_group_id','product_variant_id','purchase_batch_id','purchase_batch_item_id']::text[]),
      ('outbound_shipments', array[]::text[]),
      ('outbound_shipment_items', array['outbound_shipment_id','japan_package_item_id','product_group_id','product_variant_id']::text[])
    , ('dashboard_category_images', array[]::text[]),
      ('import_batches', array[]::text[]),
      ('waca_orders', array[]::text[]),
      ('waca_order_items', array['order_id','product_variant_id']::text[]),
      ('waca_mappings', array['product_variant_id']::text[]),
      ('waca_master_links', array['product_variant_id']::text[]),
      ('waca_import_batches', array[]::text[]),
      ('waca_cutover_audit', array['product_variant_id']::text[]),
      ('waca_state', array[]::text[])
    ),
    relspec(child_table, field, parent_table, optional) as (values
      ('product_categories','product_group_id','product_groups',false),
      ('product_variants','product_group_id','product_groups',false),
      ('product_variants','product_category_id','product_categories',true),
      ('bundle_components','bundle_variant_id','product_variants',false),
      ('bundle_components','component_variant_id','product_variants',false),
      ('purchase_batches','product_group_id','product_groups',false),
      ('purchase_batch_items','purchase_batch_id','purchase_batches',false),
      ('purchase_batch_items','product_variant_id','product_variants',false),
      ('private_orders','product_group_id','product_groups',false),
      ('private_order_items','private_order_id','private_orders',false),
      ('private_order_items','product_variant_id','product_variants',false),
      ('sales_order_items','order_id','sales_orders',false),
      ('sales_order_items','product_variant_id','product_variants',true),
      ('japan_package_items','japan_package_id','japan_packages',false),
      ('japan_package_items','product_group_id','product_groups',true),
      ('japan_package_items','product_variant_id','product_variants',true),
      ('japan_package_items','purchase_batch_id','purchase_batches',true),
      ('japan_package_items','purchase_batch_item_id','purchase_batch_items',true),
      ('outbound_shipment_items','outbound_shipment_id','outbound_shipments',false),
      ('outbound_shipment_items','japan_package_item_id','japan_package_items',true),
      ('outbound_shipment_items','product_group_id','product_groups',true),
      ('outbound_shipment_items','product_variant_id','product_variants',true)
    , ('waca_order_items','order_id','waca_orders',false),
      ('waca_order_items','product_variant_id','product_variants',true),
      ('waca_mappings','product_variant_id','product_variants',false),
      ('waca_master_links','product_variant_id','product_variants',true),
      ('waca_cutover_audit','product_variant_id','product_variants',false)
    ),
    rows as materialized (
      select s.table_name,s.fields,r.value as row,
             lower(btrim(coalesce(r.value->>'id',''),v_ws)) as id
      from spec s cross join lateral jsonb_array_elements(p_data->s.table_name) r
    ),
    identities as (select distinct table_name,id from rows),
    counts as (select table_name,jsonb_array_length(p_data->table_name) as n from spec),
    duplicates as (select table_name,id,count(*)-1 as n from rows group by table_name,id),
    local_ids as (
      select btrim(row->>'local_id',v_ws) as id from rows
      where table_name='product_variants' and coalesce(btrim(row->>'local_id',v_ws),'')<>''
    ),
    missing as (
      select rel.optional from rows r join relspec rel on r.table_name=rel.child_table
      left join identities parent on parent.table_name=rel.parent_table
        and parent.id=lower(btrim(r.row->>rel.field,v_ws))
      where parent.id is null and (not rel.optional or coalesce(btrim(r.row->>rel.field,v_ws),'')<>'')
    ),
    projection as (
      select table_name,id,
        '{"id":'||to_json(id)::text||',"relations":{'||
        coalesce((select string_agg(to_json(f)::text||':'||
          coalesce(to_json(nullif(row->>f,''))::text,'null'),',' order by f collate "C")
          from unnest(fields) f),'')||
        '},"table":'||to_json(table_name)::text||'}' as compact
      from rows
    )
  select jsonb_build_object(
    'table_counts',(select jsonb_object_agg(table_name,n) from counts),
    'total_rows',(select sum(n) from counts),
    'relationship_hash',(select encode(extensions.digest(
      '['||coalesce(string_agg(compact,',' order by (table_name||':'||id) collate "C"),'')||']','sha256'),'hex') from projection),
    'integrity',jsonb_build_object(
      'orphan_count',(select count(*) from missing where not optional),
      'optional_metadata_missing_reference_count',(select count(*) from missing where optional),
      'duplicate_variant_id_count',(select coalesce(sum(n),0) from duplicates where table_name='product_variants'),
      'duplicate_variant_local_id_count',(select count(*)-count(distinct id) from local_ids),
      'duplicate_canonical_id_count',(select coalesce(sum(n),0) from duplicates),
      'canonical_identity_anomaly_count',(select count(*) from rows where id !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
      'unknown_product_count',(select count(*) from rows where table_name='product_groups'
        and lower(btrim(coalesce(row->>'normalized_title',row->>'title',''),v_ws)) in ('未知商品','unknown product')),
      'duplicate_inventory_key_count',(select count(*)-count(distinct btrim(coalesce(row->>'inventory_key',''),v_ws)) from rows where table_name='inventory_items'),
      'missing_inventory_key_count',(select count(*) from rows where table_name='inventory_items' and coalesce(btrim(row->>'inventory_key',v_ws),'')='')
    ),
    'audit_policy',jsonb_build_object(
      'covered_updated_by_non_null_count',(select count(*) from rows where row->>'updated_by' is not null),
      'covered_updated_by_null_count',(select count(*) from rows where row->>'updated_by' is null)
    )
  ) into v_result;
  return v_result;
end;
$function$
;$canonical_10$;

  execute $canonical_11$CREATE OR REPLACE FUNCTION public.erp_prove_cloud_restore_candidate(p_source_snapshot jsonb, p_manifest jsonb, p_restore_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_started_at timestamptz := clock_timestamp();
  v_request_headers jsonb;
  v_request_host text;
  v_policy text;
  v_expected_source_fingerprint text;
  v_source_fingerprint text;
  v_effective_fingerprint text;
  v_effective jsonb;
  v_validation jsonb;
  v_audit jsonb;
  v_integrity jsonb;
  v_coverage_count integer;
  v_transformed bigint := 0;
begin
  if v_actor is null then
    raise exception using errcode='42501', message='AUTHENTICATION_REQUIRED';
  end if;
  if public.is_owner(v_actor) is distinct from true then
    raise exception using errcode='42501', message='CLOUD_RESTORE_OWNER_REQUIRED';
  end if;
  begin
    v_request_headers := nullif(current_setting('request.headers',true),'')::jsonb;
  exception when others then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_TARGET_MISMATCH';
  end;
  v_request_host := lower(split_part(coalesce(v_request_headers->>'host',''),':',1));
  if split_part(v_request_host,'.',1) is distinct from 'rhfdjsklfrgpoqsaqpkn' then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_TARGET_MISMATCH';
  end if;
  if jsonb_typeof(p_source_snapshot) is distinct from 'object'
     or jsonb_typeof(p_manifest) is distinct from 'object'
     or p_restore_mode is null
     or p_restore_mode not in ('strict','cross-environment') then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_INPUT_INVALID';
  end if;

  if p_restore_mode='cross-environment' then
    if jsonb_typeof(p_manifest->'portability') is distinct from 'object'
       or p_manifest->'portability'->>'policyVersion' is distinct from 'cross-environment-audit-null-v1'
       or p_manifest->'portability'->>'mode' is distinct from 'cross-environment'
       or p_manifest->'portability'->>'targetProjectRef' is distinct from 'rhfdjsklfrgpoqsaqpkn'
       or jsonb_typeof(p_manifest->'portability'->'totalTransformedRows') is distinct from 'number'
       or coalesce(p_manifest->'portability'->>'totalTransformedRows','') !~ '^[0-9]+$' then
      raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_POLICY_INVALID';
    end if;
    v_policy := p_manifest->'portability'->>'policyVersion';
    v_expected_source_fingerprint := p_manifest->'portability'->>'sourceSnapshotFingerprint';
    v_transformed := (p_manifest->'portability'->>'totalTransformedRows')::bigint;
  else
    if p_manifest ? 'portability' then
      raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_POLICY_INVALID';
    end if;
    v_policy := 'strict';
    v_expected_source_fingerprint := p_manifest->>'snapshotFingerprint';
  end if;
  if coalesce(v_expected_source_fingerprint,'') !~ '^[0-9a-f]{64}$'
     or coalesce(p_manifest->>'snapshotFingerprint','') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_FINGERPRINT_INVALID';
  end if;

  v_source_fingerprint := encode(extensions.digest(convert_to(
    public.erp_cloud_restore_canonical_json_text(p_source_snapshot),'UTF8'
  ),'sha256'),'hex');
  if v_source_fingerprint is distinct from v_expected_source_fingerprint then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_SOURCE_FINGERPRINT_MISMATCH';
  end if;

  v_effective := public.erp_cloud_restore_build_effective_snapshot(
    p_source_snapshot,
    p_manifest,
    p_restore_mode
  );
  if p_restore_mode='cross-environment' then
    v_validation := public.erp_cloud_restore_validate_portability(
      v_effective,
      p_manifest,
      'rhfdjsklfrgpoqsaqpkn'
    );
    if v_validation->>'ok' is distinct from 'true' then
      raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_PORTABILITY_INVALID';
    end if;
  end if;

  -- Closed dataset coverage is checked before fingerprints so unknown resources
  -- cannot be disguised as a generic hash mismatch.
  perform public.erp_cloud_restore_validate_waca_dataset(v_effective);
  v_audit := public.erp_cloud_restore_audit_dataset(v_effective);
  v_effective_fingerprint := encode(extensions.digest(convert_to(
    public.erp_cloud_restore_canonical_json_text(v_effective),'UTF8'
  ),'sha256'),'hex');
  if v_effective_fingerprint is distinct from p_manifest->>'snapshotFingerprint' then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_EFFECTIVE_FINGERPRINT_MISMATCH';
  end if;
  v_integrity := v_audit->'integrity';
  select count(*) into v_coverage_count from jsonb_object_keys(v_audit->'table_counts');
  if jsonb_typeof(p_manifest->'resourceCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'totalRows') is distinct from 'number'
     or jsonb_typeof(p_manifest->'orphanCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'duplicateVariantIdCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'duplicateVariantLocalIdCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'duplicateCanonicalIdCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'canonicalIdentityAnomalyCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'unknownProductCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'optionalMetadataMissingReferenceCount') is distinct from 'number'
     or v_coverage_count <> 24
     or p_manifest->>'resourceCount' is distinct from '24'
     or jsonb_typeof(p_manifest->'counts') is distinct from 'object'
     or p_manifest->'counts' is distinct from v_audit->'table_counts'
     or (p_manifest->>'totalRows')::bigint is distinct from (v_audit->>'total_rows')::bigint
     or p_manifest->>'relationshipHash' is distinct from v_audit->>'relationship_hash'
     or (p_manifest->>'orphanCount')::bigint is distinct from (v_integrity->>'orphan_count')::bigint
     or (p_manifest->>'duplicateVariantIdCount')::bigint is distinct from (v_integrity->>'duplicate_variant_id_count')::bigint
     or (p_manifest->>'duplicateVariantLocalIdCount')::bigint is distinct from (v_integrity->>'duplicate_variant_local_id_count')::bigint
     or (p_manifest->>'duplicateCanonicalIdCount')::bigint is distinct from (v_integrity->>'duplicate_canonical_id_count')::bigint
     or (p_manifest->>'canonicalIdentityAnomalyCount')::bigint is distinct from (v_integrity->>'canonical_identity_anomaly_count')::bigint
     or (p_manifest->>'unknownProductCount')::bigint is distinct from (v_integrity->>'unknown_product_count')::bigint
     or (p_manifest->>'optionalMetadataMissingReferenceCount')::bigint is distinct from (v_integrity->>'optional_metadata_missing_reference_count')::bigint
     or (v_integrity->>'duplicate_inventory_key_count')::bigint <> 0
     or (v_integrity->>'missing_inventory_key_count')::bigint <> 0
     or (p_restore_mode='cross-environment' and (
       (v_audit->'audit_policy'->>'covered_updated_by_non_null_count')::bigint <> 0
       or (v_audit->'audit_policy'->>'covered_updated_by_null_count')::bigint
          is distinct from (v_audit->>'total_rows')::bigint
     )) then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_CANDIDATE_INVALID';
  end if;

  return jsonb_build_object(
    'ok',true,
    'candidate_valid',true,
    'schema_version','cloud-restore-candidate-proof-v1',
    'policy',v_policy,
    'resource_count',24,
    'coverage_count',v_coverage_count,
    'total_rows',(v_audit->>'total_rows')::bigint,
    'table_counts',v_audit->'table_counts',
    'transformed_updated_by_count',v_transformed,
    'source_fingerprint',v_source_fingerprint,
    'effective_fingerprint',v_effective_fingerprint,
    'relationship_hash',v_audit->>'relationship_hash',
    'integrity',v_integrity,
    'elapsed_ms',(extract(epoch from clock_timestamp()-v_started_at)*1000)::bigint
  );
end;
$function$
;$canonical_11$;

  execute $canonical_12$CREATE OR REPLACE FUNCTION public.erp_restore_cloud_snapshot(p_idempotency_key uuid, p_snapshot_fingerprint text, p_snapshot jsonb, p_manifest jsonb, p_source_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_existing public.erp_cloud_restore_requests%rowtype;
  v_rollback_id uuid;
  v_before jsonb;
  v_before_counts jsonb := '{}'::jsonb;
  v_before_manifest jsonb;
  v_before_fingerprint text;
  v_expected_profiles jsonb := '{}'::jsonb;
  v_expected_profile jsonb;
  v_actual_profile jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_table text;
  v_expected bigint;
  v_epoch bigint;
  v_result jsonb;
  v_server_fingerprint text;
  v_expected_relationship_hash text;
  v_actual_relationship_hash text;
  v_started_at timestamptz := clock_timestamp();
  v_phase_started_at timestamptz := clock_timestamp();
  v_phase_ms bigint;
  v_phase_timings jsonb := '{}'::jsonb;
  v_current_phase text := 'auth';
begin
  raise log 'CLOUD_RESTORE_TIMING phase=auth event=start';
  if v_actor is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode = '42501', message = 'CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  if p_idempotency_key is null or p_snapshot_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_REQUEST_INVALID';
  end if;
  if jsonb_typeof(p_snapshot) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_SNAPSHOT_INVALID';
  end if;
  if jsonb_typeof(p_manifest) is distinct from 'object'
     or p_manifest->>'schemaVersion' is distinct from 'cloud-erp-snapshot-v2' then
    raise exception using errcode = '22023', message = 'UNSUPPORTED_SCHEMA_VERSION';
  end if;
  if jsonb_typeof(p_manifest->'counts') is distinct from 'object'
     or (p_manifest->>'resourceCount')::bigint <> 24
     or coalesce((p_manifest->>'orphanCount')::bigint, -1) <> 0
     or coalesce((p_manifest->>'duplicateVariantIdCount')::bigint, -1) <> 0
     or coalesce((p_manifest->>'duplicateVariantLocalIdCount')::bigint, -1) <> 0 then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_MANIFEST_INVALID';
  end if;
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('auth', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=auth event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'lock_idempotency';
  raise log 'CLOUD_RESTORE_TIMING phase=lock_idempotency event=start';
  v_server_fingerprint := public.erp_cloud_restore_idempotency_fingerprint(p_snapshot, p_manifest);
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock', 0)) then
    raise exception using errcode = '55006', message = 'CLOUD_RESTORE_LOCK_CONFLICT';
  end if;
  insert into public.erp_cloud_restore_requests(actor_id,idempotency_key,snapshot_fingerprint,status)
  values(v_actor,p_idempotency_key,v_server_fingerprint,'processing')
  on conflict(actor_id,idempotency_key) do nothing;
  select * into v_existing from public.erp_cloud_restore_requests
   where actor_id=v_actor and idempotency_key=p_idempotency_key for update;
  if v_existing.snapshot_fingerprint <> v_server_fingerprint then
    raise exception using errcode = '22023', message = 'RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH';
  end if;
  if v_existing.status = 'completed' then
    raise log 'CLOUD_RESTORE_TIMING phase=lock_idempotency event=replay duration_ms=%',
      (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
    return v_existing.canonical_result || jsonb_build_object('replayed', true);
  end if;
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('lockIdempotency', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=lock_idempotency event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'input_validation';
  raise log 'CLOUD_RESTORE_TIMING phase=input_validation event=start';
  foreach v_table in array array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state'
  ] loop
    if jsonb_typeof(p_snapshot->v_table) <> 'array' then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_RESOURCE_REQUIRED:' || v_table;
    end if;
    v_expected_profile := public.erp_cloud_restore_table_profile(
      format('public.%I', v_table)::regclass,
      p_snapshot->v_table
    );
    v_expected := (v_expected_profile->>'count')::bigint;
    if coalesce((p_manifest->'counts'->>v_table)::bigint, -1) <> v_expected then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_MANIFEST_COUNT_MISMATCH:' || v_table;
    end if;
    if (v_expected_profile->>'missingIdentityCount')::bigint > 0 then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_IDENTITY_REQUIRED:' || v_table;
    end if;
    if (v_expected_profile->>'duplicateIdentityCount')::bigint > 0 then
      raise exception using errcode = '23505', message = 'DUPLICATE_CANONICAL_ID:' || v_table;
    end if;
    if v_table = 'product_variants'
       and (v_expected_profile->>'duplicateAuxiliaryIdentityCount')::bigint > 0 then
      raise exception using errcode = '23505', message = 'DUPLICATE_VARIANT_LOCAL_ID';
    end if;
    v_expected_profiles := v_expected_profiles || jsonb_build_object(v_table, v_expected_profile);
    v_counts := v_counts || jsonb_build_object(v_table, v_expected);
  end loop;
  if coalesce((p_manifest->>'totalRows')::bigint, -1)
     <> (select coalesce(sum(value::bigint), 0) from jsonb_each_text(v_counts)) then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_MANIFEST_TOTAL_MISMATCH';
  end if;
  perform public.erp_cloud_restore_validate_waca_dataset(p_snapshot);
  v_expected_relationship_hash := public.erp_cloud_restore_relationship_hash(p_snapshot);
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('inputValidation', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=input_validation event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'before_snapshot';
  raise log 'CLOUD_RESTORE_TIMING phase=before_snapshot event=start';
  v_before := public.erp_cloud_restore_snapshot();
  foreach v_table in array array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state'
  ] loop
    v_before_counts := v_before_counts || jsonb_build_object(v_table, jsonb_array_length(v_before->v_table));
  end loop;
  v_before_fingerprint := encode(digest(convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex');
  v_before_manifest := jsonb_build_object(
    'schemaVersion', 'cloud-erp-snapshot-v2',
    'resourceCount', 24,
    'counts', v_before_counts,
    'totalRows', (select coalesce(sum(value::bigint), 0) from jsonb_each_text(v_before_counts)),
    'snapshotFingerprint', v_before_fingerprint,
    'relationshipHash', public.erp_cloud_restore_relationship_hash(v_before),
    'restoreSourceEnvironment', p_source_environment
  );
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('beforeSnapshot', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=before_snapshot event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'rollback_row';
  raise log 'CLOUD_RESTORE_TIMING phase=rollback_row event=start';
  insert into public.erp_cloud_restore_snapshots(actor_id,source_environment,snapshot_fingerprint,manifest,snapshot)
  values(
    v_actor,
    coalesce(nullif(current_setting('request.headers', true), '')::jsonb->>'host', 'unknown'),
    v_before_fingerprint,
    v_before_manifest,
    v_before
  )
  returning id into v_rollback_id;
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('rollbackRow', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=rollback_row event=complete duration_ms=%', v_phase_ms;

  perform set_config('erp.cloud_restore_active','on',true);
  v_phase_started_at := clock_timestamp();
  v_current_phase := 'delete';
  raise log 'CLOUD_RESTORE_TIMING phase=delete event=start';
  delete from public.outbound_shipment_items where id is not null;
  delete from public.outbound_shipments where id is not null;
  delete from public.japan_package_items where id is not null;
  delete from public.japan_packages where id is not null;
  delete from public.private_order_items where id is not null;
  delete from public.purchase_batch_items where id is not null;
  delete from public.sales_order_items where id is not null;
  delete from public.bundle_components where id is not null;
  delete from public.private_orders where id is not null;
  delete from public.purchase_batches where id is not null;
  delete from public.dashboard_category_images where id is not null;
  delete from public.waca_order_items where id is not null;
  delete from public.waca_mappings where id is not null;
  delete from public.waca_master_links where id is not null;
  delete from public.waca_cutover_audit where id is not null;
  delete from public.waca_import_batches where id is not null;
  delete from public.waca_state where id is not null;
  delete from public.waca_orders where id is not null;
  delete from public.import_batches where id is not null;
  delete from public.product_variants where id is not null;
  delete from public.product_categories where id is not null;
  delete from public.sales_orders where id is not null;
  delete from public.product_groups where id is not null;
  delete from public.inventory_items where id is not null;
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('delete', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=delete event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'insert';
  raise log 'CLOUD_RESTORE_TIMING phase=insert event=start';
  perform public.erp_cloud_restore_insert_rows('public.inventory_items', p_snapshot->'inventory_items');
  perform public.erp_cloud_restore_insert_rows('public.product_groups', p_snapshot->'product_groups');
  perform public.erp_cloud_restore_insert_rows('public.product_categories', p_snapshot->'product_categories');
  perform public.erp_cloud_restore_insert_rows('public.product_variants', p_snapshot->'product_variants');
  perform public.erp_cloud_restore_insert_rows('public.bundle_components', p_snapshot->'bundle_components');
  perform public.erp_cloud_restore_insert_rows('public.purchase_batches', p_snapshot->'purchase_batches');
  perform public.erp_cloud_restore_insert_rows('public.purchase_batch_items', p_snapshot->'purchase_batch_items');
  perform public.erp_cloud_restore_insert_rows('public.private_orders', p_snapshot->'private_orders');
  perform public.erp_cloud_restore_insert_rows('public.private_order_items', p_snapshot->'private_order_items');
  perform public.erp_cloud_restore_insert_rows('public.sales_orders', p_snapshot->'sales_orders');
  perform public.erp_cloud_restore_insert_rows('public.sales_order_items', p_snapshot->'sales_order_items');
  perform public.erp_cloud_restore_insert_rows('public.japan_packages', p_snapshot->'japan_packages');
  perform public.erp_cloud_restore_insert_rows('public.japan_package_items', p_snapshot->'japan_package_items');
  perform public.erp_cloud_restore_insert_rows('public.outbound_shipments', p_snapshot->'outbound_shipments');
  perform public.erp_cloud_restore_insert_rows('public.outbound_shipment_items', p_snapshot->'outbound_shipment_items');
  perform public.erp_cloud_restore_insert_rows('public.dashboard_category_images', p_snapshot->'dashboard_category_images');
  perform public.erp_cloud_restore_insert_rows('public.import_batches', p_snapshot->'import_batches');
  perform public.erp_cloud_restore_insert_rows('public.waca_orders', p_snapshot->'waca_orders');
  perform public.erp_cloud_restore_insert_rows('public.waca_order_items', p_snapshot->'waca_order_items');
  perform public.erp_cloud_restore_insert_rows('public.waca_mappings', p_snapshot->'waca_mappings');
  perform public.erp_cloud_restore_insert_rows('public.waca_master_links', p_snapshot->'waca_master_links');
  perform public.erp_cloud_restore_insert_rows('public.waca_import_batches', p_snapshot->'waca_import_batches');
  perform public.erp_cloud_restore_insert_rows('public.waca_cutover_audit', p_snapshot->'waca_cutover_audit');
  perform public.erp_cloud_restore_insert_rows('public.waca_state', p_snapshot->'waca_state');
  perform public.erp_cloud_restore_recompute_waca_quantities();
  perform public.erp_cloud_restore_validate_waca_dataset(public.erp_cloud_restore_snapshot());
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('insert', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=insert event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'integrity';
  raise log 'CLOUD_RESTORE_TIMING phase=integrity event=start';
  foreach v_table in array array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state'
  ] loop
    v_actual_profile := public.erp_cloud_restore_table_profile(format('public.%I', v_table)::regclass, null::jsonb);
    v_expected_profile := v_expected_profiles->v_table;
    if (v_actual_profile->>'count')::bigint <> (v_expected_profile->>'count')::bigint then
      raise exception using errcode = '23000', message = 'CLOUD_RESTORE_POST_INTEGRITY_COUNT_MISMATCH:' || v_table;
    end if;
    if v_actual_profile->>'identityHash' is distinct from v_expected_profile->>'identityHash' then
      raise exception using errcode = '23000', message = 'CLOUD_RESTORE_POST_INTEGRITY_IDENTITY_HASH_MISMATCH:' || v_table;
    end if;
  end loop;

  if exists (
    select 1 from public.product_variants v left join public.product_groups g on g.id=v.product_group_id where g.id is null
    union all select 1 from public.purchase_batch_items i left join public.purchase_batches b on b.id=i.purchase_batch_id where b.id is null
    union all select 1 from public.private_order_items i left join public.private_orders o on o.id=i.private_order_id where o.id is null
    union all select 1 from public.sales_order_items i left join public.sales_orders o on o.id=i.order_id where o.id is null
    union all select 1 from public.japan_package_items i left join public.japan_packages p on p.id=i.japan_package_id where p.id is null
    union all select 1 from public.outbound_shipment_items i left join public.outbound_shipments s on s.id=i.outbound_shipment_id where s.id is null
  ) then raise exception using errcode = '23503', message = 'CLOUD_RESTORE_POST_INTEGRITY_ORPHAN'; end if;
  v_actual_relationship_hash := public.erp_cloud_restore_live_relationship_hash();
  if v_actual_relationship_hash <> v_expected_relationship_hash then
    raise exception using errcode = '23000', message = 'CLOUD_RESTORE_POST_INTEGRITY_RELATIONSHIP_HASH_MISMATCH';
  end if;
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('integrity', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=integrity event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'epoch_idempotency';
  raise log 'CLOUD_RESTORE_TIMING phase=epoch_idempotency event=start';
  update public.erp_cloud_restore_epoch
     set epoch=epoch+1, restored_at=now(), restored_by=v_actor, snapshot_fingerprint=v_server_fingerprint
   where singleton=true returning epoch into v_epoch;
  v_result := jsonb_build_object(
    'ok',true,'replayed',false,'idempotencyKey',p_idempotency_key,
    'snapshotFingerprint',p_snapshot_fingerprint,'serverSnapshotFingerprint',v_server_fingerprint,'rollbackSnapshotId',v_rollback_id,
    'restoreEpoch',v_epoch,'manifest',p_manifest,'serverRelationshipHash',v_actual_relationship_hash,
    'timingsMs',v_phase_timings
  );
  update public.erp_cloud_restore_requests set status='completed',rollback_snapshot_id=v_rollback_id,
    canonical_result=v_result,completed_at=now()
   where actor_id=v_actor and idempotency_key=p_idempotency_key;
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('epochIdempotency', v_phase_ms);
  v_phase_timings := v_phase_timings || jsonb_build_object(
    'total', (extract(epoch from clock_timestamp() - v_started_at) * 1000)::bigint
  );
  v_result := jsonb_set(v_result, '{timingsMs}', v_phase_timings, true);
  update public.erp_cloud_restore_requests
     set canonical_result=v_result
   where actor_id=v_actor and idempotency_key=p_idempotency_key;
  raise log 'CLOUD_RESTORE_TIMING phase=epoch_idempotency event=complete duration_ms=% total_ms=%',
    v_phase_ms, v_phase_timings->>'total';
  return v_result;
exception
  when query_canceled then
    raise log 'CLOUD_RESTORE_TIMING phase=failure failed_phase=% classification=statement_timeout sqlstate=% total_ms=%',
      v_current_phase, sqlstate, (extract(epoch from clock_timestamp() - v_started_at) * 1000)::bigint;
    raise;
  when others then
    raise log 'CLOUD_RESTORE_TIMING phase=failure failed_phase=% classification=error sqlstate=% total_ms=%',
      v_current_phase, sqlstate, (extract(epoch from clock_timestamp() - v_started_at) * 1000)::bigint;
    raise;
end;
$function$
;$canonical_12$;

  execute $canonical_13$CREATE OR REPLACE FUNCTION public.erp_cloud_restore_validate_waca_dataset(p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_mode text;
begin
  if exists(select 1 from unnest(array['import_batches','waca_orders','waca_order_items',
      'waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state']) t
      where jsonb_typeof(p_data->t) is distinct from 'array')
    or jsonb_array_length(p_data->'waca_state') <> 1 then
    raise exception using errcode='22023',message='WACA_RESTORE_RESOURCE_MISSING';
  end if;
  v_mode := p_data->'waca_state'->0->>'mode';
  if p_data->'waca_state'->0->>'id' <> '00000000-0000-4000-8000-000000000001'
    or v_mode not in ('LEGACY_QUANTITY_ACTIVE','ORDER_REBASELINE_REQUIRED','ORDER_DRIVEN_ACTIVE')
    or (p_data->'waca_state'->0->>'revision') !~ '^[0-9]+$' then
    raise exception using errcode='22023',message='WACA_RESTORE_CUTOVER_INVALID';
  end if;
  if exists(select 1 from (values
    ('waca_orders','order_key'),('waca_order_items','item_key'),('waca_mappings','feature'),
    ('waca_master_links','child_code'),('waca_import_batches','batch_key'),
    ('waca_cutover_audit','product_variant_id')) spec(t,k)
    where exists(select 1 from jsonb_array_elements(p_data->spec.t) row
      group by row->>spec.k having count(*)>1 or coalesce(btrim(row->>spec.k),'')='')) then
    raise exception using errcode='23505',message='WACA_RESTORE_DUPLICATE_BUSINESS_KEY';
  end if;
  if exists(select 1 from jsonb_array_elements(p_data->'waca_orders') row
    where row->>'status' not in ('處理中','完成付款','取消','失敗')
      or row->'payload'->>'key' is distinct from row->>'order_key')
    or exists(select 1 from jsonb_array_elements(p_data->'waca_order_items') row
      where (row->>'quantity') !~ '^[0-9]+$'
        or row->'payload'->>'key' is distinct from row->>'item_key') then
    raise exception using errcode='22023',message='WACA_RESTORE_ROW_INVALID';
  end if;
  if exists(select 1 from jsonb_array_elements(p_data->'waca_order_items') item
    join jsonb_array_elements(p_data->'waca_mappings') mapping
      on mapping->>'feature'=item->>'feature'
    where item->>'product_variant_id' is not null
      and item->>'product_variant_id' is distinct from mapping->>'product_variant_id') then
    raise exception using errcode='23000',message='WACA_RESTORE_MAPPING_MISMATCH';
  end if;
  if v_mode='ORDER_DRIVEN_ACTIVE' and exists(
    with quantities as (
      select item->>'product_variant_id' variant_id,
        sum((item->>'quantity')::integer) quantity
      from jsonb_array_elements(p_data->'waca_order_items') item
      join jsonb_array_elements(p_data->'waca_orders') order_row
        on order_row->>'id'=item->>'order_id'
      where item->>'product_variant_id' is not null
        and order_row->>'status' in ('處理中','完成付款')
      group by item->>'product_variant_id'
    )
    select 1 from jsonb_array_elements(p_data->'product_variants') variant
    left join quantities q on q.variant_id=variant->>'id'
    where (variant->>'waca_auto_quantity')::integer is distinct from coalesce(q.quantity,0)
  ) then
    raise exception using errcode='23000',message='WACA_RESTORE_QUANTITY_MISMATCH';
  end if;
end;
$function$
;$canonical_13$;

  execute $canonical_14$CREATE OR REPLACE FUNCTION public.erp_cloud_restore_recompute_waca_quantities()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if current_setting('erp.cloud_restore_active',true) is distinct from 'on' then
    raise exception using errcode='42501',message='WACA_RECOMPUTE_RESTORE_ONLY';
  end if;
  if (select mode from public.waca_state limit 1) <> 'ORDER_DRIVEN_ACTIVE' then return; end if;
  update public.product_variants v set waca_auto_quantity=coalesce(q.quantity,0)
  from (select v2.id,sum(i.quantity) filter(where o.status in ('處理中','完成付款'))::integer quantity
    from public.product_variants v2 left join public.waca_order_items i on i.product_variant_id=v2.id
    left join public.waca_orders o on o.id=i.order_id group by v2.id) q
  where q.id=v.id and v.waca_auto_quantity is distinct from coalesce(q.quantity,0);
end;
$function$
;$canonical_14$;
  revoke all on function public.erp_cloud_restore_validate_waca_dataset(jsonb) from public,anon,authenticated;
  revoke all on function public.erp_cloud_restore_recompute_waca_quantities() from public,anon,authenticated;
end;$install$;

do $postflight$
declare
  v_full text[]:=array['bundle_components','dashboard_category_images','import_batches','inventory_items','japan_package_items','japan_packages','outbound_shipment_items','outbound_shipments','private_order_items','private_orders','product_categories','product_groups','product_variants','purchase_batch_items','purchase_batches','sales_order_items','sales_orders','waca_cutover_audit','waca_import_batches','waca_mappings','waca_master_links','waca_order_items','waca_orders','waca_state'];
  v_snapshot jsonb; v_keys text[];
begin
  v_snapshot:=public.erp_cloud_restore_snapshot();
  select array_agg(key order by key) into v_keys from jsonb_object_keys(v_snapshot) key;
  if v_keys<>v_full or to_regprocedure('public.erp_cloud_restore_validate_waca_dataset(jsonb)') is null or to_regprocedure('public.erp_cloud_restore_recompute_waca_quantities()') is null
    or not exists(select 1 from pg_trigger where tgrelid='public.import_batches'::regclass and tgname='erp_cloud_restore_maintenance_guard' and not tgisinternal)
    or has_function_privilege('anon','public.erp_cloud_restore_validate_waca_dataset(jsonb)','EXECUTE') or has_function_privilege('authenticated','public.erp_cloud_restore_validate_waca_dataset(jsonb)','EXECUTE') or has_function_privilege('public','public.erp_cloud_restore_validate_waca_dataset(jsonb)','EXECUTE')
    or has_function_privilege('anon','public.erp_cloud_restore_recompute_waca_quantities()','EXECUTE') or has_function_privilege('authenticated','public.erp_cloud_restore_recompute_waca_quantities()','EXECUTE') or has_function_privilege('public','public.erp_cloud_restore_recompute_waca_quantities()','EXECUTE') then
    raise exception using errcode='55000',message='WACA_045C_POSTFLIGHT_CONTRACT_FAILED';
  end if;
  perform public.erp_cloud_restore_validate_waca_dataset(v_snapshot);
  perform public.erp_cloud_restore_audit_dataset(v_snapshot);
end;$postflight$;

commit;
