-- Atomic Restore must preserve the backed-up outbound status timeline exactly.
-- The normal business trigger remains authoritative for ordinary inserts and
-- status transitions; this internal writer correction is restore-only.
BEGIN;

DO $preflight$
DECLARE
  v_writer oid := pg_catalog.to_regprocedure(
    'public.erp_cloud_restore_insert_rows(regclass,jsonb)'
  );
  v_trigger_function oid := pg_catalog.to_regprocedure(
    'public.erp_set_outbound_status_changed_at()'
  );
  v_trigger_count bigint;
BEGIN
  IF pg_catalog.to_regprocedure('public.erp_merge_waca_master_links(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'OUTBOUND_RESTORE_COMPAT_REQUIRES_052';
  END IF;
  IF v_writer IS NULL OR v_trigger_function IS NULL
    OR pg_catalog.to_regprocedure('public.sync_audit_columns()') IS NULL
    OR pg_catalog.to_regclass('public.outbound_shipments') IS NULL THEN
    RAISE EXCEPTION 'OUTBOUND_RESTORE_COMPAT_PRECONDITION_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.outbound_shipments'::regclass
       AND a.attname = 'status_changed_at'
       AND a.atttypid = 'timestamptz'::regtype
       AND a.attnum > 0
       AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'OUTBOUND_RESTORE_COMPAT_COLUMN_MISMATCH';
  END IF;
  SELECT count(*)
    INTO v_trigger_count
    FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid = 'public.outbound_shipments'::regclass
     AND t.tgname = 'erp_outbound_status_changed_at'
     AND NOT t.tgisinternal
     AND t.tgenabled <> 'D'
     AND t.tgfoid = v_trigger_function;
  IF v_trigger_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'OUTBOUND_RESTORE_COMPAT_TRIGGER_MISMATCH';
  END IF;
  IF pg_catalog.has_function_privilege('public', v_writer, 'EXECUTE')
    OR pg_catalog.has_function_privilege('anon', v_writer, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_writer, 'EXECUTE') THEN
    RAISE EXCEPTION 'OUTBOUND_RESTORE_COMPAT_WRITER_ACL_MISMATCH';
  END IF;
END;
$preflight$;

-- Keep the existing audit behavior for every ordinary update. The sole
-- exception is an update whose only changed value is the protected outbound
-- status timestamp; a separate SECURITY INVOKER trigger below rejects that
-- shape for non-owner callers, while the internal restore writer may use it
-- without corrupting the backed-up audit metadata.
CREATE OR REPLACE FUNCTION public.sync_audit_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_TABLE_SCHEMA = 'public'
    AND TG_TABLE_NAME = 'outbound_shipments'
    AND (to_jsonb(NEW)->'status') IS NOT DISTINCT FROM (to_jsonb(OLD)->'status')
    AND (to_jsonb(NEW)->'status_changed_at') IS DISTINCT FROM (to_jsonb(OLD)->'status_changed_at')
    AND (to_jsonb(NEW) - 'status_changed_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status_changed_at') THEN
    RETURN NEW;
  END IF;

  NEW.updated_at = now();
  NEW.version = OLD.version + 1;
  IF auth.uid() IS NOT NULL THEN
    NEW.updated_by = auth.uid();
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.erp_set_outbound_status_changed_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_table_owner name;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status_changed_at := clock_timestamp();
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := clock_timestamp();
  ELSIF NEW.status_changed_at IS DISTINCT FROM OLD.status_changed_at THEN
    SELECT pg_catalog.pg_get_userbyid(c.relowner)
      INTO v_table_owner
      FROM pg_catalog.pg_class c
     WHERE c.oid = TG_RELID;
    IF current_user IS DISTINCT FROM v_table_owner THEN
      RAISE EXCEPTION USING errcode = '42501',
        message = 'OUTBOUND_STATUS_TIMESTAMP_SYSTEM_MANAGED';
    END IF;
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_audit_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_set_outbound_status_changed_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS erp_outbound_status_changed_at ON public.outbound_shipments;
CREATE TRIGGER erp_outbound_status_changed_at
BEFORE INSERT OR UPDATE OF status, status_changed_at ON public.outbound_shipments
FOR EACH ROW
EXECUTE FUNCTION public.erp_set_outbound_status_changed_at();

CREATE OR REPLACE FUNCTION public.erp_cloud_restore_insert_rows(
  p_table regclass,
  p_rows jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_columns text;
  v_count bigint;
  v_timestamp_count bigint;
  v_timestamp_mismatch_count bigint;
BEGIN
  IF p_table NOT IN (
    'public.inventory_items'::regclass,'public.product_groups'::regclass,'public.product_categories'::regclass,
    'public.product_variants'::regclass,'public.bundle_components'::regclass,'public.purchase_batches'::regclass,
    'public.purchase_batch_items'::regclass,'public.private_orders'::regclass,'public.private_order_items'::regclass,
    'public.sales_orders'::regclass,'public.sales_order_items'::regclass,'public.japan_packages'::regclass,
    'public.japan_package_items'::regclass,'public.outbound_shipments'::regclass,'public.outbound_shipment_items'::regclass,'public.import_batches'::regclass,
    'public.dashboard_category_images'::regclass,
    'public.waca_orders'::regclass,'public.waca_order_items'::regclass,
    'public.waca_mappings'::regclass,'public.waca_master_links'::regclass,
    'public.waca_import_batches'::regclass,'public.waca_cutover_audit'::regclass,
    'public.waca_state'::regclass
  ) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'CLOUD_RESTORE_TABLE_NOT_ALLOWED';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'CLOUD_RESTORE_RESOURCE_NOT_ARRAY';
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN RETURN 0; END IF;
  SELECT string_agg(quote_ident(a.attname), ',' ORDER BY a.attnum)
    INTO v_columns
    FROM pg_attribute a
   WHERE a.attrelid = p_table AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) row_value WHERE row_value ? a.attname);
  IF v_columns IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'CLOUD_RESTORE_NO_ALLOWED_COLUMNS';
  END IF;
  EXECUTE format(
    'insert into %s (%s) select %s from jsonb_populate_recordset(null::%s, $1)',
    p_table, v_columns, v_columns, p_table
  ) USING p_rows;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- The INSERT trigger intentionally assigns the current clock time for normal
  -- business inserts. Atomic Restore corrects only its own inserted rows from
  -- the exact backup payload, inside the same transaction and before the
  -- caller performs the canonical integrity audit and COMMIT.
  IF p_table = 'public.outbound_shipments'::regclass THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_rows) AS restored(row_value)
       WHERE jsonb_typeof(restored.row_value) IS DISTINCT FROM 'object'
          OR NOT (restored.row_value ? 'id')
          OR NOT (restored.row_value ? 'status_changed_at')
    ) THEN
      RAISE EXCEPTION USING errcode = '22023',
        message = 'CLOUD_RESTORE_OUTBOUND_TIMESTAMP_EVIDENCE_MISSING';
    END IF;

    WITH restored AS (
      SELECT row_data.id, row_data.status_changed_at
        FROM jsonb_to_recordset(p_rows)
          AS row_data(id uuid, status_changed_at timestamptz)
    )
    UPDATE public.outbound_shipments target
       SET status_changed_at = restored.status_changed_at
      FROM restored
     WHERE target.id = restored.id;
    GET DIAGNOSTICS v_timestamp_count = ROW_COUNT;
    IF v_timestamp_count IS DISTINCT FROM v_count THEN
      RAISE EXCEPTION USING errcode = '55000',
        message = 'CLOUD_RESTORE_OUTBOUND_TIMESTAMP_ROW_COUNT_MISMATCH';
    END IF;

    WITH restored AS (
      SELECT row_data.id, row_data.status_changed_at
        FROM jsonb_to_recordset(p_rows)
          AS row_data(id uuid, status_changed_at timestamptz)
    )
    SELECT count(*)
      INTO v_timestamp_mismatch_count
      FROM restored
      LEFT JOIN public.outbound_shipments target ON target.id = restored.id
     WHERE target.id IS NULL
        OR target.status_changed_at IS DISTINCT FROM restored.status_changed_at;
    IF v_timestamp_mismatch_count IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION USING errcode = '55000',
        message = 'CLOUD_RESTORE_OUTBOUND_TIMESTAMP_MISMATCH';
    END IF;
  END IF;

  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.erp_cloud_restore_insert_rows(regclass,jsonb)
  FROM PUBLIC, anon, authenticated;

DO $postflight$
DECLARE
  v_definition text;
  v_audit_definition text;
  v_timestamp_definition text;
  v_trigger_definition text;
  v_writer oid := 'public.erp_cloud_restore_insert_rows(regclass,jsonb)'::regprocedure;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(v_writer)
    INTO v_definition;
  SELECT pg_catalog.pg_get_functiondef('public.sync_audit_columns()'::regprocedure)
    INTO v_audit_definition;
  SELECT pg_catalog.pg_get_functiondef('public.erp_set_outbound_status_changed_at()'::regprocedure)
    INTO v_timestamp_definition;
  SELECT pg_catalog.pg_get_triggerdef(t.oid)
    INTO v_trigger_definition
    FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid = 'public.outbound_shipments'::regclass
     AND t.tgname = 'erp_outbound_status_changed_at'
     AND NOT t.tgisinternal;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
     WHERE p.oid = v_writer
       AND p.prosecdef
       AND p.proowner = pg_catalog.to_regrole(current_user)
       AND p.prorettype = 'bigint'::regtype
       AND p.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
  )
    OR pg_catalog.has_function_privilege('public', v_writer, 'EXECUTE')
    OR pg_catalog.has_function_privilege('anon', v_writer, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_writer, 'EXECUTE')
    OR pg_catalog.strpos(v_definition, 'jsonb_to_recordset(p_rows)') = 0
    OR pg_catalog.strpos(v_definition, 'CLOUD_RESTORE_OUTBOUND_TIMESTAMP_EVIDENCE_MISSING') = 0
    OR pg_catalog.strpos(v_definition, 'CLOUD_RESTORE_OUTBOUND_TIMESTAMP_ROW_COUNT_MISMATCH') = 0
    OR pg_catalog.strpos(v_definition, 'CLOUD_RESTORE_OUTBOUND_TIMESTAMP_MISMATCH') = 0
    OR pg_catalog.strpos(v_audit_definition, 'TG_TABLE_NAME = ''outbound_shipments''') = 0
    OR pg_catalog.strpos(v_audit_definition, 'to_jsonb(NEW) - ''status_changed_at''') = 0
    OR pg_catalog.strpos(v_timestamp_definition, 'OUTBOUND_STATUS_TIMESTAMP_SYSTEM_MANAGED') = 0
    OR pg_catalog.strpos(v_timestamp_definition, 'current_user IS DISTINCT FROM v_table_owner') = 0
    OR pg_catalog.strpos(v_trigger_definition, 'UPDATE OF status, status_changed_at') = 0 THEN
    RAISE EXCEPTION 'OUTBOUND_RESTORE_COMPAT_POSTFLIGHT_FAILED';
  END IF;
END;
$postflight$;

COMMIT;
