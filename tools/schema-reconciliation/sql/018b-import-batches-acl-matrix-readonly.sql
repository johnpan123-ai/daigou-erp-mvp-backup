-- Machine-readable ACL matrix. SELECT-only: safe for live pre/postflight use.
with
  privileges(privilege) as (values
    ('DELETE'),('INSERT'),('MAINTAIN'),('REFERENCES'),
    ('SELECT'),('TRIGGER'),('TRUNCATE'),('UPDATE')
  ),
  role_contract(role_name,role_class,expected,required) as (values
    ('anon','DATA_API',array[]::text[],true),
    ('authenticated','DATA_API',array['DELETE','INSERT','SELECT','UPDATE']::text[],true),
    ('postgres','PRIVILEGED',array['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']::text[],true),
    ('service_role','PRIVILEGED',array['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']::text[],false)
  ),
  observed as (
    select c.role_name,c.role_class,c.expected,c.required,to_regrole(c.role_name) is not null role_exists,
      coalesce(array_agg(p.privilege order by p.privilege)
        filter(where to_regrole(c.role_name) is not null
          and has_table_privilege(to_regrole(c.role_name),'public.import_batches',p.privilege)),'{}'::text[]) actual
    from role_contract c cross join privileges p
    group by c.role_name,c.role_class,c.expected,c.required
  )
select jsonb_build_object(
  'table','public.import_batches',
  'roles',jsonb_agg(jsonb_build_object(
    'role',role_name,'class',role_class,'roleExists',role_exists,'required',required,
    'expected',expected,'actual',actual,
    'missing',array(select unnest(expected) except select unnest(actual)),
    'extra',array(select unnest(actual) except select unnest(expected)),
    'exact',role_exists and actual=expected,
    'status',case when not role_exists and not required then 'NOT_INSTALLED'
      when role_exists and actual=expected then 'PASS' else 'FAIL' end
  ) order by role_class,role_name)
) as import_batches_acl_matrix
from observed;
