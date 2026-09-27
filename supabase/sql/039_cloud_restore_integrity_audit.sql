-- 039: independent OWNER-only Restore integrity observation. Candidate, NOT applied.
-- No change to 031-038, the writer, policy, epoch, attempts or lock lifecycle.
-- SECURITY DEFINER is necessary: 038 INVOKER RLS hides other owners' pending attempts.
-- STABLE gives one statement snapshot. pg_locks is a separately sampled, transient view.
begin;

do $audit_preflight$
begin
  if current_user <> 'postgres' or to_regprocedure('public.is_owner(uuid)') is null
     or to_regclass('public.erp_cloud_restore_attempts') is null
     or to_regclass('public.erp_cloud_restore_requests') is null
     or to_regclass('public.erp_cloud_restore_snapshots') is null
     or to_regclass('public.erp_cloud_restore_epoch') is null
     or to_regrole('authenticated') is null or to_regrole('anon') is null
     or to_regprocedure('extensions.digest(text,text)') is null then
    raise exception using errcode='55000', message='CLOUD_RESTORE_AUDIT_DEPENDENCY_MISSING';
  end if;
  if exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'erp_cloud_restore_audit_dataset','erp_read_cloud_restore_integrity_audit')) then
    raise exception using errcode='42710', message='CLOUD_RESTORE_AUDIT_COLLISION';
  end if;
  -- Prevent missing-column/schema drift from masquerading as NULL audit values.
  if exists(select 1 from (values
    ('inventory_items','id'),
    ('inventory_items','updated_by'),
    ('inventory_items','inventory_key'),
    ('inventory_items','product_id'),
    ('inventory_items','latest_catalog_import_id'),
    ('product_groups','id'),
    ('product_groups','updated_by'),
    ('product_groups','title'),
    ('product_categories','id'),
    ('product_categories','updated_by'),
    ('product_categories','product_group_id'),
    ('product_variants','id'),
    ('product_variants','updated_by'),
    ('product_variants','product_group_id'),
    ('product_variants','product_category_id'),
    ('product_variants','local_id'),
    ('bundle_components','id'),
    ('bundle_components','updated_by'),
    ('bundle_components','bundle_variant_id'),
    ('bundle_components','component_variant_id'),
    ('purchase_batches','id'),
    ('purchase_batches','updated_by'),
    ('purchase_batches','product_group_id'),
    ('purchase_batch_items','id'),
    ('purchase_batch_items','updated_by'),
    ('purchase_batch_items','purchase_batch_id'),
    ('purchase_batch_items','product_variant_id'),
    ('private_orders','id'),
    ('private_orders','updated_by'),
    ('private_orders','product_group_id'),
    ('private_order_items','id'),
    ('private_order_items','updated_by'),
    ('private_order_items','private_order_id'),
    ('private_order_items','product_variant_id'),
    ('sales_orders','id'),
    ('sales_orders','updated_by'),
    ('sales_order_items','id'),
    ('sales_order_items','updated_by'),
    ('sales_order_items','order_id'),
    ('sales_order_items','product_variant_id'),
    ('japan_packages','id'),
    ('japan_packages','updated_by'),
    ('japan_package_items','id'),
    ('japan_package_items','updated_by'),
    ('japan_package_items','japan_package_id'),
    ('japan_package_items','product_group_id'),
    ('japan_package_items','product_variant_id'),
    ('japan_package_items','purchase_batch_id'),
    ('japan_package_items','purchase_batch_item_id'),
    ('outbound_shipments','id'),
    ('outbound_shipments','updated_by'),
    ('outbound_shipment_items','id'),
    ('outbound_shipment_items','updated_by'),
    ('outbound_shipment_items','outbound_shipment_id'),
    ('outbound_shipment_items','japan_package_item_id'),
    ('outbound_shipment_items','product_group_id'),
    ('outbound_shipment_items','product_variant_id')
  ) required(table_name,column_name)
    where not exists(select 1 from pg_catalog.pg_attribute a
      where a.attrelid=to_regclass('public.'||required.table_name)
        and a.attname=required.column_name and a.attnum>0 and not a.attisdropped))
  then raise exception using errcode='55000',message='CLOUD_RESTORE_AUDIT_SCHEMA_MISMATCH'; end if;
end;
$audit_preflight$;

-- Private pure computation; database keys are the canonical writer output.
-- Relationship JSON exactly mirrors cloudAtomicRestore.manifestFor:
-- ALL 15 tables, lower-case UUID id, only projected *_id except local_id,
-- compact recursively key-sorted JSON (including null relation values).
create function public.erp_cloud_restore_audit_dataset(p_data jsonb)
returns jsonb language plpgsql immutable security invoker
set search_path = pg_catalog, public, extensions
as $audit_dataset$
declare
  v_result jsonb;
  -- ECMAScript String.trim whitespace; match the existing TS manifest checks.
  v_ws constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if jsonb_typeof(p_data) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_data)) <> 15
     or exists (
       select 1 from unnest(array['inventory_items','product_groups','product_categories','product_variants','bundle_components','purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items','japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items']) t
       where jsonb_typeof(p_data->t) is distinct from 'array'
     ) then
    raise exception using errcode='22023', message='CLOUD_RESTORE_AUDIT_DATASET_INVALID';
  end if;
  if exists(select 1 from jsonb_each(p_data) t cross join lateral jsonb_array_elements(t.value) r
            where jsonb_typeof(r) is distinct from 'object') then
    raise exception using errcode='22023', message='CLOUD_RESTORE_AUDIT_ROW_INVALID';
  end if;
  with
    spec(table_name, fields) as (values
      ('inventory_items', array['product_id','latest_catalog_import_id']::text[]),
      ('product_groups', array[]::text[]),
      ('product_categories', array['product_group_id']::text[]),
      ('product_variants', array['product_group_id','product_category_id']::text[]),
      ('bundle_components', array['bundle_variant_id','component_variant_id']::text[]),
      ('purchase_batches', array['product_group_id']::text[]),
      ('purchase_batch_items', array['purchase_batch_id','product_variant_id']::text[]),
      ('private_orders', array['product_group_id']::text[]),
      ('private_order_items', array['private_order_id','product_variant_id']::text[]),
      ('sales_orders', array[]::text[]),
      ('sales_order_items', array['order_id','product_variant_id']::text[]),
      ('japan_packages', array[]::text[]),
      ('japan_package_items', array['japan_package_id','product_group_id','product_variant_id','purchase_batch_id','purchase_batch_item_id']::text[]),
      ('outbound_shipments', array[]::text[]),
      ('outbound_shipment_items', array['outbound_shipment_id','japan_package_item_id','product_group_id','product_variant_id']::text[])
    ),
    relspec(child_table, field, parent_table, optional) as (values
      ('product_categories','product_group_id','product_groups',false),
      ('product_variants','product_group_id','product_groups',false),
      ('product_variants','product_category_id','product_categories',true),
      ('bundle_components','bundle_variant_id','product_variants',false),
      ('bundle_components','component_variant_id','product_variants',false),
      ('purchase_batches','product_group_id','product_groups',false),
      ('purchase_batch_items','purchase_batch_id','purchase_batches',false),
      ('purchase_batch_items','product_variant_id','product_variants',false),
      ('private_orders','product_group_id','product_groups',false),
      ('private_order_items','private_order_id','private_orders',false),
      ('private_order_items','product_variant_id','product_variants',false),
      ('sales_order_items','order_id','sales_orders',false),
      ('sales_order_items','product_variant_id','product_variants',true),
      ('japan_package_items','japan_package_id','japan_packages',false),
      ('japan_package_items','product_group_id','product_groups',true),
      ('japan_package_items','product_variant_id','product_variants',true),
      ('japan_package_items','purchase_batch_id','purchase_batches',true),
      ('japan_package_items','purchase_batch_item_id','purchase_batch_items',true),
      ('outbound_shipment_items','outbound_shipment_id','outbound_shipments',false),
      ('outbound_shipment_items','japan_package_item_id','japan_package_items',true),
      ('outbound_shipment_items','product_group_id','product_groups',true),
      ('outbound_shipment_items','product_variant_id','product_variants',true)
    ),
    rows as materialized (
      select s.table_name,s.fields,r.value as row,
             lower(btrim(coalesce(r.value->>'id',''),v_ws)) as id
      from spec s cross join lateral jsonb_array_elements(p_data->s.table_name) r
    ),
    identities as (select distinct table_name,id from rows),
    counts as (select table_name,jsonb_array_length(p_data->table_name) as n from spec),
    duplicates as (select table_name,id,count(*)-1 as n from rows group by table_name,id),
    local_ids as (
      select btrim(row->>'local_id',v_ws) as id from rows
      where table_name='product_variants' and coalesce(btrim(row->>'local_id',v_ws),'')<>''
    ),
    missing as (
      select rel.optional from rows r join relspec rel on r.table_name=rel.child_table
      left join identities parent on parent.table_name=rel.parent_table
        and parent.id=lower(btrim(r.row->>rel.field,v_ws))
      where parent.id is null and (not rel.optional or coalesce(btrim(r.row->>rel.field,v_ws),'')<>'')
    ),
    projection as (
      select table_name,id,
        '{"id":'||to_json(id)::text||',"relations":{'||
        coalesce((select string_agg(to_json(f)::text||':'||
          coalesce(to_json(nullif(row->>f,''))::text,'null'),',' order by f collate "C")
          from unnest(fields) f),'')||
        '},"table":'||to_json(table_name)::text||'}' as compact
      from rows
    )
  select jsonb_build_object(
    'table_counts',(select jsonb_object_agg(table_name,n) from counts),
    'total_rows',(select sum(n) from counts),
    'relationship_hash',(select encode(extensions.digest(
      '['||coalesce(string_agg(compact,',' order by (table_name||':'||id) collate "C"),'')||']','sha256'),'hex') from projection),
    'integrity',jsonb_build_object(
      'orphan_count',(select count(*) from missing where not optional),
      'optional_metadata_missing_reference_count',(select count(*) from missing where optional),
      'duplicate_variant_id_count',(select coalesce(sum(n),0) from duplicates where table_name='product_variants'),
      'duplicate_variant_local_id_count',(select count(*)-count(distinct id) from local_ids),
      'duplicate_canonical_id_count',(select coalesce(sum(n),0) from duplicates),
      'canonical_identity_anomaly_count',(select count(*) from rows where id !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
      'unknown_product_count',(select count(*) from rows where table_name='product_groups'
        and lower(btrim(coalesce(row->>'normalized_title',row->>'title',''),v_ws)) in ('未知商品','unknown product')),
      'duplicate_inventory_key_count',(select count(*)-count(distinct btrim(coalesce(row->>'inventory_key',''),v_ws)) from rows where table_name='inventory_items'),
      'missing_inventory_key_count',(select count(*) from rows where table_name='inventory_items' and coalesce(btrim(row->>'inventory_key',v_ws),'')='')
    ),
    'audit_policy',jsonb_build_object(
      'covered_updated_by_non_null_count',(select count(*) from rows where row->>'updated_by' is not null),
      'covered_updated_by_null_count',(select count(*) from rows where row->>'updated_by' is null)
    )
  ) into v_result;
  return v_result;
end;
$audit_dataset$;
revoke all on function public.erp_cloud_restore_audit_dataset(jsonb) from public,anon,authenticated;

create function public.erp_read_cloud_restore_integrity_audit()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '30s'
as $audit_read$
declare
  v_data jsonb;
  v_audit jsonb;
  v_epoch bigint;
  v_latest public.erp_cloud_restore_attempts%rowtype;
  v_manifest jsonb;
  v_latest_safe jsonb;
  v_pending bigint;
  v_executing bigint;
  v_processing bigint;
  v_locks bigint;
  v_inconsistent bigint := 0;
  v_counts_match boolean;
  v_hash_match boolean;
begin
  if auth.uid() is null then
    raise exception using errcode='42501', message='AUTHENTICATION_REQUIRED';
  end if;
  if public.is_owner(auth.uid()) is distinct from true then
    raise exception using errcode='42501', message='CLOUD_RESTORE_OWNER_REQUIRED';
  end if;

  -- Deliberately fixed relations, ALL rows including deleted_at != null.
  -- Neither table names nor predicates can be supplied by the caller.
  select jsonb_build_object(
    'inventory_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.inventory_items t),
    'product_groups',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.product_groups t),
    'product_categories',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.product_categories t),
    'product_variants',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.product_variants t),
    'bundle_components',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.bundle_components t),
    'purchase_batches',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.purchase_batches t),
    'purchase_batch_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.purchase_batch_items t),
    'private_orders',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.private_orders t),
    'private_order_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.private_order_items t),
    'sales_orders',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.sales_orders t),
    'sales_order_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.sales_order_items t),
    'japan_packages',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.japan_packages t),
    'japan_package_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.japan_package_items t),
    'outbound_shipments',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.outbound_shipments t),
    'outbound_shipment_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.outbound_shipment_items t)
  ) into v_data;
  v_audit := public.erp_cloud_restore_audit_dataset(v_data);
  select epoch into strict v_epoch from public.erp_cloud_restore_epoch where singleton=true;
  select * into v_latest from public.erp_cloud_restore_attempts
    where status='completed' order by result_epoch desc,completed_at desc,attempt_id limit 1;
  if found then
    v_manifest := v_latest.canonical_result->'manifest';
    v_latest_safe := jsonb_build_object(
      'attempt_id',v_latest.attempt_id,'status',v_latest.status,
      'result_epoch',v_latest.result_epoch,'replayed',v_latest.canonical_result->'replayed',
      'source_fingerprint',v_latest.source_fingerprint,'effective_fingerprint',v_latest.effective_fingerprint,
      'completed_at',v_latest.completed_at,
      'source_transformed_updated_by_count',v_manifest->'portability'->'totalTransformedRows'
    );
    v_counts_match := v_manifest->'counts'=v_audit->'table_counts'
      and (v_manifest->>'totalRows')::bigint=(v_audit->>'total_rows')::bigint;
    v_hash_match := v_manifest->>'relationshipHash'=v_audit->>'relationship_hash';
    if v_latest.result_epoch is distinct from v_epoch
      or v_manifest->>'snapshotFingerprint' is distinct from v_latest.effective_fingerprint
      or v_latest.canonical_result->>'snapshotFingerprint' is distinct from v_latest.effective_fingerprint
      or not exists(select 1 from public.erp_cloud_restore_requests r
        join public.erp_cloud_restore_snapshots s on s.id=r.rollback_snapshot_id
        where r.idempotency_key=v_latest.attempt_id and r.status='completed'
          and r.canonical_result->>'restoreEpoch'=v_epoch::text
          and r.canonical_result->>'snapshotFingerprint'=v_latest.effective_fingerprint
          and r.completed_at is not null)
    then v_inconsistent := v_inconsistent+1; end if;
  elsif v_epoch > 0 then v_inconsistent := v_inconsistent+1;
  end if;
  select count(*) filter(where status='prepared'),count(*) filter(where status='executing')
    into v_pending,v_executing from public.erp_cloud_restore_attempts;
  select count(*) into v_processing from public.erp_cloud_restore_requests where status='processing';

  -- Observation only: never try/acquire advisory locks, never reconcile attempts.
  select count(*) into v_locks from pg_catalog.pg_locks l
    where l.locktype='advisory' and l.objsubid=1
      and l.database=(select oid from pg_catalog.pg_database where datname=current_database())
      and ((l.classid::bigint<<32)|l.objid::bigint) in (
        select hashtextextended('erp-cloud-restore-maintenance-lock',0)
        union all select hashtextextended('erp-cloud-restore-attempt:'||attempt_id::text,0)
          from public.erp_cloud_restore_attempts
      );

  return v_audit || jsonb_build_object(
    'schema_version','cloud-restore-integrity-audit-v1','audited_at',statement_timestamp(),'epoch',v_epoch,
    'audit_policy',(v_audit->'audit_policy')||jsonb_build_object('policy',v_latest.restore_policy),
    'expected_manifest',case when v_manifest is null then null else jsonb_build_object(
      'counts',v_manifest->'counts','total_rows',v_manifest->'totalRows',
      'relationship_hash',v_manifest->'relationshipHash') end,
    'comparison',jsonb_build_object('counts_match',v_counts_match,'relationship_hash_match',v_hash_match),
    'restore_state',jsonb_build_object(
      'latest_completed',v_latest_safe,'pending_count',v_pending,'executing_count',v_executing,
      'processing_request_count',v_processing,'active_lock_count',v_locks,
      'metadata_inconsistency_count',v_inconsistent,
      'partial_state',case when v_inconsistent>0 then 'inconsistent'
        when v_pending+v_executing+v_processing+v_locks>0 or v_counts_match is not true or v_hash_match is not true then 'unproven'
        else 'not_detected' end,
      'scope','statement snapshot; locks sampled separately; counts/identity/relationships, not all business values'
    )
  );
end;
$audit_read$;
revoke all on function public.erp_read_cloud_restore_integrity_audit() from public,anon,authenticated;
grant execute on function public.erp_read_cloud_restore_integrity_audit() to authenticated;

do $audit_postflight$
declare v record; v_oid oid;
begin
  for v in select * from (values
    ('public.erp_cloud_restore_audit_dataset(jsonb)','i',false,1,array['p_data']::text[]),
    ('public.erp_read_cloud_restore_integrity_audit()','s',true,0,null::text[])
  ) s(signature,volatility,definer,nargs,names) loop
    v_oid:=to_regprocedure(v.signature);
    if v_oid is null or not exists(select 1 from pg_catalog.pg_proc p where p.oid=v_oid
       and p.proowner='postgres'::regrole and p.prokind='f' and p.prorettype='jsonb'::regtype
       and p.pronargs=v.nargs and p.proargnames is not distinct from v.names
       and (v.nargs=0 or p.proargtypes[0]='jsonb'::regtype)
       and p.provolatile=v.volatility::"char" and p.prosecdef=v.definer
       and p.proconfig @> array['search_path=pg_catalog, public, extensions']
       and (not v.definer or p.proconfig @> array['statement_timeout=30s']))
       or exists(select 1 from pg_catalog.pg_proc p,
          lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where p.oid=v_oid and a.privilege_type='EXECUTE'
            and (a.grantee=0 or (a.grantee<>p.proowner and
              (not v.definer or a.grantee<>'authenticated'::regrole or a.is_grantable))))
       or has_function_privilege('anon',v_oid,'EXECUTE')
       or has_function_privilege('authenticated',v_oid,'EXECUTE') is distinct from v.definer
       or (select count(*) from pg_catalog.pg_proc other join pg_catalog.pg_proc target
           on other.pronamespace=target.pronamespace and other.proname=target.proname
           where target.oid=v_oid)<>1
    then raise exception using errcode='55000',message='CLOUD_RESTORE_AUDIT_POSTFLIGHT_FAILED'; end if;
  end loop;
end;
$audit_postflight$;
commit;
