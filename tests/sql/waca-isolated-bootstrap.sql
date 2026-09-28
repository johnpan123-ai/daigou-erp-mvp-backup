-- Minimal isolated contract fixture, never applied to Supabase.
do $$ begin
  if to_regrole('anon') is null then create role anon nologin; end if;
  if to_regrole('authenticated') is null then create role authenticated nologin; end if;
end $$;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub',true),'')::uuid,
    (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
  )
$$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
create table public.product_variants(
  id uuid primary key,
  local_id text unique,
  myacg_item_code text not null,
  product_title text not null,
  variant_name text not null,
  waca_auto_quantity integer not null default 0,
  waca_manual_adjustment integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  version integer not null default 1
);
create function public.is_owner(p_actor uuid) returns boolean
language sql stable as $$ select p_actor = '00000000-0000-4000-8000-000000000099'::uuid $$;
create function public.erp_assert_cloud_restore_unlocked() returns trigger
language plpgsql as $$ begin return null; end $$;
insert into auth.users(id) values ('00000000-0000-4000-8000-000000000099');
insert into public.product_variants(id,local_id,myacg_item_code,product_title,variant_name,waca_auto_quantity)
values ('00000000-0000-4000-8000-000000000011','v-11','G001','Test group','Test variant',8);
