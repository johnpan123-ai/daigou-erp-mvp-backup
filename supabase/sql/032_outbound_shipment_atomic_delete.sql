-- Experimental Cloud F4: atomic, idempotent Outbound Shipment + Items deletion.
-- Staging review artifact only. Do not apply to Production.

BEGIN;

DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.erp_apply_outbound_shipment_transaction(uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'F4_OUTBOUND_RPC_ALREADY_EXISTS' USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.to_regprocedure('public.erp_apply_field_mutations(text,jsonb)') IS NULL
     OR pg_catalog.to_regclass('public.erp_idempotency_keys') IS NULL THEN
    RAISE EXCEPTION 'F4_OUTBOUND_DEPENDENCY_MISSING' USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE FUNCTION public.erp_apply_outbound_shipment_transaction(
  p_idempotency_key uuid,
  p_request jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '15s'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_shipment_id uuid;
  v_shipment_operation jsonb;
  v_item_operations jsonb;
  v_operation jsonb;
  v_existing public.erp_idempotency_keys%ROWTYPE;
  v_claimed boolean;
  v_request_fingerprint text;
  v_mutation_result jsonb;
  v_failure jsonb;
  v_result jsonb;
  v_top_level_keys text[];
  v_request_headers jsonb;
  v_request_host text;
  v_active_item_ids uuid[];
  v_requested_item_ids uuid[];
BEGIN
  IF v_actor IS NULL OR NOT public.is_editor(v_actor) THEN
    RAISE EXCEPTION 'F4_OUTBOUND_TRANSACTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'F4_OUTBOUND_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[])
    INTO v_top_level_keys FROM jsonb_object_keys(p_request) key;
  IF v_top_level_keys IS DISTINCT FROM ARRAY[
    'itemOperations','shipmentId','shipmentOperation','targetProjectRef','transactionType'
  ]::text[] THEN
    RAISE EXCEPTION 'F4_OUTBOUND_REQUEST_FIELDS_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_request->>'transactionType' IS DISTINCT FROM 'delete-shipment'
     OR COALESCE(p_request->>'targetProjectRef', '') !~ '^[a-z0-9]{20}$' THEN
    RAISE EXCEPTION 'F4_OUTBOUND_REQUEST_SCOPE_INVALID' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_request_headers := NULLIF(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_request_headers := NULL;
  END;
  v_request_host := pg_catalog.lower(pg_catalog.split_part(COALESCE(v_request_headers->>'host', ''), ':', 1));
  IF v_request_host IS DISTINCT FROM (p_request->>'targetProjectRef') || '.supabase.co' THEN
    RAISE EXCEPTION 'F4_OUTBOUND_TARGET_PROJECT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_shipment_id := (p_request->>'shipmentId')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'F4_OUTBOUND_SHIPMENT_UUID_REQUIRED' USING ERRCODE = '22023';
  END;

  v_shipment_operation := p_request->'shipmentOperation';
  v_item_operations := p_request->'itemOperations';
  IF jsonb_typeof(v_shipment_operation) IS DISTINCT FROM 'object'
     OR v_shipment_operation->>'kind' IS DISTINCT FROM 'delete'
     OR v_shipment_operation->>'id' IS DISTINCT FROM v_shipment_id::text
     OR jsonb_typeof(v_shipment_operation->'expectedVersion') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_item_operations) IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_item_operations) > 1000 THEN
    RAISE EXCEPTION 'F4_OUTBOUND_DELETE_OPERATIONS_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_item_operations) operation
     WHERE operation->>'kind' IS DISTINCT FROM 'delete'
        OR jsonb_typeof(operation->'expectedVersion') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'F4_OUTBOUND_ITEM_DELETE_OPERATION_INVALID' USING ERRCODE = '22023';
  END IF;

  v_request_fingerprint := md5(p_request::text);
  BEGIN
    INSERT INTO public.erp_idempotency_keys (
      actor_id, idempotency_key, operation_type, request_fingerprint,
      request_payload, status
    ) VALUES (
      v_actor, p_idempotency_key, 'edit', v_request_fingerprint,
      p_request, 'processing'
    )
    ON CONFLICT (actor_id, idempotency_key) DO NOTHING
    RETURNING true INTO v_claimed;

    IF COALESCE(v_claimed, false) IS FALSE THEN
      SELECT * INTO v_existing
        FROM public.erp_idempotency_keys
       WHERE actor_id = v_actor AND idempotency_key = p_idempotency_key
       FOR UPDATE;
      IF v_existing.operation_type IS DISTINCT FROM 'edit'
         OR v_existing.request_fingerprint IS DISTINCT FROM v_request_fingerprint
         OR v_existing.request_payload IS DISTINCT FROM p_request THEN
        RETURN jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 'recordId', v_shipment_id);
      END IF;
      IF v_existing.status = 'completed' AND v_existing.canonical_result IS NOT NULL THEN
        RETURN jsonb_set(v_existing.canonical_result, '{replayed}', 'true'::jsonb, true);
      END IF;
      RAISE EXCEPTION 'F4_OUTBOUND_IDEMPOTENCY_INCOMPLETE' USING ERRCODE = '55000';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('outbound_shipments:' || v_shipment_id::text, 0)
    );
    PERFORM 1 FROM public.outbound_shipments shipment
     WHERE shipment.id = v_shipment_id AND shipment.deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      v_failure := jsonb_build_object('ok', false, 'code', 'RECORD_DELETED_OR_MISSING', 'entity', 'outbound_shipments', 'recordId', v_shipment_id);
      RAISE EXCEPTION 'F4_OUTBOUND_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(array_agg(item.id ORDER BY item.id), ARRAY[]::uuid[])
      INTO v_active_item_ids
      FROM public.outbound_shipment_items item
     WHERE item.outbound_shipment_id = v_shipment_id AND item.deleted_at IS NULL;
    SELECT COALESCE(array_agg((operation->>'id')::uuid ORDER BY (operation->>'id')::uuid), ARRAY[]::uuid[])
      INTO v_requested_item_ids
      FROM jsonb_array_elements(v_item_operations) operation;
    IF v_requested_item_ids IS DISTINCT FROM v_active_item_ids THEN
      RAISE EXCEPTION 'F4_OUTBOUND_ITEM_SCOPE_MISMATCH' USING ERRCODE = '22023';
    END IF;

    FOR v_operation IN SELECT value FROM jsonb_array_elements(v_item_operations) ORDER BY value->>'id'
    LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('outbound_shipment_items:' || (v_operation->>'id'), 0)
      );
      PERFORM 1 FROM public.outbound_shipment_items item
       WHERE item.id = (v_operation->>'id')::uuid
         AND item.outbound_shipment_id = v_shipment_id
         AND item.deleted_at IS NULL
       FOR UPDATE;
      IF NOT FOUND THEN
        v_failure := jsonb_build_object('ok', false, 'code', 'RECORD_DELETED_OR_MISSING', 'entity', 'outbound_shipment_items', 'recordId', v_operation->>'id');
        RAISE EXCEPTION 'F4_OUTBOUND_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;

    IF jsonb_array_length(v_item_operations) > 0 THEN
      v_mutation_result := public.erp_apply_field_mutations('outbound_shipment_items', v_item_operations);
      IF v_mutation_result->>'ok' IS DISTINCT FROM 'true' THEN
        v_failure := v_mutation_result;
        RAISE EXCEPTION 'F4_OUTBOUND_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    v_mutation_result := public.erp_apply_field_mutations('outbound_shipments', jsonb_build_array(v_shipment_operation));
    IF v_mutation_result->>'ok' IS DISTINCT FROM 'true' THEN
      v_failure := v_mutation_result;
      RAISE EXCEPTION 'F4_OUTBOUND_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
    END IF;

    v_result := jsonb_build_object(
      'ok', true,
      'transactionType', 'delete-shipment',
      'idempotencyKey', p_idempotency_key,
      'replayed', false,
      'shipmentId', v_shipment_id,
      'itemIds', to_jsonb(v_active_item_ids)
    );
    UPDATE public.erp_idempotency_keys
       SET status = 'completed', canonical_result = v_result, completed_at = clock_timestamp()
     WHERE actor_id = v_actor AND idempotency_key = p_idempotency_key;
    RETURN v_result;
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM = 'F4_OUTBOUND_STRUCTURED_ROLLBACK' AND v_failure IS NOT NULL THEN RETURN v_failure; END IF;
      RAISE;
    WHEN check_violation OR foreign_key_violation OR not_null_violation OR unique_violation THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TRANSACTION_CONSTRAINT_FAILED', 'recordId', v_shipment_id);
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_apply_outbound_shipment_transaction(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_apply_outbound_shipment_transaction(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_outbound_shipment_transaction(uuid, jsonb) TO authenticated;

DO $$
DECLARE
  v_function_oid oid := pg_catalog.to_regprocedure('public.erp_apply_outbound_shipment_transaction(uuid,jsonb)');
  v_schema_name name;
  v_function_name name;
  v_argument_count smallint;
  v_argument_types oidvector;
  v_argument_names text[];
  v_overload_count bigint;
  v_result_type oid;
  v_config text[];
  v_security_definer boolean;
  v_owner oid;
  v_kind "char";
  v_public_execute boolean;
BEGIN
  IF v_function_oid IS NULL THEN RAISE EXCEPTION 'F4_OUTBOUND_POSTFLIGHT_FUNCTION_MISSING' USING ERRCODE = '55000'; END IF;
  SELECT namespace.nspname, function_record.proname, function_record.pronargs,
         function_record.proargtypes, function_record.proargnames,
         function_record.prorettype, function_record.proconfig, function_record.prosecdef,
         function_record.proowner, function_record.prokind
    INTO v_schema_name, v_function_name, v_argument_count,
         v_argument_types, v_argument_names, v_result_type, v_config,
         v_security_definer, v_owner, v_kind
    FROM pg_catalog.pg_proc function_record
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function_record.pronamespace
   WHERE function_record.oid = v_function_oid;
  SELECT count(*)
    INTO v_overload_count
    FROM pg_catalog.pg_proc function_record
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function_record.pronamespace
   WHERE namespace.nspname = 'public'
     AND function_record.proname = 'erp_apply_outbound_shipment_transaction';
  IF v_schema_name IS DISTINCT FROM 'public'
     OR v_function_name IS DISTINCT FROM 'erp_apply_outbound_shipment_transaction'
     OR v_overload_count IS DISTINCT FROM 1
     OR v_argument_count IS DISTINCT FROM 2
     OR v_argument_types[0] IS DISTINCT FROM 'uuid'::pg_catalog.regtype::oid
     OR v_argument_types[1] IS DISTINCT FROM 'jsonb'::pg_catalog.regtype::oid
     OR v_argument_names IS DISTINCT FROM ARRAY['p_idempotency_key', 'p_request']::text[]
     OR v_result_type IS DISTINCT FROM 'jsonb'::pg_catalog.regtype
     OR v_kind IS DISTINCT FROM 'f'
     OR v_owner IS DISTINCT FROM pg_catalog.to_regrole(current_user)
     OR v_security_definer IS DISTINCT FROM true
     OR NOT COALESCE('search_path=' = ANY(v_config), false)
     OR NOT COALESCE('statement_timeout=15s' = ANY(v_config), false) THEN
    RAISE EXCEPTION 'F4_OUTBOUND_POSTFLIGHT_FUNCTION_CONTRACT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) privilege
    WHERE procedure.oid = v_function_oid
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ) INTO v_public_execute;
  IF v_public_execute
     OR pg_catalog.has_function_privilege('anon', v_function_oid, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', v_function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'F4_OUTBOUND_POSTFLIGHT_ACL_MISMATCH' USING ERRCODE = '55000';
  END IF;
END;
$$;

COMMIT;
