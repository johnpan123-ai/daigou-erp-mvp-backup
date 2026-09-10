begin;

-- Cloud Restore export boundary. Apply only to an explicitly authorized
-- non-production project. The function returns raw rows, including soft
-- deleted records, in one statement-consistent snapshot.
create or replace function public.erp_export_cloud_restore_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_snapshot jsonb;
begin
  if v_actor is null then
    raise exception using errcode = 'P0001', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not public.is_owner(v_actor) then
    raise exception using errcode = 'P0001', message = 'CLOUD_RESTORE_OWNER_REQUIRED';
  end if;

  select jsonb_build_object(
    'inventory_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.inventory_key) from public.inventory_items t), '[]'::jsonb),
    'product_groups', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.product_groups t), '[]'::jsonb),
    'product_categories', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.product_categories t), '[]'::jsonb),
    'product_variants', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.product_variants t), '[]'::jsonb),
    'bundle_components', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.bundle_components t), '[]'::jsonb),
    'purchase_batches', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.purchase_batches t), '[]'::jsonb),
    'purchase_batch_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.purchase_batch_items t), '[]'::jsonb),
    'private_orders', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.private_orders t), '[]'::jsonb),
    'private_order_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.private_order_items t), '[]'::jsonb),
    'sales_orders', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.sales_orders t), '[]'::jsonb),
    'sales_order_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.sales_order_items t), '[]'::jsonb),
    'japan_packages', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.japan_packages t), '[]'::jsonb),
    'japan_package_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.japan_package_items t), '[]'::jsonb),
    'outbound_shipments', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.outbound_shipments t), '[]'::jsonb),
    'outbound_shipment_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.outbound_shipment_items t), '[]'::jsonb)
  ) into v_snapshot;

  return v_snapshot;
end;
$$;

revoke all on function public.erp_export_cloud_restore_snapshot() from public, anon, authenticated;
grant execute on function public.erp_export_cloud_restore_snapshot() to authenticated;

commit;
