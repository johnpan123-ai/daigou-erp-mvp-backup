-- Close the bounded-timeout gap exposed by the 17,658-row cross-environment Restore.
-- Candidate artifact only. Apply only in a separately authorized Staging gate.
-- 031-035 are immutable history; this migration requires the exact 035 post-state.
begin;

do $restore_final_closure_preflight$
declare
  v_legacy_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)');
  v_validator_oid oid := to_regprocedure('public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)');
  v_fingerprint_oid oid := to_regprocedure('public.erp_cloud_restore_idempotency_fingerprint(jsonb,jsonb)');
  v_builder_oid oid := to_regprocedure('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)');
  v_effective_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text)');
  v_legacy record;
  v_validator record;
  v_builder record;
  v_effective record;
  v_legacy_definition text;
  v_fingerprint_definition text;
  v_builder_definition text;
  v_effective_definition text;
begin
  if v_legacy_oid is null or v_validator_oid is null or v_fingerprint_oid is null
     or v_builder_oid is null or v_effective_oid is null then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FINAL_CLOSURE_BASE_CONTRACT_MISSING';
  end if;
  if to_regprocedure('public.erp_cloud_restore_reject_invalid_portable_row(text)') is not null then
    raise exception using errcode = '42710', message = 'CLOUD_RESTORE_FINAL_CLOSURE_HELPER_COLLISION';
  end if;
  select * into v_legacy from pg_catalog.pg_proc where oid = v_legacy_oid;
  select * into v_validator from pg_catalog.pg_proc where oid = v_validator_oid;
  select * into v_builder from pg_catalog.pg_proc where oid = v_builder_oid;
  select * into v_effective from pg_catalog.pg_proc where oid = v_effective_oid;

  if not coalesce(v_legacy.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=30s']::text[]
     or not coalesce(v_validator.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=30s']::text[]
     or not coalesce(v_builder.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=30s']::text[]
     or not coalesce(v_effective.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=30s']::text[] then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FINAL_CLOSURE_TIMEOUT_BASE_MISMATCH';
  end if;
  if v_legacy.proowner <> v_validator.proowner
     or v_legacy.proowner <> v_builder.proowner
     or v_legacy.proowner <> v_effective.proowner
     or not v_legacy.prosecdef or not v_validator.prosecdef or not v_builder.prosecdef or not v_effective.prosecdef then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FINAL_CLOSURE_OWNER_SECURITY_MISMATCH';
  end if;
  if has_function_privilege('public', v_builder_oid, 'EXECUTE')
     or has_function_privilege('anon', v_builder_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_builder_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_legacy_oid, 'EXECUTE')
     or has_function_privilege('public', v_effective_oid, 'EXECUTE')
     or has_function_privilege('anon', v_effective_oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_effective_oid, 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FINAL_CLOSURE_ACL_BASE_MISMATCH';
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='erp_restore_cloud_snapshot') <> 1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='erp_cloud_restore_build_effective_snapshot') <> 1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='erp_cloud_restore_validate_portability') <> 1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='erp_restore_cloud_snapshot_effective') <> 1 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FINAL_CLOSURE_OVERLOAD_COLLISION';
  end if;

  v_legacy_definition := regexp_replace(lower(pg_get_functiondef(v_legacy_oid)), '[[:space:]]+', '', 'g');
  v_fingerprint_definition := regexp_replace(lower(pg_get_functiondef(v_fingerprint_oid)), '[[:space:]]+', '', 'g');
  v_builder_definition := regexp_replace(lower(pg_get_functiondef(v_builder_oid)), '[[:space:]]+', '', 'g');
  v_effective_definition := regexp_replace(lower(pg_get_functiondef(v_effective_oid)), '[[:space:]]+', '', 'g');
  -- The live 035 builder is the expected old base and still performs one
  -- redundant validation. The replacement below removes it; the authoritative
  -- validation remains in the fingerprint path before the first DELETE.
  if regexp_count(v_builder_definition, 'performpublic\.erp_cloud_restore_validate_portability\(') <> 1
     or regexp_count(v_fingerprint_definition, 'performpublic\.erp_cloud_restore_validate_portability\(') <> 1
     or regexp_count(v_legacy_definition, 'v_server_fingerprint:=public\.erp_cloud_restore_idempotency_fingerprint\(p_snapshot,p_manifest\);') <> 1
     or strpos(v_legacy_definition, 'v_server_fingerprint:=public.erp_cloud_restore_idempotency_fingerprint(p_snapshot,p_manifest);')
        >= strpos(v_legacy_definition, 'deletefrompublic.')
     or strpos(v_builder_definition, 'jsonb_build_object(''updated_by'',null)') = 0
     or strpos(v_builder_definition, 'cross-environment-audit-null-v1') = 0
     or strpos(v_effective_definition, 'returnpublic.erp_restore_cloud_snapshot(') = 0 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FINAL_CLOSURE_DEFINITION_BASE_MISMATCH';
  end if;
end;
$restore_final_closure_preflight$;

-- A tiny fail-closed helper permits one-pass aggregation without accepting a
-- non-object JSON row. It is private to SECURITY DEFINER Restore functions.
create or replace function public.erp_cloud_restore_reject_invalid_portable_row(p_table text)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '22023', message = 'CLOUD_RESTORE_PORTABILITY_ROW_INVALID:' || p_table;
end;
$$;

revoke all on function public.erp_cloud_restore_reject_invalid_portable_row(text) from public, anon, authenticated;

create or replace function public.erp_cloud_restore_build_effective_snapshot(
  p_source_snapshot jsonb,
  p_manifest jsonb,
  p_restore_mode text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '120s'
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
$$;

revoke all on function public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text) from public, anon, authenticated;

alter function public.erp_cloud_restore_validate_portability(jsonb,jsonb,text) set statement_timeout = '120s';
alter function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) set statement_timeout = '120s';

create or replace function public.erp_restore_cloud_snapshot_effective(
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
set statement_timeout = '120s'
as $$
declare
  v_effective_snapshot jsonb;
  v_started_at timestamptz := clock_timestamp();
  v_policy text := coalesce(p_manifest->'portability'->>'policyVersion', 'strict');
  v_target text := coalesce(p_manifest->'portability'->>'targetProjectRef', 'same-environment');
  v_source_fingerprint text := coalesce(p_manifest->'portability'->>'sourceSnapshotFingerprint', p_snapshot_fingerprint);
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
exception
  when query_canceled then
    raise log 'CLOUD_RESTORE_EFFECTIVE_FAILURE attempt=% classification=statement_timeout timeout_source=postgresql_statement_timeout sqlstate=% elapsed_ms=% policy=% target=% source_fingerprint=% effective_fingerprint=%',
      p_idempotency_key, sqlstate,
      (extract(epoch from clock_timestamp() - v_started_at) * 1000)::bigint,
      v_policy, v_target, v_source_fingerprint, p_snapshot_fingerprint;
    raise;
  when others then
    raise log 'CLOUD_RESTORE_EFFECTIVE_FAILURE attempt=% classification=server_error timeout_source=none sqlstate=% elapsed_ms=% policy=% target=% source_fingerprint=% effective_fingerprint=%',
      p_idempotency_key, sqlstate,
      (extract(epoch from clock_timestamp() - v_started_at) * 1000)::bigint,
      v_policy, v_target, v_source_fingerprint, p_snapshot_fingerprint;
    raise;
end;
$$;

revoke all on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) from public, anon, authenticated;
revoke all on function public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text) from public, anon;
grant execute on function public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text) to authenticated;

do $restore_final_closure_postflight$
declare
  v_legacy_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)');
  v_validator_oid oid := to_regprocedure('public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)');
  v_builder_oid oid := to_regprocedure('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)');
  v_effective_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text)');
  v_reject_oid oid := to_regprocedure('public.erp_cloud_restore_reject_invalid_portable_row(text)');
  v_legacy record;
  v_validator record;
  v_builder record;
  v_effective record;
  v_legacy_definition text;
  v_fingerprint_definition text;
  v_builder_definition text;
  v_effective_definition text;
begin
  if v_legacy_oid is null or v_validator_oid is null or v_builder_oid is null or v_effective_oid is null or v_reject_oid is null then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FINAL_CLOSURE_POSTFLIGHT_MISSING';
  end if;
  select * into v_legacy from pg_catalog.pg_proc where oid=v_legacy_oid;
  select * into v_validator from pg_catalog.pg_proc where oid=v_validator_oid;
  select * into v_builder from pg_catalog.pg_proc where oid=v_builder_oid;
  select * into v_effective from pg_catalog.pg_proc where oid=v_effective_oid;

  if not coalesce(v_legacy.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or not coalesce(v_validator.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or not coalesce(v_builder.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or not coalesce(v_effective.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[] then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FINAL_CLOSURE_TIMEOUT_POSTFLIGHT_MISMATCH';
  end if;
  if v_builder.pronargs <> 3
     or v_builder.proargtypes[0] <> 'jsonb'::regtype::oid
     or v_builder.proargtypes[1] <> 'jsonb'::regtype::oid
     or v_builder.proargtypes[2] <> 'text'::regtype::oid
     or v_builder.proargnames is distinct from array['p_source_snapshot','p_manifest','p_restore_mode']::text[]
     or v_builder.prorettype <> 'jsonb'::regtype::oid
     or v_builder.prokind <> 'f' or not v_builder.prosecdef
     or v_effective.pronargs <> 6
     or v_effective.proargtypes[0] <> 'uuid'::regtype::oid
     or v_effective.proargtypes[1] <> 'text'::regtype::oid
     or v_effective.proargtypes[2] <> 'jsonb'::regtype::oid
     or v_effective.proargtypes[3] <> 'jsonb'::regtype::oid
     or v_effective.proargtypes[4] <> 'text'::regtype::oid
     or v_effective.proargtypes[5] <> 'text'::regtype::oid
     or v_effective.proargnames is distinct from array['p_idempotency_key','p_snapshot_fingerprint','p_source_snapshot','p_manifest','p_source_environment','p_restore_mode']::text[]
     or v_effective.prorettype <> 'jsonb'::regtype::oid
     or v_effective.prokind <> 'f' or not v_effective.prosecdef
     or v_builder.proowner <> v_legacy.proowner or v_effective.proowner <> v_legacy.proowner then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FINAL_CLOSURE_FUNCTION_POSTFLIGHT_MISMATCH';
  end if;
  if has_function_privilege('public', v_builder_oid, 'EXECUTE')
     or has_function_privilege('anon', v_builder_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_builder_oid, 'EXECUTE')
     or has_function_privilege('public', v_reject_oid, 'EXECUTE')
     or has_function_privilege('anon', v_reject_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_reject_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_legacy_oid, 'EXECUTE')
     or has_function_privilege('public', v_effective_oid, 'EXECUTE')
     or has_function_privilege('anon', v_effective_oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_effective_oid, 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FINAL_CLOSURE_ACL_POSTFLIGHT_MISMATCH';
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='erp_restore_cloud_snapshot') <> 1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='erp_cloud_restore_validate_portability') <> 1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='erp_cloud_restore_build_effective_snapshot') <> 1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='erp_cloud_restore_reject_invalid_portable_row') <> 1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='erp_restore_cloud_snapshot_effective') <> 1 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FINAL_CLOSURE_OVERLOAD_POSTFLIGHT_COLLISION';
  end if;

  v_legacy_definition := regexp_replace(lower(pg_get_functiondef(v_legacy_oid)), '[[:space:]]+', '', 'g');
  v_fingerprint_definition := regexp_replace(lower(pg_get_functiondef('public.erp_cloud_restore_idempotency_fingerprint(jsonb,jsonb)'::regprocedure)), '[[:space:]]+', '', 'g');
  v_builder_definition := regexp_replace(lower(pg_get_functiondef(v_builder_oid)), '[[:space:]]+', '', 'g');
  v_effective_definition := regexp_replace(lower(pg_get_functiondef(v_effective_oid)), '[[:space:]]+', '', 'g');
  if regexp_count(v_builder_definition, 'jsonb_array_elements\(p_source_snapshot->v_table\)') <> 1
     or strpos(v_builder_definition, 'erp_cloud_restore_reject_invalid_portable_row') = 0
     or strpos(v_builder_definition, 'performpublic.erp_cloud_restore_validate_portability') > 0
     or regexp_count(v_fingerprint_definition, 'performpublic\.erp_cloud_restore_validate_portability\(') <> 1
     or regexp_count(v_legacy_definition, 'v_server_fingerprint:=public\.erp_cloud_restore_idempotency_fingerprint\(p_snapshot,p_manifest\);') <> 1
     or strpos(v_legacy_definition, 'v_server_fingerprint:=public.erp_cloud_restore_idempotency_fingerprint(p_snapshot,p_manifest);')
        >= strpos(v_legacy_definition, 'deletefrompublic.')
     or strpos(v_effective_definition, 'cloud_restore_effective_failure') = 0
     or strpos(v_effective_definition, 'timeout_source=postgresql_statement_timeout') = 0
     or strpos(v_effective_definition, 'returnpublic.erp_restore_cloud_snapshot(') = 0 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FINAL_CLOSURE_DEFINITION_POSTFLIGHT_MISMATCH';
  end if;
end;
$restore_final_closure_postflight$;

commit;
