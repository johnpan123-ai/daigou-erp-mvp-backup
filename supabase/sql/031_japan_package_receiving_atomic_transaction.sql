-- Experimental Cloud F3: idempotent Japan Package create/attach/receiving transactions.
-- Portable migration artifact. Apply only through an environment-verified SQL gate;
-- this review round does not authorize applying it to any environment.

BEGIN;

-- This candidate has never been applied. Refuse to replace an unrelated or
-- previously installed function with the same signature.
DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.erp_apply_japan_package_transaction(uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'F3_FUNCTION_COLLISION' USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_apply_japan_package_transaction(
  p_idempotency_key uuid,
  p_request jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_transaction_type text;
  v_operation_type text;
  v_package_id uuid;
  v_package_operation jsonb;
  v_item_operations jsonb;
  v_expected_package_version integer;
  v_request_fingerprint text;
  v_existing public.erp_idempotency_keys%ROWTYPE;
  v_claimed boolean;
  v_operation jsonb;
  v_item_id uuid;
  v_purchase_item public.purchase_batch_items%ROWTYPE;
  v_current_package public.japan_packages%ROWTYPE;
  v_current_item public.japan_package_items%ROWTYPE;
  v_mutation_result jsonb;
  v_failure jsonb;
  v_package jsonb;
  v_items jsonb;
  v_result jsonb;
  v_all_checked boolean;
  v_target_status text;
  v_top_level_keys text[];
  v_change_keys text[];
  v_expected_keys text[];
  v_request_headers jsonb;
  v_request_host text;
BEGIN
  IF v_actor IS NULL OR NOT public.is_editor(v_actor) THEN
    RAISE EXCEPTION 'F3_JAPAN_PACKAGE_TRANSACTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'F3_IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'F3_REQUEST_MUST_BE_OBJECT' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[])
    INTO v_top_level_keys FROM jsonb_object_keys(p_request) key;
  IF v_top_level_keys IS DISTINCT FROM ARRAY[
    'expectedPackageVersion','itemOperations','packageId','packageOperation',
    'targetProjectRef','transactionType'
  ]::text[] THEN
    RAISE EXCEPTION 'F3_REQUEST_FIELDS_INVALID' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_request->>'targetProjectRef', '') !~ '^[a-z0-9]{20}$' THEN
    RAISE EXCEPTION 'F3_TARGET_PROJECT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_request_headers := NULLIF(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'F3_TARGET_PROJECT_FORBIDDEN' USING ERRCODE = '42501';
  END;
  v_request_host := pg_catalog.lower(pg_catalog.split_part(COALESCE(v_request_headers->>'host', ''), ':', 1));
  IF v_request_host IS DISTINCT FROM (p_request->>'targetProjectRef') || '.supabase.co' THEN
    RAISE EXCEPTION 'F3_TARGET_PROJECT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_transaction_type := p_request->>'transactionType';
  IF v_transaction_type NOT IN ('create-package','attach-items','set-receiving') THEN
    RAISE EXCEPTION 'F3_TRANSACTION_TYPE_INVALID' USING ERRCODE = '22023';
  END IF;
  v_operation_type := CASE WHEN v_transaction_type = 'create-package' THEN 'create' ELSE 'edit' END;
  BEGIN
    v_package_id := (p_request->>'packageId')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'F3_PACKAGE_UUID_REQUIRED' USING ERRCODE = '22023';
  END;
  v_package_operation := p_request->'packageOperation';
  v_item_operations := p_request->'itemOperations';
  IF jsonb_typeof(v_item_operations) IS DISTINCT FROM 'array' OR jsonb_array_length(v_item_operations) > 1000 THEN
    RAISE EXCEPTION 'F3_ITEM_OPERATIONS_INVALID' USING ERRCODE = '22023';
  END IF;

  IF v_transaction_type = 'create-package' THEN
    IF jsonb_typeof(v_package_operation) IS DISTINCT FROM 'object'
       OR v_package_operation->>'kind' IS DISTINCT FROM 'create'
       OR v_package_operation->>'id' IS DISTINCT FROM v_package_id::text
       OR jsonb_array_length(v_item_operations) <> 0
       OR jsonb_typeof(p_request->'expectedPackageVersion') IS DISTINCT FROM 'null' THEN
      RAISE EXCEPTION 'F3_CREATE_CONTRACT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF v_package_operation->'values'->>'status' NOT IN ('registered','arrived','confirmed','problem') THEN
      RAISE EXCEPTION 'F3_PACKAGE_STATUS_INVALID' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF jsonb_typeof(v_package_operation) IS DISTINCT FROM 'null'
       OR jsonb_typeof(p_request->'expectedPackageVersion') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'F3_EXISTING_PACKAGE_CONTRACT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_expected_package_version := (p_request->>'expectedPackageVersion')::integer;
    IF v_expected_package_version < 1 THEN
      RAISE EXCEPTION 'F3_PACKAGE_VERSION_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_transaction_type IN ('attach-items','set-receiving') AND jsonb_array_length(v_item_operations) = 0 THEN
    RAISE EXCEPTION 'F3_ITEM_OPERATION_REQUIRED' USING ERRCODE = '22023';
  END IF;

  v_request_fingerprint := md5(p_request::text);
  BEGIN
    INSERT INTO public.erp_idempotency_keys (
      actor_id, idempotency_key, operation_type, request_fingerprint,
      request_payload, status
    ) VALUES (
      v_actor, p_idempotency_key, v_operation_type, v_request_fingerprint,
      p_request, 'processing'
    )
    ON CONFLICT (actor_id, idempotency_key) DO NOTHING
    RETURNING true INTO v_claimed;

    IF COALESCE(v_claimed, false) IS FALSE THEN
      SELECT * INTO v_existing FROM public.erp_idempotency_keys
       WHERE actor_id = v_actor AND idempotency_key = p_idempotency_key
       FOR UPDATE;
      IF v_existing.operation_type IS DISTINCT FROM v_operation_type
         OR v_existing.request_fingerprint IS DISTINCT FROM v_request_fingerprint
         OR v_existing.request_payload IS DISTINCT FROM p_request THEN
        RETURN jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 'recordId', v_package_id);
      END IF;
      IF v_existing.status = 'completed' AND v_existing.canonical_result IS NOT NULL THEN
        RETURN jsonb_set(v_existing.canonical_result, '{replayed}', 'true'::jsonb, true);
      END IF;
      RAISE EXCEPTION 'F3_IDEMPOTENCY_INCOMPLETE' USING ERRCODE = '55000';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('japan_packages:' || v_package_id::text, 0));

    IF v_transaction_type = 'create-package' THEN
      v_mutation_result := public.erp_apply_field_mutations('japan_packages', jsonb_build_array(v_package_operation));
      IF v_mutation_result->>'ok' IS DISTINCT FROM 'true' THEN
        v_failure := v_mutation_result;
        RAISE EXCEPTION 'F3_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
      END IF;
    ELSE
      SELECT * INTO v_current_package FROM public.japan_packages
       WHERE id = v_package_id AND deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN
        v_failure := jsonb_build_object('ok', false, 'code', 'RECORD_DELETED_OR_MISSING', 'entity', 'japan_packages', 'recordId', v_package_id);
        RAISE EXCEPTION 'F3_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
      END IF;
      IF v_current_package.version IS DISTINCT FROM v_expected_package_version THEN
        v_failure := jsonb_build_object('ok', false, 'code', 'FIELD_CONFLICT', 'entity', 'japan_packages', 'recordId', v_package_id);
        RAISE EXCEPTION 'F3_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
      END IF;

      FOR v_operation IN SELECT value FROM jsonb_array_elements(v_item_operations) ORDER BY value->>'id'
      LOOP
        BEGIN
          v_item_id := (v_operation->>'id')::uuid;
        EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
          RAISE EXCEPTION 'F3_ITEM_UUID_REQUIRED' USING ERRCODE = '22023';
        END;
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('japan_package_items:' || v_item_id::text, 0));

        IF v_transaction_type = 'attach-items' THEN
          IF v_operation->>'kind' IS DISTINCT FROM 'create'
             OR v_operation->'values'->>'japan_package_id' IS DISTINCT FROM v_package_id::text
             OR COALESCE((v_operation->'values'->>'quantity')::integer, 0) <= 0
             OR COALESCE(v_operation->'values'->>'checked', 'false')::boolean THEN
            RAISE EXCEPTION 'F3_ATTACH_ITEM_CONTRACT_INVALID' USING ERRCODE = '22023';
          END IF;
          IF v_operation->'values'->>'purchase_batch_item_id' IS NOT NULL THEN
            SELECT * INTO v_purchase_item FROM public.purchase_batch_items
             WHERE id = (v_operation->'values'->>'purchase_batch_item_id')::uuid
               AND deleted_at IS NULL FOR SHARE;
            IF NOT FOUND
               OR v_purchase_item.purchase_batch_id::text IS DISTINCT FROM v_operation->'values'->>'purchase_batch_id'
               OR v_purchase_item.product_variant_id::text IS DISTINCT FROM v_operation->'values'->>'product_variant_id'
               OR (v_operation->'values'->>'quantity')::integer > v_purchase_item.quantity THEN
              RAISE EXCEPTION 'F3_PURCHASE_ITEM_RELATION_INVALID' USING ERRCODE = '23503';
            END IF;
            IF EXISTS (
              SELECT 1 FROM public.japan_package_items existing
               WHERE existing.purchase_batch_item_id = v_purchase_item.id AND existing.deleted_at IS NULL
            ) THEN
              v_failure := jsonb_build_object('ok', false, 'code', 'DUPLICATE_RELATION', 'entity', 'japan_package_items', 'recordId', v_item_id);
              RAISE EXCEPTION 'F3_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
            END IF;
          END IF;
        ELSE
          IF v_operation->>'kind' IS DISTINCT FROM 'patch' THEN
            RAISE EXCEPTION 'F3_RECEIVING_PATCH_REQUIRED' USING ERRCODE = '22023';
          END IF;
          SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO v_change_keys
            FROM jsonb_object_keys(v_operation->'changes') key;
          SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO v_expected_keys
            FROM jsonb_object_keys(v_operation->'expected') key;
          IF v_change_keys IS DISTINCT FROM v_expected_keys
             OR NOT v_change_keys <@ ARRAY['checked','checked_at']::text[]
             OR NOT ('checked' = ANY(v_change_keys))
             OR jsonb_typeof(v_operation->'observedVersion') IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'F3_RECEIVING_FIELDS_INVALID' USING ERRCODE = '22023';
          END IF;
          SELECT * INTO v_current_item FROM public.japan_package_items
           WHERE id = v_item_id AND japan_package_id = v_package_id AND deleted_at IS NULL FOR UPDATE;
          IF NOT FOUND THEN
            v_failure := jsonb_build_object('ok', false, 'code', 'RECORD_DELETED_OR_MISSING', 'entity', 'japan_package_items', 'recordId', v_item_id);
            RAISE EXCEPTION 'F3_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
          END IF;
          IF v_current_item.version IS DISTINCT FROM (v_operation->>'observedVersion')::integer THEN
            v_failure := jsonb_build_object('ok', false, 'code', 'FIELD_CONFLICT', 'entity', 'japan_package_items', 'recordId', v_item_id);
            RAISE EXCEPTION 'F3_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
          END IF;
          IF (v_operation->'changes'->>'checked')::boolean AND jsonb_typeof(v_operation->'changes'->'checked_at') IS DISTINCT FROM 'string' THEN
            RAISE EXCEPTION 'F3_CHECKED_AT_REQUIRED' USING ERRCODE = '22023';
          END IF;
          IF NOT (v_operation->'changes'->>'checked')::boolean AND v_operation->'changes'->'checked_at' <> 'null'::jsonb THEN
            RAISE EXCEPTION 'F3_UNCHECKED_AT_MUST_BE_NULL' USING ERRCODE = '22023';
          END IF;
        END IF;
      END LOOP;

      v_mutation_result := public.erp_apply_field_mutations('japan_package_items', v_item_operations);
      IF v_mutation_result->>'ok' IS DISTINCT FROM 'true' THEN
        v_failure := v_mutation_result;
        RAISE EXCEPTION 'F3_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
      END IF;

      SELECT bool_and(item.checked) AND count(*) > 0 INTO v_all_checked
        FROM public.japan_package_items item
       WHERE item.japan_package_id = v_package_id AND item.deleted_at IS NULL;
      v_target_status := v_current_package.status;
      IF v_current_package.status <> 'problem' THEN
        IF COALESCE(v_all_checked, false) THEN
          v_target_status := 'confirmed';
        ELSIF v_current_package.status = 'confirmed' THEN
          v_target_status := 'arrived';
        END IF;
      END IF;
      IF v_transaction_type = 'attach-items'
         OR v_target_status IS DISTINCT FROM v_current_package.status THEN
        UPDATE public.japan_packages
           SET status = v_target_status,
               arrived_at = CASE WHEN v_target_status IN ('arrived','confirmed') THEN COALESCE(arrived_at, CURRENT_DATE) ELSE arrived_at END,
               version = version + 1,
               updated_at = clock_timestamp(),
               updated_by = v_actor,
               sync_status = 'synced'
         WHERE id = v_package_id;
      END IF;
    END IF;

    SELECT to_jsonb(package_row) INTO v_package FROM public.japan_packages package_row
     WHERE package_row.id = v_package_id AND package_row.deleted_at IS NULL;
    SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id), '[]'::jsonb) INTO v_items
      FROM public.japan_package_items item
     WHERE item.japan_package_id = v_package_id AND item.deleted_at IS NULL;
    IF v_package IS NULL THEN
      RAISE EXCEPTION 'F3_CANONICAL_PACKAGE_MISSING' USING ERRCODE = '55000';
    END IF;

    v_result := jsonb_build_object(
      'ok', true,
      'transactionType', v_transaction_type,
      'idempotencyKey', p_idempotency_key,
      'replayed', false,
      'package', v_package,
      'items', v_items
    );
    UPDATE public.erp_idempotency_keys
       SET status = 'completed', canonical_result = v_result, completed_at = clock_timestamp()
     WHERE actor_id = v_actor AND idempotency_key = p_idempotency_key;
    RETURN v_result;
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM = 'F3_STRUCTURED_ROLLBACK' AND v_failure IS NOT NULL THEN RETURN v_failure; END IF;
      RAISE;
    WHEN check_violation OR foreign_key_violation OR not_null_violation OR unique_violation THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TRANSACTION_CONSTRAINT_FAILED', 'recordId', v_package_id);
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_apply_japan_package_transaction(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_apply_japan_package_transaction(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_japan_package_transaction(uuid, jsonb) TO authenticated;

-- Postflight checks prove the immutable function/ACL contract without executing it.
DO $$
DECLARE
  v_function_oid oid := pg_catalog.to_regprocedure('public.erp_apply_japan_package_transaction(uuid,jsonb)');
  v_schema_name name;
  v_function_name name;
  v_argument_count smallint;
  v_argument_types oidvector;
  v_argument_names text[];
  v_overload_count bigint;
  v_security_definer boolean;
  v_config text[];
  v_return_type oid;
  v_owner oid;
  v_kind "char";
  v_public_execute boolean;
  v_search_path_values text[];
BEGIN
  IF v_function_oid IS NULL THEN
    RAISE EXCEPTION 'F3_FUNCTION_SIGNATURE_MISSING' USING ERRCODE = '55000';
  END IF;
  SELECT namespace.nspname, procedure.proname, procedure.pronargs,
         procedure.proargtypes, procedure.proargnames, procedure.prosecdef,
         procedure.proconfig, procedure.prorettype, procedure.proowner, procedure.prokind
    INTO v_schema_name, v_function_name, v_argument_count,
         v_argument_types, v_argument_names, v_security_definer,
         v_config, v_return_type, v_owner, v_kind
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
   WHERE procedure.oid = v_function_oid;
  SELECT count(*)
    INTO v_overload_count
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = 'public'
     AND procedure.proname = 'erp_apply_japan_package_transaction';
  IF v_schema_name IS DISTINCT FROM 'public'
     OR v_function_name IS DISTINCT FROM 'erp_apply_japan_package_transaction' THEN
    RAISE EXCEPTION 'F3_FUNCTION_SIGNATURE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF v_overload_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'F3_FUNCTION_OVERLOAD_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF v_argument_count IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'F3_FUNCTION_ARG_COUNT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF v_argument_types[0] IS DISTINCT FROM 'uuid'::pg_catalog.regtype::oid
     OR v_argument_types[1] IS DISTINCT FROM 'jsonb'::pg_catalog.regtype::oid THEN
    RAISE EXCEPTION 'F3_FUNCTION_ARG_TYPES_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF v_argument_names IS DISTINCT FROM ARRAY['p_idempotency_key', 'p_request']::text[] THEN
    RAISE EXCEPTION 'F3_FUNCTION_ARG_NAMES_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF v_return_type IS DISTINCT FROM 'jsonb'::pg_catalog.regtype THEN
    RAISE EXCEPTION 'F3_FUNCTION_RETURN_TYPE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF v_kind IS DISTINCT FROM 'f' THEN
    RAISE EXCEPTION 'F3_FUNCTION_KIND_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF v_owner IS DISTINCT FROM pg_catalog.to_regrole(current_user) THEN
    RAISE EXCEPTION 'F3_FUNCTION_OWNER_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF v_security_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'F3_FUNCTION_SECURITY_DEFINER_MISMATCH' USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.array_agg(pg_catalog.split_part(config_entry, '=', 2) ORDER BY config_entry)
    INTO v_search_path_values
    FROM pg_catalog.unnest(COALESCE(v_config, ARRAY[]::text[])) config_entry
   WHERE pg_catalog.split_part(config_entry, '=', 1) = 'search_path';
  IF v_search_path_values IS DISTINCT FROM ARRAY['""']::text[] THEN
    RAISE EXCEPTION 'F3_FUNCTION_SEARCH_PATH_MISMATCH' USING ERRCODE = '55000';
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      ) privilege
     WHERE procedure.oid = v_function_oid
       AND privilege.grantee = 0
       AND privilege.privilege_type = 'EXECUTE'
  ) INTO v_public_execute;
  IF v_public_execute THEN
    RAISE EXCEPTION 'F3_FUNCTION_PUBLIC_ACL_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.has_function_privilege('anon', v_function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'F3_FUNCTION_ANON_ACL_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF NOT pg_catalog.has_function_privilege('authenticated', v_function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'F3_FUNCTION_AUTHENTICATED_ACL_MISMATCH' USING ERRCODE = '55000';
  END IF;
END;
$$;

COMMIT;
