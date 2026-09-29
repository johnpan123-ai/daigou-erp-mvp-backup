-- Compatibility repair for the PostgreSQL/Supabase default-grant drift seen
-- after 018. It removes only the four non-product table privileges from the
-- Data API roles. Owner and any privileged/service role ACLs are untouched.
begin;

do $import_batch_acl_preflight$
declare
  v_anon text[];
  v_authenticated text[];
  v_public text[];
  v_expected_authenticated constant text[] := array['DELETE','INSERT','SELECT','UPDATE'];
  v_allowed_extras constant text[] := array['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE'];
begin
  if current_user <> 'postgres'
    or to_regclass('public.import_batches') is null
    or pg_get_userbyid((select relowner from pg_class where oid='public.import_batches'::regclass)) <> 'postgres' then
    raise exception using errcode='55000',message='IMPORT_BATCH_ACL_REPAIR_OWNER_OR_TABLE_MISMATCH';
  end if;
  if not exists(select 1 from pg_constraint c
      where c.conrelid='public.import_batches'::regclass and c.contype='p'
        and pg_get_constraintdef(c.oid)='PRIMARY KEY (id)')
    or not (select relrowsecurity from pg_class where oid='public.import_batches'::regclass)
    or exists(select 1 from (values
      ('select_policy'),('insert_policy'),('update_policy'),('delete_policy')
    ) expected(name) where not exists(select 1 from pg_policy p
      where p.polrelid='public.import_batches'::regclass and p.polname=expected.name)) then
    raise exception using errcode='55000',message='IMPORT_BATCH_ACL_REPAIR_SCHEMA_CONTRACT_MISMATCH';
  end if;

  select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
    into v_anon
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    left join pg_roles r on r.oid=a.grantee
   where c.oid='public.import_batches'::regclass and r.rolname='anon';
  select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
    into v_authenticated
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    left join pg_roles r on r.oid=a.grantee
   where c.oid='public.import_batches'::regclass and r.rolname='authenticated';
  select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
    into v_public
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   where c.oid='public.import_batches'::regclass and a.grantee=0;

  if not v_anon <@ v_allowed_extras
    or not v_authenticated <@ (v_expected_authenticated || v_allowed_extras)
    or not v_expected_authenticated <@ v_authenticated
    or cardinality(v_public) <> 0 then
    raise exception using errcode='55000',message='IMPORT_BATCH_ACL_REPAIR_UNEXPECTED_PRIVILEGE_SET';
  end if;
end;
$import_batch_acl_preflight$;

-- Intentionally not REVOKE ALL: preserve the product CRUD grant and every ACL
-- belonging to postgres, service_role, or any other privileged role.
revoke maintain,references,trigger,truncate on table public.import_batches from anon;
revoke maintain,references,trigger,truncate on table public.import_batches from authenticated;

do $import_batch_acl_postflight$
declare
  v_anon text[];
  v_authenticated text[];
  v_public text[];
  v_expected_authenticated constant text[] := array['DELETE','INSERT','SELECT','UPDATE'];
  v_owner_expected constant text[] := array[
    'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
  ];
begin
  select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
    into v_anon
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    left join pg_roles r on r.oid=a.grantee
   where c.oid='public.import_batches'::regclass and r.rolname='anon';
  select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
    into v_authenticated
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    left join pg_roles r on r.oid=a.grantee
   where c.oid='public.import_batches'::regclass and r.rolname='authenticated';
  select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
    into v_public
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   where c.oid='public.import_batches'::regclass and a.grantee=0;

  if cardinality(v_anon) <> 0
    or v_authenticated is distinct from v_expected_authenticated
    or cardinality(v_public) <> 0
    or exists(select 1 from unnest(v_owner_expected) privilege
      where not has_table_privilege('postgres','public.import_batches',privilege)) then
    raise exception using errcode='55000',message='IMPORT_BATCH_ACL_REPAIR_POSTFLIGHT_FAILED';
  end if;
end;
$import_batch_acl_postflight$;

commit;
