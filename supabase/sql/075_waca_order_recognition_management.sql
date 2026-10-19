begin;

-- Candidate ONLY. No business DML at adoption. Evidence uses existing, backed-up
-- item payloads and import batches; no new table, column, or backup resource.
-- The reviewed 044/074 implementations remain private delegates, unchanged.
alter function public.erp_commit_waca_snapshot(jsonb,bigint,boolean) rename to erp_commit_waca_snapshot_v044;
alter function public.erp_commit_waca_counted_snapshot(jsonb,bigint,jsonb) rename to erp_commit_waca_counted_snapshot_v074;
revoke all on function public.erp_commit_waca_snapshot_v044(jsonb,bigint,boolean) from public,anon,authenticated;
revoke all on function public.erp_commit_waca_counted_snapshot_v074(jsonb,bigint,jsonb) from public,anon,authenticated;

-- A current controlled quantity receipt is required, not just a counted flag.
-- Any intervening manual/other Variant edit invalidates this conservative proof.
create function public.erp_waca_reversal_keys(p_variant uuid,p_epoch bigint) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select coalesce((select case
    when a.payload->'recognitionContinuity' is not null then
      case when (a.payload->'recognitionContinuity'->>'epoch')::bigint=p_epoch
        and (a.payload->'recognitionContinuity'->>'version')::bigint=v.version
        and (a.payload->'recognitionContinuity'->>'auto')::integer=v.waca_auto_quantity
        and (a.payload->'recognitionContinuity'->>'manual')::integer=v.waca_manual_adjustment
        then a.payload->'recognitionContinuity'->'itemKeys' else '[]'::jsonb end
    -- Bootstrap is deliberately narrower than a latest aggregate receipt: only
    -- lines created in that very controlled import have proven extra credit.
    when exists(
    select 1 from public.product_variants v join public.waca_import_batches b on b.updated_at=v.updated_at
    where v.id=p_variant and (
      exists(select 1 from jsonb_array_elements(coalesce(b.payload->'transition'->'variants','[]')) x
        where b.payload->'transition'->>'restoreEpoch'=p_epoch::text
          and x->>'variantId'=v.id::text and x->>'mode'='ACCUMULATE'
          and (x->>'after')::integer=v.waca_auto_quantity+v.waca_manual_adjustment
          and (x->>'after')::integer=(x->>'before')::integer+(x->>'countedDelta')::integer)
    )) then coalesce((select jsonb_agg(i.item_key order by i.item_key) from public.waca_order_items i
      where i.product_variant_id=v.id and i.created_at=v.updated_at
        and coalesce((i.payload->>'countedQuantity')::integer,0)>0
        and i.payload->>'countedReason' in ('NORMAL_IMPORT','OWNER_CONFIRMED_NEW')), '[]'::jsonb)
    else '[]'::jsonb end from public.product_variants v left join public.waca_cutover_audit a on a.product_variant_id=v.id
      where v.id=p_variant),'[]'::jsonb)
$$;
revoke all on function public.erp_waca_reversal_keys(uuid,bigint) from public,anon,authenticated;
create function public.erp_waca_reversal_proven(p_variant uuid,p_epoch bigint,p_item text) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select public.erp_waca_reversal_keys(p_variant,p_epoch) ? p_item
$$;
revoke all on function public.erp_waca_reversal_proven(uuid,bigint,text) from public,anon,authenticated;

create function public.erp_store_waca_recognition_continuity(p_variant uuid,p_epoch bigint,p_keys jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v public.product_variants%rowtype; n bigint;
begin
  select * into v from public.product_variants where id=p_variant;
  insert into public.waca_cutover_audit(product_variant_id,payload,updated_by)
  values(v.id,jsonb_build_object('productVariantId',v.id,'sku',v.myacg_item_code,'productTitle',v.product_title,
    'variantTitle',v.variant_name,'legacyWacaQuantity',v.waca_auto_quantity+v.waca_manual_adjustment,
    'legacyAutoQuantity',v.waca_auto_quantity,'unverifiedPreCutoverManualQuantity',v.waca_manual_adjustment,
    'newOrderDerivedQuantity',v.waca_auto_quantity,'difference',0,'cutoverAt',now()),auth.uid())
    on conflict(product_variant_id) do nothing;
  update public.waca_cutover_audit set payload=payload||jsonb_build_object('recognitionContinuity',jsonb_build_object(
    'epoch',p_epoch,'version',v.version,'auto',v.waca_auto_quantity,'manual',v.waca_manual_adjustment,'itemKeys',p_keys)),
    updated_at=now(),updated_by=auth.uid() where product_variant_id=p_variant;
  get diagnostics n=row_count;
  if n<>1 then raise exception using errcode='23514',message='WACA_RECOGNITION_PROOF_UPDATE_MISMATCH'; end if;
end;
$$;
revoke all on function public.erp_store_waca_recognition_continuity(uuid,bigint,jsonb) from public,anon,authenticated;

-- Existing imports may update source facts, but never replace Owner decisions
-- or immutable management receipts. The sole decision writer is the new RPC.
create function public.erp_assert_waca_recognition_preserved(p_snapshot jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r jsonb; old_batch jsonb; old_item public.waca_order_items%rowtype; q integer; epoch bigint;
begin
  select e.epoch into epoch from public.erp_cloud_restore_epoch e where singleton;
  for r in select value from jsonb_array_elements(coalesce(p_snapshot->'items','[]')) loop
    select * into old_item from public.waca_order_items where item_key=r->>'key';
    if (r->'recognition') is distinct from (old_item.payload->'recognition') then
      raise exception using errcode='23000',message='WACA_OWNER_DECISION_IMMUTABLE';
    end if;
    if old_item.payload->'recognition' is not null then
      if r->>'orderKey' is distinct from old_item.payload->>'orderKey'
        or public.erp_waca_variant_id(r->>'productVariantId') is distinct from old_item.product_variant_id then
        raise exception using errcode='23000',message='WACA_MANAGED_IDENTITY_CHANGED';
      end if;
      select case when coalesce((select o->>'status' from jsonb_array_elements(coalesce(p_snapshot->'orders','[]')) o
          where o->>'key'=r->>'orderKey'),(select status from public.waca_orders where id=old_item.order_id))
          in ('處理中','完成付款') then (r->>'quantity')::integer else 0 end into q;
      if old_item.payload->'recognition'->>'mode'='COUNT'
        and (r->>'countedQuantity')::integer is distinct from (old_item.payload->>'countedQuantity')::integer
        and (old_item.payload->'recognition'->>'restoreEpoch')::bigint is distinct from epoch then
        raise exception using errcode='23000',message='WACA_MANAGED_RESTORE_REVIEW_REQUIRED';
      end if;
      if old_item.payload->'recognition'->>'mode' in ('INCLUDED','HOLD') and (r->>'countedQuantity')::integer<>0
        or old_item.payload->'recognition'->>'mode'='COUNT' and (r->>'countedQuantity')::integer not in
          (q,(old_item.payload->>'countedQuantity')::integer) then
        raise exception using errcode='23000',message='WACA_OWNER_DECISION_CONFLICT';
      end if;
      if old_item.payload->'recognition'->>'mode'='INCLUDED' and r->>'countedReason' is distinct from 'BASELINE_INCLUDED'
        or old_item.payload->'recognition'->>'mode'='HOLD' and r->>'countedReason' is distinct from 'PENDING_REVIEW'
        or old_item.payload->'recognition'->>'mode'='COUNT' and coalesce(r->>'countedReason','') not in ('OWNER_CONFIRMED_NEW','SOURCE_CHANGE_APPLIED') then
        raise exception using errcode='23000',message='WACA_OWNER_DECISION_CONFLICT';
      end if;
      if (r->>'countedQuantity')::integer < (old_item.payload->>'countedQuantity')::integer
        and not public.erp_waca_reversal_proven(old_item.product_variant_id,epoch,old_item.item_key) then
        raise exception using errcode='23000',message='WACA_REVERSAL_PROOF_REQUIRED';
      end if;
    end if;
  end loop;
  for r in select value from jsonb_array_elements(coalesce(p_snapshot->'batches','[]')) loop
    select b.payload into old_batch from public.waca_import_batches b where b.batch_key=r->>'id';
    if (r->'recognition' is not null or old_batch->'recognition' is not null) and r is distinct from old_batch then
      raise exception using errcode='23000',message='WACA_RECOGNITION_RECEIPT_IMMUTABLE';
    end if;
  end loop;
  for r in select value from jsonb_array_elements(coalesce(p_snapshot->'cutoverAudit','[]')) loop
    if (r->'recognitionContinuity') is distinct from (select a.payload->'recognitionContinuity' from public.waca_cutover_audit a
      where a.product_variant_id=public.erp_waca_variant_id(r->>'productVariantId')) then
      raise exception using errcode='23000',message='WACA_RECOGNITION_PROOF_IMMUTABLE';
    end if;
  end loop;
end;
$$;
revoke all on function public.erp_assert_waca_recognition_preserved(jsonb) from public,anon,authenticated;

-- Legacy metadata callers can submit a complete snapshot. Identical history is
-- accepted but NOT upserted, so its immutable receipt/timestamp is preserved.
create function public.erp_prune_waca_recognition_evidence(p_snapshot jsonb) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select case when jsonb_typeof(p_snapshot->'batches')='array' and jsonb_typeof(p_snapshot->'cutoverAudit')='array' then
    jsonb_set(jsonb_set(p_snapshot,'{batches}',coalesce((select jsonb_agg(r order by ord) from jsonb_array_elements(p_snapshot->'batches') with ordinality x(r,ord)
      where not exists(select 1 from public.waca_import_batches b where b.batch_key=r->>'id' and b.payload=r)),'[]'::jsonb)),
      '{cutoverAudit}',coalesce((select jsonb_agg(r order by ord) from jsonb_array_elements(p_snapshot->'cutoverAudit') with ordinality x(r,ord)
        where not exists(select 1 from public.waca_cutover_audit a where a.product_variant_id=public.erp_waca_variant_id(r->>'productVariantId')
          and a.payload-'productVariantId'=r-'productVariantId')),'[]'::jsonb))
    else p_snapshot end
$$;
revoke all on function public.erp_prune_waca_recognition_evidence(jsonb) from public,anon,authenticated;

create function public.erp_commit_waca_snapshot(p_snapshot jsonb,p_expected_revision bigint,p_update_auto_quantity boolean)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,public,extensions set statement_timeout='120s' as $$
begin
  if auth.uid() is null or not public.is_owner(auth.uid()) then raise exception using errcode='42501',message='WACA_OWNER_REQUIRED'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) then
    raise exception using errcode='55006',message='CLOUD_RESTORE_MAINTENANCE_LOCKED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('erp-waca-ledger-import',0));
  perform public.erp_assert_waca_recognition_preserved(p_snapshot);
  -- A managed ledger may not start a legacy merge from an already inconsistent
  -- source/auto projection. Do not let unrelated metadata writes hide drift.
  if exists(select 1 from public.product_variants v where exists(select 1 from public.waca_order_items m
      where m.product_variant_id=v.id and m.payload->'recognition' is not null)
    and v.waca_auto_quantity is distinct from (select coalesce(sum(i.quantity) filter(where o.status in ('處理中','完成付款')),0)::integer
      from public.waca_order_items i join public.waca_orders o on o.id=i.order_id where i.product_variant_id=v.id)) then
    raise exception using errcode='23000',message='WACA_MANAGED_LEDGER_DRIFT';
  end if;
  if p_update_auto_quantity and exists(select 1 from public.waca_order_items where payload->'recognition' is not null) then
    raise exception using errcode='23000',message='WACA_MANAGED_LEGACY_QUANTITY_DISABLED';
  end if;
  return public.erp_commit_waca_snapshot_v044(public.erp_prune_waca_recognition_evidence(p_snapshot),p_expected_revision,p_update_auto_quantity);
end;
$$;
revoke all on function public.erp_commit_waca_snapshot(jsonb,bigint,boolean) from public,anon,authenticated;
grant execute on function public.erp_commit_waca_snapshot(jsonb,bigint,boolean) to authenticated;

create function public.erp_commit_waca_counted_snapshot(p_snapshot jsonb,p_expected_revision bigint,p_plan jsonb)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,public,extensions set statement_timeout='120s' as $$
declare result jsonb; clean jsonb; epoch bigint; v record; keys jsonb;
begin
  if auth.uid() is null or not public.is_owner(auth.uid()) then raise exception using errcode='42501',message='WACA_OWNER_REQUIRED'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) then
    raise exception using errcode='55006',message='CLOUD_RESTORE_MAINTENANCE_LOCKED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('erp-waca-ledger-import',0));
  perform public.erp_assert_waca_recognition_preserved(p_snapshot);
  select e.epoch into epoch from public.erp_cloud_restore_epoch e where singleton;
  -- Preserve a line's credit only across an unbroken controlled-write chain.
  -- A manual edit invalidates old credits permanently; a later import must NOT
  -- launder them into a new "safe" receipt.
  perform 1 from public.product_variants pv where pv.id in (
    select public.erp_waca_variant_id(k) from jsonb_object_keys(p_plan->'expectedDisplay') k
  ) order by pv.id for update;
  create temporary table _waca_recognition_credits on commit drop as
    select pv.id,pv.version,public.erp_waca_reversal_keys(pv.id,epoch) keys,
      coalesce((select jsonb_object_agg(i.item_key,coalesce((i.payload->>'countedQuantity')::integer,0))
        from public.waca_order_items i where i.product_variant_id=pv.id),'{}'::jsonb) counts
    from public.product_variants pv where pv.id in (
      select public.erp_waca_variant_id(k) from jsonb_object_keys(p_plan->'expectedDisplay') k);
  clean:=public.erp_prune_waca_recognition_evidence(p_snapshot);
  result:=public.erp_commit_waca_counted_snapshot_v074(clean,p_expected_revision,p_plan);
  for v in select pv.*,c.keys,c.counts from public.product_variants pv join _waca_recognition_credits c on c.id=pv.id
    where pv.version<>c.version loop
    if exists(select 1 from jsonb_array_elements(p_plan->'overwriteVariantIds') x where public.erp_waca_variant_id(x#>>'{}')=v.id) then keys:='[]'::jsonb;
    else
      select coalesce(jsonb_agg(i.item_key order by i.item_key),'[]'::jsonb) into keys from public.waca_order_items i
        where i.product_variant_id=v.id and coalesce((i.payload->>'countedQuantity')::integer,0)>0
          and (v.keys ? i.item_key or coalesce((v.counts->>i.item_key)::integer,0)=0);
    end if;
    perform public.erp_store_waca_recognition_continuity(v.id,epoch,keys);
  end loop;
  return result;
end;
$$;
revoke all on function public.erp_commit_waca_counted_snapshot(jsonb,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.erp_commit_waca_counted_snapshot(jsonb,bigint,jsonb) to authenticated;

create function public.erp_plan_waca_recognition(p_request jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,extensions as $$
declare
  actor uuid:=auth.uid(); revision bigint; epoch bigint; driven boolean; choice jsonb;
  i public.waca_order_items%rowtype; o public.waca_orders%rowtype; v public.product_variants%rowtype;
  before_q integer; after_q integer; source_q integer; old_mode text; mode text;
  lines jsonb:='[]'; quantities jsonb:='[]'; delta integer; ledger_q integer; request_hash text;
begin
  if actor is null or not public.is_owner(actor) then raise exception using errcode='42501',message='WACA_OWNER_REQUIRED'; end if;
  if jsonb_typeof(p_request) is distinct from 'object'
    or coalesce(p_request->>'requestId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_request->>'revision','') !~ '^[0-9]+$' or coalesce(p_request->>'restoreEpoch','') !~ '^[0-9]+$'
    or length(btrim(coalesce(p_request->>'reason','')))=0 or length(p_request->>'reason')>500
    or jsonb_typeof(p_request->'choices') is distinct from 'array' then
    raise exception using errcode='22023',message='WACA_RECOGNITION_REQUEST_INVALID';
  end if;
  if jsonb_array_length(p_request->'choices') not between 1 and 500
    or (select count(distinct c->>'itemKey') from jsonb_array_elements(p_request->'choices') c)
      <>jsonb_array_length(p_request->'choices') then
    raise exception using errcode='22023',message='WACA_RECOGNITION_CHOICES_INVALID';
  end if;
  select s.revision,s.mode='ORDER_DRIVEN_ACTIVE' into revision,driven from public.waca_state s
    where id='00000000-0000-4000-8000-000000000001';
  select e.epoch into epoch from public.erp_cloud_restore_epoch e where singleton;
  if revision is distinct from (p_request->>'revision')::bigint then raise exception using errcode='40001',message='WACA_STALE_REVISION'; end if;
  if epoch is distinct from (p_request->>'restoreEpoch')::bigint then raise exception using errcode='40001',message='WACA_RESTORE_EPOCH_CHANGED'; end if;
  if not coalesce(driven,false) then raise exception using errcode='23000',message='WACA_RECOGNITION_REQUIRES_COUNTED_LEDGER'; end if;
  request_hash:=encode(extensions.digest(p_request::text,'sha256'),'hex');
  for choice in select value from jsonb_array_elements(p_request->'choices') order by value->>'itemKey' loop
    mode:=choice->>'mode';
    if mode is null or mode not in ('COUNT','INCLUDED','HOLD') then raise exception using errcode='22023',message='WACA_RECOGNITION_MODE_INVALID'; end if;
    select * into i from public.waca_order_items where item_key=choice->>'itemKey';
    if not found then raise exception using errcode='23503',message='WACA_RECOGNITION_ITEM_MISSING'; end if;
    select * into o from public.waca_orders where id=i.order_id;
    if o.order_key is distinct from p_request->>'orderKey' or i.product_variant_id is null then
      raise exception using errcode='23000',message='WACA_RECOGNITION_IDENTITY_INVALID';
    end if;
    select * into v from public.product_variants where id=i.product_variant_id and deleted_at is null;
    if not found then raise exception using errcode='23503',message='WACA_RECOGNITION_VARIANT_MISSING'; end if;
    source_q:=case when o.status in ('處理中','完成付款') then i.quantity else 0 end;
    if mode='COUNT' and o.status not in ('處理中','完成付款') then
      raise exception using errcode='23000',message='WACA_INACTIVE_ORDER_NOT_COUNTABLE';
    end if;
    before_q:=coalesce((i.payload->>'countedQuantity')::integer,source_q);
    old_mode:=coalesce(i.payload->'recognition'->>'mode',case when i.payload->>'countedReason'='BASELINE_INCLUDED' then 'INCLUDED'
      when before_q>0 or i.payload->>'countedReason' in ('NORMAL_IMPORT','OWNER_CONFIRMED_NEW','SOURCE_CHANGE_APPLIED','OVERWRITE','LEGACY_COUNTED') then 'COUNT' else 'HOLD' end);
    after_q:=case when mode='COUNT' then source_q else 0 end;
    -- A same-setting/no-difference operation creates neither receipt nor revision.
    if old_mode=mode and before_q=after_q and (i.payload->>'countedReview' is null
      or mode='HOLD' and i.payload->>'countedReview'='OWNER_HOLD') then continue; end if;
    if before_q<0 or after_q<before_q and (
      coalesce(i.payload->>'countedReason','') not in ('NORMAL_IMPORT','OWNER_CONFIRMED_NEW','SOURCE_CHANGE_APPLIED')
      or not public.erp_waca_reversal_proven(v.id,epoch,i.item_key)) then
      raise exception using errcode='23000',message='WACA_REVERSAL_PROOF_REQUIRED',detail=i.item_key;
    end if;
    lines:=lines||jsonb_build_array(jsonb_build_object('itemKey',i.item_key,'orderKey',o.order_key,
      'variantId',v.id,'sku',v.myacg_item_code,'sourceQuantity',i.quantity,'sourceStatus',o.status,
      'beforeMode',old_mode,'mode',mode,'countedBefore',before_q,'countedAfter',after_q,'delta',after_q-before_q,
      'previousDecision',i.payload->'recognition','previousReason',i.payload->>'countedReason','previousCountedBy',i.payload->>'countedBy'));
  end loop;
  for v in select pv.* from public.product_variants pv where pv.id in
    (select (x->>'variantId')::uuid from jsonb_array_elements(lines) x) order by pv.id loop
    select sum((x->>'delta')::integer)::integer into delta from jsonb_array_elements(lines) x where x->>'variantId'=v.id::text;
    select coalesce(sum(i2.quantity) filter(where o2.status in ('處理中','完成付款')),0)::integer into ledger_q
      from public.waca_order_items i2 join public.waca_orders o2 on o2.id=i2.order_id where i2.product_variant_id=v.id;
    if ledger_q<>v.waca_auto_quantity then raise exception using errcode='23000',message='WACA_RECOGNITION_LEDGER_MISMATCH'; end if;
    if v.waca_auto_quantity+v.waca_manual_adjustment+delta<0 then raise exception using errcode='23514',message='WACA_COUNTED_NEGATIVE_DISPLAY'; end if;
    quantities:=quantities||jsonb_build_array(jsonb_build_object('variantId',v.id,'sku',v.myacg_item_code,'version',v.version,
      'autoBefore',v.waca_auto_quantity,'manualBefore',v.waca_manual_adjustment,
      'before',v.waca_auto_quantity+v.waca_manual_adjustment,'after',v.waca_auto_quantity+v.waca_manual_adjustment+delta,'delta',delta,
      'reversibleItemKeys',public.erp_waca_reversal_keys(v.id,epoch)));
  end loop;
  return jsonb_build_object('contract','waca-recognition-v1','requestId',p_request->>'requestId','requestHash',request_hash,
    'revision',revision,'restoreEpoch',epoch,'orderKey',p_request->>'orderKey','reason',p_request->>'reason','lines',lines,'quantities',quantities);
end;
$$;
revoke all on function public.erp_plan_waca_recognition(jsonb) from public,anon,authenticated;

create function public.erp_preview_waca_recognition(p_request jsonb) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select public.erp_plan_waca_recognition(p_request)
$$;
revoke all on function public.erp_preview_waca_recognition(jsonb) from public,anon,authenticated;
grant execute on function public.erp_preview_waca_recognition(jsonb) to authenticated;

create function public.erp_commit_waca_recognition(p_request jsonb,p_expected_plan jsonb) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,public,extensions set statement_timeout='15s' as $$
declare
  actor uuid:=auth.uid(); plan jsonb; prior jsonb; line jsonb; qty jsonb; n bigint; epoch bigint;
  evidence jsonb:='[]'; result jsonb; keys jsonb; now_at timestamptz:=now(); v public.product_variants%rowtype;
begin
  if actor is null or not public.is_owner(actor) then raise exception using errcode='42501',message='WACA_OWNER_REQUIRED'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) then
    raise exception using errcode='55006',message='CLOUD_RESTORE_MAINTENANCE_LOCKED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('erp-waca-ledger-import',0));
  perform 1 from public.waca_state where id='00000000-0000-4000-8000-000000000001' for update;
  select e.epoch into epoch from public.erp_cloud_restore_epoch e where singleton;
  if epoch is distinct from (p_request->>'restoreEpoch')::bigint then raise exception using errcode='40001',message='WACA_RESTORE_EPOCH_CHANGED'; end if;
  select b.payload->'recognition' into prior from public.waca_import_batches b where b.batch_key=p_request->>'requestId';
  if found then
    if prior->'request' is distinct from p_request or prior->'plan' is distinct from p_expected_plan or prior->>'actor' is distinct from actor::text then
      raise exception using errcode='23000',message='WACA_RECOGNITION_REQUEST_REUSED'; end if;
    return prior->'result';
  end if;
  -- Lock target variants before re-planning so another manual writer cannot race the proof/CAS.
  perform 1 from public.product_variants pv where pv.id in
    (select i.product_variant_id from public.waca_order_items i join jsonb_array_elements(p_request->'choices') c
      on i.item_key=c->>'itemKey') order by pv.id for update;
  plan:=public.erp_plan_waca_recognition(p_request);
  if plan is distinct from p_expected_plan then raise exception using errcode='40001',message='WACA_RECOGNITION_PREVIEW_CHANGED'; end if;
  if jsonb_array_length(plan->'lines')=0 then return jsonb_build_object('status','NO_CHANGE','revision',(plan->>'revision')::bigint,'requestId',plan->>'requestId'); end if;
  for line in select value from jsonb_array_elements(plan->'lines') loop
    update public.waca_order_items set payload=(payload-'countedReview')||jsonb_build_object(
      'countedQuantity',(line->>'countedAfter')::integer,
      'countedReason',case line->>'mode' when 'COUNT' then 'OWNER_CONFIRMED_NEW' when 'INCLUDED' then 'BASELINE_INCLUDED' else 'PENDING_REVIEW' end,
      'countedBy',actor::text,'recognition',jsonb_build_object('mode',line->>'mode','requestId',plan->>'requestId',
        'restoreEpoch',epoch,'sourceQuantity',line->'sourceQuantity','sourceStatus',line->>'sourceStatus','actor',actor,'decidedAt',now_at))
      ||case when line->>'mode'='HOLD' then '{"countedReview":"OWNER_HOLD"}'::jsonb else '{}'::jsonb end,
      updated_at=now_at,updated_by=actor where item_key=line->>'itemKey' and product_variant_id=(line->>'variantId')::uuid;
    get diagnostics n=row_count;
    if n<>1 then raise exception using errcode='23514',message='WACA_RECOGNITION_ITEM_UPDATE_MISMATCH'; end if;
  end loop;
  for qty in select value from jsonb_array_elements(plan->'quantities') loop
    -- Zero-delta decisions still record a proof but never touch unrelated Variant fields.
    if (qty->>'delta')::integer<>0 then
      update public.product_variants set waca_manual_adjustment=waca_manual_adjustment+(qty->>'delta')::integer,
        version=version+1,updated_at=now_at,updated_by=actor
      where id=(qty->>'variantId')::uuid and version=(qty->>'version')::bigint
        and waca_auto_quantity=(qty->>'autoBefore')::integer and waca_manual_adjustment=(qty->>'manualBefore')::integer;
      get diagnostics n=row_count;
      if n<>1 then raise exception using errcode='40001',message='WACA_RECOGNITION_VARIANT_CHANGED'; end if;
    end if;
    select * into v from public.product_variants where id=(qty->>'variantId')::uuid;
    evidence:=evidence||jsonb_build_array(jsonb_build_object('variantId',v.id,'versionAfter',v.version,
      'autoAfter',v.waca_auto_quantity,'manualAfter',v.waca_manual_adjustment));
    select coalesce(jsonb_agg(i.item_key order by i.item_key),'[]'::jsonb) into keys from public.waca_order_items i
      where i.product_variant_id=v.id and coalesce((i.payload->>'countedQuantity')::integer,0)>0
        and ((qty->'reversibleItemKeys') ? i.item_key or exists(select 1 from jsonb_array_elements(plan->'lines') l
          where l->>'itemKey'=i.item_key and (l->>'countedBefore')::integer=0 and (l->>'countedAfter')::integer>0));
    perform public.erp_store_waca_recognition_continuity(v.id,epoch,keys);
  end loop;
  update public.waca_state set revision=revision+1,updated_at=now_at,updated_by=actor
    where id='00000000-0000-4000-8000-000000000001' and revision=(plan->>'revision')::bigint;
  get diagnostics n=row_count;
  if n<>1 then raise exception using errcode='40001',message='WACA_STALE_REVISION'; end if;
  result:=jsonb_build_object('status','COMMITTED','revision',(plan->>'revision')::bigint+1,'requestId',plan->>'requestId');
  insert into public.waca_import_batches(batch_key,payload,updated_at,updated_by)
    values(plan->>'requestId',jsonb_build_object('id',plan->>'requestId','fileName','來源訂單認列調整','importedAt',now_at,
      'rows',jsonb_array_length(plan->'lines'),'inserted',0,'updated',jsonb_array_length(plan->'lines'),'unchanged',0,
      'result',jsonb_build_object('ordersTotal',1,'productRows',jsonb_array_length(plan->'lines'),'cancelledOrders',0,
        'failedOrders',0,'matched',jsonb_array_length(plan->'lines'),'unmatched',0,'multipleCandidates',0,'statusConflicts','[]'::jsonb,'effectiveQuantity',0),
      'conflictRows','[]'::jsonb,'recognition',jsonb_build_object('contract','waca-recognition-v1','request',p_request,'plan',plan,
        'result',result,'actor',actor,'at',now_at,'variants',evidence)),now_at,actor);
  return result;
end;
$$;
revoke all on function public.erp_commit_waca_recognition(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.erp_commit_waca_recognition(jsonb,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
