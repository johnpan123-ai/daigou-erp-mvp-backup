-- Cloud Restore cross-environment audit identity portability.
-- Review/build artifact only. Do not apply without a separately authorized
-- Staging SQL gate. This migration performs no business-table DML.
begin;

create or replace function public.erp_cloud_restore_validate_portability(
  p_snapshot jsonb,
  p_manifest jsonb,
  p_target_project_ref text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '30s'
as $$
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
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'
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
$$;

revoke all on function public.erp_cloud_restore_validate_portability(jsonb,jsonb,text) from public, anon;
grant execute on function public.erp_cloud_restore_validate_portability(jsonb,jsonb,text) to authenticated;

create or replace function public.erp_cloud_restore_idempotency_fingerprint(
  p_snapshot jsonb,
  p_manifest jsonb
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if p_manifest ? 'portability' then
    perform public.erp_cloud_restore_validate_portability(
      p_snapshot,
      p_manifest,
      p_manifest->'portability'->>'targetProjectRef'
    );
    return encode(digest(convert_to(jsonb_build_object(
      'snapshot', p_snapshot,
      'portability', p_manifest->'portability'
    )::text, 'UTF8'), 'sha256'), 'hex');
  end if;
  return encode(digest(convert_to(p_snapshot::text, 'UTF8'), 'sha256'), 'hex');
end;
$$;

revoke all on function public.erp_cloud_restore_idempotency_fingerprint(jsonb,jsonb) from public, anon, authenticated;

do $patch_restore_idempotency$
declare
  v_definition text;
  v_original constant text := 'v_server_fingerprint := encode(digest(convert_to(p_snapshot::text, ''UTF8''), ''sha256''), ''hex'');';
  v_replacement constant text := 'v_server_fingerprint := public.erp_cloud_restore_idempotency_fingerprint(p_snapshot, p_manifest);';
begin
  select pg_get_functiondef('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'::regprocedure)
    into v_definition;
  if v_definition is null then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ACCEPTED_FUNCTION_MISSING';
  end if;
  if strpos(v_definition, v_replacement) > 0 then
    null;
  elsif strpos(v_definition, v_original) > 0 then
    v_definition := replace(v_definition, v_original, v_replacement);
    execute v_definition;
  else
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_IDEMPOTENCY_BASELINE_MISMATCH';
  end if;
end;
$patch_restore_idempotency$;

revoke all on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) from public, anon;
grant execute on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) to authenticated;

do $portability_postflight$
declare
  v_restore_definition text := lower(pg_get_functiondef('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'::regprocedure));
  v_validate_definition text := lower(pg_get_functiondef('public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)'::regprocedure));
  v_restore_config text[];
  v_validate_config text[];
  v_validate_security_definer boolean;
begin
  select p.proconfig into v_restore_config
    from pg_proc p
   where p.oid = 'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'::regprocedure;
  select p.proconfig, p.prosecdef into v_validate_config, v_validate_security_definer
    from pg_proc p
   where p.oid = 'public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)'::regprocedure;
  if strpos(v_restore_definition, 'erp_cloud_restore_idempotency_fingerprint(p_snapshot, p_manifest)') = 0
     or strpos(v_restore_definition, 'pg_try_advisory_xact_lock') = 0
     or strpos(v_restore_definition, 'erp.cloud_restore_active') = 0
     or strpos(v_validate_definition, 'rhfdjsklfrgpoqsaqpkn') = 0
     or strpos(v_validate_definition, 'auth.users') = 0
     or strpos(v_validate_definition, 'updated_by') = 0
     or not coalesce(v_restore_config @> array['statement_timeout=30s'], false)
     or not coalesce(v_restore_config @> array['search_path=pg_catalog, public, extensions'], false)
     or not coalesce(v_validate_security_definer, false)
     or not coalesce(v_validate_config @> array['search_path=pg_catalog, public, extensions'], false)
     or not coalesce(v_validate_config @> array['statement_timeout=30s'], false)
     or exists (
       select 1 from aclexplode(coalesce(
         (select proacl from pg_proc where oid = 'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'::regprocedure),
         acldefault('f', (select proowner from pg_proc where oid = 'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'::regprocedure))
       )) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
     )
     or has_function_privilege('anon', 'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', 'EXECUTE')
     or exists (
       select 1 from aclexplode(coalesce(
         (select proacl from pg_proc where oid = 'public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)'::regprocedure),
         acldefault('f', (select proowner from pg_proc where oid = 'public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)'::regprocedure))
       )) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
     )
     or has_function_privilege('anon', 'public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)', 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_POSTFLIGHT_FAILED';
  end if;
end;
$portability_postflight$;

commit;
