-- Read-only postflight for the 046b compatibility repair.
with
identity_state as (
  select
    pg_get_userbyid(c.relowner) table_owner,
    coalesce((select array_agg(a.attname::text order by k.ordinality)
      from pg_constraint p cross join lateral unnest(p.conkey) with ordinality k(attnum,ordinality)
      join pg_attribute a on a.attrelid=p.conrelid and a.attnum=k.attnum
      where p.conrelid=c.oid and p.contype='p'),array[]::text[]) primary_key,
    exists(select 1 from pg_constraint p where p.conrelid=c.oid and p.contype='u'
      and pg_get_constraintdef(p.oid)='UNIQUE (inventory_key)') inventory_key_unique
  from pg_class c where c.oid=to_regclass('public.inventory_items')
), parent_column as (
  select count(*)::integer found_count,
    coalesce(bool_and(format_type(a.atttypid,a.atttypmod)='text' and not a.attnotnull and d.oid is null),false) canonical
  from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attrelid=to_regclass('public.inventory_items') and a.attname='myacg_parent_code'
    and a.attnum>0 and not a.attisdropped
), parent_index as (
  select count(*)::integer found_count,
    coalesce(bool_and(i.indrelid=to_regclass('public.inventory_items') and not i.indisunique and not i.indisprimary
      and pg_get_indexdef(i.indexrelid,1,true)='myacg_parent_code'
      and pg_get_expr(i.indpred,i.indrelid)='((myacg_parent_code IS NOT NULL) AND (deleted_at IS NULL))'),false) canonical
  from pg_index i where i.indexrelid=to_regclass('public.inventory_items_myacg_parent_code_idx')
), function_state as (
  select count(*)::integer overload_count,
    coalesce(bool_and(to_regprocedure('public.erp_apply_field_mutations(text,jsonb)')=p.oid
      and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and pg_get_function_result(p.oid)='jsonb'
      and coalesce(p.proconfig,'{}'::text[]) @> array['search_path=""']
      and has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not has_function_privilege('public',p.oid,'EXECUTE')
      and pg_get_functiondef(p.oid) like '%v_create_allowed := ARRAY[''inventory_key'',''myacg_item_code'',''myacg_parent_code'',''product_id''%'),false) canonical
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='erp_apply_field_mutations'
), acl_state as (
  select
    coalesce(array_agg(a.privilege_type order by a.privilege_type)
      filter(where r.rolname='anon'),'{}'::text[]) anon_privileges,
    coalesce(array_agg(a.privilege_type order by a.privilege_type)
      filter(where r.rolname='authenticated'),'{}'::text[]) authenticated_privileges,
    coalesce(array_agg(a.privilege_type order by a.privilege_type)
      filter(where a.grantee=0),'{}'::text[]) public_privileges
  from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  left join pg_roles r on r.oid=a.grantee
  where c.oid=to_regclass('public.inventory_items')
), row_integrity as (
  select count(*)::bigint row_count,
    count(*) filter(where id is null)::bigint null_id_count,
    (count(id)-count(distinct id))::bigint duplicate_id_count,
    count(*) filter(where inventory_key is null)::bigint null_inventory_key_count,
    (count(inventory_key)-count(distinct inventory_key))::bigint duplicate_inventory_key_count
  from public.inventory_items
), references_state as (
  select count(*)::integer dependent_fk_count
  from pg_constraint where confrelid=to_regclass('public.inventory_items') and contype='f'
)
select jsonb_build_object(
  'result',case when identity_state.table_owner='postgres' and identity_state.primary_key=array['id']
    and identity_state.inventory_key_unique and parent_column.found_count=1 and parent_column.canonical
    and parent_index.found_count=1 and parent_index.canonical
    and function_state.overload_count=1 and function_state.canonical
    and cardinality(acl_state.anon_privileges)=0
    and acl_state.authenticated_privileges=array['SELECT']
    and cardinality(acl_state.public_privileges)=0
    and row_integrity.null_id_count=0 and row_integrity.duplicate_id_count=0
    and row_integrity.null_inventory_key_count=0 and row_integrity.duplicate_inventory_key_count=0
    and references_state.dependent_fk_count=0
    then 'PASS' else 'BLOCK' end,
  'tableOwner',identity_state.table_owner,'primaryKey',identity_state.primary_key,
  'inventoryKeyUnique',identity_state.inventory_key_unique,
  'parentColumnCanonical',parent_column.found_count=1 and parent_column.canonical,
  'parentIndexCanonical',parent_index.found_count=1 and parent_index.canonical,
  'functionCanonical',function_state.overload_count=1 and function_state.canonical,
  'anonPrivileges',acl_state.anon_privileges,'authenticatedPrivileges',acl_state.authenticated_privileges,
  'publicPrivileges',acl_state.public_privileges,'rowCount',row_integrity.row_count,
  'nullIdCount',row_integrity.null_id_count,'duplicateIdCount',row_integrity.duplicate_id_count,
  'nullInventoryKeyCount',row_integrity.null_inventory_key_count,
  'duplicateInventoryKeyCount',row_integrity.duplicate_inventory_key_count
  ,'dependentForeignKeyCount',references_state.dependent_fk_count,
  'dependentReferenceViolationCount',case when references_state.dependent_fk_count=0 then 0 else null end
) as waca_parent_repair_postflight
from identity_state cross join parent_column cross join parent_index
cross join function_state cross join acl_state cross join row_integrity cross join references_state;
