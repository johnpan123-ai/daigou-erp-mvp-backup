-- Align Cloud Restore with the authoritative post-parity live schema.
-- All fifteen Restore tables use id uuid NOT NULL PRIMARY KEY as canonical
-- database identity. inventory_items.inventory_key remains a NOT NULL UNIQUE
-- importer/domain key and is never used as the Restore row identity.
-- Review/build artifact only. Apply only in a separately authorized Staging gate.
begin;

do $restore_live_schema_preflight$
declare
  v_table text;
  v_table_oid oid;
  v_id_attnum smallint;
  v_id_not_null boolean;
  v_id_type text;
  v_inventory_key_attnum smallint;
  v_inventory_key_not_null boolean;
  v_inventory_key_type text;
  v_tables constant text[] := array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'
  ];
begin
  foreach v_table in array v_tables loop
    v_table_oid := null;
    v_id_attnum := null;
    v_id_not_null := null;
    v_id_type := null;
    select c.oid, a.attnum, a.attnotnull, format_type(a.atttypid, a.atttypmod)
      into v_table_oid, v_id_attnum, v_id_not_null, v_id_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
     where n.nspname = 'public'
       and c.relname = v_table
       and c.relkind in ('r', 'p')
       and a.attname = 'id'
       and a.attnum > 0
       and not a.attisdropped;

    if v_table_oid is null
       or not coalesce(v_id_not_null, false)
       or v_id_type is distinct from 'uuid'
       or not exists (
         select 1
           from pg_constraint constraint_row
          where constraint_row.conrelid = v_table_oid
            and constraint_row.contype = 'p'
            and constraint_row.conkey = array[v_id_attnum]::smallint[]
       ) then
      raise exception using
        errcode = '55000',
        message = 'CLOUD_RESTORE_ID_PRIMARY_KEY_CONTRACT_MISMATCH:' || v_table;
    end if;
  end loop;

  select a.attnum, a.attnotnull, format_type(a.atttypid, a.atttypmod)
    into v_inventory_key_attnum, v_inventory_key_not_null, v_inventory_key_type
    from pg_attribute a
   where a.attrelid = 'public.inventory_items'::regclass
     and a.attname = 'inventory_key'
     and a.attnum > 0
     and not a.attisdropped;

  if v_inventory_key_attnum is null
     or not coalesce(v_inventory_key_not_null, false)
     or v_inventory_key_type is distinct from 'text'
     or not exists (
       select 1
         from pg_constraint constraint_row
        where constraint_row.conrelid = 'public.inventory_items'::regclass
          and constraint_row.contype = 'u'
          and constraint_row.conkey = array[v_inventory_key_attnum]::smallint[]
     )
     or exists (
       select 1
         from pg_constraint constraint_row
        where constraint_row.conrelid = 'public.inventory_items'::regclass
          and constraint_row.contype = 'p'
          and v_inventory_key_attnum = any(constraint_row.conkey)
     ) then
    raise exception using
      errcode = '55000',
      message = 'CLOUD_RESTORE_INVENTORY_KEY_CONTRACT_MISMATCH';
  end if;
end;
$restore_live_schema_preflight$;

create or replace function public.erp_cloud_restore_table_profile(
  p_table regclass,
  p_rows jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
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
    'public.japan_package_items'::regclass,'public.outbound_shipments'::regclass,'public.outbound_shipment_items'::regclass
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
$$;

revoke all on function public.erp_cloud_restore_table_profile(regclass, jsonb) from public, anon, authenticated;

-- The currently accepted Staging function is the 025 definition. Patch only
-- its fixed, allowlisted DELETE statements so all fifteen use the live id PK.
-- An unexpected definition fails closed instead of manufacturing a new path.
do $restore_guarded_delete_upgrade$
declare
  v_definition text;
  v_table text;
  v_unguarded_count integer := 0;
  v_guarded_count integer := 0;
  v_tables constant text[] := array[
    'outbound_shipment_items','outbound_shipments','japan_package_items','japan_packages',
    'private_order_items','purchase_batch_items','sales_order_items','bundle_components',
    'private_orders','purchase_batches','product_variants','product_categories','sales_orders',
    'product_groups','inventory_items'
  ];
begin
  select pg_get_functiondef(p.oid)
    into v_definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.oid = 'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'::regprocedure;

  if v_definition is null
     or strpos(lower(v_definition), 'security definer') = 0
     or strpos(v_definition, 'public.is_owner(v_actor)') = 0
     or strpos(v_definition, 'pg_try_advisory_xact_lock') = 0
     or strpos(v_definition, 'erp.cloud_restore_active') = 0
     or strpos(v_definition, 'erp_cloud_restore_snapshots') = 0
     or strpos(v_definition, 'RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH') = 0
     or strpos(v_definition, 'DUPLICATE_CANONICAL_ID') = 0
     or strpos(v_definition, 'CLOUD_RESTORE_TIMING phase=') = 0 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ACCEPTED_FUNCTION_BASELINE_MISMATCH';
  end if;

  foreach v_table in array v_tables loop
    if strpos(lower(v_definition), format('delete from public.%s where id is not null;', v_table)) > 0 then
      v_guarded_count := v_guarded_count + 1;
    elsif strpos(lower(v_definition), format('delete from public.%s;', v_table)) > 0 then
      v_unguarded_count := v_unguarded_count + 1;
      v_definition := replace(
        v_definition,
        format('delete from public.%s;', v_table),
        format('delete from public.%s where id is not null;', v_table)
      );
    else
      raise exception using
        errcode = '55000',
        message = 'CLOUD_RESTORE_DELETE_BASELINE_MISMATCH:' || v_table;
    end if;
  end loop;

  if not ((v_unguarded_count = 15 and v_guarded_count = 0)
          or (v_unguarded_count = 0 and v_guarded_count = 15)) then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_MIXED_DELETE_BASELINE_REFUSED';
  end if;
  execute v_definition;
end;
$restore_guarded_delete_upgrade$;

revoke all on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) from public, anon;
grant execute on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) to authenticated;

do $restore_live_schema_postflight$
declare
  v_restore_definition text;
  v_profile_definition text;
  v_compact_definition text;
  v_config text[];
  v_public_execute boolean;
  v_previous_position integer := 0;
  v_position integer;
  v_table text;
  v_delete_tables constant text[] := array[
    'outbound_shipment_items','outbound_shipments','japan_package_items','japan_packages',
    'private_order_items','purchase_batch_items','sales_order_items','bundle_components',
    'private_orders','purchase_batches','product_variants','product_categories','sales_orders',
    'product_groups','inventory_items'
  ];
begin
  select lower(pg_get_functiondef(p.oid)), p.proconfig,
         exists (
           select 1
             from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
            where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
         )
    into v_restore_definition, v_config, v_public_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.oid = 'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'::regprocedure;

  select lower(pg_get_functiondef('public.erp_cloud_restore_table_profile(regclass,jsonb)'::regprocedure))
    into v_profile_definition;
  v_compact_definition := regexp_replace(v_restore_definition, '[[:space:]]+', '', 'g');

  if strpos(v_restore_definition, 'security definer') = 0
     or strpos(v_compact_definition, 'ifv_actorisnullthen') = 0
     or strpos(v_compact_definition, 'public.is_owner(v_actor)') = 0
     or strpos(v_compact_definition, 'pg_try_advisory_xact_lock') = 0
     or strpos(v_compact_definition, 'performset_config(''erp.cloud_restore_active'',''on'',true)') = 0
     or strpos(v_profile_definition, 'row_value.id::text') = 0
     or strpos(v_profile_definition, 'row_value->>''id''') = 0
     or strpos(v_profile_definition, 'when p_table = ''public.inventory_items''::regclass then ''inventory_key''') > 0 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_AUTHORITY_OR_IDENTITY_POSTFLIGHT_FAILED';
  end if;

  if regexp_count(v_restore_definition, 'delete[[:space:]]+from[[:space:]]+public\.[a-z_]+[[:space:]]+where[[:space:]]+id[[:space:]]+is[[:space:]]+not[[:space:]]+null') <> 15
     or regexp_count(v_restore_definition, 'delete[[:space:]]+from[[:space:]]+') <> 15 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_SAFEUPDATE_DELETE_POSTFLIGHT_FAILED';
  end if;
  foreach v_table in array v_delete_tables loop
    v_position := strpos(v_compact_definition, format('deletefrompublic.%swhereidisnotnull', v_table));
    if v_position = 0 or v_position <= v_previous_position then
      raise exception using errcode = '55000', message = 'CLOUD_RESTORE_DELETE_ALLOWLIST_OR_ORDER_POSTFLIGHT_FAILED:' || v_table;
    end if;
    v_previous_position := v_position;
  end loop;

  if not coalesce(v_config @> array['statement_timeout=30s'], false)
     or not coalesce(v_config @> array['search_path=pg_catalog, public, extensions'], false)
     or exists (
       select 1 from unnest(coalesce(v_config, array[]::text[])) config_entry
        where split_part(config_entry, '=', 1) = 'safeupdate.enabled'
     ) then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FUNCTION_CONFIG_POSTFLIGHT_FAILED';
  end if;

  if v_public_execute
     or has_function_privilege('anon', 'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_FUNCTION_GRANT_POSTFLIGHT_FAILED';
  end if;
end;
$restore_live_schema_postflight$;

commit;
