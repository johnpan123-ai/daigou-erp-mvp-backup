begin;

-- 074: minimal safeupdate compatibility repair. Candidate only; live apply requires Owner approval.
-- Replaces only the existing counted RPC. No business DML, schema/ACL expansion or recognition changes.
create or replace function public.erp_commit_waca_counted_snapshot(
  p_snapshot jsonb, p_expected_revision bigint, p_plan jsonb
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '120s'
as $$
declare
  v_actor uuid := auth.uid();
  v_revision bigint; v_mode text; v_payload jsonb; v_driven boolean; v_first boolean;
  v_epoch bigint; v_restored_at timestamptz; v_epoch_fp text; v_transition jsonb;
  v_row jsonb; v_overwrite uuid[] := '{}'; v_id uuid; v_bad text;
  v_effective integer; v_total integer; v_unmatched integer; v_status text;
  v_state_rows bigint;
  v_now timestamptz := now();
  v_checked_at text := to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  if v_actor is null or not public.is_owner(v_actor) then
    raise exception using errcode='42501',message='WACA_OWNER_REQUIRED';
  end if;
  if jsonb_typeof(p_plan) is distinct from 'object' or p_plan->>'contract' is distinct from 'waca-counted-import-v1'
     or jsonb_typeof(p_plan->'overwriteVariantIds') is distinct from 'array'
     or jsonb_typeof(p_plan->'expectedDisplay') is distinct from 'object'
     or (p_plan->>'restoreEpoch') !~ '^[0-9]+$' then
    raise exception using errcode='22023',message='WACA_COUNTED_PLAN_INVALID';
  end if;
  if jsonb_typeof(p_snapshot) is distinct from 'object' or jsonb_typeof(p_snapshot->'items') is distinct from 'array' then
    raise exception using errcode='22023',message='WACA_SNAPSHOT_INVALID';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) then
    raise exception using errcode='55006',message='CLOUD_RESTORE_MAINTENANCE_LOCKED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('erp-waca-ledger-import',0));

  select revision,mode,payload into v_revision,v_mode,v_payload from public.waca_state for update;
  v_revision := coalesce(v_revision,0); v_mode := coalesce(v_mode,'LEGACY_QUANTITY_ACTIVE');
  v_payload := coalesce(v_payload,'{}'::jsonb);
  if v_revision <> p_expected_revision then
    raise exception using errcode='40001',message='WACA_STALE_REVISION';
  end if;
  select e.epoch,e.restored_at,e.snapshot_fingerprint into v_epoch,v_restored_at,v_epoch_fp
    from public.erp_cloud_restore_epoch e where e.singleton;
  if (p_plan->>'restoreEpoch')::bigint is distinct from coalesce(v_epoch,0) then
    raise exception using errcode='40001',message='WACA_RESTORE_EPOCH_CHANGED';
  end if;
  v_driven := v_mode = 'ORDER_DRIVEN_ACTIVE';
  v_first := not v_driven;

  -- Every submitted item must declare a valid counted quantity.
  select coalesce(value->>'key','?') into v_bad from jsonb_array_elements(p_snapshot->'items')
   where coalesce(value->>'countedQuantity','') !~ '^[0-9]+$' limit 1;
  if found then raise exception using errcode='22023',message='WACA_COUNTED_QUANTITY_INVALID',detail=v_bad; end if;

  for v_row in select value from jsonb_array_elements(p_plan->'overwriteVariantIds') loop
    v_id := public.erp_waca_variant_id(v_row#>>'{}');
    v_overwrite := array_append(v_overwrite, v_id);
  end loop;

  create temporary table _waca_counted_before on commit drop as
    select i.product_variant_id variant_id,
      sum(case when o.status in ('處理中','完成付款') then i.quantity else 0 end)::integer q,
      sum(coalesce((i.payload->>'countedQuantity')::integer,
        case when v_driven and o.status in ('處理中','完成付款') then i.quantity else 0 end))::integer c
    from public.waca_order_items i join public.waca_orders o on o.id=i.order_id
    where i.product_variant_id is not null group by i.product_variant_id;
  create temporary table _waca_variant_before on commit drop as
    select v.id, v.waca_auto_quantity auto_q, v.waca_manual_adjustment manual_q,
      v.myacg_item_code, v.product_title, v.variant_name, v.local_id
    from public.product_variants v;

  -- Ledger upsert through the existing, unchanged RPC (no quantity update, mode preserved).
  perform public.erp_commit_waca_snapshot(p_snapshot, p_expected_revision, false);

  create temporary table _waca_counted_after on commit drop as
    select i.product_variant_id variant_id,
      sum(case when o.status in ('處理中','完成付款') then i.quantity else 0 end)::integer q,
      sum(coalesce((i.payload->>'countedQuantity')::integer,
        case when v_driven and o.status in ('處理中','完成付款') then i.quantity else 0 end))::integer c,
      bool_and(coalesce((i.payload->>'countedQuantity')::integer, -1)
        = case when o.status in ('處理中','完成付款') then i.quantity else 0 end) fully_counted
    from public.waca_order_items i join public.waca_orders o on o.id=i.order_id
    where i.product_variant_id is not null group by i.product_variant_id;

  if exists(select 1 from unnest(v_overwrite) w left join _waca_counted_after a on a.variant_id=w
            where a.variant_id is not null and not a.fully_counted) then
    raise exception using errcode='23000',message='WACA_OVERWRITE_NOT_FULLY_COUNTED';
  end if;

  create temporary table _waca_counted_plan on commit drop as
    select b.id variant_id, b.auto_q, b.manual_q, b.auto_q+b.manual_q display_before,
      coalesce(a.q,0) auto_after,
      case when b.id = any(v_overwrite) then 0
        else b.auto_q+b.manual_q+coalesce(a.c,0)-coalesce(cb.c,0)-coalesce(a.q,0) end manual_after
    from _waca_variant_before b
    left join _waca_counted_after a on a.variant_id=b.id
    left join _waca_counted_before cb on cb.variant_id=b.id;

  -- A counted import can never produce a negative WACA demand: the Purchase Records clamp at 0 must not
  -- be able to hide an anomaly written here (history >= 0 and every countedQuantity >= 0 by construction).
  select p.variant_id::text into v_bad from _waca_counted_plan p
   where (p.auto_after <> p.auto_q or p.manual_after <> p.manual_q) and p.auto_after + p.manual_after < 0 limit 1;
  if found then raise exception using errcode='23514',message='WACA_COUNTED_NEGATIVE_DISPLAY',detail=v_bad; end if;

  -- Fail closed unless every changing variant matches the reviewed preview exactly.
  select p.variant_id::text into v_bad from _waca_counted_plan p
   where (p.auto_after <> p.auto_q or p.manual_after <> p.manual_q or p.variant_id = any(v_overwrite))
     and (p_plan->'expectedDisplay'->(p.variant_id::text) is null
       or (p_plan->'expectedDisplay'->(p.variant_id::text)->>'before')::integer is distinct from p.display_before
       or (p_plan->'expectedDisplay'->(p.variant_id::text)->>'after')::integer is distinct from p.auto_after+p.manual_after)
   limit 1;
  if found then raise exception using errcode='40001',message='WACA_COUNTED_PREVIEW_MISMATCH',detail=v_bad; end if;

  if v_first then
    insert into public.waca_cutover_audit(product_variant_id,payload,updated_by)
    select p.variant_id,jsonb_build_object(
      'productVariantId',coalesce(v.local_id,p.variant_id::text),
      'sku',v.myacg_item_code,'productTitle',v.product_title,'variantTitle',v.variant_name,
      'legacyWacaQuantity',p.display_before,'legacyAutoQuantity',p.auto_q,
      'unverifiedPreCutoverManualQuantity',p.manual_q,
      'newOrderDerivedQuantity',p.auto_after,'difference',p.auto_after-p.display_before,
      'cutoverAt',v_checked_at,'transition','counted-v1'),v_actor
    from _waca_counted_plan p join _waca_variant_before v on v.id=p.variant_id
    on conflict(product_variant_id) do nothing;
  end if;

  update public.product_variants v set waca_auto_quantity=p.auto_after, waca_manual_adjustment=p.manual_after,
    updated_at=v_now, updated_by=v_actor, version=v.version+1
  from _waca_counted_plan p
  where p.variant_id=v.id and (p.auto_after<>p.auto_q or p.manual_after<>p.manual_q);

  if exists(select 1 from public.product_variants v left join (
      select i.product_variant_id,sum(i.quantity)::integer quantity
      from public.waca_order_items i join public.waca_orders o on o.id=i.order_id
      where i.product_variant_id is not null and o.status in ('處理中','完成付款')
      group by i.product_variant_id) q on q.product_variant_id=v.id
    where v.waca_auto_quantity is distinct from coalesce(q.quantity,0)) then
    raise exception using errcode='23000',message='WACA_RECONCILIATION_FAILED';
  end if;

  select coalesce(sum(i.quantity),0)::integer into v_effective
    from public.waca_order_items i join public.waca_orders o on o.id=i.order_id where o.status in ('處理中','完成付款');
  select count(distinct feature)::integer into v_total from public.waca_order_items where product_variant_id is not null;
  select count(distinct i.feature)::integer into v_unmatched
    from public.waca_order_items i join public.waca_orders o on o.id=i.order_id
    where i.product_variant_id is null and i.quantity>0 and o.status in ('處理中','完成付款');
  v_status := case when v_unmatched=0 then 'PASS' else 'FAIL' end;
  update public.waca_import_batches b set
    payload=b.payload || jsonb_build_object('reconciliation',jsonb_build_object(
      'status',v_status,'passed',v_total,'total',v_total+v_unmatched,'effectiveQuantity',v_effective,'checkedAt',v_checked_at)),
    updated_at=v_now
    where b.batch_key in (select value->>'id' from jsonb_array_elements(coalesce(p_snapshot->'batches','[]'::jsonb)));

  v_transition := case when v_first then jsonb_build_object(
      'contract','waca-counted-import-v1','restoreEpoch',coalesce(v_epoch,0),
      'baselineAt',to_char(coalesce(v_restored_at,v_now) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'restoreSnapshotFingerprint',v_epoch_fp,'previousMode',v_mode,'establishedAt',v_checked_at)
    else v_payload->'transition' end;
  update public.waca_state set mode='ORDER_DRIVEN_ACTIVE',
    payload=jsonb_build_object('mode','ORDER_DRIVEN_ACTIVE','updatedAt',v_checked_at,
      'sourceBackupFormatVersion',p_snapshot->'cutoverState'->'sourceBackupFormatVersion')
      || case when v_transition is null then '{}'::jsonb else jsonb_build_object('transition',v_transition) end,
    updated_at=v_now, updated_by=v_actor
    where id='00000000-0000-4000-8000-000000000001'::uuid and revision=v_revision+1;
  get diagnostics v_state_rows = row_count;
  if v_state_rows <> 1 then
    raise exception using errcode='23514',message='WACA_COUNTED_STATE_UPDATE_MISMATCH';
  end if;

  return jsonb_build_object('revision',v_revision+1,'reconciliation',v_status,'effectiveQuantity',v_effective,
    'unmatchedFeatures',v_unmatched,'transitionEstablished',v_first,'transition',v_transition);
end;
$$;
revoke all on function public.erp_commit_waca_counted_snapshot(jsonb,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.erp_commit_waca_counted_snapshot(jsonb,bigint,jsonb) to authenticated;

commit;
