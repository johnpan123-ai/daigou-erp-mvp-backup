begin;

-- Source only. Never apply this file to a live project in the Sol closure turn.
-- WACA business keys remain text; canonical database IDs are UUIDs for restore.
create table public.waca_orders (
  id uuid primary key default gen_random_uuid(),
  order_key text not null unique,
  status text not null check (status in ('處理中','完成付款','取消','失敗')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table public.waca_order_items (
  id uuid primary key default gen_random_uuid(),
  item_key text not null unique,
  order_id uuid not null references public.waca_orders(id) on delete cascade,
  feature text not null,
  product_variant_id uuid references public.product_variants(id) on delete restrict,
  quantity integer not null check (quantity >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create index waca_order_items_order_id_idx on public.waca_order_items(order_id);
create index waca_order_items_variant_id_idx on public.waca_order_items(product_variant_id);
create index waca_order_items_feature_idx on public.waca_order_items(feature);

create table public.waca_mappings (
  id uuid primary key default gen_random_uuid(),
  feature text not null unique,
  product_variant_id uuid not null references public.product_variants(id) on delete restrict,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create index waca_mappings_variant_id_idx on public.waca_mappings(product_variant_id);

create table public.waca_master_links (
  id uuid primary key default gen_random_uuid(),
  child_code text not null unique,
  main_code text not null,
  product_variant_id uuid references public.product_variants(id) on delete restrict,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create index waca_master_links_variant_id_idx on public.waca_master_links(product_variant_id);

create table public.waca_import_batches (
  id uuid primary key default gen_random_uuid(),
  batch_key text not null unique,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table public.waca_cutover_audit (
  id uuid primary key default gen_random_uuid(),
  product_variant_id uuid not null unique references public.product_variants(id) on delete restrict,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table public.waca_state (
  id uuid primary key default '00000000-0000-4000-8000-000000000001'::uuid,
  revision bigint not null default 0 check (revision >= 0),
  mode text not null check (mode in ('LEGACY_QUANTITY_ACTIVE','ORDER_REBASELINE_REQUIRED','ORDER_DRIVEN_ACTIVE')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint waca_state_singleton check (id = '00000000-0000-4000-8000-000000000001'::uuid)
);
insert into public.waca_state(id,revision,mode,payload)
values('00000000-0000-4000-8000-000000000001',0,'LEGACY_QUANTITY_ACTIVE',
  jsonb_build_object('mode','LEGACY_QUANTITY_ACTIVE','updatedAt',now(),'sourceBackupFormatVersion',null));

do $waca_security$
declare v_table text;
begin
  foreach v_table in array array[
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state'
  ] loop
    execute format('alter table public.%I enable row level security',v_table);
    execute format('revoke all on public.%I from public, anon, authenticated',v_table);
    execute format('grant select on public.%I to authenticated',v_table);
    execute format('create policy waca_owner_read on public.%I for select to authenticated using (public.is_owner(auth.uid()))',v_table);
    execute format('create trigger erp_cloud_restore_maintenance_guard before insert or update or delete on public.%I for each statement execute function public.erp_assert_cloud_restore_unlocked()',v_table);
  end loop;
end;
$waca_security$;

-- Only the owner may call these RPCs. No direct table writes are granted.
create function public.erp_waca_variant_id(p_identity text) returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_ids uuid[];
begin
  if p_identity is null or btrim(p_identity) = '' then return null; end if;
  select array_agg(v.id) into v_ids from public.product_variants v
   where v.local_id = p_identity or v.id::text = p_identity;
  if coalesce(cardinality(v_ids),0) <> 1 then
    raise exception using errcode='23503', message='WACA_VARIANT_IDENTITY_NOT_UNIQUE_OR_MISSING';
  end if;
  return v_ids[1];
end;
$$;
revoke all on function public.erp_waca_variant_id(text) from public,anon,authenticated;

create function public.erp_read_waca_snapshot() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_state public.waca_state%rowtype;
begin
  if v_actor is null or not public.is_owner(v_actor) then
    raise exception using errcode='42501',message='WACA_OWNER_REQUIRED';
  end if;
  select * into v_state from public.waca_state limit 1;
  return jsonb_build_object(
    'revision',coalesce(v_state.revision,0),
    'orders',coalesce((select jsonb_agg(payload order by order_key) from public.waca_orders),'[]'::jsonb),
    'items',coalesce((select jsonb_agg(jsonb_set(payload,'{productVariantId}',
      to_jsonb(coalesce(product_variant_id::text,'')),true) order by item_key)
      from public.waca_order_items),'[]'::jsonb),
    'mappings',coalesce((select jsonb_agg(jsonb_set(payload,'{productVariantId}',
      to_jsonb(product_variant_id::text),true) order by feature)
      from public.waca_mappings),'[]'::jsonb),
    'batches',coalesce((select jsonb_agg(payload order by created_at,id) from public.waca_import_batches),'[]'::jsonb),
    'masterLinks',coalesce((select jsonb_agg(jsonb_set(payload,'{productVariantId}',
      to_jsonb(coalesce(product_variant_id::text,'')),true) order by child_code)
      from public.waca_master_links),'[]'::jsonb),
    'cutoverAudit',coalesce((select jsonb_agg(jsonb_set(payload,'{productVariantId}',
      to_jsonb(product_variant_id::text),true) order by product_variant_id)
      from public.waca_cutover_audit),'[]'::jsonb),
    'cutoverState',case when v_state.id is null then null else v_state.payload end
  );
end;
$$;
revoke all on function public.erp_read_waca_snapshot() from public,anon,authenticated;
grant execute on function public.erp_read_waca_snapshot() to authenticated;

create function public.erp_commit_waca_snapshot(
  p_snapshot jsonb, p_expected_revision bigint, p_update_auto_quantity boolean
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '120s'
as $$
declare
  v_actor uuid := auth.uid(); v_revision bigint; v_previous_mode text;
  v_row jsonb; v_order_id uuid; v_variant_id uuid;
  v_effective integer; v_total integer;
  v_unmatched integer; v_reconciliation_status text;
  v_first_cutover boolean; v_checked_at text := to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  if v_actor is null or not public.is_owner(v_actor) then
    raise exception using errcode='42501',message='WACA_OWNER_REQUIRED';
  end if;
  if jsonb_typeof(p_snapshot) is distinct from 'object' or p_expected_revision < 0 then
    raise exception using errcode='22023',message='WACA_SNAPSHOT_INVALID';
  end if;
  if exists(select 1 from unnest(array['orders','items','mappings','batches','masterLinks','cutoverAudit']) k
    where jsonb_typeof(p_snapshot->k) is distinct from 'array') then
    raise exception using errcode='22023',message='WACA_SNAPSHOT_COLLECTION_MISSING';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) then
    raise exception using errcode='55006',message='CLOUD_RESTORE_MAINTENANCE_LOCKED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('erp-waca-ledger-import',0));
  select revision,mode into v_revision,v_previous_mode from public.waca_state for update;
  v_revision := coalesce(v_revision,0);
  v_previous_mode := coalesce(v_previous_mode,'LEGACY_QUANTITY_ACTIVE');
  if v_revision <> p_expected_revision then
    raise exception using errcode='40001',message='WACA_STALE_REVISION';
  end if;
  v_first_cutover := p_update_auto_quantity and v_previous_mode <> 'ORDER_DRIVEN_ACTIVE';

  -- Every operation below shares the caller's PostgreSQL transaction. A raised
  -- validation/reconciliation error rolls back batch, ledger and quantity.
  for v_row in select value from jsonb_array_elements(p_snapshot->'orders') loop
    if coalesce(v_row->>'key','')='' or coalesce(v_row->>'orderNumber','')=''
      or v_row->>'status' not in ('處理中','完成付款','取消','失敗') then
      raise exception using errcode='22023',message='WACA_ORDER_INVALID';
    end if;
    insert into public.waca_orders(order_key,status,payload,updated_by)
    values(v_row->>'key',v_row->>'status',v_row,v_actor)
    on conflict(order_key) do update set status=excluded.status,payload=excluded.payload,
      updated_at=now(),updated_by=v_actor;
  end loop;

  for v_row in select value from jsonb_array_elements(p_snapshot->'items') loop
    select id into v_order_id from public.waca_orders where order_key=v_row->>'orderKey';
    if v_order_id is null or coalesce(v_row->>'key','')=''
       or coalesce(v_row->>'feature','')=''
       or (v_row->>'quantity') !~ '^[0-9]+$' then
      raise exception using errcode='22023',message='WACA_ITEM_INVALID';
    end if;
    v_variant_id := public.erp_waca_variant_id(v_row->>'productVariantId');
    insert into public.waca_order_items(item_key,order_id,feature,product_variant_id,quantity,payload,updated_by)
    values(v_row->>'key',v_order_id,v_row->>'feature',v_variant_id,(v_row->>'quantity')::integer,v_row,v_actor)
    on conflict(item_key) do update set order_id=excluded.order_id,feature=excluded.feature,
      product_variant_id=excluded.product_variant_id,quantity=excluded.quantity,payload=excluded.payload,
      updated_at=now(),updated_by=v_actor;
  end loop;

  for v_row in select value from jsonb_array_elements(p_snapshot->'mappings') loop
    v_variant_id := public.erp_waca_variant_id(v_row->>'productVariantId');
    if v_variant_id is null or coalesce(v_row->>'feature','')='' then
      raise exception using errcode='22023',message='WACA_MAPPING_INVALID';
    end if;
    insert into public.waca_mappings(feature,product_variant_id,payload,updated_by)
    values(v_row->>'feature',v_variant_id,v_row,v_actor)
    on conflict(feature) do update set product_variant_id=excluded.product_variant_id,payload=excluded.payload,
      updated_at=now(),updated_by=v_actor;
  end loop;

  for v_row in select value from jsonb_array_elements(p_snapshot->'masterLinks') loop
    v_variant_id := public.erp_waca_variant_id(v_row->>'productVariantId');
    if coalesce(v_row->>'childCode','')='' or coalesce(v_row->>'mainCode','')='' then
      raise exception using errcode='22023',message='WACA_MASTER_LINK_INVALID';
    end if;
    insert into public.waca_master_links(child_code,main_code,product_variant_id,payload,updated_by)
    values(v_row->>'childCode',v_row->>'mainCode',v_variant_id,v_row,v_actor)
    on conflict(child_code) do update set main_code=excluded.main_code,
      product_variant_id=excluded.product_variant_id,payload=excluded.payload,
      updated_at=now(),updated_by=v_actor;
  end loop;

  for v_row in select value from jsonb_array_elements(p_snapshot->'batches') loop
    if coalesce(v_row->>'id','')='' then raise exception using errcode='22023',message='WACA_BATCH_INVALID'; end if;
    insert into public.waca_import_batches(batch_key,payload,updated_by)
    values(v_row->>'id',v_row,v_actor)
    on conflict(batch_key) do update set payload=excluded.payload,updated_at=now(),updated_by=v_actor;
  end loop;

  for v_row in select value from jsonb_array_elements(p_snapshot->'cutoverAudit') loop
    v_variant_id := public.erp_waca_variant_id(v_row->>'productVariantId');
    if v_variant_id is null then raise exception using errcode='22023',message='WACA_CUTOVER_AUDIT_INVALID'; end if;
    insert into public.waca_cutover_audit(product_variant_id,payload,updated_by)
    values(v_variant_id,v_row,v_actor)
    on conflict(product_variant_id) do update set payload=excluded.payload,updated_at=now(),updated_by=v_actor;
  end loop;

  if exists(select 1 from public.waca_order_items i
    join public.waca_mappings m on m.feature=i.feature
    where i.product_variant_id is not null and i.product_variant_id<>m.product_variant_id) then
    raise exception using errcode='23000',message='WACA_MAPPING_RECONCILIATION_FAILED';
  end if;

  if p_update_auto_quantity then
    if v_first_cutover then
      insert into public.waca_cutover_audit(product_variant_id,payload,updated_by)
      select v.id,jsonb_build_object(
        'productVariantId',coalesce(v.local_id,v.id::text),
        'sku',v.myacg_item_code,'productTitle',v.product_title,'variantTitle',v.variant_name,
        'legacyWacaQuantity',v.waca_auto_quantity+v.waca_manual_adjustment,
        'legacyAutoQuantity',v.waca_auto_quantity,
        'unverifiedPreCutoverManualQuantity',v.waca_manual_adjustment,
        'newOrderDerivedQuantity',coalesce(q.quantity,0),
        'difference',coalesce(q.quantity,0)-v.waca_auto_quantity-v.waca_manual_adjustment,
        'cutoverAt',v_checked_at),v_actor
      from public.product_variants v
      left join (select i.product_variant_id,sum(i.quantity)::integer quantity
        from public.waca_order_items i join public.waca_orders o on o.id=i.order_id
        where i.product_variant_id is not null and o.status in ('處理中','完成付款')
        group by i.product_variant_id) q on q.product_variant_id=v.id
      on conflict(product_variant_id) do nothing;
    end if;
    update public.product_variants v set
      waca_auto_quantity=coalesce(q.quantity,0),
      waca_manual_adjustment=case when v_first_cutover then 0 else v.waca_manual_adjustment end,
      updated_at=now(),updated_by=v_actor,version=v.version+1
    from (select v2.id, sum(i.quantity) filter(where o.status in ('處理中','完成付款'))::integer quantity
      from public.product_variants v2
      left join public.waca_order_items i on i.product_variant_id=v2.id
      left join public.waca_orders o on o.id=i.order_id group by v2.id) q
    where q.id=v.id and (v.waca_auto_quantity is distinct from coalesce(q.quantity,0)
      or (v_first_cutover and v.waca_manual_adjustment <> 0));
  end if;

  select coalesce(sum(i.quantity),0)::integer into v_effective
    from public.waca_order_items i join public.waca_orders o on o.id=i.order_id
    where o.status in ('處理中','完成付款');
  select count(distinct feature)::integer into v_total from public.waca_order_items where product_variant_id is not null;
  select count(distinct i.feature)::integer into v_unmatched
    from public.waca_order_items i join public.waca_orders o on o.id=i.order_id
    where i.product_variant_id is null and i.quantity>0 and o.status in ('處理中','完成付款');
  v_reconciliation_status := case when v_unmatched=0 then 'PASS' else 'FAIL' end;
  if p_update_auto_quantity and exists(
    select 1 from public.product_variants v left join (
      select i.product_variant_id,sum(i.quantity)::integer quantity
      from public.waca_order_items i join public.waca_orders o on o.id=i.order_id
      where i.product_variant_id is not null and o.status in ('處理中','完成付款')
      group by i.product_variant_id) q on q.product_variant_id=v.id
    where v.waca_auto_quantity is distinct from coalesce(q.quantity,0)
  ) then raise exception using errcode='23000',message='WACA_RECONCILIATION_FAILED'; end if;
  if p_update_auto_quantity then
    update public.waca_import_batches b set
      payload=b.payload || jsonb_build_object('reconciliation',jsonb_build_object(
        'status',v_reconciliation_status,'passed',v_total,'total',v_total+v_unmatched,
        'effectiveQuantity',v_effective,'checkedAt',v_checked_at)),updated_at=now()
      where b.batch_key in (select value->>'id' from jsonb_array_elements(p_snapshot->'batches'));
  end if;
  insert into public.waca_state(id,revision,mode,payload,updated_by)
    values('00000000-0000-4000-8000-000000000001',v_revision+1,
      case when p_update_auto_quantity then 'ORDER_DRIVEN_ACTIVE' else v_previous_mode end,
      jsonb_build_object('mode',case when p_update_auto_quantity then 'ORDER_DRIVEN_ACTIVE' else v_previous_mode end,
        'updatedAt',v_checked_at,'sourceBackupFormatVersion',p_snapshot->'cutoverState'->'sourceBackupFormatVersion'),v_actor)
    on conflict(id) do update set revision=excluded.revision,mode=excluded.mode,
      payload=excluded.payload,updated_at=now(),updated_by=v_actor;
  return jsonb_build_object('revision',v_revision+1,'reconciliation',v_reconciliation_status,
    'effectiveQuantity',v_effective,'unmatchedFeatures',v_unmatched);
end;
$$;
revoke all on function public.erp_commit_waca_snapshot(jsonb,bigint,boolean) from public,anon,authenticated;
grant execute on function public.erp_commit_waca_snapshot(jsonb,bigint,boolean) to authenticated;

commit;
