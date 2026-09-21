-- Prevent the 036 fail-closed row-shape helper from being evaluated during
-- PostgreSQL planning for an otherwise valid JSON object row.
-- Candidate artifact only. Apply only in a separately authorized Staging gate.
-- 031-036 are immutable history; this migration requires the exact 036 post-state.
begin;

do $cloud_restore_row_shape_preflight$
declare
  v_helper_oid oid := to_regprocedure('public.erp_cloud_restore_reject_invalid_portable_row(text)');
  v_builder_oid oid := to_regprocedure('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)');
  v_legacy_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)');
  v_effective_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text)');
  v_helper record;
  v_builder record;
  v_legacy record;
  v_effective record;
  v_builder_definition text;
  v_legacy_definition text;
begin
  if v_helper_oid is null or v_builder_oid is null or v_legacy_oid is null or v_effective_oid is null then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ROW_SHAPE_BASE_CONTRACT_MISSING';
  end if;

  select * into v_helper from pg_catalog.pg_proc where oid = v_helper_oid;
  select * into v_builder from pg_catalog.pg_proc where oid = v_builder_oid;
  select * into v_legacy from pg_catalog.pg_proc where oid = v_legacy_oid;
  select * into v_effective from pg_catalog.pg_proc where oid = v_effective_oid;

  if v_helper.pronargs <> 1
     or v_helper.proargtypes[0] <> 'text'::regtype::oid
     or v_helper.proargnames is distinct from array['p_table']::text[]
     or v_helper.prorettype <> 'boolean'::regtype::oid
     or v_helper.prokind <> 'f'
     or v_helper.prosecdef
     or v_helper.provolatile <> 'i'
     or v_helper.proowner <> v_builder.proowner
     or not coalesce(v_helper.proconfig, '{}'::text[]) @> array['search_path=pg_catalog']::text[] then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ROW_SHAPE_HELPER_BASE_MISMATCH';
  end if;

  if not v_builder.prosecdef
     or not v_legacy.prosecdef
     or not v_effective.prosecdef
     or v_builder.proowner <> v_legacy.proowner
     or v_builder.proowner <> v_effective.proowner
     or not coalesce(v_builder.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or not coalesce(v_legacy.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or not coalesce(v_effective.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[] then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ROW_SHAPE_SECURITY_TIMEOUT_MISMATCH';
  end if;

  if has_function_privilege('public', v_helper_oid, 'EXECUTE')
     or has_function_privilege('anon', v_helper_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_helper_oid, 'EXECUTE')
     or has_function_privilege('public', v_builder_oid, 'EXECUTE')
     or has_function_privilege('anon', v_builder_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_builder_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_legacy_oid, 'EXECUTE')
     or has_function_privilege('public', v_effective_oid, 'EXECUTE')
     or has_function_privilege('anon', v_effective_oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_effective_oid, 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ROW_SHAPE_ACL_MISMATCH';
  end if;

  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'erp_cloud_restore_reject_invalid_portable_row') <> 1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'erp_cloud_restore_build_effective_snapshot') <> 1 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ROW_SHAPE_OVERLOAD_COLLISION';
  end if;

  v_builder_definition := regexp_replace(lower(pg_get_functiondef(v_builder_oid)), '[[:space:]]+', '', 'g');
  v_legacy_definition := regexp_replace(lower(pg_get_functiondef(v_legacy_oid)), '[[:space:]]+', '', 'g');

  if regexp_count(v_builder_definition, 'jsonb_array_elements\(p_source_snapshot->v_table\)') <> 1
     or regexp_count(v_builder_definition, 'public\.erp_cloud_restore_reject_invalid_portable_row\(v_table\)') <> 1
     or strpos(v_builder_definition, "whenjsonb_typeof(row_value)='object'thentrue") = 0
     or strpos(v_builder_definition, 'jsonb_array_elements_text(') > 0
     or strpos(v_builder_definition, 'jsonb_each_text(') > 0
     or strpos(v_builder_definition, 'row_value::text') > 0
     or strpos(v_builder_definition, 'row_value->>') > 0
     or strpos(v_builder_definition, "jsonb_build_object('updated_by',null)") = 0
     or strpos(v_builder_definition, 'cross-environment-audit-null-v1') = 0
     or regexp_count(v_legacy_definition, 'v_server_fingerprint:=public\.erp_cloud_restore_idempotency_fingerprint\(p_snapshot,p_manifest\);') <> 1
     or strpos(v_legacy_definition, 'v_server_fingerprint:=public.erp_cloud_restore_idempotency_fingerprint(p_snapshot,p_manifest);')
        >= strpos(v_legacy_definition, 'deletefrompublic.') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ROW_SHAPE_DEFINITION_BASE_MISMATCH';
  end if;
end;
$cloud_restore_row_shape_preflight$;

-- The helper intentionally raises and therefore must not be folded or moved
-- ahead of its guarded CASE branch. Valid object rows keep the one-pass 036
-- traversal; invalid scalar/null/array rows still execute the helper and fail.
alter function public.erp_cloud_restore_reject_invalid_portable_row(text) volatile;

do $cloud_restore_row_shape_postflight$
declare
  v_helper_oid oid := to_regprocedure('public.erp_cloud_restore_reject_invalid_portable_row(text)');
  v_builder_oid oid := to_regprocedure('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)');
  v_legacy_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)');
  v_effective_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text)');
  v_helper record;
  v_builder record;
  v_legacy record;
  v_effective record;
  v_builder_definition text;
  v_legacy_definition text;
begin
  if v_helper_oid is null or v_builder_oid is null or v_legacy_oid is null or v_effective_oid is null then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ROW_SHAPE_POSTFLIGHT_MISSING';
  end if;

  select * into v_helper from pg_catalog.pg_proc where oid = v_helper_oid;
  select * into v_builder from pg_catalog.pg_proc where oid = v_builder_oid;
  select * into v_legacy from pg_catalog.pg_proc where oid = v_legacy_oid;
  select * into v_effective from pg_catalog.pg_proc where oid = v_effective_oid;

  if v_helper.provolatile <> 'v'
     or v_helper.pronargs <> 1
     or v_helper.proargtypes[0] <> 'text'::regtype::oid
     or v_helper.proargnames is distinct from array['p_table']::text[]
     or v_helper.prorettype <> 'boolean'::regtype::oid
     or v_helper.prokind <> 'f'
     or v_helper.prosecdef
     or v_helper.proowner <> v_builder.proowner
     or not coalesce(v_helper.proconfig, '{}'::text[]) @> array['search_path=pg_catalog']::text[] then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ROW_SHAPE_VOLATILITY_POSTFLIGHT_MISMATCH';
  end if;

  if not v_builder.prosecdef
     or not v_legacy.prosecdef
     or not v_effective.prosecdef
     or not coalesce(v_builder.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or not coalesce(v_legacy.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or not coalesce(v_effective.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[] then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ROW_SHAPE_CONTRACT_POSTFLIGHT_MISMATCH';
  end if;

  if has_function_privilege('public', v_helper_oid, 'EXECUTE')
     or has_function_privilege('anon', v_helper_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_helper_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_legacy_oid, 'EXECUTE')
     or has_function_privilege('public', v_effective_oid, 'EXECUTE')
     or has_function_privilege('anon', v_effective_oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_effective_oid, 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ROW_SHAPE_ACL_POSTFLIGHT_MISMATCH';
  end if;

  v_builder_definition := regexp_replace(lower(pg_get_functiondef(v_builder_oid)), '[[:space:]]+', '', 'g');
  v_legacy_definition := regexp_replace(lower(pg_get_functiondef(v_legacy_oid)), '[[:space:]]+', '', 'g');
  if regexp_count(v_builder_definition, 'jsonb_array_elements\(p_source_snapshot->v_table\)') <> 1
     or regexp_count(v_builder_definition, 'public\.erp_cloud_restore_reject_invalid_portable_row\(v_table\)') <> 1
     or strpos(v_builder_definition, "whenjsonb_typeof(row_value)='object'thentrue") = 0
     or strpos(v_builder_definition, 'jsonb_array_elements_text(') > 0
     or strpos(v_builder_definition, 'jsonb_each_text(') > 0
     or strpos(v_builder_definition, 'row_value::text') > 0
     or strpos(v_builder_definition, 'row_value->>') > 0
     or regexp_count(v_legacy_definition, 'v_server_fingerprint:=public\.erp_cloud_restore_idempotency_fingerprint\(p_snapshot,p_manifest\);') <> 1
     or strpos(v_legacy_definition, 'v_server_fingerprint:=public.erp_cloud_restore_idempotency_fingerprint(p_snapshot,p_manifest);')
        >= strpos(v_legacy_definition, 'deletefrompublic.') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ROW_SHAPE_DEFINITION_POSTFLIGHT_MISMATCH';
  end if;
end;
$cloud_restore_row_shape_postflight$;

commit;
