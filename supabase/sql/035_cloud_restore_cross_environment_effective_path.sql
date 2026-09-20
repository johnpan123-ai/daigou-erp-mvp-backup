-- Make cross-environment audit portability an effective Server write path.
-- Review/build artifact only. Apply only in a separately authorized Staging gate.
-- The existing 031-034 migration history is intentionally untouched.
begin;

do $effective_path_preflight$
declare
  v_restore_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)');
  v_validator_oid oid := to_regprocedure('public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)');
  v_fingerprint_oid oid := to_regprocedure('public.erp_cloud_restore_idempotency_fingerprint(jsonb,jsonb)');
  v_restore_definition text;
  v_compact_restore_definition text;
begin
  if v_restore_oid is null or v_validator_oid is null or v_fingerprint_oid is null then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_EFFECTIVE_PATH_BASE_CONTRACT_MISSING';
  end if;
  if to_regprocedure('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)') is not null
     or to_regprocedure('public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text)') is not null then
    raise exception using errcode = '42710', message = 'CLOUD_RESTORE_EFFECTIVE_PATH_COLLISION';
  end if;

  select pg_get_functiondef(v_restore_oid) into v_restore_definition;
  v_compact_restore_definition := regexp_replace(lower(v_restore_definition), '[[:space:]]+', '', 'g');
  if strpos(v_compact_restore_definition, 'v_server_fingerprint:=public.erp_cloud_restore_idempotency_fingerprint(p_snapshot,p_manifest);') = 0
     or strpos(v_compact_restore_definition, 'deletefrompublic.') = 0
     or strpos(v_compact_restore_definition, 'v_server_fingerprint:=public.erp_cloud_restore_idempotency_fingerprint(p_snapshot,p_manifest);')
        >= strpos(v_compact_restore_definition, 'deletefrompublic.') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_EFFECTIVE_PATH_BASE_WIRING_MISMATCH';
  end if;
  if not has_function_privilege('authenticated', v_restore_oid, 'EXECUTE')
     or has_function_privilege('anon', v_restore_oid, 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_EFFECTIVE_PATH_BASE_ACL_MISMATCH';
  end if;
end;
$effective_path_preflight$;

create function public.erp_cloud_restore_build_effective_snapshot(
  p_source_snapshot jsonb,
  p_manifest jsonb,
  p_restore_mode text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '30s'
as $$
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
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'
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
    if exists (
      select 1
        from jsonb_array_elements(p_source_snapshot->v_table) row_value
       where jsonb_typeof(row_value) is distinct from 'object'
    ) then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_ROW_INVALID:' || v_table;
    end if;

    select count(*)
      into v_actual_transformed
      from jsonb_array_elements(p_source_snapshot->v_table) row_value
     where row_value ? 'updated_by'
       and jsonb_typeof(row_value->'updated_by') is distinct from 'null';
    if v_actual_transformed <> (v_counts->>v_table)::bigint then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_TRANSFORM_COUNT_MISMATCH:' || v_table;
    end if;
    v_total_transformed := v_total_transformed + v_actual_transformed;

    select coalesce(
      jsonb_agg(row_value || jsonb_build_object('updated_by', null) order by ordinality),
      '[]'::jsonb
    )
      into v_rows
      from jsonb_array_elements(p_source_snapshot->v_table) with ordinality source_row(row_value, ordinality);
    v_effective := jsonb_set(v_effective, array[v_table], v_rows, false);
  end loop;

  if (select count(*) from jsonb_object_keys(v_counts)) <> cardinality(v_tables)
     or v_total_transformed <> (v_policy->>'totalTransformedRows')::bigint then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_COVERAGE_INVALID';
  end if;

  perform public.erp_cloud_restore_validate_portability(
    v_effective,
    p_manifest,
    v_policy->>'targetProjectRef'
  );
  return v_effective;
end;
$$;

revoke all on function public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text) from public, anon, authenticated;

create function public.erp_restore_cloud_snapshot_effective(
  p_idempotency_key uuid,
  p_snapshot_fingerprint text,
  p_source_snapshot jsonb,
  p_manifest jsonb,
  p_source_environment text,
  p_restore_mode text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '30s'
as $$
declare
  v_effective_snapshot jsonb;
begin
  if p_snapshot_fingerprint !~ '^[0-9a-f]{64}$'
     or p_snapshot_fingerprint is distinct from p_manifest->>'snapshotFingerprint' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_EFFECTIVE_FINGERPRINT_MISMATCH';
  end if;

  v_effective_snapshot := public.erp_cloud_restore_build_effective_snapshot(
    p_source_snapshot,
    p_manifest,
    p_restore_mode
  );

  return public.erp_restore_cloud_snapshot(
    p_idempotency_key,
    p_snapshot_fingerprint,
    v_effective_snapshot,
    p_manifest,
    p_source_environment
  );
end;
$$;

revoke all on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) from authenticated;
revoke all on function public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text) from public, anon;
grant execute on function public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text) to authenticated;

do $effective_path_postflight$
declare
  v_legacy_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)');
  v_builder_oid oid := to_regprocedure('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)');
  v_effective_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text)');
  v_legacy_owner oid;
  v_builder record;
  v_effective record;
  v_builder_definition text;
  v_effective_definition text;
  v_compact_builder text;
  v_compact_effective text;
begin
  if v_legacy_oid is null or v_builder_oid is null or v_effective_oid is null then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_EFFECTIVE_PATH_POSTFLIGHT_MISSING';
  end if;
  select proowner into v_legacy_owner from pg_proc where oid = v_legacy_oid;
  select * into v_builder from pg_proc where oid = v_builder_oid;
  select * into v_effective from pg_proc where oid = v_effective_oid;

  if v_builder.pronargs <> 3
     or v_builder.proargtypes[0] <> 'jsonb'::regtype::oid
     or v_builder.proargtypes[1] <> 'jsonb'::regtype::oid
     or v_builder.proargtypes[2] <> 'text'::regtype::oid
     or v_builder.proargnames is distinct from array['p_source_snapshot','p_manifest','p_restore_mode']::text[]
     or v_builder.prorettype <> 'jsonb'::regtype::oid
     or v_builder.prokind <> 'f'
     or not v_builder.prosecdef
     or v_builder.proowner <> v_legacy_owner
     or not coalesce(v_builder.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=30s']::text[] then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_EFFECTIVE_BUILDER_CONTRACT_MISMATCH';
  end if;
  if v_effective.pronargs <> 6
     or v_effective.proargtypes[0] <> 'uuid'::regtype::oid
     or v_effective.proargtypes[1] <> 'text'::regtype::oid
     or v_effective.proargtypes[2] <> 'jsonb'::regtype::oid
     or v_effective.proargtypes[3] <> 'jsonb'::regtype::oid
     or v_effective.proargtypes[4] <> 'text'::regtype::oid
     or v_effective.proargtypes[5] <> 'text'::regtype::oid
     or v_effective.proargnames is distinct from array[
       'p_idempotency_key','p_snapshot_fingerprint','p_source_snapshot',
       'p_manifest','p_source_environment','p_restore_mode'
     ]::text[]
     or v_effective.prorettype <> 'jsonb'::regtype::oid
     or v_effective.prokind <> 'f'
     or not v_effective.prosecdef
     or v_effective.proowner <> v_legacy_owner
     or not coalesce(v_effective.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=30s']::text[] then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_EFFECTIVE_RPC_CONTRACT_MISMATCH';
  end if;

  if has_function_privilege('public', v_builder_oid, 'EXECUTE')
     or has_function_privilege('anon', v_builder_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_builder_oid, 'EXECUTE')
     or has_function_privilege('public', v_effective_oid, 'EXECUTE')
     or has_function_privilege('anon', v_effective_oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_effective_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_legacy_oid, 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_EFFECTIVE_PATH_ACL_MISMATCH';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'erp_cloud_restore_build_effective_snapshot') <> 1
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'erp_restore_cloud_snapshot_effective') <> 1 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_EFFECTIVE_PATH_OVERLOAD_COLLISION';
  end if;

  select pg_get_functiondef(v_builder_oid), pg_get_functiondef(v_effective_oid)
    into v_builder_definition, v_effective_definition;
  v_compact_builder := regexp_replace(lower(v_builder_definition), '[[:space:]]+', '', 'g');
  v_compact_effective := regexp_replace(lower(v_effective_definition), '[[:space:]]+', '', 'g');
  if strpos(v_compact_builder, 'cross-environment-audit-null-v1') = 0
     or strpos(v_compact_builder, 'jsonb_build_object(''updated_by'',null)') = 0
     or strpos(v_compact_builder, 'erp_cloud_restore_validate_portability') = 0
     or strpos(v_compact_builder, 'cloud_restore_portability_transform_count_mismatch') = 0
     or strpos(v_compact_builder, 'deletefrompublic.') > 0
     or strpos(v_compact_builder, 'truncate') > 0
     or strpos(v_compact_effective, 'v_effective_snapshot:=public.erp_cloud_restore_build_effective_snapshot(') = 0
     or strpos(v_compact_effective, 'returnpublic.erp_restore_cloud_snapshot(') = 0
     or strpos(v_compact_effective, 'v_effective_snapshot:=public.erp_cloud_restore_build_effective_snapshot(')
        >= strpos(v_compact_effective, 'returnpublic.erp_restore_cloud_snapshot(') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_EFFECTIVE_PATH_DEFINITION_MISMATCH';
  end if;
end;
$effective_path_postflight$;

commit;
