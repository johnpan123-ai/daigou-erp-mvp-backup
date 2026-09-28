-- Canonical fresh-install source for the existing import_batches resource.
-- The earlier 002_erp_tables.sql is a superseded draft with conflicting core
-- table definitions; fresh installs must not run it to obtain this one table.
begin;

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  file_name text not null,
  imported_at timestamptz not null default now(),
  total_rows integer not null default 0,
  valid_rows integer not null default 0,
  skipped_cancelled_rows integer not null default 0,
  new_order_items integer not null default 0,
  skipped_duplicate_items integer not null default 0,
  created_groups_count integer not null default 0,
  completed_group_skus_count integer not null default 0,
  catalog_missing_count integer not null default 0,
  note text,
  details jsonb,
  local_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz,
  version integer not null default 1,
  sync_status text not null default 'synced'
);
do $import_batch_contract$
begin
  if not exists(select 1 from pg_constraint c
    where c.conrelid='public.import_batches'::regclass and c.contype='p'
      and pg_get_constraintdef(c.oid)='PRIMARY KEY (id)')
    or exists(select 1 from (values
      ('id','uuid'),('platform','text'),('file_name','text'),
      ('imported_at','timestamp with time zone'),('details','jsonb'),
      ('updated_by','uuid'),('version','integer'),('sync_status','text')
    ) spec(name,type_name) where not exists(
      select 1 from pg_attribute a where a.attrelid='public.import_batches'::regclass
        and a.attname=spec.name and format_type(a.atttypid,a.atttypmod)=spec.type_name
        and a.attnum>0 and not a.attisdropped)) then
    raise exception using errcode='55000',message='IMPORT_BATCH_CANONICAL_SCHEMA_MISMATCH';
  end if;
end;
$import_batch_contract$;
create index if not exists idx_import_batches_local_id on public.import_batches(local_id);
alter table public.import_batches enable row level security;
drop policy if exists select_policy on public.import_batches;
create policy select_policy on public.import_batches for select to authenticated
  using (deleted_at is null or public.is_owner(auth.uid()));
drop policy if exists insert_policy on public.import_batches;
create policy insert_policy on public.import_batches for insert to authenticated
  with check (public.is_editor(auth.uid()));
drop policy if exists update_policy on public.import_batches;
create policy update_policy on public.import_batches for update to authenticated
  using (public.is_editor(auth.uid())) with check (public.is_editor(auth.uid()));
drop policy if exists delete_policy on public.import_batches;
create policy delete_policy on public.import_batches for delete to authenticated
  using (public.is_editor(auth.uid()));
grant select, insert, update, delete on public.import_batches to authenticated;

commit;
