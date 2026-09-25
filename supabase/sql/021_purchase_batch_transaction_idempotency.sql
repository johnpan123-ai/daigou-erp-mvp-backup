-- Experimental Cloud P0-4: atomic Purchase Batch + Items writes with idempotent replay.
-- Staging review artifact only. Do not apply to Production.

BEGIN;

CREATE TABLE IF NOT EXISTS public.erp_idempotency_keys (
  actor_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  operation_type text NOT NULL,
  request_fingerprint text NOT NULL,
  request_payload jsonb NOT NULL,
  status text NOT NULL,
  canonical_result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT erp_idempotency_keys_pkey PRIMARY KEY (actor_id, idempotency_key),
  CONSTRAINT erp_idempotency_keys_operation_type_check CHECK (operation_type IN ('create', 'edit')),
  CONSTRAINT erp_idempotency_keys_status_check CHECK (status IN ('processing', 'completed')),
  CONSTRAINT erp_idempotency_keys_completion_check CHECK (
    (status = 'processing' AND canonical_result IS NULL AND completed_at IS NULL)
    OR (status = 'completed' AND canonical_result IS NOT NULL AND completed_at IS NOT NULL)
  )
);

ALTER TABLE public.erp_idempotency_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.erp_idempotency_keys FROM PUBLIC;
REVOKE ALL ON TABLE public.erp_idempotency_keys FROM anon;
REVOKE ALL ON TABLE public.erp_idempotency_keys FROM authenticated;

CREATE INDEX IF NOT EXISTS erp_idempotency_keys_created_at_idx
  ON public.erp_idempotency_keys (created_at);

-- Fail closed if an earlier object with this name does not match the P0-4 store contract.
DO $$
DECLARE
  v_columns text[];
  v_column_contract text[];
BEGIN
  SELECT array_agg(column_name ORDER BY ordinal_position)
    INTO v_columns
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'erp_idempotency_keys';
  IF v_columns IS DISTINCT FROM ARRAY[
    'actor_id','idempotency_key','operation_type','request_fingerprint','request_payload',
    'status','canonical_result','created_at','completed_at'
  ]::text[] THEN
    RAISE EXCEPTION 'P0_4_IDEMPOTENCY_STORE_CONTRACT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  SELECT array_agg(
    attribute.attname || ':' || pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
      || ':' || CASE WHEN attribute.attnotnull THEN 'NOT_NULL' ELSE 'NULLABLE' END
    ORDER BY attribute.attnum
  ) INTO v_column_contract
    FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'erp_idempotency_keys'
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped;
  IF v_column_contract IS DISTINCT FROM ARRAY[
    'actor_id:uuid:NOT_NULL','idempotency_key:uuid:NOT_NULL','operation_type:text:NOT_NULL',
    'request_fingerprint:text:NOT_NULL','request_payload:jsonb:NOT_NULL','status:text:NOT_NULL',
    'canonical_result:jsonb:NULLABLE','created_at:timestamp with time zone:NOT_NULL',
    'completed_at:timestamp with time zone:NULLABLE'
  ]::text[] THEN
    RAISE EXCEPTION 'P0_4_IDEMPOTENCY_STORE_TYPE_CONTRACT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint constraint_record
     WHERE constraint_record.conrelid = 'public.erp_idempotency_keys'::regclass
       AND constraint_record.contype = 'p'
       AND constraint_record.conname = 'erp_idempotency_keys_pkey'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint constraint_record
     WHERE constraint_record.conrelid = 'public.erp_idempotency_keys'::regclass
       AND constraint_record.contype = 'c'
       AND constraint_record.conname = 'erp_idempotency_keys_completion_check'
  ) THEN
    RAISE EXCEPTION 'P0_4_IDEMPOTENCY_STORE_CONSTRAINT_CONTRACT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy policy
     WHERE policy.polrelid = 'public.erp_idempotency_keys'::regclass
  ) THEN
    RAISE EXCEPTION 'P0_4_IDEMPOTENCY_STORE_POLICY_NOT_ALLOWED' USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_apply_purchase_batch_transaction(
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
  v_operation_type text;
  v_batch_id uuid;
  v_batch_operations jsonb;
  v_item_operations jsonb;
  v_operation jsonb;
  v_existing public.erp_idempotency_keys%ROWTYPE;
  v_claimed boolean;
  v_request_fingerprint text;
  v_mutation_result jsonb;
  v_failure jsonb;
  v_batch jsonb;
  v_items jsonb;
  v_result jsonb;
  v_top_level_keys text[];
  v_item_batch_id uuid;
BEGIN
  IF v_actor IS NULL OR NOT public.is_editor(v_actor) THEN
    RAISE EXCEPTION 'P0_4_PURCHASE_TRANSACTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'P0_4_IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'P0_4_REQUEST_MUST_BE_OBJECT' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[])
    INTO v_top_level_keys FROM jsonb_object_keys(p_request) key;
  IF v_top_level_keys IS DISTINCT FROM ARRAY[
    'batchId','batchOperations','itemOperations','operationType'
  ]::text[] THEN
    RAISE EXCEPTION 'P0_4_REQUEST_FIELDS_INVALID' USING ERRCODE = '22023';
  END IF;

  v_operation_type := p_request->>'operationType';
  IF v_operation_type NOT IN ('create', 'edit') THEN
    RAISE EXCEPTION 'P0_4_OPERATION_TYPE_INVALID' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_batch_id := (p_request->>'batchId')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'P0_4_BATCH_UUID_REQUIRED' USING ERRCODE = '22023';
  END;
  IF v_batch_id IS NULL THEN
    RAISE EXCEPTION 'P0_4_BATCH_UUID_REQUIRED' USING ERRCODE = '22023';
  END IF;
  v_batch_operations := p_request->'batchOperations';
  v_item_operations := p_request->'itemOperations';
  IF jsonb_typeof(v_batch_operations) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_item_operations) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'P0_4_OPERATIONS_MUST_BE_ARRAYS' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(v_batch_operations) > 1 THEN
    RAISE EXCEPTION 'P0_4_SINGLE_BATCH_OPERATION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_batch_operations) operation
     WHERE operation->>'id' IS DISTINCT FROM v_batch_id::text
        OR (v_operation_type = 'create' AND operation->>'kind' IS DISTINCT FROM 'create')
        OR (v_operation_type = 'edit' AND operation->>'kind' IS DISTINCT FROM 'patch')
  ) THEN
    RAISE EXCEPTION 'P0_4_BATCH_OPERATION_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_operation_type = 'create' AND jsonb_array_length(v_batch_operations) <> 1 THEN
    RAISE EXCEPTION 'P0_4_CREATE_BATCH_OPERATION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_operation_type = 'create' AND jsonb_array_length(v_item_operations) = 0 THEN
    RAISE EXCEPTION 'P0_4_CREATE_ITEM_OPERATION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(v_item_operations) > 1000 THEN
    RAISE EXCEPTION 'P0_4_ITEM_OPERATION_LIMIT_EXCEEDED' USING ERRCODE = '54000';
  END IF;

  -- Child operations are structurally bound to exactly one Batch. Existing-row
  -- ownership is checked below only after the same advisory/row locks used by CAS.
  FOR v_operation IN SELECT value FROM jsonb_array_elements(v_item_operations)
  LOOP
    IF v_operation->>'kind' = 'create' THEN
      IF v_operation->'values'->>'purchase_batch_id' IS DISTINCT FROM v_batch_id::text THEN
        RAISE EXCEPTION 'P0_4_ITEM_BATCH_SCOPE_INVALID' USING ERRCODE = '22023';
      END IF;
    ELSIF v_operation->>'kind' IN ('patch', 'delete', 'reorder') THEN
      IF v_operation->>'kind' IN ('patch', 'reorder')
         AND v_operation->'changes' ? 'purchase_batch_id'
         AND v_operation->'changes'->>'purchase_batch_id' IS DISTINCT FROM v_batch_id::text THEN
        RAISE EXCEPTION 'P0_4_ITEM_BATCH_REPARENT_FORBIDDEN' USING ERRCODE = '22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'P0_4_ITEM_OPERATION_INVALID' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_request_fingerprint := md5(p_request::text);

  -- This block is a PostgreSQL subtransaction. Any structured conflict or constraint
  -- failure rolls back the idempotency claim and every Batch/Item mutation together.
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
      SELECT * INTO v_existing
        FROM public.erp_idempotency_keys
       WHERE actor_id = v_actor AND idempotency_key = p_idempotency_key
       FOR UPDATE;
      IF v_existing.operation_type IS DISTINCT FROM v_operation_type
         OR v_existing.request_fingerprint IS DISTINCT FROM v_request_fingerprint
         OR v_existing.request_payload IS DISTINCT FROM p_request THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
          'recordId', v_batch_id
        );
      END IF;
      IF v_existing.status = 'completed' AND v_existing.canonical_result IS NOT NULL THEN
        RETURN jsonb_set(v_existing.canonical_result, '{replayed}', 'true'::jsonb, true);
      END IF;
      RAISE EXCEPTION 'P0_4_IDEMPOTENCY_INCOMPLETE' USING ERRCODE = '55000';
    END IF;

    -- Freeze the parent and every existing child in deterministic order before the
    -- first mutation. This closes the gap where another transaction could delete or
    -- re-parent an Item after the structural check but before the P0-3 CAS call.
    IF v_operation_type = 'edit' THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('purchase_batches:' || v_batch_id::text, 0)
      );
      PERFORM 1
        FROM public.purchase_batches batch
       WHERE batch.id = v_batch_id
         AND batch.deleted_at IS NULL
       FOR UPDATE;
      IF NOT FOUND THEN
        v_failure := jsonb_build_object(
          'ok', false, 'code', 'RECORD_DELETED_OR_MISSING',
          'entity', 'purchase_batches', 'recordId', v_batch_id
        );
        RAISE EXCEPTION 'P0_4_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    FOR v_operation IN
      SELECT value
        FROM jsonb_array_elements(v_item_operations)
       WHERE value->>'kind' IN ('patch', 'delete', 'reorder')
       ORDER BY value->>'id'
    LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'purchase_batch_items:' || (v_operation->>'id'), 0
        )
      );
      v_item_batch_id := NULL;
      SELECT item.purchase_batch_id
        INTO v_item_batch_id
        FROM public.purchase_batch_items item
       WHERE item.id = (v_operation->>'id')::uuid
         AND item.deleted_at IS NULL
       FOR UPDATE;
      IF NOT FOUND OR v_item_batch_id IS DISTINCT FROM v_batch_id THEN
        v_failure := jsonb_build_object(
          'ok', false, 'code', 'RECORD_DELETED_OR_MISSING',
          'entity', 'purchase_batch_items', 'recordId', v_operation->>'id'
        );
        RAISE EXCEPTION 'P0_4_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;

    -- The existing P0-3 function remains authoritative for field whitelists, locks,
    -- field-aware expected-value checks, stale delete, and version increments.
    IF jsonb_array_length(v_batch_operations) > 0 THEN
      v_mutation_result := public.erp_apply_field_mutations('purchase_batches', v_batch_operations);
      IF v_mutation_result->>'ok' IS DISTINCT FROM 'true' THEN
        v_failure := v_mutation_result;
        RAISE EXCEPTION 'P0_4_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF jsonb_array_length(v_item_operations) > 0 THEN
      v_mutation_result := public.erp_apply_field_mutations('purchase_batch_items', v_item_operations);
      IF v_mutation_result->>'ok' IS DISTINCT FROM 'true' THEN
        v_failure := v_mutation_result;
        RAISE EXCEPTION 'P0_4_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    SELECT to_jsonb(batch) INTO v_batch
      FROM public.purchase_batches batch
     WHERE batch.id = v_batch_id AND batch.deleted_at IS NULL;
    IF v_batch IS NULL THEN
      v_failure := jsonb_build_object(
        'ok', false, 'code', 'RECORD_DELETED_OR_MISSING',
        'entity', 'purchase_batches', 'recordId', v_batch_id
      );
      RAISE EXCEPTION 'P0_4_STRUCTURED_ROLLBACK' USING ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id), '[]'::jsonb)
      INTO v_items
      FROM public.purchase_batch_items item
     WHERE item.purchase_batch_id = v_batch_id AND item.deleted_at IS NULL;

    v_result := jsonb_build_object(
      'ok', true,
      'operationType', v_operation_type,
      'idempotencyKey', p_idempotency_key,
      'replayed', false,
      'batch', v_batch,
      'items', v_items
    );
    UPDATE public.erp_idempotency_keys
       SET status = 'completed', canonical_result = v_result, completed_at = clock_timestamp()
     WHERE actor_id = v_actor AND idempotency_key = p_idempotency_key;
    RETURN v_result;
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM = 'P0_4_STRUCTURED_ROLLBACK' AND v_failure IS NOT NULL THEN
        RETURN v_failure;
      END IF;
      RAISE;
    WHEN check_violation OR foreign_key_violation OR not_null_violation OR unique_violation THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'TRANSACTION_CONSTRAINT_FAILED',
        'entity', 'purchase_batch_items',
        'recordId', v_batch_id
      );
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_apply_purchase_batch_transaction(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_apply_purchase_batch_transaction(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_purchase_batch_transaction(uuid, jsonb) TO authenticated;

COMMIT;
