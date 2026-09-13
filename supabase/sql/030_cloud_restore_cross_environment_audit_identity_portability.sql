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
  v_original_count integer;
  v_replacement_count integer;
begin
  select pg_get_functiondef('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'::regprocedure)
    into v_definition;
  if v_definition is null then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ACCEPTED_FUNCTION_MISSING';
  end if;

  v_original_count := (length(v_definition) - length(replace(v_definition, v_original, ''))) / length(v_original);
  v_replacement_count := (length(v_definition) - length(replace(v_definition, v_replacement, ''))) / length(v_replacement);
  if v_original_count <> 1 or v_replacement_count <> 0 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_IDEMPOTENCY_BASELINE_MISMATCH';
  end if;

  v_definition := replace(v_definition, v_original, v_replacement);
  v_original_count := (length(v_definition) - length(replace(v_definition, v_original, ''))) / length(v_original);
  v_replacement_count := (length(v_definition) - length(replace(v_definition, v_replacement, ''))) / length(v_replacement);
  if v_original_count <> 0 or v_replacement_count <> 1 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_IDEMPOTENCY_PATCH_MISMATCH';
  end if;
  execute v_definition;
end;
$patch_restore_idempotency$;

revoke all on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) from public, anon;
grant execute on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) to authenticated;

do $portability_postflight$
declare
  v_restore_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)');
  v_validate_oid oid := to_regprocedure('public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)');
  v_fingerprint_oid oid := to_regprocedure('public.erp_cloud_restore_idempotency_fingerprint(jsonb,jsonb)');
  v_restore record;
  v_validate record;
  v_fingerprint record;
  v_restore_definition text;
  v_validate_definition text;
  v_fingerprint_definition text;
  v_compact_restore_definition text;
  v_compact_validate_definition text;
  v_compact_fingerprint_definition text;
  v_required_snippet text;
  v_wiring_position integer;
  v_first_delete_position integer;
  v_table text;
  v_table_oid oid;
  v_column_attnum smallint;
  v_table_external_count integer;
  v_table_expected_fk_count integer;
  v_external_reference_count integer := 0;
  v_tables constant text[] := array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'
  ];
begin
  if v_restore_oid is null or v_validate_oid is null or v_fingerprint_oid is null then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_FUNCTION_MISSING';
  end if;

  select p.*, l.lanname as language_name, oidvectortypes(p.proargtypes) as argument_types
    into v_restore
    from pg_proc p
    join pg_language l on l.oid = p.prolang
   where p.oid = v_restore_oid;
  select p.*, l.lanname as language_name, oidvectortypes(p.proargtypes) as argument_types
    into v_validate
    from pg_proc p
    join pg_language l on l.oid = p.prolang
   where p.oid = v_validate_oid;
  select p.*, l.lanname as language_name, oidvectortypes(p.proargtypes) as argument_types
    into v_fingerprint
    from pg_proc p
    join pg_language l on l.oid = p.prolang
   where p.oid = v_fingerprint_oid;

  if v_validate.argument_types <> 'jsonb, jsonb, text'
     or v_validate.prorettype <> 'jsonb'::regtype
     or v_validate.language_name <> 'plpgsql'
     or not v_validate.prosecdef
     or not coalesce(v_validate.proconfig @> array['search_path=pg_catalog, public, extensions'], false)
     or not coalesce(v_validate.proconfig @> array['statement_timeout=30s'], false)
     or exists (
       select 1 from unnest(coalesce(v_validate.proconfig, array[]::text[])) config_entry
        where split_part(config_entry, '=', 1) = 'safeupdate.enabled'
     )
     or exists (
       select 1 from aclexplode(coalesce(v_validate.proacl, acldefault('f', v_validate.proowner))) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
     )
     or has_function_privilege('anon', v_validate_oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_validate_oid, 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_VALIDATOR_CATALOG_MISMATCH';
  end if;

  if v_fingerprint.argument_types <> 'jsonb, jsonb'
     or v_fingerprint.prorettype <> 'text'::regtype
     or v_fingerprint.language_name <> 'plpgsql'
     or not v_fingerprint.prosecdef
     or not coalesce(v_fingerprint.proconfig @> array['search_path=pg_catalog, public, extensions'], false)
     or exists (
       select 1 from unnest(coalesce(v_fingerprint.proconfig, array[]::text[])) config_entry
        where split_part(config_entry, '=', 1) in ('safeupdate.enabled', 'statement_timeout')
     )
     or exists (
       select 1 from aclexplode(coalesce(v_fingerprint.proacl, acldefault('f', v_fingerprint.proowner))) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
     )
     or has_function_privilege('anon', v_fingerprint_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_fingerprint_oid, 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_FINGERPRINT_CATALOG_MISMATCH';
  end if;

  if v_restore.argument_types <> 'uuid, text, jsonb, jsonb, text'
     or v_restore.prorettype <> 'jsonb'::regtype
     or v_restore.language_name <> 'plpgsql'
     or not v_restore.prosecdef
     or not coalesce(v_restore.proconfig @> array['search_path=pg_catalog, public, extensions'], false)
     or not coalesce(v_restore.proconfig @> array['statement_timeout=30s'], false)
     or exists (
       select 1 from unnest(coalesce(v_restore.proconfig, array[]::text[])) config_entry
        where split_part(config_entry, '=', 1) = 'safeupdate.enabled'
     )
     or exists (
       select 1 from aclexplode(coalesce(v_restore.proacl, acldefault('f', v_restore.proowner))) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
     )
     or has_function_privilege('anon', v_restore_oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_restore_oid, 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_RESTORE_CATALOG_MISMATCH';
  end if;

  v_restore_definition := lower(pg_get_functiondef(v_restore_oid));
  v_validate_definition := lower(pg_get_functiondef(v_validate_oid));
  v_fingerprint_definition := lower(pg_get_functiondef(v_fingerprint_oid));
  v_compact_restore_definition := regexp_replace(v_restore_definition, '[[:space:]]+', '', 'g');
  v_compact_validate_definition := regexp_replace(v_validate_definition, '[[:space:]]+', '', 'g');
  v_compact_fingerprint_definition := regexp_replace(v_fingerprint_definition, '[[:space:]]+', '', 'g');

  foreach v_required_snippet in array array[
    'ifv_actorisnullthen',
    'ifnotpublic.is_owner(v_actor)then',
    'ifp_target_project_refisdistinctfrom''rhfdjsklfrgpoqsaqpkn''then',
    'ifsplit_part(v_request_host,''.'',1)isdistinctfromp_target_project_refthen',
    'v_policy->>''policyversion''isdistinctfrom''cross-environment-audit-null-v1''',
    'v_policy->>''mode''isdistinctfrom''cross-environment''',
    'v_policy->>''targetprojectref''isdistinctfromp_target_project_ref',
    'wherekeynotin(',
    'jsonb_array_elements(p_snapshot->v_table)row_value',
    'not(row_value?''updated_by'')',
    'jsonb_typeof(row_value->''updated_by'')isdistinctfrom''null''',
    'cloud_restore_portability_schema_mismatch:',
    'cloud_restore_portability_external_reference_blocked'
  ] loop
    if strpos(v_compact_validate_definition, v_required_snippet) = 0 then
      raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_VALIDATOR_DEFINITION_MISMATCH';
    end if;
  end loop;

  foreach v_table in array v_tables loop
    v_table_oid := null;
    v_column_attnum := null;
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

    if v_table_oid is null or v_column_attnum is null then
      raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_SCHEMA_MISMATCH:' || v_table || '.updated_by';
    end if;

    select count(distinct fk.oid),
           count(distinct fk.oid) filter (
             where cardinality(fk.conkey) = 1
               and child_column.attname = 'updated_by'
               and parent_ns.nspname = 'auth'
               and parent.relname = 'users'
               and parent_column.attname = 'id'
               and fk.confdeltype = 'n'
               and fk.convalidated
           )
      into v_table_external_count, v_table_expected_fk_count
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
       and child.relname = v_table
       and not (parent_ns.nspname = 'public' and parent.relname = any(v_tables));

    if v_table_external_count <> 1 or v_table_expected_fk_count <> 1 then
      raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_EXTERNAL_REFERENCE_BLOCKED:' || v_table;
    end if;
    v_external_reference_count := v_external_reference_count + v_table_external_count;
  end loop;

  if v_external_reference_count <> cardinality(v_tables) then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_EXTERNAL_REFERENCE_BLOCKED';
  end if;

  if strpos(v_compact_fingerprint_definition, 'ifp_manifest?''portability''then') = 0
     or strpos(v_compact_fingerprint_definition, 'performpublic.erp_cloud_restore_validate_portability(p_snapshot,p_manifest,p_manifest->''portability''->>''targetprojectref'')') = 0
     or strpos(v_compact_fingerprint_definition, 'jsonb_build_object(''snapshot'',p_snapshot,''portability'',p_manifest->''portability'')') = 0
     or strpos(v_compact_fingerprint_definition, 'returnencode(digest(convert_to(p_snapshot::text,''utf8''),''sha256''),''hex'')') = 0 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_FINGERPRINT_DEFINITION_MISMATCH';
  end if;

  if regexp_count(v_compact_restore_definition, 'v_server_fingerprint:=public\.erp_cloud_restore_idempotency_fingerprint\(p_snapshot,p_manifest\);') <> 1
     or strpos(v_compact_restore_definition, 'v_server_fingerprint:=encode(digest(convert_to(p_snapshot::text,''utf8''),''sha256''),''hex'');') > 0
     or strpos(v_compact_restore_definition, 'ifv_existing.snapshot_fingerprint<>v_server_fingerprintthen') = 0
     or strpos(v_compact_restore_definition, 'ifv_existing.status=''completed''then') = 0
     or strpos(v_compact_restore_definition, 'returnv_existing.canonical_result||jsonb_build_object(''replayed'',true)') = 0 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_IDEMPOTENCY_DEFINITION_MISMATCH';
  end if;

  v_wiring_position := strpos(v_compact_restore_definition, 'v_server_fingerprint:=public.erp_cloud_restore_idempotency_fingerprint(p_snapshot,p_manifest);');
  v_first_delete_position := strpos(v_compact_restore_definition, 'deletefrompublic.');
  if v_wiring_position = 0
     or v_first_delete_position = 0
     or v_wiring_position >= v_first_delete_position then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_PORTABILITY_VALIDATION_ORDER_MISMATCH';
  end if;
end;
$portability_postflight$;

commit;
