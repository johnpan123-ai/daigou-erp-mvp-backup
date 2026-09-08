-- STAGING TEST ONLY: authenticated P0-4 test status, residual audit, and cleanup.
-- This artifact must only be applied to rhfdjsklfrgpoqsaqpkn after review.
-- It never changes P0-4 business RPC grants or business-table RLS policies.

BEGIN;

CREATE OR REPLACE FUNCTION public.erp_p0_4_assert_staging_test_request()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_headers jsonb;
  v_host text;
BEGIN
  BEGIN
    v_headers := NULLIF(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;
  v_host := lower(COALESCE(v_headers->>'host', ''));
  IF v_host NOT IN (
    'rhfdjsklfrgpoqsaqpkn.supabase.co',
    'rhfdjsklfrgpoqsaqpkn.supabase.co:443'
  ) THEN
    RAISE EXCEPTION 'P0_4_STAGING_TEST_HOST_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NULL OR NOT public.is_editor(auth.uid()) THEN
    RAISE EXCEPTION 'P0_4_AUTHENTICATED_EDITOR_REQUIRED' USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_p0_4_assert_staging_test_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_p0_4_assert_staging_test_request() FROM anon;
REVOKE ALL ON FUNCTION public.erp_p0_4_assert_staging_test_request() FROM authenticated;

CREATE OR REPLACE FUNCTION public.erp_p0_4_assert_test_marker(p_marker text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_marker IS NULL
     OR p_marker !~ '^P0-4-IDEMPOTENCY-TEST-[A-Z0-9-]{12,}$'
     OR length(p_marker) > 180 THEN
    RAISE EXCEPTION 'P0_4_TEST_MARKER_INVALID' USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_p0_4_assert_test_marker(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_p0_4_assert_test_marker(text) FROM anon;
REVOKE ALL ON FUNCTION public.erp_p0_4_assert_test_marker(text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.erp_p0_4_authenticated_test_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_group_id uuid;
  v_variant_id uuid;
BEGIN
  PERFORM public.erp_p0_4_assert_staging_test_request();

  SELECT profile.role INTO v_role
    FROM public.profiles profile
   WHERE profile.user_id = v_actor AND profile.is_active = true;

  SELECT product_group.id, product_variant.id
    INTO v_group_id, v_variant_id
    FROM public.product_groups product_group
    JOIN public.product_variants product_variant
      ON product_variant.product_group_id = product_group.id
     AND product_variant.deleted_at IS NULL
   WHERE product_group.deleted_at IS NULL
   ORDER BY product_group.id, product_variant.id
   LIMIT 1;

  RETURN jsonb_build_object(
    'authenticated', true,
    'editor', public.is_editor(v_actor),
    'role', v_role,
    'prerequisites', jsonb_build_object(
      'productGroupId', v_group_id,
      'productVariantId', v_variant_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.erp_p0_4_authenticated_test_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_p0_4_authenticated_test_status() FROM anon;
GRANT EXECUTE ON FUNCTION public.erp_p0_4_authenticated_test_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_p0_4_authenticated_test_residuals(p_marker text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_batch_ids uuid[];
  v_batch_count bigint;
  v_item_count bigint;
  v_idempotency_count bigint;
BEGIN
  PERFORM public.erp_p0_4_assert_staging_test_request();
  PERFORM public.erp_p0_4_assert_test_marker(p_marker);

  SELECT COALESCE(array_agg(batch.id), ARRAY[]::uuid[]), count(*)
    INTO v_batch_ids, v_batch_count
    FROM public.purchase_batches batch
   WHERE batch.name LIKE p_marker || '%'
     AND batch.updated_by = v_actor;

  SELECT count(*) INTO v_item_count
    FROM public.purchase_batch_items item
   WHERE item.purchase_batch_id = ANY(v_batch_ids)
     AND item.updated_by = v_actor;

  SELECT count(*) INTO v_idempotency_count
    FROM public.erp_idempotency_keys idem
   WHERE idem.actor_id = v_actor
     AND (
       EXISTS (
         SELECT 1 FROM unnest(v_batch_ids) batch_id
          WHERE idem.request_payload->>'batchId' = batch_id::text
       )
       OR idem.request_payload #>> '{batchOperations,0,values,name}' LIKE p_marker || '%'
       OR idem.canonical_result #>> '{batch,name}' LIKE p_marker || '%'
     );

  RETURN jsonb_build_object(
    'purchaseBatches', v_batch_count,
    'purchaseBatchItems', v_item_count,
    'idempotencyKeys', v_idempotency_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.erp_p0_4_authenticated_test_residuals(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_p0_4_authenticated_test_residuals(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.erp_p0_4_authenticated_test_residuals(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_p0_4_authenticated_test_cleanup(p_marker text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_batch_ids uuid[];
  v_deleted_batches bigint := 0;
  v_deleted_items bigint := 0;
  v_deleted_idempotency bigint := 0;
  v_residual jsonb;
BEGIN
  PERFORM public.erp_p0_4_assert_staging_test_request();
  PERFORM public.erp_p0_4_assert_test_marker(p_marker);

  SELECT COALESCE(array_agg(locked_batch.id), ARRAY[]::uuid[])
    INTO v_batch_ids
    FROM (
      SELECT batch.id
        FROM public.purchase_batches batch
       WHERE batch.name LIKE p_marker || '%'
         AND batch.updated_by = v_actor
       FOR UPDATE
    ) locked_batch;

  DELETE FROM public.purchase_batch_items item
   WHERE item.purchase_batch_id = ANY(v_batch_ids)
     AND item.updated_by = v_actor;
  GET DIAGNOSTICS v_deleted_items = ROW_COUNT;

  DELETE FROM public.purchase_batches batch
   WHERE batch.id = ANY(v_batch_ids)
     AND batch.name LIKE p_marker || '%'
     AND batch.updated_by = v_actor;
  GET DIAGNOSTICS v_deleted_batches = ROW_COUNT;

  DELETE FROM public.erp_idempotency_keys idem
   WHERE idem.actor_id = v_actor
     AND (
       EXISTS (
         SELECT 1 FROM unnest(v_batch_ids) batch_id
          WHERE idem.request_payload->>'batchId' = batch_id::text
       )
       OR idem.request_payload #>> '{batchOperations,0,values,name}' LIKE p_marker || '%'
       OR idem.canonical_result #>> '{batch,name}' LIKE p_marker || '%'
     );
  GET DIAGNOSTICS v_deleted_idempotency = ROW_COUNT;

  v_residual := public.erp_p0_4_authenticated_test_residuals(p_marker);
  IF (v_residual->>'purchaseBatches')::bigint <> 0
     OR (v_residual->>'purchaseBatchItems')::bigint <> 0
     OR (v_residual->>'idempotencyKeys')::bigint <> 0 THEN
    RAISE EXCEPTION 'P0_4_TEST_CLEANUP_RESIDUAL' USING ERRCODE = '55000';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'deleted', jsonb_build_object(
      'purchaseBatches', v_deleted_batches,
      'purchaseBatchItems', v_deleted_items,
      'idempotencyKeys', v_deleted_idempotency
    ),
    'residual', v_residual
  );
END;
$$;

REVOKE ALL ON FUNCTION public.erp_p0_4_authenticated_test_cleanup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_p0_4_authenticated_test_cleanup(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.erp_p0_4_authenticated_test_cleanup(text) TO authenticated;

COMMIT;
