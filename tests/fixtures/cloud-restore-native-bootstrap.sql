-- Isolated PostgreSQL benchmark bootstrap only. Never apply to Supabase.
create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$ begin
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;

create table if not exists auth.users(id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'
  )::uuid
$$;

create or replace function public.is_owner(id uuid) returns boolean language sql stable as $$select id is not null$$;
create or replace function public.is_editor(id uuid) returns boolean language sql stable as $$select id is not null$$;
create or replace function public.is_owner_or_staff(id uuid) returns boolean language sql stable as $$select id is not null$$;

create or replace function public.erp_assert_cloud_restore_unlocked() returns trigger language plpgsql as $$
begin return null; end
$$;
create or replace function public.sync_audit_columns() returns trigger language plpgsql as $$
begin
  new.updated_at:=clock_timestamp();
  new.updated_by:=coalesce(auth.uid(),new.updated_by);
  new.version:=coalesce(old.version,0)+1;
  return new;
end
$$;
create or replace function public.erp_set_outbound_status_changed_at() returns trigger language plpgsql as $$
begin
  if tg_op='INSERT' or new.status is distinct from old.status then new.status_changed_at:=clock_timestamp(); end if;
  return new;
end
$$;

grant usage on schema auth,extensions to authenticated,anon,service_role;
