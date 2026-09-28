-- Canonical bridge from 014 inventory_key PK to the UUID-id Cloud schema
-- required by 029 and 039. Also accepts an already-upgraded UUID-id table.
-- Never rewrites inventory business keys, quantities, or row contents.
begin;

do $inventory_identity_preflight$
declare v_pk text;
begin
  if to_regclass('public.inventory_items') is null then
    raise exception using errcode='55000',message='INVENTORY_IDENTITY_TABLE_MISSING';
  end if;
  select pg_get_constraintdef(c.oid) into v_pk
    from pg_constraint c where c.conrelid='public.inventory_items'::regclass and c.contype='p';
  if v_pk not in ('PRIMARY KEY (inventory_key)','PRIMARY KEY (id)') then
    raise exception using errcode='55000',message='INVENTORY_IDENTITY_UNKNOWN_PRIMARY_KEY';
  end if;
  if not exists(select 1 from pg_attribute a
    where a.attrelid='public.inventory_items'::regclass
      and a.attname='inventory_key' and a.attnotnull
      and format_type(a.atttypid,a.atttypmod)='text'
      and a.attnum>0 and not a.attisdropped) then
    raise exception using errcode='55000',message='INVENTORY_IDENTITY_KEY_SHAPE_MISMATCH';
  end if;
  if v_pk='PRIMARY KEY (id)' and not exists(select 1 from pg_attribute a
    where a.attrelid='public.inventory_items'::regclass
      and a.attname='id' and a.attnotnull
      and format_type(a.atttypid,a.atttypmod)='uuid'
      and a.attnum>0 and not a.attisdropped) then
    raise exception using errcode='55000',message='INVENTORY_IDENTITY_UUID_SHAPE_MISMATCH';
  end if;
  if v_pk='PRIMARY KEY (inventory_key)' and exists(
    select 1 from information_schema.columns where table_schema='public'
      and table_name='inventory_items' and column_name='id'
  ) then
    raise exception using errcode='55000',message='INVENTORY_IDENTITY_PARTIAL_UPGRADE';
  end if;
  if v_pk='PRIMARY KEY (id)' and not exists(
    select 1 from pg_constraint c where c.conrelid='public.inventory_items'::regclass
      and c.contype='u' and pg_get_constraintdef(c.oid)='UNIQUE (inventory_key)'
  ) then
    raise exception using errcode='55000',message='INVENTORY_IDENTITY_KEY_UNIQUE_MISSING';
  end if;
end;
$inventory_identity_preflight$;

do $inventory_identity_upgrade$
begin
  if exists(select 1 from pg_constraint c where c.conrelid='public.inventory_items'::regclass
      and c.contype='p' and pg_get_constraintdef(c.oid)='PRIMARY KEY (inventory_key)') then
    alter table public.inventory_items add column id uuid not null default gen_random_uuid();
    alter table public.inventory_items drop constraint inventory_items_pkey;
    alter table public.inventory_items add constraint inventory_items_pkey primary key (id);
    alter table public.inventory_items add constraint inventory_items_inventory_key_key unique (inventory_key);
  end if;
end;
$inventory_identity_upgrade$;

alter table public.inventory_items
  add column if not exists latest_catalog_import_id text,
  add column if not exists catalog_last_seen_at timestamptz;
create index if not exists inventory_items_catalog_last_seen_at_idx
  on public.inventory_items(catalog_last_seen_at);

do $inventory_identity_postflight$
begin
  if not exists(select 1 from pg_constraint c where c.conrelid='public.inventory_items'::regclass
      and c.contype='p' and pg_get_constraintdef(c.oid)='PRIMARY KEY (id)')
    or not exists(select 1 from pg_constraint c where c.conrelid='public.inventory_items'::regclass
      and c.contype='u' and pg_get_constraintdef(c.oid)='UNIQUE (inventory_key)')
    or exists(select 1 from public.inventory_items where id is null or inventory_key is null) then
    raise exception using errcode='55000',message='INVENTORY_IDENTITY_POSTFLIGHT_FAILED';
  end if;
end;
$inventory_identity_postflight$;

commit;
