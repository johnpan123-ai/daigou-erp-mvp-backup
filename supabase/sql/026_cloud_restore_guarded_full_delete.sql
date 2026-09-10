-- Allow the owner-only atomic Restore RPC to perform its fixed, reviewed
-- full-table replacement while preserving safeupdate for every other caller.
-- Review/build artifact only. Do not apply without a separately authorized gate.
begin;

do $restore_delete_contract_preflight$
declare
  v_definition text;
  v_compact_definition text;
  v_auth_position integer;
  v_owner_position integer;
  v_lock_position integer;
  v_context_position integer;
  v_previous_position integer := 0;
  v_position integer;
  v_table text;
  v_delete_tables constant text[] := array[
    'outbound_shipment_items',
    'outbound_shipments',
    'japan_package_items',
    'japan_packages',
    'private_order_items',
    'purchase_batch_items',
    'sales_order_items',
    'bundle_components',
    'private_orders',
    'purchase_batches',
    'product_variants',
    'product_categories',
    'sales_orders',
    'product_groups',
    'inventory_items'
  ];
begin
  v_definition := lower(pg_get_functiondef(
    'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'::regprocedure
  ));
  v_compact_definition := regexp_replace(v_definition, '[[:space:]]+', '', 'g');
  v_auth_position := strpos(v_compact_definition, 'ifv_actorisnullthen');
  v_owner_position := strpos(v_compact_definition, 'public.is_owner(v_actor)');
  v_lock_position := strpos(
    v_compact_definition,
    'pg_try_advisory_xact_lock(hashtextextended(''erp-cloud-restore-maintenance-lock'''
  );
  v_context_position := strpos(
    v_compact_definition,
    'performset_config(''erp.cloud_restore_active'',''on'',true)'
  );

  if strpos(v_definition, 'security definer') = 0
     or v_auth_position = 0
     or v_owner_position <= v_auth_position
     or v_lock_position <= v_owner_position
     or v_context_position <= v_lock_position then
    raise exception using
      errcode = '55000',
      message = 'CLOUD_RESTORE_DELETE_CONTEXT_CONTRACT_MISSING';
  end if;

  if regexp_count(v_definition, 'delete[[:space:]]+from[[:space:]]+') <> array_length(v_delete_tables, 1)
     or regexp_count(v_definition, 'delete[[:space:]]+from[[:space:]]+public\.') <> array_length(v_delete_tables, 1) then
    raise exception using
      errcode = '55000',
      message = 'CLOUD_RESTORE_DELETE_ALLOWLIST_COUNT_MISMATCH';
  end if;

  foreach v_table in array v_delete_tables loop
    v_position := strpos(v_definition, format('delete from public.%s', v_table));
    if v_position = 0 or v_position <= v_previous_position then
      raise exception using
        errcode = '55000',
        message = 'CLOUD_RESTORE_DELETE_ALLOWLIST_OR_ORDER_MISMATCH:' || v_table;
    end if;
    v_previous_position := v_position;
  end loop;

  if strpos(v_compact_definition, 'deletefrompublic.outbound_shipment_items') <= v_context_position then
    raise exception using
      errcode = '55000',
      message = 'CLOUD_RESTORE_DELETE_BEFORE_CONTEXT';
  end if;
end;
$restore_delete_contract_preflight$;

-- PostgreSQL restores a function SET option to its previous value when the
-- function exits, including exceptional exits. This does not alter the role,
-- database, connection pool, or global safeupdate configuration.
alter function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)
  set safeupdate.enabled = 'off';

-- Preserve the previously accepted execution and authority boundaries.
alter function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)
  set statement_timeout = '30s';
alter function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)
  set search_path = pg_catalog, public, extensions;

revoke all on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) from public, anon;
grant execute on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) to authenticated;

do $restore_delete_contract_postflight$
declare
  v_config text[];
  v_public_execute boolean;
begin
  select
    p.proconfig,
    exists (
      select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
       where privilege.grantee = 0
         and privilege.privilege_type = 'EXECUTE'
    )
    into v_config, v_public_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.oid = 'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'::regprocedure;

  if not coalesce(v_config @> array['safeupdate.enabled=off'], false)
     or not coalesce(v_config @> array['statement_timeout=30s'], false)
     or not coalesce(v_config @> array['search_path=pg_catalog, public, extensions'], false) then
    raise exception using
      errcode = '55000',
      message = 'CLOUD_RESTORE_FUNCTION_CONFIG_POSTFLIGHT_FAILED';
  end if;

  if v_public_execute
     or has_function_privilege('anon', 'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', 'EXECUTE') then
    raise exception using
      errcode = '55000',
      message = 'CLOUD_RESTORE_FUNCTION_GRANT_POSTFLIGHT_FAILED';
  end if;
end;
$restore_delete_contract_postflight$;

commit;
