-- Cloud ERP atomic JSON restore.
-- Review/build artifact only. Do not apply without a separately authorized Cloud gate.
begin;

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.erp_cloud_restore_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  source_environment text not null,
  snapshot_fingerprint text not null,
  manifest jsonb not null,
  snapshot jsonb not null
);

create table if not exists public.erp_cloud_restore_requests (
  actor_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null,
  snapshot_fingerprint text not null,
  status text not null check (status in ('processing', 'completed')),
  rollback_snapshot_id uuid references public.erp_cloud_restore_snapshots(id) on delete restrict,
  canonical_result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (actor_id, idempotency_key),
  constraint erp_cloud_restore_completion_check check (
    (status = 'processing' and canonical_result is null and completed_at is null)
    or (status = 'completed' and canonical_result is not null and completed_at is not null and rollback_snapshot_id is not null)
  )
);

create table if not exists public.erp_cloud_restore_epoch (
  singleton boolean primary key default true check (singleton),
  epoch bigint not null default 0,
  restored_at timestamptz,
  restored_by uuid references auth.users(id) on delete set null,
  snapshot_fingerprint text
);
insert into public.erp_cloud_restore_epoch (singleton) values (true) on conflict (singleton) do nothing;

alter table public.erp_cloud_restore_snapshots enable row level security;
alter table public.erp_cloud_restore_requests enable row level security;
alter table public.erp_cloud_restore_epoch enable row level security;

drop policy if exists "cloud restore owner snapshot read" on public.erp_cloud_restore_snapshots;
create policy "cloud restore owner snapshot read" on public.erp_cloud_restore_snapshots
for select to authenticated using (public.is_owner(auth.uid()));
drop policy if exists "cloud restore own request read" on public.erp_cloud_restore_requests;
create policy "cloud restore own request read" on public.erp_cloud_restore_requests
for select to authenticated using (actor_id = auth.uid() and public.is_owner(auth.uid()));
drop policy if exists "cloud restore epoch read" on public.erp_cloud_restore_epoch;
create policy "cloud restore epoch read" on public.erp_cloud_restore_epoch
for select to authenticated using (true);

revoke all on public.erp_cloud_restore_snapshots from public, anon, authenticated;
revoke all on public.erp_cloud_restore_requests from public, anon, authenticated;
revoke all on public.erp_cloud_restore_epoch from public, anon;
grant select on public.erp_cloud_restore_snapshots to authenticated;
grant select on public.erp_cloud_restore_requests to authenticated;
grant select on public.erp_cloud_restore_epoch to authenticated;

create or replace function public.erp_assert_cloud_restore_unlocked()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if current_setting('erp.cloud_restore_active', true) = 'on' then
    return null;
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock', 0)) then
    raise exception using errcode = '55006', message = 'CLOUD_RESTORE_MAINTENANCE_LOCKED';
  end if;
  return null;
end;
$$;

revoke all on function public.erp_assert_cloud_restore_unlocked() from public, anon, authenticated;

do $install_restore_guards$
declare
  v_table text;
begin
  foreach v_table in array array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items',
    'sales_orders','sales_order_items','japan_packages','japan_package_items',
    'outbound_shipments','outbound_shipment_items'
  ] loop
    execute format('drop trigger if exists erp_cloud_restore_maintenance_guard on public.%I', v_table);
    execute format(
      'create trigger erp_cloud_restore_maintenance_guard before insert or update or delete on public.%I for each statement execute function public.erp_assert_cloud_restore_unlocked()',
      v_table
    );
  end loop;
end;
$install_restore_guards$;

create or replace function public.erp_cloud_restore_snapshot()
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
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
    'outbound_shipment_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.outbound_shipment_items t), '[]'::jsonb)
  );
$$;
revoke all on function public.erp_cloud_restore_snapshot() from public, anon, authenticated;

create or replace function public.erp_cloud_restore_relationship_hash(p_snapshot jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, public, extensions
as $$
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
  ), projection as (
    select coalesce(jsonb_agg(jsonb_build_object('table',table_name,'id',record_id,'relations',links) order by table_name,record_id), '[]'::jsonb) value from relations
  )
  select encode(digest(convert_to(value::text,'UTF8'),'sha256'),'hex') from projection;
$$;
revoke all on function public.erp_cloud_restore_relationship_hash(jsonb) from public, anon, authenticated;

create or replace function public.erp_cloud_restore_insert_rows(p_table regclass, p_rows jsonb)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_columns text;
  v_count bigint;
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
$$;
revoke all on function public.erp_cloud_restore_insert_rows(regclass, jsonb) from public, anon, authenticated;

create or replace function public.erp_restore_cloud_snapshot(
  p_idempotency_key uuid,
  p_snapshot_fingerprint text,
  p_snapshot jsonb,
  p_manifest jsonb,
  p_source_environment text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.erp_cloud_restore_requests%rowtype;
  v_rollback_id uuid;
  v_before jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_table text;
  v_expected bigint;
  v_actual bigint;
  v_epoch bigint;
  v_result jsonb;
  v_server_fingerprint text;
  v_expected_relationship_hash text;
  v_actual_relationship_hash text;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode = '42501', message = 'CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  if p_idempotency_key is null or p_snapshot_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_REQUEST_INVALID';
  end if;
  if jsonb_typeof(p_snapshot) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_SNAPSHOT_INVALID';
  end if;
  if jsonb_typeof(p_manifest) is distinct from 'object'
     or p_manifest->>'schemaVersion' is distinct from 'cloud-erp-snapshot-v1' then
    raise exception using errcode = '22023', message = 'UNSUPPORTED_SCHEMA_VERSION';
  end if;
  if jsonb_typeof(p_manifest->'counts') is distinct from 'object'
     or (p_manifest->>'resourceCount')::bigint <> 15
     or coalesce((p_manifest->>'orphanCount')::bigint, -1) <> 0
     or coalesce((p_manifest->>'duplicateVariantIdCount')::bigint, -1) <> 0
     or coalesce((p_manifest->>'duplicateVariantLocalIdCount')::bigint, -1) <> 0 then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_MANIFEST_INVALID';
  end if;
  v_server_fingerprint := encode(digest(convert_to(p_snapshot::text, 'UTF8'), 'sha256'), 'hex');
  v_expected_relationship_hash := public.erp_cloud_restore_relationship_hash(p_snapshot);
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
    return v_existing.canonical_result || jsonb_build_object('replayed', true);
  end if;

  foreach v_table in array array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'
  ] loop
    if jsonb_typeof(p_snapshot->v_table) <> 'array' then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_RESOURCE_REQUIRED:' || v_table;
    end if;
    v_expected := jsonb_array_length(p_snapshot->v_table);
    if coalesce((p_manifest->'counts'->>v_table)::bigint, -1) <> v_expected then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_MANIFEST_COUNT_MISMATCH:' || v_table;
    end if;
    if (select count(*) from (select row_value->>'id' from jsonb_array_elements(p_snapshot->v_table) row_value group by 1 having count(*) > 1) duplicates) > 0
       and v_table <> 'inventory_items' then
      raise exception using errcode = '23505', message = 'DUPLICATE_CANONICAL_ID:' || v_table;
    end if;
    v_counts := v_counts || jsonb_build_object(v_table, v_expected);
  end loop;
  if coalesce((p_manifest->>'totalRows')::bigint, -1)
     <> (select coalesce(sum(value::bigint), 0) from jsonb_each_text(v_counts)) then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_MANIFEST_TOTAL_MISMATCH';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_snapshot->'product_variants') v
    where nullif(v->>'local_id','') is not null
    group by v->>'local_id' having count(*) > 1
  ) then raise exception using errcode = '23505', message = 'DUPLICATE_VARIANT_LOCAL_ID'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_snapshot->'inventory_items') item
    group by item->>'inventory_key' having nullif(item->>'inventory_key','') is null or count(*) > 1
  ) then raise exception using errcode = '23505', message = 'DUPLICATE_OR_MISSING_INVENTORY_KEY'; end if;

  v_before := public.erp_cloud_restore_snapshot();
  insert into public.erp_cloud_restore_snapshots(actor_id,source_environment,snapshot_fingerprint,manifest,snapshot)
  values(
    v_actor,
    coalesce(nullif(current_setting('request.headers', true), '')::jsonb->>'host', 'unknown'),
    v_server_fingerprint,
    p_manifest || jsonb_build_object('restoreSourceEnvironment', p_source_environment),
    v_before
  )
  returning id into v_rollback_id;

  perform set_config('erp.cloud_restore_active','on',true);
  delete from public.outbound_shipment_items;
  delete from public.outbound_shipments;
  delete from public.japan_package_items;
  delete from public.japan_packages;
  delete from public.private_order_items;
  delete from public.purchase_batch_items;
  delete from public.sales_order_items;
  delete from public.bundle_components;
  delete from public.private_orders;
  delete from public.purchase_batches;
  delete from public.product_variants;
  delete from public.product_categories;
  delete from public.sales_orders;
  delete from public.product_groups;
  delete from public.inventory_items;

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

  foreach v_table in array array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'
  ] loop
    execute format('select count(*) from public.%I', v_table) into v_actual;
    v_expected := (v_counts->>v_table)::bigint;
    if v_actual <> v_expected then
      raise exception using errcode = '23000', message = 'CLOUD_RESTORE_POST_INTEGRITY_COUNT_MISMATCH:' || v_table;
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
  v_actual_relationship_hash := public.erp_cloud_restore_relationship_hash(public.erp_cloud_restore_snapshot());
  if v_actual_relationship_hash <> v_expected_relationship_hash then
    raise exception using errcode = '23000', message = 'CLOUD_RESTORE_POST_INTEGRITY_RELATIONSHIP_HASH_MISMATCH';
  end if;

  update public.erp_cloud_restore_epoch
     set epoch=epoch+1, restored_at=now(), restored_by=v_actor, snapshot_fingerprint=v_server_fingerprint
   where singleton=true returning epoch into v_epoch;
  v_result := jsonb_build_object(
    'ok',true,'replayed',false,'idempotencyKey',p_idempotency_key,
    'snapshotFingerprint',p_snapshot_fingerprint,'serverSnapshotFingerprint',v_server_fingerprint,'rollbackSnapshotId',v_rollback_id,
    'restoreEpoch',v_epoch,'manifest',p_manifest,'serverRelationshipHash',v_actual_relationship_hash
  );
  update public.erp_cloud_restore_requests set status='completed',rollback_snapshot_id=v_rollback_id,
    canonical_result=v_result,completed_at=now()
   where actor_id=v_actor and idempotency_key=p_idempotency_key;
  return v_result;
exception when others then
  raise;
end;
$$;

revoke all on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) from public, anon;
grant execute on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) to authenticated;

do $publication$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='erp_cloud_restore_epoch'
  ) then
    alter publication supabase_realtime add table public.erp_cloud_restore_epoch;
  end if;
end;
$publication$;

commit;
