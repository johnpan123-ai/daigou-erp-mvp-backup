-- ERP 2.0 read-only schema snapshot. This statement reads catalog metadata only.
-- It intentionally excludes business row values and migration execution claims.
with
columns_by_table as (
  select c.oid as table_oid,
    jsonb_object_agg(a.attname, jsonb_build_object(
      'dataType', format_type(a.atttypid,a.atttypmod),
      'nullable', not a.attnotnull,
      'default', pg_get_expr(d.adbin,d.adrelid)
    ) order by a.attname) as value
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
  where c.relkind in ('r','p') group by c.oid
),
constraints_by_table as (
  select c.conrelid as table_oid,
    coalesce(jsonb_agg(jsonb_build_object(
      'name',c.conname,'type',c.contype,'definition',pg_get_constraintdef(c.oid),
      'columns',(select jsonb_agg(a.attname order by k.ordinality)
        from unnest(c.conkey) with ordinality k(attnum,ordinality)
        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum),
      'referencedTable',case when c.confrelid=0 then null else c.confrelid::regclass::text end,
      'referencedColumns',case when c.confrelid=0 then null else (select jsonb_agg(a.attname order by k.ordinality)
        from unnest(c.confkey) with ordinality k(attnum,ordinality)
        join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum) end,
      'validated',c.convalidated
    ) order by c.conname),'[]'::jsonb) as value
  from pg_constraint c join pg_namespace n on n.oid=c.connamespace and n.nspname='public'
  group by c.conrelid
),
indexes_by_table as (
  select i.indrelid as table_oid,
    jsonb_object_agg('public.'||ic.relname,jsonb_build_object(
      'unique',i.indisunique,'primary',i.indisprimary,'valid',i.indisvalid,
      'definition',pg_get_indexdef(i.indexrelid)
    ) order by ic.relname) as value
  from pg_index i join pg_class ic on ic.oid=i.indexrelid
  join pg_namespace n on n.oid=ic.relnamespace and n.nspname='public'
  group by i.indrelid
),
triggers_by_table as (
  select t.tgrelid as table_oid,
    jsonb_object_agg(t.tgname,jsonb_build_object('enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) order by t.tgname) as value
  from pg_trigger t where not t.tgisinternal group by t.tgrelid
),
policies_by_table as (
  select (quote_ident(schemaname)||'.'||quote_ident(tablename))::regclass::oid as table_oid,
    jsonb_object_agg(policyname,jsonb_build_object(
      'permissive',permissive,'roles',roles,'command',cmd,'using',qual,'withCheck',with_check
    ) order by policyname) as value
  from pg_policies where schemaname='public' group by schemaname,tablename
),
grants_by_table as (
  select c.oid as table_oid,
    jsonb_object_agg(g.grantee,g.privileges order by g.grantee) as value
  from pg_class c join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
  cross join lateral (
    select role_name as grantee,coalesce(jsonb_agg(privilege order by privilege) filter(where privilege is not null),'[]'::jsonb) privileges
    from (values ('public'),('anon'),('authenticated')) role(role_name)
    left join lateral (
      select privilege_type privilege from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      left join pg_roles r on r.oid=acl.grantee
      where (role.role_name='public' and acl.grantee=0) or r.rolname=role.role_name
    ) p on true group by role_name
  ) g
  where c.relkind in ('r','p') group by c.oid
),
tables_object as (
  select jsonb_object_agg('public.'||c.relname,jsonb_build_object(
    'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
    'columns',coalesce(col.value,'{}'::jsonb),
    'constraints',coalesce(con.value,'[]'::jsonb),
    'primaryKey',coalesce((select x->'columns' from jsonb_array_elements(coalesce(con.value,'[]'::jsonb)) x where x->>'type'='p' limit 1),'[]'::jsonb),
    'uniques',coalesce((select jsonb_agg(x->'columns' order by x->>'name') from jsonb_array_elements(coalesce(con.value,'[]'::jsonb)) x where x->>'type'='u'),'[]'::jsonb),
    'indexes',coalesce(idx.value,'{}'::jsonb),'triggers',coalesce(trg.value,'{}'::jsonb),
    'policies',coalesce(pol.value,'{}'::jsonb),'grants',coalesce(gr.value,'{}'::jsonb)
  ) order by c.relname) as value
  from pg_class c join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
  left join columns_by_table col on col.table_oid=c.oid
  left join constraints_by_table con on con.table_oid=c.oid
  left join indexes_by_table idx on idx.table_oid=c.oid
  left join triggers_by_table trg on trg.table_oid=c.oid
  left join policies_by_table pol on pol.table_oid=c.oid
  left join grants_by_table gr on gr.table_oid=c.oid
  where c.relkind in ('r','p')
),
functions_object as (
  select jsonb_object_agg('public.'||p.proname||'('||replace(oidvectortypes(p.proargtypes),', ', ',')||')',jsonb_build_object(
    'returnType',pg_get_function_result(p.oid),'language',l.lanname,'owner',pg_get_userbyid(p.proowner),
    'arguments',pg_get_function_arguments(p.oid),'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,
    'securityDefiner',p.prosecdef,'volatility',p.provolatile,'config',coalesce(to_jsonb(p.proconfig),'[]'::jsonb),
    'authenticatedExecute',case when to_regrole('authenticated') is null then false else has_function_privilege('authenticated',p.oid,'EXECUTE') end,
    'anonExecute',case when to_regrole('anon') is null then false else has_function_privilege('anon',p.oid,'EXECUTE') end,
    'publicExecute',has_function_privilege('public',p.oid,'EXECUTE'),'definition',pg_get_functiondef(p.oid)
  ) order by p.proname,oidvectortypes(p.proargtypes)) as value
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace and n.nspname='public'
  join pg_language l on l.oid=p.prolang
),
schema_names as (
  select jsonb_agg(nspname order by nspname) value from pg_namespace
  where nspname in ('public','auth','storage','realtime','extensions')
)
select jsonb_build_object(
  'contractVersion',1,
  'capturedAt',clock_timestamp(),
  'identity',jsonb_build_object(
    'databaseName',current_database(),'currentUser',current_user,
    'serverVersion',current_setting('server_version'),'projectRef',null,'environmentRole','PRODUCTION'
  ),
  'migrationHistory',jsonb_build_object(
    'available',to_regclass('public.erp_schema_migration_ledger') is not null,
    'supabaseInternalLedgerPresent',to_regclass('supabase_migrations.schema_migrations') is not null,
    'entries','{}'::jsonb
  ),
  'completeness',jsonb_build_object(
    'structural',true,'tables',true,'columns',true,'constraints',true,'indexes',true,
    'triggers',true,'functions',true,'policies',true,'grants',true,'inventoryIntegrity',false
  ),
  'schemas',coalesce((select value from schema_names),'[]'::jsonb),
  'tables',coalesce((select value from tables_object),'{}'::jsonb),
  'functions',coalesce((select value from functions_object),'{}'::jsonb),
  -- Catalog proof of extension-owned functions, not name-only substitutions.
  -- Qualified and visible unqualified calls resolve to the same extension code.
  'sqlResolution',jsonb_build_object('resolvedFunctionAliases',coalesce((
    select jsonb_object_agg(alias,canonical_name) from (
      select distinct alias,'extension:'||e.extname||':'||p.proname as canonical_name
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      join pg_depend d on d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e'
      join pg_extension e on d.refclassid='pg_extension'::regclass and e.oid=d.refobjid
      cross join lateral (select n.nspname||'.'||p.proname as alias
        union all select p.proname where pg_function_is_visible(p.oid)) names
      where e.extname='pgcrypto' and p.proname='digest'
    ) resolved
  ),'{}'::jsonb),'digestCandidates',coalesce((
    select jsonb_object_agg(qualified_name,extensions) from (
      select n.nspname||'.'||p.proname qualified_name,
        jsonb_agg(distinct coalesce(e.extname,'APPLICATION_FUNCTION')) extensions
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      left join pg_depend d on d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e'
      left join pg_extension e on d.refclassid='pg_extension'::regclass and e.oid=d.refobjid
      where p.proname='digest' group by n.nspname,p.proname
    ) candidates
  ),'{}'::jsonb)),
  'integrity','{}'::jsonb
) as erp_schema_snapshot;
