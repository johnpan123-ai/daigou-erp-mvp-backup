-- Cloud ERP atomic JSON restore execution-cost and bounded-timeout upgrade.
-- Review/build artifact only. Apply only in the separately authorized Staging gate.
begin;

create or replace function public.erp_cloud_restore_table_profile(
  p_table regclass,
  p_rows jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_identity_column text;
  v_sql text;
  v_profile jsonb;
begin
  if p_table not in (
    'public.inventory_items'::regclass,'public.product_groups'::regclass,'public.product_categories'::regclass,
    'public.product_variants'::regclass,'public.bundle_components'::regclass,'public.purchase_batches'::regclass,
    'public.purchase_batch_items'::regclass,'public.private_orders'::regclass,'public.private_order_items'::regclass,
    'public.sales_orders'::regclass,'public.sales_order_items'::regclass,'public.japan_packages'::regclass,
    'public.japan_package_items'::regclass,'public.outbound_shipments'::regclass,'public.outbound_shipment_items'::regclass
  ) then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_TABLE_NOT_ALLOWED';
  end if;
  if p_rows is not null and jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_RESOURCE_NOT_ARRAY';
  end if;

  v_identity_column := case
    when p_table = 'public.inventory_items'::regclass then 'inventory_key'
    else 'id'
  end;
  if p_rows is null then
    v_sql := format($profile$
      with normalized_rows as (
        select
          nullif(btrim(row_value.%I::text), '') as identity_value,
          %s as auxiliary_identity
        from %s row_value
      )
      select jsonb_build_object(
        'count', count(*),
        'missingIdentityCount', count(*) filter (where identity_value is null),
        'duplicateIdentityCount', count(identity_value) - count(distinct identity_value),
        'duplicateAuxiliaryIdentityCount', count(auxiliary_identity) - count(distinct auxiliary_identity),
        'identityHash', encode(digest(convert_to(coalesce(
          string_agg(identity_value, E'\n' order by identity_value), ''
        ), 'UTF8'), 'sha256'), 'hex')
      )
      from normalized_rows
    $profile$,
      v_identity_column,
      case when p_table = 'public.product_variants'::regclass
        then 'nullif(btrim(row_value.local_id::text), '''')'
        else 'null::text'
      end,
      p_table
    );
    execute v_sql into v_profile;
  else
    v_sql := format($profile$
      with normalized_rows as (
        select
          nullif(btrim(row_value->>%L), '') as identity_value,
          %s as auxiliary_identity
        from jsonb_array_elements($1) row_value
      )
    select jsonb_build_object(
      'count', count(*),
      'missingIdentityCount', count(*) filter (where identity_value is null),
      'duplicateIdentityCount', count(identity_value) - count(distinct identity_value),
      'duplicateAuxiliaryIdentityCount', count(auxiliary_identity) - count(distinct auxiliary_identity),
      'identityHash', encode(digest(convert_to(coalesce(
        string_agg(identity_value, E'\n' order by identity_value), ''
      ), 'UTF8'), 'sha256'), 'hex')
    )
    from normalized_rows
    $profile$,
      v_identity_column,
      case when p_table = 'public.product_variants'::regclass
        then 'nullif(btrim(row_value->>''local_id''), '''')'
        else 'null::text'
      end
    );
    execute v_sql using p_rows into v_profile;
  end if;
  return v_profile;
end;
$$;

revoke all on function public.erp_cloud_restore_table_profile(regclass, jsonb) from public, anon, authenticated;

create or replace function public.erp_cloud_restore_live_relationship_hash()
returns text
language sql
security definer
set search_path = pg_catalog, public, extensions
as $$
  with relations(table_name, record_id, links) as (
    select 'product_categories', t.id::text, jsonb_build_object('product_group_id',to_jsonb(t.product_group_id)) from public.product_categories t
    union all select 'product_variants', t.id::text, jsonb_build_object('product_group_id',to_jsonb(t.product_group_id),'product_category_id',to_jsonb(t.product_category_id)) from public.product_variants t
    union all select 'bundle_components', t.id::text, jsonb_build_object('bundle_variant_id',to_jsonb(t.bundle_variant_id),'component_variant_id',to_jsonb(t.component_variant_id)) from public.bundle_components t
    union all select 'purchase_batches', t.id::text, jsonb_build_object('product_group_id',to_jsonb(t.product_group_id)) from public.purchase_batches t
    union all select 'purchase_batch_items', t.id::text, jsonb_build_object('purchase_batch_id',to_jsonb(t.purchase_batch_id),'product_variant_id',to_jsonb(t.product_variant_id)) from public.purchase_batch_items t
    union all select 'private_orders', t.id::text, jsonb_build_object('product_group_id',to_jsonb(t.product_group_id)) from public.private_orders t
    union all select 'private_order_items', t.id::text, jsonb_build_object('private_order_id',to_jsonb(t.private_order_id),'product_variant_id',to_jsonb(t.product_variant_id)) from public.private_order_items t
    union all select 'sales_order_items', t.id::text, jsonb_build_object('order_id',to_jsonb(t.order_id),'product_variant_id',to_jsonb(t.product_variant_id)) from public.sales_order_items t
    union all select 'japan_package_items', t.id::text, jsonb_build_object('japan_package_id',to_jsonb(t.japan_package_id),'product_group_id',to_jsonb(t.product_group_id),'product_variant_id',to_jsonb(t.product_variant_id),'purchase_batch_id',to_jsonb(t.purchase_batch_id),'purchase_batch_item_id',to_jsonb(t.purchase_batch_item_id)) from public.japan_package_items t
    union all select 'outbound_shipment_items', t.id::text, jsonb_build_object('outbound_shipment_id',to_jsonb(t.outbound_shipment_id),'japan_package_item_id',to_jsonb(t.japan_package_item_id),'product_group_id',to_jsonb(t.product_group_id),'product_variant_id',to_jsonb(t.product_variant_id)) from public.outbound_shipment_items t
  ), projection as (
    select coalesce(jsonb_agg(
      jsonb_build_object('table',table_name,'id',record_id,'relations',links)
      order by table_name,record_id
    ), '[]'::jsonb) value
    from relations
  )
  select encode(digest(convert_to(value::text,'UTF8'),'sha256'),'hex') from projection;
$$;

revoke all on function public.erp_cloud_restore_live_relationship_hash() from public, anon, authenticated;

create or replace function public.erp_restore_cloud_snapshot(
  p_idempotency_key uuid,
  p_snapshot_fingerprint text,
  p_snapshot jsonb,
  p_manifest jsonb,
  p_source_environment text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '30s'
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.erp_cloud_restore_requests%rowtype;
  v_rollback_id uuid;
  v_before jsonb;
  v_before_counts jsonb := '{}'::jsonb;
  v_before_manifest jsonb;
  v_before_fingerprint text;
  v_expected_profiles jsonb := '{}'::jsonb;
  v_expected_profile jsonb;
  v_actual_profile jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_table text;
  v_expected bigint;
  v_epoch bigint;
  v_result jsonb;
  v_server_fingerprint text;
  v_expected_relationship_hash text;
  v_actual_relationship_hash text;
  v_started_at timestamptz := clock_timestamp();
  v_phase_started_at timestamptz := clock_timestamp();
  v_phase_ms bigint;
  v_phase_timings jsonb := '{}'::jsonb;
  v_current_phase text := 'auth';
begin
  raise log 'CLOUD_RESTORE_TIMING phase=auth event=start';
  if v_actor is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode = '42501', message = 'CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  if p_idempotency_key is null or p_snapshot_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_REQUEST_INVALID';
  end if;
  if jsonb_typeof(p_snapshot) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_SNAPSHOT_INVALID';
  end if;
  if jsonb_typeof(p_manifest) is distinct from 'object'
     or p_manifest->>'schemaVersion' is distinct from 'cloud-erp-snapshot-v1' then
    raise exception using errcode = '22023', message = 'UNSUPPORTED_SCHEMA_VERSION';
  end if;
  if jsonb_typeof(p_manifest->'counts') is distinct from 'object'
     or (p_manifest->>'resourceCount')::bigint <> 15
     or coalesce((p_manifest->>'orphanCount')::bigint, -1) <> 0
     or coalesce((p_manifest->>'duplicateVariantIdCount')::bigint, -1) <> 0
     or coalesce((p_manifest->>'duplicateVariantLocalIdCount')::bigint, -1) <> 0 then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_MANIFEST_INVALID';
  end if;
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('auth', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=auth event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'lock_idempotency';
  raise log 'CLOUD_RESTORE_TIMING phase=lock_idempotency event=start';
  v_server_fingerprint := encode(digest(convert_to(p_snapshot::text, 'UTF8'), 'sha256'), 'hex');
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock', 0)) then
    raise exception using errcode = '55006', message = 'CLOUD_RESTORE_LOCK_CONFLICT';
  end if;
  insert into public.erp_cloud_restore_requests(actor_id,idempotency_key,snapshot_fingerprint,status)
  values(v_actor,p_idempotency_key,v_server_fingerprint,'processing')
  on conflict(actor_id,idempotency_key) do nothing;
  select * into v_existing from public.erp_cloud_restore_requests
   where actor_id=v_actor and idempotency_key=p_idempotency_key for update;
  if v_existing.snapshot_fingerprint <> v_server_fingerprint then
    raise exception using errcode = '22023', message = 'RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH';
  end if;
  if v_existing.status = 'completed' then
    raise log 'CLOUD_RESTORE_TIMING phase=lock_idempotency event=replay duration_ms=%',
      (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
    return v_existing.canonical_result || jsonb_build_object('replayed', true);
  end if;
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('lockIdempotency', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=lock_idempotency event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'input_validation';
  raise log 'CLOUD_RESTORE_TIMING phase=input_validation event=start';
  foreach v_table in array array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'
  ] loop
    if jsonb_typeof(p_snapshot->v_table) <> 'array' then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_RESOURCE_REQUIRED:' || v_table;
    end if;
    v_expected_profile := public.erp_cloud_restore_table_profile(
      format('public.%I', v_table)::regclass,
      p_snapshot->v_table
    );
    v_expected := (v_expected_profile->>'count')::bigint;
    if coalesce((p_manifest->'counts'->>v_table)::bigint, -1) <> v_expected then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_MANIFEST_COUNT_MISMATCH:' || v_table;
    end if;
    if (v_expected_profile->>'missingIdentityCount')::bigint > 0 then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_IDENTITY_REQUIRED:' || v_table;
    end if;
    if (v_expected_profile->>'duplicateIdentityCount')::bigint > 0 then
      raise exception using errcode = '23505', message = 'DUPLICATE_CANONICAL_ID:' || v_table;
    end if;
    if v_table = 'product_variants'
       and (v_expected_profile->>'duplicateAuxiliaryIdentityCount')::bigint > 0 then
      raise exception using errcode = '23505', message = 'DUPLICATE_VARIANT_LOCAL_ID';
    end if;
    v_expected_profiles := v_expected_profiles || jsonb_build_object(v_table, v_expected_profile);
    v_counts := v_counts || jsonb_build_object(v_table, v_expected);
  end loop;
  if coalesce((p_manifest->>'totalRows')::bigint, -1)
     <> (select coalesce(sum(value::bigint), 0) from jsonb_each_text(v_counts)) then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_MANIFEST_TOTAL_MISMATCH';
  end if;
  v_expected_relationship_hash := public.erp_cloud_restore_relationship_hash(p_snapshot);
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('inputValidation', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=input_validation event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'before_snapshot';
  raise log 'CLOUD_RESTORE_TIMING phase=before_snapshot event=start';
  v_before := public.erp_cloud_restore_snapshot();
  foreach v_table in array array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'
  ] loop
    v_before_counts := v_before_counts || jsonb_build_object(v_table, jsonb_array_length(v_before->v_table));
  end loop;
  v_before_fingerprint := encode(digest(convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex');
  v_before_manifest := jsonb_build_object(
    'schemaVersion', 'cloud-erp-snapshot-v1',
    'resourceCount', 15,
    'counts', v_before_counts,
    'totalRows', (select coalesce(sum(value::bigint), 0) from jsonb_each_text(v_before_counts)),
    'snapshotFingerprint', v_before_fingerprint,
    'relationshipHash', public.erp_cloud_restore_relationship_hash(v_before),
    'restoreSourceEnvironment', p_source_environment
  );
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('beforeSnapshot', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=before_snapshot event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'rollback_row';
  raise log 'CLOUD_RESTORE_TIMING phase=rollback_row event=start';
  insert into public.erp_cloud_restore_snapshots(actor_id,source_environment,snapshot_fingerprint,manifest,snapshot)
  values(
    v_actor,
    coalesce(nullif(current_setting('request.headers', true), '')::jsonb->>'host', 'unknown'),
    v_before_fingerprint,
    v_before_manifest,
    v_before
  )
  returning id into v_rollback_id;
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('rollbackRow', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=rollback_row event=complete duration_ms=%', v_phase_ms;

  perform set_config('erp.cloud_restore_active','on',true);
  v_phase_started_at := clock_timestamp();
  v_current_phase := 'delete';
  raise log 'CLOUD_RESTORE_TIMING phase=delete event=start';
  delete from public.outbound_shipment_items;
  delete from public.outbound_shipments;
  delete from public.japan_package_items;
  delete from public.japan_packages;
  delete from public.private_order_items;
  delete from public.purchase_batch_items;
  delete from public.sales_order_items;
  delete from public.bundle_components;
  delete from public.private_orders;
  delete from public.purchase_batches;
  delete from public.product_variants;
  delete from public.product_categories;
  delete from public.sales_orders;
  delete from public.product_groups;
  delete from public.inventory_items;
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('delete', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=delete event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'insert';
  raise log 'CLOUD_RESTORE_TIMING phase=insert event=start';
  perform public.erp_cloud_restore_insert_rows('public.inventory_items', p_snapshot->'inventory_items');
  perform public.erp_cloud_restore_insert_rows('public.product_groups', p_snapshot->'product_groups');
  perform public.erp_cloud_restore_insert_rows('public.product_categories', p_snapshot->'product_categories');
  perform public.erp_cloud_restore_insert_rows('public.product_variants', p_snapshot->'product_variants');
  perform public.erp_cloud_restore_insert_rows('public.bundle_components', p_snapshot->'bundle_components');
  perform public.erp_cloud_restore_insert_rows('public.purchase_batches', p_snapshot->'purchase_batches');
  perform public.erp_cloud_restore_insert_rows('public.purchase_batch_items', p_snapshot->'purchase_batch_items');
  perform public.erp_cloud_restore_insert_rows('public.private_orders', p_snapshot->'private_orders');
  perform public.erp_cloud_restore_insert_rows('public.private_order_items', p_snapshot->'private_order_items');
  perform public.erp_cloud_restore_insert_rows('public.sales_orders', p_snapshot->'sales_orders');
  perform public.erp_cloud_restore_insert_rows('public.sales_order_items', p_snapshot->'sales_order_items');
  perform public.erp_cloud_restore_insert_rows('public.japan_packages', p_snapshot->'japan_packages');
  perform public.erp_cloud_restore_insert_rows('public.japan_package_items', p_snapshot->'japan_package_items');
  perform public.erp_cloud_restore_insert_rows('public.outbound_shipments', p_snapshot->'outbound_shipments');
  perform public.erp_cloud_restore_insert_rows('public.outbound_shipment_items', p_snapshot->'outbound_shipment_items');
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('insert', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=insert event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'integrity';
  raise log 'CLOUD_RESTORE_TIMING phase=integrity event=start';
  foreach v_table in array array[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'
  ] loop
    v_actual_profile := public.erp_cloud_restore_table_profile(format('public.%I', v_table)::regclass, null::jsonb);
    v_expected_profile := v_expected_profiles->v_table;
    if (v_actual_profile->>'count')::bigint <> (v_expected_profile->>'count')::bigint then
      raise exception using errcode = '23000', message = 'CLOUD_RESTORE_POST_INTEGRITY_COUNT_MISMATCH:' || v_table;
    end if;
    if v_actual_profile->>'identityHash' is distinct from v_expected_profile->>'identityHash' then
      raise exception using errcode = '23000', message = 'CLOUD_RESTORE_POST_INTEGRITY_IDENTITY_HASH_MISMATCH:' || v_table;
    end if;
  end loop;

  if exists (
    select 1 from public.product_variants v left join public.product_groups g on g.id=v.product_group_id where g.id is null
    union all select 1 from public.purchase_batch_items i left join public.purchase_batches b on b.id=i.purchase_batch_id where b.id is null
    union all select 1 from public.private_order_items i left join public.private_orders o on o.id=i.private_order_id where o.id is null
    union all select 1 from public.sales_order_items i left join public.sales_orders o on o.id=i.order_id where o.id is null
    union all select 1 from public.japan_package_items i left join public.japan_packages p on p.id=i.japan_package_id where p.id is null
    union all select 1 from public.outbound_shipment_items i left join public.outbound_shipments s on s.id=i.outbound_shipment_id where s.id is null
  ) then raise exception using errcode = '23503', message = 'CLOUD_RESTORE_POST_INTEGRITY_ORPHAN'; end if;
  v_actual_relationship_hash := public.erp_cloud_restore_live_relationship_hash();
  if v_actual_relationship_hash <> v_expected_relationship_hash then
    raise exception using errcode = '23000', message = 'CLOUD_RESTORE_POST_INTEGRITY_RELATIONSHIP_HASH_MISMATCH';
  end if;
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('integrity', v_phase_ms);
  raise log 'CLOUD_RESTORE_TIMING phase=integrity event=complete duration_ms=%', v_phase_ms;

  v_phase_started_at := clock_timestamp();
  v_current_phase := 'epoch_idempotency';
  raise log 'CLOUD_RESTORE_TIMING phase=epoch_idempotency event=start';
  update public.erp_cloud_restore_epoch
     set epoch=epoch+1, restored_at=now(), restored_by=v_actor, snapshot_fingerprint=v_server_fingerprint
   where singleton=true returning epoch into v_epoch;
  v_result := jsonb_build_object(
    'ok',true,'replayed',false,'idempotencyKey',p_idempotency_key,
    'snapshotFingerprint',p_snapshot_fingerprint,'serverSnapshotFingerprint',v_server_fingerprint,'rollbackSnapshotId',v_rollback_id,
    'restoreEpoch',v_epoch,'manifest',p_manifest,'serverRelationshipHash',v_actual_relationship_hash,
    'timingsMs',v_phase_timings
  );
  update public.erp_cloud_restore_requests set status='completed',rollback_snapshot_id=v_rollback_id,
    canonical_result=v_result,completed_at=now()
   where actor_id=v_actor and idempotency_key=p_idempotency_key;
  v_phase_ms := (extract(epoch from clock_timestamp() - v_phase_started_at) * 1000)::bigint;
  v_phase_timings := v_phase_timings || jsonb_build_object('epochIdempotency', v_phase_ms);
  v_phase_timings := v_phase_timings || jsonb_build_object(
    'total', (extract(epoch from clock_timestamp() - v_started_at) * 1000)::bigint
  );
  v_result := jsonb_set(v_result, '{timingsMs}', v_phase_timings, true);
  update public.erp_cloud_restore_requests
     set canonical_result=v_result
   where actor_id=v_actor and idempotency_key=p_idempotency_key;
  raise log 'CLOUD_RESTORE_TIMING phase=epoch_idempotency event=complete duration_ms=% total_ms=%',
    v_phase_ms, v_phase_timings->>'total';
  return v_result;
exception
  when query_canceled then
    raise log 'CLOUD_RESTORE_TIMING phase=failure failed_phase=% classification=statement_timeout sqlstate=% total_ms=%',
      v_current_phase, sqlstate, (extract(epoch from clock_timestamp() - v_started_at) * 1000)::bigint;
    raise;
  when others then
    raise log 'CLOUD_RESTORE_TIMING phase=failure failed_phase=% classification=error sqlstate=% total_ms=%',
      v_current_phase, sqlstate, (extract(epoch from clock_timestamp() - v_started_at) * 1000)::bigint;
    raise;
end;
$$;

revoke all on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) from public, anon;
grant execute on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) to authenticated;

commit;
