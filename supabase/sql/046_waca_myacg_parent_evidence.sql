begin;

-- Source only in this Sol turn. Retain the exact GP parent from every future
-- MyACG catalog import so WACA can derive GP -> G evidence after a reload.
-- Historical catalogs without this column need the one-time catalog evidence
-- recovery path; no GP parent is guessed from names or SKU shape.
alter table public.inventory_items add column if not exists myacg_parent_code text;
create index if not exists inventory_items_myacg_parent_code_idx
  on public.inventory_items(myacg_parent_code)
  where myacg_parent_code is not null and deleted_at is null;

-- The installed 020 CAS gateway owns inventory writes. Extend only its
-- inventory field whitelist; fail closed if that source has drifted. The
-- gateway's owner check, CAS, RLS boundary and other entity rules stay intact.
do $extend_inventory_cas$
declare
  v_source text;
  v_old text := 'v_create_allowed := ARRAY[''inventory_key'',''myacg_item_code'',''product_id''';
  v_new text := 'v_create_allowed := ARRAY[''inventory_key'',''myacg_item_code'',''myacg_parent_code'',''product_id''';
begin
  if current_user <> 'postgres'
    or to_regprocedure('public.erp_apply_field_mutations(text,jsonb)') is null then
    raise exception using errcode='55000',message='WACA_MYACG_CAS_BASE_MISSING';
  end if;
  select pg_get_functiondef('public.erp_apply_field_mutations(text,jsonb)'::regprocedure)
    into v_source;
  if strpos(v_source,v_old)=0
    or strpos(substr(v_source,strpos(v_source,v_old)+length(v_old)),v_old)>0
    or strpos(v_source,v_new)>0 then
    raise exception using errcode='55000',message='WACA_MYACG_CAS_SOURCE_DRIFT';
  end if;
  execute replace(v_source,v_old,v_new);
end;
$extend_inventory_cas$;

-- Existing 020 function privileges are retained by CREATE OR REPLACE.
-- Reassert the Data API execution contract instead of relying on defaults.
revoke all on function public.erp_apply_field_mutations(text,jsonb) from public,anon;
grant execute on function public.erp_apply_field_mutations(text,jsonb) to authenticated;
grant select on public.inventory_items to authenticated;
revoke all on public.inventory_items from anon;

commit;
