-- Compatibility closure for the observed live state where 044 committed and
-- 045 rolled back on a whitespace-sensitive source anchor. Historical 045 is
-- immutable. This transaction accepts only the known complete pre-045 or
-- complete post-045 semantic contract and converges both to the canonical
-- 24-resource Restore definitions.
begin;

do $waca_restore_compatibility_preflight$
declare
  v_signature text;
  v_definition text;
  v_validate_exists boolean := to_regprocedure('public.erp_cloud_restore_validate_waca_dataset(jsonb)') is not null;
  v_recompute_exists boolean := to_regprocedure('public.erp_cloud_restore_recompute_waca_quantities()') is not null;
begin
  if current_user <> 'postgres'
    or to_regclass('public.waca_state') is null
    or to_regclass('public.import_batches') is null
    or to_regclass('public.dashboard_category_images') is null
    or to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)') is null
    or to_regprocedure('public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)') is null
    or to_regprocedure('public.erp_cloud_restore_audit_dataset(jsonb)') is null
    or to_regprocedure('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)') is null
    or to_regprocedure('public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)') is null then
    raise exception using errcode='55000',message='WACA_045B_BASE_CONTRACT_MISSING';
  end if;
  if v_validate_exists is distinct from v_recompute_exists then
    raise exception using errcode='55000',message='WACA_045B_PARTIAL_HELPER_STATE';
  end if;

  -- Independent semantic safety checks for the 041 durable-failure, 042
  -- prepared/executing lifecycle, and 043 proof-id dispatch boundaries.
  foreach v_signature in array array[
    'public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)',
    'public.erp_reconcile_cloud_restore_attempt(uuid,uuid)',
    'public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)',
    'public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)'
  ] loop
    v_definition := lower(regexp_replace(pg_get_functiondef(to_regprocedure(v_signature)),'[[:space:]]+','','g'));
    if (v_signature like '%snapshot_attempt(uuid,uuid,uuid,text%'
        and (strpos(v_definition,'erp_cloud_restore_failures')=0 or strpos(v_definition,'execution_started_at')=0))
      or (v_signature like '%reconcile_cloud_restore_attempt%'
        and (strpos(v_definition,'execution_id')=0 or strpos(v_definition,'not_committed')=0))
      or (v_signature like '%candidate_v2%'
        and (strpos(v_definition,'erp_prove_cloud_restore_candidate')=0
          or strpos(v_definition,'erp_cloud_restore_build_effective_snapshot')=0
          or strpos(v_definition,'proof_id')=0))
      or (v_signature like '%restore_proven%'
        and (strpos(v_definition,'p_proof_id')=0 or strpos(v_definition,'rpc=executeevent=db-entry')=0)) then
      raise exception using errcode='55000',message='WACA_045B_CONTROL_PLANE_CONTRACT_DRIFT:'||v_signature;
    end if;
  end loop;

  v_definition := lower(regexp_replace(pg_get_functiondef(
    'public.erp_cloud_restore_audit_dataset(jsonb)'::regprocedure),'[[:space:]]+','','g'));
  if v_validate_exists then
    if strpos(v_definition,'<>24')=0 or strpos(v_definition,'waca_order_items')=0
      or strpos(v_definition,'waca_mappings')=0 then
      raise exception using errcode='55000',message='WACA_045B_POST_STATE_CONFLICT';
    end if;
  elsif strpos(v_definition,'<>15')=0 or strpos(v_definition,'outbound_shipment_items')=0
    or strpos(v_definition,'waca_order_items')>0 then
    raise exception using errcode='55000',message='WACA_045B_PRE_STATE_CONFLICT';
  end if;
end;
$waca_restore_compatibility_preflight$;

drop trigger if exists erp_cloud_restore_maintenance_guard on public.import_batches;
create trigger erp_cloud_restore_maintenance_guard before insert or update or delete
  on public.import_batches for each statement execute function public.erp_assert_cloud_restore_unlocked();

create or replace function public.erp_cloud_restore_validate_waca_dataset(p_data jsonb) returns void
language plpgsql immutable security invoker set search_path=pg_catalog,public as $validate$
declare v_mode text;
begin
  if exists(select 1 from unnest(array['import_batches','waca_orders','waca_order_items',
      'waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state']) t
      where jsonb_typeof(p_data->t) is distinct from 'array')
    or jsonb_array_length(p_data->'waca_state') <> 1 then
    raise exception using errcode='22023',message='WACA_RESTORE_RESOURCE_MISSING';
  end if;
  v_mode := p_data->'waca_state'->0->>'mode';
  if p_data->'waca_state'->0->>'id' <> '00000000-0000-4000-8000-000000000001'
    or v_mode not in ('LEGACY_QUANTITY_ACTIVE','ORDER_REBASELINE_REQUIRED','ORDER_DRIVEN_ACTIVE')
    or (p_data->'waca_state'->0->>'revision') !~ '^[0-9]+$' then
    raise exception using errcode='22023',message='WACA_RESTORE_CUTOVER_INVALID';
  end if;
  if exists(select 1 from (values
    ('waca_orders','order_key'),('waca_order_items','item_key'),('waca_mappings','feature'),
    ('waca_master_links','child_code'),('waca_import_batches','batch_key'),
    ('waca_cutover_audit','product_variant_id')) spec(t,k)
    where exists(select 1 from jsonb_array_elements(p_data->spec.t) row
      group by row->>spec.k having count(*)>1 or coalesce(btrim(row->>spec.k),'')='')) then
    raise exception using errcode='23505',message='WACA_RESTORE_DUPLICATE_BUSINESS_KEY';
  end if;
  if exists(select 1 from jsonb_array_elements(p_data->'waca_orders') row
    where row->>'status' not in ('處理中','完成付款','取消','失敗')
      or row->'payload'->>'key' is distinct from row->>'order_key')
    or exists(select 1 from jsonb_array_elements(p_data->'waca_order_items') row
      where (row->>'quantity') !~ '^[0-9]+$'
        or row->'payload'->>'key' is distinct from row->>'item_key') then
    raise exception using errcode='22023',message='WACA_RESTORE_ROW_INVALID';
  end if;
  if exists(select 1 from jsonb_array_elements(p_data->'waca_order_items') item
    join jsonb_array_elements(p_data->'waca_mappings') mapping
      on mapping->>'feature'=item->>'feature'
    where item->>'product_variant_id' is not null
      and item->>'product_variant_id' is distinct from mapping->>'product_variant_id') then
    raise exception using errcode='23000',message='WACA_RESTORE_MAPPING_MISMATCH';
  end if;
  if v_mode='ORDER_DRIVEN_ACTIVE' and exists(
    with quantities as (
      select item->>'product_variant_id' variant_id,
        sum((item->>'quantity')::integer) quantity
      from jsonb_array_elements(p_data->'waca_order_items') item
      join jsonb_array_elements(p_data->'waca_orders') order_row
        on order_row->>'id'=item->>'order_id'
      where item->>'product_variant_id' is not null
        and order_row->>'status' in ('處理中','完成付款')
      group by item->>'product_variant_id'
    )
    select 1 from jsonb_array_elements(p_data->'product_variants') variant
    left join quantities q on q.variant_id=variant->>'id'
    where (variant->>'waca_auto_quantity')::integer is distinct from coalesce(q.quantity,0)
  ) then
    raise exception using errcode='23000',message='WACA_RESTORE_QUANTITY_MISMATCH';
  end if;
end;
$validate$;
revoke all on function public.erp_cloud_restore_validate_waca_dataset(jsonb) from public,anon,authenticated;

create or replace function public.erp_cloud_restore_recompute_waca_quantities() returns void
language plpgsql volatile security definer set search_path=pg_catalog,public as $recompute$
begin
  if current_setting('erp.cloud_restore_active',true) is distinct from 'on' then
    raise exception using errcode='42501',message='WACA_RECOMPUTE_RESTORE_ONLY';
  end if;
  if (select mode from public.waca_state limit 1) <> 'ORDER_DRIVEN_ACTIVE' then return; end if;
  update public.product_variants v set waca_auto_quantity=coalesce(q.quantity,0)
  from (select v2.id,sum(i.quantity) filter(where o.status in ('處理中','完成付款'))::integer quantity
    from public.product_variants v2 left join public.waca_order_items i on i.product_variant_id=v2.id
    left join public.waca_orders o on o.id=i.order_id group by v2.id) q
  where q.id=v.id and v.waca_auto_quantity is distinct from coalesce(q.quantity,0);
end;
$recompute$;
revoke all on function public.erp_cloud_restore_recompute_waca_quantities() from public,anon,authenticated;

-- Exact replacement remains canonical for stable anchors. The post-state is
-- accepted for replay. Safety does not depend on these strings alone: the
-- independent preflight above proves the 041-044 semantic contract first.
create or replace function pg_temp.waca_patch_compat(p_signature text,p_old text,p_new text,p_expected integer default 1) returns void
language plpgsql as $patch$
declare v_oid oid; v_definition text; v_old_count integer; v_new_count integer;
begin
  v_oid := to_regprocedure(p_signature);
  if v_oid is null then raise exception using errcode='55000',message='WACA_045B_FUNCTION_MISSING:'||p_signature; end if;
  v_definition := replace(pg_get_functiondef(v_oid),E'\r\n',E'\n');
  v_old_count := (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old);
  v_new_count := (length(v_definition)-length(replace(v_definition,p_new,'')))/length(p_new);
  if v_new_count=p_expected then return; end if;
  if v_new_count<>0 or v_old_count<>p_expected then
    raise exception using errcode='55000',message='WACA_045B_SEMANTIC_SOURCE_CONFLICT:'||p_signature;
  end if;
  execute replace(v_definition,p_old,p_new);
end;
$patch$;

-- The one anchor proven incompatible on live is matched semantically across
-- line-ending and indentation variants, while still requiring exactly one
-- pre-state or one post-state occurrence.
create or replace function pg_temp.waca_patch_audit_spec(p_signature text,p_new text) returns void
language plpgsql as $patch$
declare
  v_definition text := replace(pg_get_functiondef(to_regprocedure(p_signature)),E'\r\n',E'\n');
  v_pattern text := E'\\)[[:space:]]*,[[:space:]]*relspec\\(child_table,[[:space:]]*field,[[:space:]]*parent_table,[[:space:]]*optional\\)[[:space:]]*as[[:space:]]*\\(values';
  v_old_count integer;
  v_new_count integer;
begin
  v_new_count := (length(v_definition)-length(replace(v_definition,p_new,'')))/length(p_new);
  if v_new_count=1 then return; end if;
  select count(*) into v_old_count from regexp_matches(v_definition,v_pattern,'g');
  if v_new_count<>0 or v_old_count<>1 then
    raise exception using errcode='55000',message='WACA_045B_AUDIT_SPEC_CONFLICT:'||p_signature;
  end if;
  execute regexp_replace(v_definition,v_pattern,p_new);
end;
$patch$;

select pg_temp.waca_patch_compat(s,$old$'public.outbound_shipment_items'::regclass$old$,
  $new$'public.outbound_shipment_items'::regclass,'public.import_batches'::regclass,
    'public.dashboard_category_images'::regclass,
    'public.waca_orders'::regclass,'public.waca_order_items'::regclass,
    'public.waca_mappings'::regclass,'public.waca_master_links'::regclass,
    'public.waca_import_batches'::regclass,'public.waca_cutover_audit'::regclass,
    'public.waca_state'::regclass$new$)
from (values
  ('public.erp_cloud_restore_table_profile(regclass,jsonb)'),
  ('public.erp_cloud_restore_insert_rows(regclass,jsonb)')
) signatures(s);

select pg_temp.waca_patch_compat(s,
  $old$'outbound_shipment_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.outbound_shipment_items t), '[]'::jsonb)$old$,
  $new$'outbound_shipment_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.outbound_shipment_items t), '[]'::jsonb),
    'dashboard_category_images', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.dashboard_category_images t), '[]'::jsonb),
    'import_batches', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.import_batches t), '[]'::jsonb),
    'waca_orders', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_orders t), '[]'::jsonb),
    'waca_order_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_order_items t), '[]'::jsonb),
    'waca_mappings', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_mappings t), '[]'::jsonb),
    'waca_master_links', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_master_links t), '[]'::jsonb),
    'waca_import_batches', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_import_batches t), '[]'::jsonb),
    'waca_cutover_audit', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_cutover_audit t), '[]'::jsonb),
    'waca_state', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.waca_state t), '[]'::jsonb)$new$)
from (values
  ('public.erp_cloud_restore_snapshot()'),
  ('public.erp_export_cloud_restore_snapshot()')
) signatures(s);

select pg_temp.waca_patch_compat('public.erp_read_cloud_restore_integrity_audit()',
  $old$'outbound_shipment_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.outbound_shipment_items t)$old$,
  $new$'outbound_shipment_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.outbound_shipment_items t),
    'dashboard_category_images',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.dashboard_category_images t),
    'import_batches',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.import_batches t),
    'waca_orders',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_orders t),
    'waca_order_items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_order_items t),
    'waca_mappings',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_mappings t),
    'waca_master_links',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_master_links t),
    'waca_import_batches',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_import_batches t),
    'waca_cutover_audit',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_cutover_audit t),
    'waca_state',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.waca_state t)$new$);

select pg_temp.waca_patch_compat('public.erp_cloud_restore_relationship_hash(jsonb)',
  $old$  ), projection as ($old$,
  $new$    union all select 'waca_order_items', row->>'id', jsonb_build_object('order_id',row->'order_id','product_variant_id',row->'product_variant_id') from jsonb_array_elements(p_snapshot->'waca_order_items') row
    union all select 'waca_mappings', row->>'id', jsonb_build_object('product_variant_id',row->'product_variant_id') from jsonb_array_elements(p_snapshot->'waca_mappings') row
    union all select 'waca_master_links', row->>'id', jsonb_build_object('product_variant_id',row->'product_variant_id') from jsonb_array_elements(p_snapshot->'waca_master_links') row
    union all select 'waca_cutover_audit', row->>'id', jsonb_build_object('product_variant_id',row->'product_variant_id') from jsonb_array_elements(p_snapshot->'waca_cutover_audit') row
  ), projection as ($new$);
select pg_temp.waca_patch_compat('public.erp_cloud_restore_live_relationship_hash()',
  $old$  ), projection as ($old$,
  $new$    union all select 'waca_order_items', t.id::text, jsonb_build_object('order_id',to_jsonb(t.order_id),'product_variant_id',to_jsonb(t.product_variant_id)) from public.waca_order_items t
    union all select 'waca_mappings', t.id::text, jsonb_build_object('product_variant_id',to_jsonb(t.product_variant_id)) from public.waca_mappings t
    union all select 'waca_master_links', t.id::text, jsonb_build_object('product_variant_id',to_jsonb(t.product_variant_id)) from public.waca_master_links t
    union all select 'waca_cutover_audit', t.id::text, jsonb_build_object('product_variant_id',to_jsonb(t.product_variant_id)) from public.waca_cutover_audit t
  ), projection as ($new$);

select pg_temp.waca_patch_compat(s,$old$'outbound_shipments','outbound_shipment_items'$old$,
  $new$'outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state'$new$)
from (values
  ('public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)'),
  ('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)'),
  ('public.erp_cloud_restore_audit_dataset(jsonb)')
) signatures(s);
select pg_temp.waca_patch_compat('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)',
  $old$'outbound_shipments','outbound_shipment_items'$old$,
  $new$'outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state'$new$,3);

select pg_temp.waca_patch_compat('public.erp_cloud_restore_audit_dataset(jsonb)',
  $old$(select count(*) from jsonb_object_keys(p_data)) <> 15$old$,
  $new$(select count(*) from jsonb_object_keys(p_data)) <> 24$new$);
select pg_temp.waca_patch_audit_spec('public.erp_cloud_restore_audit_dataset(jsonb)',
  $new$),
    relspec(child_table, field, parent_table, optional) as (values$new$);
select pg_temp.waca_patch_compat('public.erp_cloud_restore_audit_dataset(jsonb)',
  $old$    ),
    rows as materialized ($old$,
  $new$    , ('waca_order_items','order_id','waca_orders',false),
      ('waca_order_items','product_variant_id','product_variants',true),
      ('waca_mappings','product_variant_id','product_variants',false),
      ('waca_master_links','product_variant_id','product_variants',true),
      ('waca_cutover_audit','product_variant_id','product_variants',false)
    ),
    rows as materialized ($new$);

-- Insert the WACA spec rows immediately before relspec. Keeping this separate
-- from the whitespace-tolerant boundary replacement makes the final function
-- body byte-for-byte equivalent (after catalog normalization) to canonical 045.
select pg_temp.waca_patch_compat('public.erp_cloud_restore_audit_dataset(jsonb)',
  $old$    ),
    relspec(child_table, field, parent_table, optional) as (values$old$,
  $new$    , ('dashboard_category_images', array[]::text[]),
      ('import_batches', array[]::text[]),
      ('waca_orders', array[]::text[]),
      ('waca_order_items', array['order_id','product_variant_id']::text[]),
      ('waca_mappings', array['product_variant_id']::text[]),
      ('waca_master_links', array['product_variant_id']::text[]),
      ('waca_import_batches', array[]::text[]),
      ('waca_cutover_audit', array['product_variant_id']::text[]),
      ('waca_state', array[]::text[])
    ),
    relspec(child_table, field, parent_table, optional) as (values$new$);

select pg_temp.waca_patch_compat('public.erp_read_cloud_restore_integrity_audit()',
  $old$v_audit := public.erp_cloud_restore_audit_dataset(v_data);$old$,
  $new$perform public.erp_cloud_restore_validate_waca_dataset(v_data);
  v_audit := public.erp_cloud_restore_audit_dataset(v_data);$new$);

select pg_temp.waca_patch_compat('public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)',
  $old$v_coverage_count <> 15$old$,$new$v_coverage_count <> 24$new$);
select pg_temp.waca_patch_compat('public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)',
  $old$p_manifest->>'resourceCount' is distinct from '15'$old$,
  $new$p_manifest->>'resourceCount' is distinct from '24'$new$);
select pg_temp.waca_patch_compat('public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)',
  $old$'resource_count',15$old$,$new$'resource_count',24$new$);
select pg_temp.waca_patch_compat('public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)',
  $old$v_audit := public.erp_cloud_restore_audit_dataset(v_effective);$old$,
  $new$perform public.erp_cloud_restore_validate_waca_dataset(v_effective);
  v_audit := public.erp_cloud_restore_audit_dataset(v_effective);$new$);

select pg_temp.waca_patch_compat('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)',
  $old$'cloud-erp-snapshot-v1'$old$,$new$'cloud-erp-snapshot-v2'$new$,2);
select pg_temp.waca_patch_compat('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)',
  $old$'resourceCount')::bigint <> 15$old$,$new$'resourceCount')::bigint <> 24$new$);
select pg_temp.waca_patch_compat('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)',
  $old$'resourceCount', 15$old$,$new$'resourceCount', 24$new$);
select pg_temp.waca_patch_compat('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)',
  $old$v_expected_relationship_hash := public.erp_cloud_restore_relationship_hash(p_snapshot);$old$,
  $new$perform public.erp_cloud_restore_validate_waca_dataset(p_snapshot);
  v_expected_relationship_hash := public.erp_cloud_restore_relationship_hash(p_snapshot);$new$);
select pg_temp.waca_patch_compat('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)',
  $old$delete from public.product_variants$old$,
  $new$delete from public.dashboard_category_images where id is not null;
  delete from public.waca_order_items where id is not null;
  delete from public.waca_mappings where id is not null;
  delete from public.waca_master_links where id is not null;
  delete from public.waca_cutover_audit where id is not null;
  delete from public.waca_import_batches where id is not null;
  delete from public.waca_state where id is not null;
  delete from public.waca_orders where id is not null;
  delete from public.import_batches where id is not null;
  delete from public.product_variants$new$);
select pg_temp.waca_patch_compat('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)',
  $old$perform public.erp_cloud_restore_insert_rows('public.outbound_shipment_items', p_snapshot->'outbound_shipment_items');$old$,
  $new$perform public.erp_cloud_restore_insert_rows('public.outbound_shipment_items', p_snapshot->'outbound_shipment_items');
  perform public.erp_cloud_restore_insert_rows('public.dashboard_category_images', p_snapshot->'dashboard_category_images');
  perform public.erp_cloud_restore_insert_rows('public.import_batches', p_snapshot->'import_batches');
  perform public.erp_cloud_restore_insert_rows('public.waca_orders', p_snapshot->'waca_orders');
  perform public.erp_cloud_restore_insert_rows('public.waca_order_items', p_snapshot->'waca_order_items');
  perform public.erp_cloud_restore_insert_rows('public.waca_mappings', p_snapshot->'waca_mappings');
  perform public.erp_cloud_restore_insert_rows('public.waca_master_links', p_snapshot->'waca_master_links');
  perform public.erp_cloud_restore_insert_rows('public.waca_import_batches', p_snapshot->'waca_import_batches');
  perform public.erp_cloud_restore_insert_rows('public.waca_cutover_audit', p_snapshot->'waca_cutover_audit');
  perform public.erp_cloud_restore_insert_rows('public.waca_state', p_snapshot->'waca_state');
  perform public.erp_cloud_restore_recompute_waca_quantities();
  perform public.erp_cloud_restore_validate_waca_dataset(public.erp_cloud_restore_snapshot());$new$);

do $waca_restore_compatibility_postflight$
declare v_signature text; v_definition text;
begin
  foreach v_signature in array array[
    'public.erp_cloud_restore_snapshot()',
    'public.erp_export_cloud_restore_snapshot()',
    'public.erp_read_cloud_restore_integrity_audit()',
    'public.erp_cloud_restore_audit_dataset(jsonb)',
    'public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)',
    'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'
  ] loop
    v_definition := lower(regexp_replace(pg_get_functiondef(to_regprocedure(v_signature)),'[[:space:]]+','','g'));
    if (v_signature='public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)'
        and (strpos(v_definition,'erp_cloud_restore_validate_waca_dataset')=0
          or strpos(v_definition,'v_coverage_count<>24')=0))
      or (v_signature<>'public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)'
        and (strpos(v_definition,'waca_state')=0 or strpos(v_definition,'import_batches')=0)) then
      raise exception using errcode='55000',message='WACA_045B_POSTFLIGHT_MISSING:'||v_signature;
    end if;
  end loop;
  v_definition := lower(regexp_replace(pg_get_functiondef(
    'public.erp_cloud_restore_audit_dataset(jsonb)'::regprocedure),'[[:space:]]+','','g'));
  if strpos(v_definition,'<>24')=0
    or to_regprocedure('public.erp_cloud_restore_validate_waca_dataset(jsonb)') is null
    or to_regprocedure('public.erp_cloud_restore_recompute_waca_quantities()') is null
    or has_function_privilege('anon','public.erp_commit_waca_snapshot(jsonb,bigint,boolean)','EXECUTE')
    or not has_function_privilege('authenticated','public.erp_commit_waca_snapshot(jsonb,bigint,boolean)','EXECUTE')
    or has_function_privilege('anon','public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)','EXECUTE') then
    raise exception using errcode='55000',message='WACA_045B_POSTFLIGHT_CONTRACT_FAILED';
  end if;
end;
$waca_restore_compatibility_postflight$;

commit;
