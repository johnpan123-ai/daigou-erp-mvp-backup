-- 080 root-cause evidence (READ ONLY; run as postgres in Supabase SQL Editor or a direct read-only connection).
-- Runs the export's exact SELECT twice inside a read-only transaction (no RPC call, no JWT impersonation, no
-- writes, no setting persisted). Compare "JIT:" timing and total Execution Time for jit=on vs jit=off.
-- If the SQL Editor times out first, run the same file with psql over the direct connection.
begin transaction read only;
set local statement_timeout = '60s';
select current_setting('jit') jit, current_setting('jit_above_cost') jit_above_cost, current_setting('work_mem') work_mem, pg_jit_available() jit_available;
explain (analyze, buffers, settings, timing)
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
  );
set local jit = off;
explain (analyze, buffers, settings, timing)
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
  );
rollback;
