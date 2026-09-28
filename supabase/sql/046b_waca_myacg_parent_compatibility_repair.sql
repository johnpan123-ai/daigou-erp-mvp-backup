-- Compatibility closure for environments whose inventory table predates the
-- canonical 046 ACL state. This migration is deliberately state-guarded: it
-- accepts only the observed legacy ACL drift or the already-canonical state.
-- It never rewrites inventory identity or business row values.
begin;

do $waca_parent_compatibility_preflight$
declare
  v_pk text;
  v_column_type text;
  v_column_not_null boolean;
  v_column_default text;
  v_index_definition text;
  v_index_unique boolean;
  v_index_primary boolean;
  v_function_source text;
  v_function_count integer;
  v_old text := 'v_create_allowed := ARRAY[''inventory_key'',''myacg_item_code'',''product_id''';
  v_new text := 'v_create_allowed := ARRAY[''inventory_key'',''myacg_item_code'',''myacg_parent_code'',''product_id''';
  v_old_count integer;
  v_new_count integer;
  v_anon_privileges text[];
  v_authenticated_privileges text[];
  v_public_privileges text[];
  v_allowed_anon_repair text[] := array['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE'];
  v_allowed_authenticated_repair text[] := array[
    'DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'
  ];
begin
  if current_user <> 'postgres' then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_OWNER_REQUIRED';
  end if;
  if to_regclass('public.inventory_items') is null then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_TABLE_MISSING';
  end if;
  if pg_get_userbyid((select relowner from pg_class where oid='public.inventory_items'::regclass)) <> 'postgres' then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_TABLE_OWNER_MISMATCH';
  end if;

  select pg_get_constraintdef(c.oid) into v_pk
    from pg_constraint c
   where c.conrelid='public.inventory_items'::regclass and c.contype='p';
  if v_pk is distinct from 'PRIMARY KEY (id)'
    or not exists(select 1 from pg_attribute a
      where a.attrelid='public.inventory_items'::regclass and a.attname='id'
        and a.attnum>0 and not a.attisdropped and a.attnotnull
        and format_type(a.atttypid,a.atttypmod)='uuid')
    or not exists(select 1 from pg_attribute a
      where a.attrelid='public.inventory_items'::regclass and a.attname='inventory_key'
        and a.attnum>0 and not a.attisdropped and a.attnotnull
        and format_type(a.atttypid,a.atttypmod)='text')
    or not exists(select 1 from pg_constraint c
      where c.conrelid='public.inventory_items'::regclass and c.contype='u'
        and pg_get_constraintdef(c.oid)='UNIQUE (inventory_key)') then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_UUID_IDENTITY_MISMATCH';
  end if;
  if exists(select 1 from public.inventory_items where id is null or inventory_key is null)
    or (select count(*)-count(distinct id) from public.inventory_items) <> 0
    or (select count(*)-count(distinct inventory_key) from public.inventory_items) <> 0 then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_INVENTORY_INTEGRITY_FAILED';
  end if;

  select format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)
    into v_column_type,v_column_not_null,v_column_default
    from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
   where a.attrelid='public.inventory_items'::regclass and a.attname='myacg_parent_code'
     and a.attnum>0 and not a.attisdropped;
  if found and (v_column_type is distinct from 'text' or v_column_not_null or v_column_default is not null) then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_COLUMN_CONFLICT';
  end if;

  if to_regclass('public.inventory_items_myacg_parent_code_idx') is not null then
    select pg_get_indexdef(i.indexrelid),i.indisunique,i.indisprimary
      into v_index_definition,v_index_unique,v_index_primary
      from pg_index i
     where i.indexrelid='public.inventory_items_myacg_parent_code_idx'::regclass
       and i.indrelid='public.inventory_items'::regclass;
    if not found or v_index_unique or v_index_primary
      or lower(regexp_replace(v_index_definition,'\s+',' ','g')) is distinct from
        lower('CREATE INDEX inventory_items_myacg_parent_code_idx ON public.inventory_items USING btree (myacg_parent_code) WHERE ((myacg_parent_code IS NOT NULL) AND (deleted_at IS NULL))') then
      raise exception using errcode='55000',message='WACA_MYACG_REPAIR_INDEX_CONFLICT';
    end if;
  end if;

  select count(*) into v_function_count
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='erp_apply_field_mutations';
  if v_function_count <> 1
    or to_regprocedure('public.erp_apply_field_mutations(text,jsonb)') is null then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_FUNCTION_SIGNATURE_CONFLICT';
  end if;
  if not exists(select 1
      from pg_proc p join pg_roles r on r.oid=p.proowner
     where p.oid='public.erp_apply_field_mutations(text,jsonb)'::regprocedure
       and r.rolname='postgres' and p.prosecdef
       and pg_get_function_result(p.oid)='jsonb'
       and coalesce(p.proconfig,'{}'::text[]) @> array['search_path=""']
       and has_function_privilege('authenticated',p.oid,'EXECUTE')
       and not has_function_privilege('anon',p.oid,'EXECUTE')
       and not has_function_privilege('public',p.oid,'EXECUTE')) then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_FUNCTION_CONTRACT_CONFLICT';
  end if;
  select pg_get_functiondef('public.erp_apply_field_mutations(text,jsonb)'::regprocedure)
    into v_function_source;
  v_old_count := (length(v_function_source)-length(replace(v_function_source,v_old,'')))/length(v_old);
  v_new_count := (length(v_function_source)-length(replace(v_function_source,v_new,'')))/length(v_new);
  if not ((v_old_count=1 and v_new_count=0) or (v_old_count=0 and v_new_count=1)) then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_FUNCTION_SOURCE_CONFLICT';
  end if;

  select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
    into v_anon_privileges
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    left join pg_roles r on r.oid=a.grantee
   where c.oid='public.inventory_items'::regclass and r.rolname='anon';
  select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
    into v_authenticated_privileges
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    left join pg_roles r on r.oid=a.grantee
   where c.oid='public.inventory_items'::regclass and r.rolname='authenticated';
  select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
    into v_public_privileges
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   where c.oid='public.inventory_items'::regclass and a.grantee=0;
  if not v_anon_privileges <@ v_allowed_anon_repair
    or not v_authenticated_privileges <@ v_allowed_authenticated_repair
    or not ('SELECT'=any(v_authenticated_privileges))
    or cardinality(v_public_privileges) <> 0 then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_TABLE_ACL_CONFLICT';
  end if;
  perform set_config('erp.waca_046b_inventory_row_count',(select count(*)::text from public.inventory_items),true);
end;
$waca_parent_compatibility_preflight$;

alter table public.inventory_items add column if not exists myacg_parent_code text;
create index if not exists inventory_items_myacg_parent_code_idx
  on public.inventory_items(myacg_parent_code)
  where myacg_parent_code is not null and deleted_at is null;

do $waca_parent_compatibility_function$
declare
  v_source text;
  v_old text := 'v_create_allowed := ARRAY[''inventory_key'',''myacg_item_code'',''product_id''';
  v_new text := 'v_create_allowed := ARRAY[''inventory_key'',''myacg_item_code'',''myacg_parent_code'',''product_id''';
  v_old_count integer;
  v_new_count integer;
begin
  select pg_get_functiondef('public.erp_apply_field_mutations(text,jsonb)'::regprocedure) into v_source;
  v_old_count := (length(v_source)-length(replace(v_source,v_old,'')))/length(v_old);
  v_new_count := (length(v_source)-length(replace(v_source,v_new,'')))/length(v_new);
  if v_old_count=1 and v_new_count=0 then
    execute replace(v_source,v_old,v_new);
  elsif not (v_old_count=0 and v_new_count=1) then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_FUNCTION_SOURCE_CONFLICT';
  end if;
end;
$waca_parent_compatibility_function$;

revoke execute on function public.erp_apply_field_mutations(text,jsonb) from public,anon;
grant execute on function public.erp_apply_field_mutations(text,jsonb) to authenticated;

-- Direct inventory writes are not part of the Cloud contract. Authenticated
-- writes remain available through the security-definer CAS gateway above.
revoke insert,update,delete,truncate,references,trigger,maintain
  on table public.inventory_items from authenticated;
grant select on table public.inventory_items to authenticated;
revoke maintain,references,trigger,truncate
  on table public.inventory_items from anon;

do $waca_parent_compatibility_postflight$
declare
  v_index_definition text;
  v_function_source text;
  v_new text := 'v_create_allowed := ARRAY[''inventory_key'',''myacg_item_code'',''myacg_parent_code'',''product_id''';
  v_anon_privileges text[];
  v_authenticated_privileges text[];
  v_public_privileges text[];
begin
  if current_setting('erp.waca_046b_inventory_row_count',true) is null
    or current_setting('erp.waca_046b_inventory_row_count',true)::bigint <>
      (select count(*) from public.inventory_items)
    or not exists(select 1 from pg_attribute a
      left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid='public.inventory_items'::regclass and a.attname='myacg_parent_code'
        and a.attnum>0 and not a.attisdropped and not a.attnotnull
        and format_type(a.atttypid,a.atttypmod)='text' and d.oid is null)
    or not exists(select 1 from pg_constraint c
      where c.conrelid='public.inventory_items'::regclass and c.contype='p'
        and pg_get_constraintdef(c.oid)='PRIMARY KEY (id)')
    or not exists(select 1 from pg_constraint c
      where c.conrelid='public.inventory_items'::regclass and c.contype='u'
        and pg_get_constraintdef(c.oid)='UNIQUE (inventory_key)') then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_POSTFLIGHT_IDENTITY_FAILED';
  end if;
  select pg_get_indexdef('public.inventory_items_myacg_parent_code_idx'::regclass)
    into v_index_definition;
  if lower(regexp_replace(v_index_definition,'\s+',' ','g')) is distinct from
    lower('CREATE INDEX inventory_items_myacg_parent_code_idx ON public.inventory_items USING btree (myacg_parent_code) WHERE ((myacg_parent_code IS NOT NULL) AND (deleted_at IS NULL))') then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_POSTFLIGHT_INDEX_FAILED';
  end if;
  select pg_get_functiondef('public.erp_apply_field_mutations(text,jsonb)'::regprocedure)
    into v_function_source;
  if (length(v_function_source)-length(replace(v_function_source,v_new,'')))/length(v_new) <> 1
    or not exists(select 1
      from pg_proc p join pg_roles r on r.oid=p.proowner
     where p.oid='public.erp_apply_field_mutations(text,jsonb)'::regprocedure
       and r.rolname='postgres' and p.prosecdef
       and pg_get_function_result(p.oid)='jsonb'
       and coalesce(p.proconfig,'{}'::text[]) @> array['search_path=""'])
    or not has_function_privilege('authenticated','public.erp_apply_field_mutations(text,jsonb)','EXECUTE')
    or has_function_privilege('anon','public.erp_apply_field_mutations(text,jsonb)','EXECUTE')
    or has_function_privilege('public','public.erp_apply_field_mutations(text,jsonb)','EXECUTE') then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_POSTFLIGHT_FUNCTION_FAILED';
  end if;
  select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
    into v_anon_privileges
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    left join pg_roles r on r.oid=a.grantee
   where c.oid='public.inventory_items'::regclass and r.rolname='anon';
  select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
    into v_authenticated_privileges
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    left join pg_roles r on r.oid=a.grantee
   where c.oid='public.inventory_items'::regclass and r.rolname='authenticated';
  select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
    into v_public_privileges
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   where c.oid='public.inventory_items'::regclass and a.grantee=0;
  if v_anon_privileges <> '{}'::text[]
    or v_authenticated_privileges <> array['SELECT']
    or v_public_privileges <> '{}'::text[] then
    raise exception using errcode='55000',message='WACA_MYACG_REPAIR_POSTFLIGHT_TABLE_ACL_FAILED';
  end if;
end;
$waca_parent_compatibility_postflight$;

commit;
