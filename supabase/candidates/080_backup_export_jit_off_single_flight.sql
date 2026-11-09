-- 080 Candidate only (NOT applied). Owner approval + Codex review required; never apply to ERP1.
-- Location: supabase/candidates/ (outside the canonical chain). Adoption = move to supabase/sql/ and register
-- in supabase/canonicalFreshInstallV3.mjs (release-control step).
-- Production symptom: erp_export_cloud_restore_snapshot_json() cancelled after ~10.36 s (SQLSTATE 57014).
-- Change (function only; body, 24 resources, ordering, JSON return, owner gate, ACL unchanged):
--   * SET jit = off for this function: the 24 ordered json_agg sub-plans exceed JIT cost thresholds on
--     every call; JIT compile time is pure overhead for a once-per-backup statement.
--   * work_mem NOT raised: isolated measurement (1x = 30.7 MB, 2x = 61.5 MB synthetic snapshot) shows zero
--     temp spill at the 4 MB default; 64 MB would allow up to 24 x 64 MB of sort memory per export for no gain.
--   * Single-flight advisory lock (transaction-scoped, released on commit/rollback/cancel): bounds memory to
--     one export; a concurrent caller gets CLOUD_BACKUP_ALREADY_RUNNING (fail closed, no partial output).
--   * Keeps 065's STABLE (one MVCC snapshot across all 24 resources; no temp materialisation in PostgREST).
-- No table, data, role, timeout, RLS or Ledger change. Rollback: supabase/candidates/080_rollback.sql.
begin;

create or replace function public.erp_export_cloud_restore_snapshot_json()
returns json
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions
set jit = off
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
  -- 080: one full export at a time (each holds ~0.15-0.35 GB while building ~25-60 MB of JSON;
  -- 5 concurrent at 2x data measured +1.9 GB). A second caller fails fast; nothing partial is returned.
  if not pg_try_advisory_xact_lock(hashtextextended('erp_export_cloud_restore_snapshot_json', 0)) then
    raise exception using errcode = 'P0001', message = 'CLOUD_BACKUP_ALREADY_RUNNING';
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

notify pgrst, 'reload schema';

commit;
