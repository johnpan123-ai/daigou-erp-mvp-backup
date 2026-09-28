set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000099';

do $test$
declare
  v_snapshot jsonb := '{
    "revision":0,
    "orders":[{"key":"WACA::A","orderNumber":"A","status":"完成付款","purchasedAt":"2026-09-28"}],
    "items":[{"key":"WACA::A::F","orderKey":"WACA::A","feature":"F","productCode":"G001","productTitle":"Test group","spec1":"Test variant","spec2":"","specCode":"","quantity":11,"subtotal":110,"productVariantId":"v-11","match":"MANUAL_MATCH","diagnostic":null}],
    "mappings":[{"feature":"F","myacgMainId":"GP001","myacgVariantId":"G001","productVariantId":"v-11","method":"MANUAL","confirmedAt":"2026-09-28","historicalProductTitle":"Test group","historicalVariantTitle":"Test variant","masterStatus":"ACTIVE"}],
    "batches":[{"id":"B1","fileName":"waca.xlsx","importedAt":"2026-09-28","rows":1,"inserted":1,"updated":0,"unchanged":0,"conflictRows":[],"result":{}}],
    "masterLinks":[],"cutoverAudit":[]
  }'::jsonb;
  v_result jsonb;
  v_read jsonb;
  v_total integer;
begin
  v_read := public.erp_read_waca_snapshot();
  if (v_read->>'revision')::integer <> 0 then raise exception 'fresh revision mismatch'; end if;
  v_result := public.erp_commit_waca_snapshot(v_snapshot,0,true);
  if (v_result->>'revision')::integer <> 1 then raise exception 'first revision mismatch'; end if;
  v_read := public.erp_read_waca_snapshot();
  if jsonb_array_length(v_read->'orders') <> 1 or jsonb_array_length(v_read->'items') <> 1
    or jsonb_array_length(v_read->'mappings') <> 1
    or (v_read->'cutoverAudit'->0->>'legacyWacaQuantity')::integer <> 8
    or (v_read->'cutoverAudit'->0->>'newOrderDerivedQuantity')::integer <> 11
    or v_read->'items'->0->>'productVariantId' <> '00000000-0000-4000-8000-000000000011'
    or v_read->'mappings'->0->>'productVariantId' <> '00000000-0000-4000-8000-000000000011'
    or v_read->'cutoverAudit'->0->>'productVariantId' <> '00000000-0000-4000-8000-000000000011'
    or v_read->'cutoverState'->>'mode' <> 'ORDER_DRIVEN_ACTIVE'
    or v_read->'batches'->0->'reconciliation'->>'status' <> 'PASS' then
    raise exception 'first cutover/ledger result mismatch: %',v_read;
  end if;
  for v_total in 1..4 loop
    v_result := public.erp_commit_waca_snapshot(v_snapshot,v_total,true);
    if (v_result->>'revision')::integer <> v_total+1 then raise exception 'repeat revision mismatch'; end if;
  end loop;

  begin
    perform public.erp_commit_waca_snapshot(
      jsonb_set(jsonb_set(v_snapshot,'{orders}',
        v_snapshot->'orders'||'{"key":"WACA::B","orderNumber":"B","status":"完成付款","purchasedAt":"2026-09-28"}'::jsonb),
        '{items,0,productVariantId}','"missing-variant"'::jsonb),5,true);
    raise exception 'invalid variant was accepted';
  exception when foreign_key_violation then null;
  end;
  v_read := public.erp_read_waca_snapshot();
  if (v_read->>'revision')::integer <> 5 or jsonb_array_length(v_read->'orders') <> 1 then
    raise exception 'failed import partially committed';
  end if;
  raise notice 'PASS isolated owner import, 8->11 cutover, same-file 5x idempotency, failure rollback';
end;
$test$;

reset role;
do $verify$
begin
  if (select waca_auto_quantity from public.product_variants where local_id='v-11') <> 11 then
    raise exception 'derived quantity is not 11';
  end if;
  if (select waca_manual_adjustment from public.product_variants where local_id='v-11') <> 0 then
    raise exception 'legacy adjustment was retained';
  end if;
end;
$verify$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000098';
do $nonowner$
begin
  if (select count(*) from public.waca_orders) <> 0 then raise exception 'non-owner RLS leak'; end if;
  begin
    perform public.erp_read_waca_snapshot();
    raise exception 'non-owner RPC accepted';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS non-owner RLS and RPC deny';
end;
$nonowner$;

set role anon;
do $anonymous$
begin
  begin
    perform public.erp_read_waca_snapshot();
    raise exception 'anon RPC accepted';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS anonymous RPC deny';
end;
$anonymous$;
