BEGIN;

ALTER TABLE public.outbound_shipments
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;

DO $preflight$
DECLARE
  v_named_functions bigint;
  v_exact_function oid := pg_catalog.to_regprocedure('public.erp_set_outbound_status_changed_at()');
BEGIN
  SELECT count(*)
    INTO v_named_functions
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'erp_set_outbound_status_changed_at';
  IF v_named_functions > 0 AND (v_named_functions <> 1 OR v_exact_function IS NULL) THEN
    RAISE EXCEPTION 'OUTBOUND_STATUS_TIMESTAMP_FUNCTION_COLLISION';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.erp_set_outbound_status_changed_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status_changed_at := clock_timestamp();
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := clock_timestamp();
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.erp_set_outbound_status_changed_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_set_outbound_status_changed_at() FROM anon;
REVOKE ALL ON FUNCTION public.erp_set_outbound_status_changed_at() FROM authenticated;

DROP TRIGGER IF EXISTS erp_outbound_status_changed_at ON public.outbound_shipments;
CREATE TRIGGER erp_outbound_status_changed_at
BEFORE INSERT OR UPDATE OF status ON public.outbound_shipments
FOR EACH ROW
EXECUTE FUNCTION public.erp_set_outbound_status_changed_at();

CREATE INDEX IF NOT EXISTS idx_outbound_shipments_status_changed_at
  ON public.outbound_shipments(status, status_changed_at DESC)
  WHERE deleted_at IS NULL;

DO $postflight$
DECLARE
  v_column_ok boolean;
  v_trigger_ok boolean;
  v_function_ok boolean;
  v_public_execute boolean;
  v_overload_count bigint;
  v_index_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) privilege
    WHERE p.oid = 'public.erp_set_outbound_status_changed_at()'::regprocedure
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ) INTO v_public_execute;

  SELECT count(*)
    INTO v_overload_count
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'erp_set_outbound_status_changed_at';

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'outbound_shipments'
      AND a.attname = 'status_changed_at'
      AND a.atttypid = 'timestamptz'::regtype
      AND a.attnotnull = false
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) INTO v_column_ok;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = 'public.outbound_shipments'::regclass
      AND t.tgname = 'erp_outbound_status_changed_at'
      AND NOT t.tgisinternal
      AND t.tgenabled <> 'D'
      AND t.tgfoid = 'public.erp_set_outbound_status_changed_at()'::regprocedure
  ) INTO v_trigger_ok;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.erp_set_outbound_status_changed_at()'::regprocedure
      AND p.prokind = 'f'
      AND p.prosecdef = false
      AND p.proowner = pg_catalog.to_regrole(current_user)
      AND p.prorettype = 'trigger'::regtype
      AND p.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
      AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) INTO v_function_ok;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class i
    JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
    JOIN pg_catalog.pg_index ix ON ix.indexrelid = i.oid
    WHERE n.nspname = 'public'
      AND i.relname = 'idx_outbound_shipments_status_changed_at'
      AND ix.indrelid = 'public.outbound_shipments'::regclass
      AND ix.indisvalid
      AND ix.indisready
  ) INTO v_index_ok;

  IF NOT v_column_ok THEN RAISE EXCEPTION 'OUTBOUND_STATUS_TIMESTAMP_COLUMN_MISMATCH'; END IF;
  IF v_overload_count IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'OUTBOUND_STATUS_TIMESTAMP_FUNCTION_OVERLOAD_MISMATCH'; END IF;
  IF NOT v_trigger_ok THEN RAISE EXCEPTION 'OUTBOUND_STATUS_TIMESTAMP_TRIGGER_MISMATCH'; END IF;
  IF v_public_execute THEN RAISE EXCEPTION 'OUTBOUND_STATUS_TIMESTAMP_PUBLIC_ACL_MISMATCH'; END IF;
  IF NOT v_function_ok THEN RAISE EXCEPTION 'OUTBOUND_STATUS_TIMESTAMP_FUNCTION_MISMATCH'; END IF;
  IF NOT v_index_ok THEN RAISE EXCEPTION 'OUTBOUND_STATUS_TIMESTAMP_INDEX_MISMATCH'; END IF;
END;
$postflight$;

COMMIT;
