begin;

-- Transport-only successor: preserve the legacy JSONB RPC for existing clients.
-- The snapshot is a single SELECT over the same 24 complete, ordered raw rows.
-- JSON is returned directly: no full-document JSON -> JSONB -> JSON conversion.
-- No timeout increase, staging writes, filtered resources or altered Restore data.
create or replace function public.erp_export_cloud_restore_snapshot_json()
returns json
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_snapshot json;
begin
  if v_actor is null then
    raise exception using errcode = 'P0001', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not public.is_owner(v_actor) then
    raise exception using errcode = 'P0001', message = 'CLOUD_RESTORE_OWNER_REQUIRED';
  end if;

  select json_build_object(
    'inventory_items', coalesce((select json_agg(t order by t.inventory_key) from public.inventory_items t), '[]'::json),
    'product_groups', coalesce((select json_agg(t order by t.id) from public.product_groups t), '[]'::json),
    'product_categories', coalesce((select json_agg(t order by t.id) from public.product_categories t), '[]'::json),
    'product_variants', coalesce((select json_agg(t order by t.id) from public.product_variants t), '[]'::json),
    'bundle_components', coalesce((select json_agg(t order by t.id) from public.bundle_components t), '[]'::json),
    'purchase_batches', coalesce((select json_agg(t order by t.id) from public.purchase_batches t), '[]'::json),
    'purchase_batch_items', coalesce((select json_agg(t order by t.id) from public.purchase_batch_items t), '[]'::json),
    'private_orders', coalesce((select json_agg(t order by t.id) from public.private_orders t), '[]'::json),
    'private_order_items', coalesce((select json_agg(t order by t.id) from public.private_order_items t), '[]'::json),
    'sales_orders', coalesce((select json_agg(t order by t.id) from public.sales_orders t), '[]'::json),
    'sales_order_items', coalesce((select json_agg(t order by t.id) from public.sales_order_items t), '[]'::json),
    'japan_packages', coalesce((select json_agg(t order by t.id) from public.japan_packages t), '[]'::json),
    'japan_package_items', coalesce((select json_agg(t order by t.id) from public.japan_package_items t), '[]'::json),
    'outbound_shipments', coalesce((select json_agg(t order by t.id) from public.outbound_shipments t), '[]'::json),
    'outbound_shipment_items', coalesce((select json_agg(t order by t.id) from public.outbound_shipment_items t), '[]'::json),
    'dashboard_category_images', coalesce((select json_agg(t order by t.id) from public.dashboard_category_images t), '[]'::json),
    'import_batches', coalesce((select json_agg(t order by t.id) from public.import_batches t), '[]'::json),
    'waca_orders', coalesce((select json_agg(t order by t.id) from public.waca_orders t), '[]'::json),
    'waca_order_items', coalesce((select json_agg(t order by t.id) from public.waca_order_items t), '[]'::json),
    'waca_mappings', coalesce((select json_agg(t order by t.id) from public.waca_mappings t), '[]'::json),
    'waca_master_links', coalesce((select json_agg(t order by t.id) from public.waca_master_links t), '[]'::json),
    'waca_import_batches', coalesce((select json_agg(t order by t.id) from public.waca_import_batches t), '[]'::json),
    'waca_cutover_audit', coalesce((select json_agg(t order by t.id) from public.waca_cutover_audit t), '[]'::json),
    'waca_state', coalesce((select json_agg(t order by t.id) from public.waca_state t), '[]'::json)
  ) into v_snapshot;
  return v_snapshot;
end;
$$;

revoke all on function public.erp_export_cloud_restore_snapshot_json() from public, anon, authenticated;
grant execute on function public.erp_export_cloud_restore_snapshot_json() to authenticated;

-- Published only after COMMIT; make the additive RPC visible to PostgREST.
notify pgrst, 'reload schema';

commit;
