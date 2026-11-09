-- 080 root-cause evidence (READ ONLY; run as postgres in Supabase SQL Editor or psql over the direct connection).
-- No RPC call, no JWT impersonation, no writes, no setting persisted (read-only transaction, rolled back).
-- Part A answers "which timeout applies to the API path": role-level settings of the PostgREST roles.
--   Expected if the mechanism holds: authenticated (or authenticator) carries statement_timeout below the
--   export's execution time (Supabase default is commonly 8s; the production value is what this returns).
-- Part B measures the export's real execution time/plan on production data (Execution Time vs that limit).
begin transaction read only;
set local statement_timeout = '120s';
-- A1. role-level settings (PostgREST applies the impersonated role's settings per request)
select r.rolname, r.rolconfig, r.rolbypassrls, r.rolinherit
from pg_roles r where r.rolname in ('anon','authenticated','authenticator','service_role','postgres') order by 1;
-- A2. database-wide / role-in-database settings
select coalesce(d.datname,'<all>') db, coalesce(r.rolname,'<all>') role, s.setconfig
from pg_db_role_setting s left join pg_database d on d.oid = s.setdatabase left join pg_roles r on r.oid = s.setrole;
-- A3. this function's own settings, volatility, ACL (080 not applied -> no statement_timeout entry)
select p.proconfig, p.provolatile, p.prosecdef, p.proacl::text
from pg_proc p where p.oid = 'public.erp_export_cloud_restore_snapshot_json()'::regprocedure;
-- A4. current session values for comparison (SQL Editor = postgres role, not the API role)
select current_user, current_setting('statement_timeout') statement_timeout, current_setting('jit') jit,
       current_setting('work_mem') work_mem, current_setting('server_version') server_version;
-- A5. table sizes behind the 24 resources (JSON volume driver)
select c.relname, c.reltuples::bigint est_rows, pg_size_pretty(pg_table_size(c.oid)) size
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by pg_table_size(c.oid) desc limit 24;
-- B. exact export SELECT (same as the function body), timed with plan
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
