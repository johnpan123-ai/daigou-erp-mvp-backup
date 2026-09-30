-- Source-only compatibility closure for the reviewed 2026-09-30 post-047
-- Live schema. This migration is deliberately state guarded and contains no
-- business-row rewrite beyond validated ISO text -> date conversions.
begin;

do $erp2_canonical_048_preflight$
declare
  v_table text;
  v_required text[];
  v_anon text[];
  v_authenticated text[];
  v_public text[];
  v_allowed_extras constant text[] := array['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE'];
  v_type text;
  v_nullable boolean;
  v_default text;
  v_definition text;
  v_raw text;
  v_date date;
begin
  if current_user <> 'postgres'
    or to_regprocedure('public.is_owner(uuid)') is null
    or to_regprocedure('public.is_editor(uuid)') is null then
    raise exception using errcode='55000',message='ERP2_048_OWNER_OR_ROLE_HELPER_MISMATCH';
  end if;

  foreach v_table in array array[
    'bundle_components','dashboard_category_images','erp_cloud_restore_epoch',
    'japan_package_items','japan_packages','outbound_shipment_items','outbound_shipments',
    'private_order_items','private_orders','product_categories','product_groups','product_variants',
    'profiles','purchase_batch_items','purchase_batches','sales_order_items','sales_orders'
  ] loop
    if to_regclass('public.' || v_table) is null
      or pg_get_userbyid((select relowner from pg_class where oid=to_regclass('public.' || v_table))) <> 'postgres' then
      raise exception using errcode='55000',message='ERP2_048_REQUIRED_TABLE_OR_OWNER_MISMATCH:' || v_table;
    end if;
  end loop;

  -- Accept only the reviewed pre-048/fresh states or the canonical target.
  select format_type(a.atttypid,a.atttypmod),not a.attnotnull,pg_get_expr(d.adbin,d.adrelid)
    into v_type,v_nullable,v_default
    from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
   where a.attrelid='public.product_groups'::regclass and a.attname='proxy_agent'
     and a.attnum>0 and not a.attisdropped;
  if found and (v_type is distinct from 'text' or not v_nullable or v_default is not null) then
    raise exception using errcode='55000',message='ERP2_048_PROXY_AGENT_CONFLICT';
  end if;
  select format_type(a.atttypid,a.atttypmod),not a.attnotnull,pg_get_expr(d.adbin,d.adrelid)
    into v_type,v_nullable,v_default
    from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
   where a.attrelid='public.product_groups'::regclass and a.attname='show_in_purchase_list'
     and a.attnum>0 and not a.attisdropped;
  if found and (v_type is distinct from 'boolean' or v_nullable or v_default is distinct from 'false') then
    raise exception using errcode='55000',message='ERP2_048_PURCHASE_VISIBILITY_CONFLICT';
  end if;

  foreach v_table in array array['product_groups.purchase_date','purchase_batches.date'] loop
    select format_type(a.atttypid,a.atttypmod),not a.attnotnull,pg_get_expr(d.adbin,d.adrelid)
      into v_type,v_nullable,v_default
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
     where a.attrelid=to_regclass('public.' || split_part(v_table,'.',1))
       and a.attname=split_part(v_table,'.',2) and a.attnum>0 and not a.attisdropped;
    if not found or v_type not in ('text','date') or not v_nullable or v_default is not null then
      raise exception using errcode='55000',message='ERP2_048_DATE_COLUMN_CONFLICT:' || v_table;
    end if;
    if v_type='text' then
      for v_raw in execute format('select %I from public.%I where %I is not null and %I <> ''''',
        split_part(v_table,'.',2),split_part(v_table,'.',1),split_part(v_table,'.',2),split_part(v_table,'.',2))
      loop
        if v_raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
          raise exception using errcode='22007',message='ERP2_048_UNSAFE_DATE_CAST:' || v_table;
        end if;
        begin
          v_date := v_raw::date;
        exception when others then
          raise exception using errcode='22007',message='ERP2_048_UNSAFE_DATE_CAST:' || v_table;
        end;
        if to_char(v_date,'YYYY-MM-DD') <> v_raw then
          raise exception using errcode='22007',message='ERP2_048_UNSAFE_DATE_CAST:' || v_table;
        end if;
      end loop;
    end if;
  end loop;

  foreach v_table in array array['private_manual_adjustment','purchased_manual_adjustment'] loop
    select format_type(a.atttypid,a.atttypmod),not a.attnotnull,pg_get_expr(d.adbin,d.adrelid)
      into v_type,v_nullable,v_default
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
     where a.attrelid='public.product_variants'::regclass and a.attname=v_table
       and a.attnum>0 and not a.attisdropped;
    if not found or v_type <> 'integer'
      or not ((not v_nullable and v_default='0') or (v_nullable and v_default is null)) then
      raise exception using errcode='55000',message='ERP2_048_MANUAL_ADJUSTMENT_CONFLICT:' || v_table;
    end if;
  end loop;

  foreach v_table in array array['private_orders','purchase_batches'] loop
    select pg_get_constraintdef(c.oid) into v_definition
      from pg_constraint c where c.conrelid=to_regclass('public.' || v_table)
       and c.conname=v_table || '_product_group_id_fkey' and c.contype='f';
    if v_definition not in (
      'FOREIGN KEY (product_group_id) REFERENCES product_groups(id) ON DELETE RESTRICT',
      'FOREIGN KEY (product_group_id) REFERENCES product_groups(id) ON DELETE CASCADE'
    ) then
      raise exception using errcode='55000',message='ERP2_048_GROUP_FK_CONFLICT:' || v_table;
    end if;
  end loop;

  for v_table,v_required in
    select * from (values
      ('bundle_components',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('dashboard_category_images',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('erp_cloud_restore_epoch',array['SELECT']::text[]),
      ('japan_package_items',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('japan_packages',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('outbound_shipment_items',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('outbound_shipments',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('private_order_items',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('private_orders',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('product_categories',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('product_groups',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('product_variants',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('profiles',array['SELECT']::text[]),
      ('purchase_batch_items',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('purchase_batches',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('sales_order_items',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('sales_orders',array['DELETE','INSERT','SELECT','UPDATE']::text[])
    ) contract(table_name,required_grants)
  loop
    select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
      into v_anon from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      left join pg_roles r on r.oid=a.grantee
     where c.oid=to_regclass('public.' || v_table) and r.rolname='anon';
    select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
      into v_authenticated from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      left join pg_roles r on r.oid=a.grantee
     where c.oid=to_regclass('public.' || v_table) and r.rolname='authenticated';
    select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[])
      into v_public from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
     where c.oid=to_regclass('public.' || v_table) and a.grantee=0;
    if not v_anon <@ v_allowed_extras
      or not v_authenticated <@ (v_required || v_allowed_extras)
      or (cardinality(v_authenticated)>0 and not v_required <@ v_authenticated)
      or cardinality(v_public)<>0 then
      raise exception using errcode='55000',message='ERP2_048_ACL_CONFLICT:' || v_table;
    end if;
  end loop;
end;
$erp2_canonical_048_preflight$;

alter table public.product_groups add column if not exists proxy_agent text;
alter table public.product_groups add column if not exists show_in_purchase_list boolean not null default false;

do $erp2_canonical_048_dates$
declare v_type text;
begin
  select format_type(atttypid,atttypmod) into v_type from pg_attribute
   where attrelid='public.product_groups'::regclass and attname='purchase_date' and attnum>0 and not attisdropped;
  if v_type='text' then
    execute 'alter table public.product_groups alter column purchase_date type date using nullif(purchase_date,'''')::date';
  end if;
  select format_type(atttypid,atttypmod) into v_type from pg_attribute
   where attrelid='public.purchase_batches'::regclass and attname='date' and attnum>0 and not attisdropped;
  if v_type='text' then
    execute 'alter table public.purchase_batches alter column date type date using nullif(date,'''')::date';
  end if;
end;
$erp2_canonical_048_dates$;

alter table public.product_variants
  alter column private_manual_adjustment drop not null,
  alter column private_manual_adjustment drop default,
  alter column purchased_manual_adjustment drop not null,
  alter column purchased_manual_adjustment drop default;

do $erp2_canonical_048_fks$
declare v_table text; v_definition text;
begin
  foreach v_table in array array['private_orders','purchase_batches'] loop
    select pg_get_constraintdef(c.oid) into v_definition from pg_constraint c
     where c.conrelid=to_regclass('public.' || v_table)
       and c.conname=v_table || '_product_group_id_fkey' and c.contype='f';
    if v_definition like '% ON DELETE RESTRICT' then
      execute format('alter table public.%I drop constraint %I',v_table,v_table || '_product_group_id_fkey');
      execute format('alter table public.%I add constraint %I foreign key(product_group_id) references public.product_groups(id) on delete cascade',
        v_table,v_table || '_product_group_id_fkey');
    end if;
  end loop;
end;
$erp2_canonical_048_fks$;

drop policy if exists select_policy on public.inventory_items;
create policy select_policy on public.inventory_items for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));
drop policy if exists select_policy on public.private_order_items;
create policy select_policy on public.private_order_items for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));
drop policy if exists select_policy on public.product_categories;
create policy select_policy on public.product_categories for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));
drop policy if exists select_policy on public.product_groups;
create policy select_policy on public.product_groups for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));
drop policy if exists select_policy on public.product_variants;
create policy select_policy on public.product_variants for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));
drop policy if exists select_policy on public.purchase_batch_items;
create policy select_policy on public.purchase_batch_items for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));
drop policy if exists select_policy on public.purchase_batches;
create policy select_policy on public.purchase_batches for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));

drop policy if exists insert_policy on public.sales_orders;
create policy insert_policy on public.sales_orders for insert to authenticated with check(public.is_editor(auth.uid()));
drop policy if exists update_policy on public.sales_orders;
create policy update_policy on public.sales_orders for update to authenticated using(public.is_editor(auth.uid())) with check(public.is_editor(auth.uid()));
drop policy if exists delete_policy on public.sales_orders;
create policy delete_policy on public.sales_orders for delete to authenticated using(public.is_editor(auth.uid()));
drop policy if exists insert_policy on public.sales_order_items;
create policy insert_policy on public.sales_order_items for insert to authenticated with check(public.is_editor(auth.uid()));
drop policy if exists update_policy on public.sales_order_items;
create policy update_policy on public.sales_order_items for update to authenticated using(public.is_editor(auth.uid())) with check(public.is_editor(auth.uid()));
drop policy if exists delete_policy on public.sales_order_items;
create policy delete_policy on public.sales_order_items for delete to authenticated using(public.is_editor(auth.uid()));

revoke maintain,references,trigger,truncate on table
  public.bundle_components,public.dashboard_category_images,public.erp_cloud_restore_epoch,
  public.japan_package_items,public.japan_packages,public.outbound_shipment_items,public.outbound_shipments,
  public.private_order_items,public.private_orders,public.product_categories,public.product_groups,
  public.product_variants,public.profiles,public.purchase_batch_items,public.purchase_batches,
  public.sales_order_items,public.sales_orders from anon,authenticated;
grant select,insert,update,delete on table
  public.bundle_components,public.dashboard_category_images,
  public.japan_package_items,public.japan_packages,public.outbound_shipment_items,public.outbound_shipments,
  public.private_order_items,public.private_orders,public.product_categories,public.product_groups,
  public.product_variants,public.purchase_batch_items,public.purchase_batches,
  public.sales_order_items,public.sales_orders to authenticated;
grant select on table public.profiles,public.erp_cloud_restore_epoch to authenticated;

do $erp2_canonical_048_postflight$
declare
  v_count integer;
  v_table text;
  v_required text[];
  v_anon text[];
  v_authenticated text[];
begin
  select count(*) into v_count from information_schema.columns where table_schema='public' and (
    (table_name='product_groups' and column_name='proxy_agent' and data_type='text' and is_nullable='YES' and column_default is null)
    or (table_name='product_groups' and column_name='show_in_purchase_list' and data_type='boolean' and is_nullable='NO' and column_default='false')
    or (table_name='product_groups' and column_name='purchase_date' and data_type='date' and is_nullable='YES' and column_default is null)
    or (table_name='purchase_batches' and column_name='date' and data_type='date' and is_nullable='YES' and column_default is null)
    or (table_name='product_variants' and column_name='private_manual_adjustment' and data_type='integer' and is_nullable='YES' and column_default is null)
    or (table_name='product_variants' and column_name='purchased_manual_adjustment' and data_type='integer' and is_nullable='YES' and column_default is null)
  );
  if v_count<>6 then raise exception using errcode='55000',message='ERP2_048_COLUMN_POSTFLIGHT_FAILED'; end if;

  select count(*) into v_count from pg_constraint c join pg_class t on t.oid=c.conrelid
   where t.relname in ('private_orders','purchase_batches') and c.conname=t.relname || '_product_group_id_fkey'
     and c.contype='f' and pg_get_constraintdef(c.oid)='FOREIGN KEY (product_group_id) REFERENCES product_groups(id) ON DELETE CASCADE';
  if v_count<>2 then raise exception using errcode='55000',message='ERP2_048_FK_POSTFLIGHT_FAILED'; end if;

  for v_table,v_required in
    select * from (values
      ('bundle_components',array['DELETE','INSERT','SELECT','UPDATE']::text[]),('dashboard_category_images',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('erp_cloud_restore_epoch',array['SELECT']::text[]),('japan_package_items',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('japan_packages',array['DELETE','INSERT','SELECT','UPDATE']::text[]),('outbound_shipment_items',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('outbound_shipments',array['DELETE','INSERT','SELECT','UPDATE']::text[]),('private_order_items',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('private_orders',array['DELETE','INSERT','SELECT','UPDATE']::text[]),('product_categories',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('product_groups',array['DELETE','INSERT','SELECT','UPDATE']::text[]),('product_variants',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('profiles',array['SELECT']::text[]),('purchase_batch_items',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('purchase_batches',array['DELETE','INSERT','SELECT','UPDATE']::text[]),('sales_order_items',array['DELETE','INSERT','SELECT','UPDATE']::text[]),
      ('sales_orders',array['DELETE','INSERT','SELECT','UPDATE']::text[])
    ) contract(table_name,required_grants)
  loop
    select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[]) into v_anon
      from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      left join pg_roles r on r.oid=a.grantee where c.oid=to_regclass('public.' || v_table) and r.rolname='anon';
    select coalesce(array_agg(a.privilege_type order by a.privilege_type),'{}'::text[]) into v_authenticated
      from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      left join pg_roles r on r.oid=a.grantee where c.oid=to_regclass('public.' || v_table) and r.rolname='authenticated';
    if cardinality(v_anon)<>0 or v_authenticated is distinct from v_required then
      raise exception using errcode='55000',message='ERP2_048_ACL_POSTFLIGHT_FAILED:' || v_table;
    end if;
  end loop;

  if exists(select 1 from (values
      ('inventory_items','select_policy','authenticated'),('private_order_items','select_policy','authenticated'),
      ('product_categories','select_policy','authenticated'),('product_groups','select_policy','authenticated'),
      ('product_variants','select_policy','authenticated'),('purchase_batch_items','select_policy','authenticated'),
      ('purchase_batches','select_policy','authenticated')
    ) expected(table_name,policy_name,role_name)
    where not exists(select 1 from pg_policy p join pg_class t on t.oid=p.polrelid
      where t.relname=expected.table_name and p.polname=expected.policy_name
        and p.polroles=array[(select oid from pg_roles where rolname=expected.role_name)])) then
    raise exception using errcode='55000',message='ERP2_048_SELECT_POLICY_POSTFLIGHT_FAILED';
  end if;
  if exists(select 1 from (values
      ('sales_orders','insert_policy'),('sales_orders','update_policy'),('sales_orders','delete_policy'),
      ('sales_order_items','insert_policy'),('sales_order_items','update_policy'),('sales_order_items','delete_policy')
    ) expected(table_name,policy_name)
    where not exists(select 1 from pg_policy p join pg_class t on t.oid=p.polrelid
      where t.relname=expected.table_name and p.polname=expected.policy_name
        and (coalesce(pg_get_expr(p.polqual,p.polrelid),'') like '%is_editor(auth.uid())%'
          or coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') like '%is_editor(auth.uid())%'))) then
    raise exception using errcode='55000',message='ERP2_048_SALES_POLICY_POSTFLIGHT_FAILED';
  end if;
end;
$erp2_canonical_048_postflight$;

commit;
