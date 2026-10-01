-- Additive source only. Uses the existing environment-local idempotency store.
-- No new business resource and no historical migration rewrite.
BEGIN;

CREATE OR REPLACE FUNCTION public.erp_apply_private_order_transaction(p_idempotency_key uuid, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor uuid := auth.uid(); order_id uuid; action text; claimed boolean;
  old_request public.erp_idempotency_keys%ROWTYPE;
  operation jsonb; result jsonb; failure jsonb; parent jsonb; children jsonb;
  current_version integer; current_items jsonb; actual_parent uuid;
BEGIN
  IF actor IS NULL OR NOT public.is_editor(actor) THEN
    RAISE EXCEPTION 'PRIVATE_ORDER_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_request) k) IS DISTINCT FROM
      ARRAY['action','expectedItems','expectedParentVersion','family','itemOperations','orderId','orderOperations']::text[]
    OR p_request->>'family' IS DISTINCT FROM 'private-order' THEN
    RAISE EXCEPTION 'PRIVATE_ORDER_INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  order_id := (p_request->>'orderId')::uuid; action := p_request->>'action';
  IF order_id IS NULL OR action IS NULL OR action NOT IN ('create','edit','delete')
    OR jsonb_typeof(p_request->'orderOperations') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_request->'itemOperations') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_request->'expectedItems') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_request->'orderOperations') > 1
    OR jsonb_array_length(p_request->'itemOperations') > 1000 THEN
    RAISE EXCEPTION 'PRIVATE_ORDER_INVALID_OPERATIONS' USING ERRCODE = '22023';
  END IF;
  IF (action IN ('create','delete') AND jsonb_array_length(p_request->'orderOperations') <> 1)
    OR (action = 'create' AND jsonb_array_length(p_request->'itemOperations') = 0)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_request->'orderOperations') op WHERE
      op->>'id' IS DISTINCT FROM order_id::text OR op->>'kind' IS DISTINCT FROM
        CASE action WHEN 'create' THEN 'create' WHEN 'delete' THEN 'delete' ELSE 'patch' END) THEN
    RAISE EXCEPTION 'PRIVATE_ORDER_INVALID_PARENT' USING ERRCODE = '22023';
  END IF;
  FOR operation IN SELECT value FROM jsonb_array_elements(p_request->'itemOperations') LOOP
    IF operation->>'kind' IS NULL OR operation->>'kind' NOT IN ('create','patch','delete')
      OR (operation->>'kind' = 'create' AND operation->'values'->>'private_order_id' IS DISTINCT FROM order_id::text)
      OR (operation->'changes' ? 'private_order_id' AND operation->'changes'->>'private_order_id' IS DISTINCT FROM order_id::text)
      OR (action = 'delete' AND operation->>'kind' <> 'delete') THEN
      RAISE EXCEPTION 'PRIVATE_ORDER_CHILD_SCOPE_INVALID' USING ERRCODE = '22023';
    END IF;
    IF coalesce(operation->'values',operation->'changes','{}') ? 'quantity' AND
      ((coalesce(operation->'values',operation->'changes')->>'quantity')::numeric <= 0
       OR trunc((coalesce(operation->'values',operation->'changes')->>'quantity')::numeric)
          IS DISTINCT FROM (coalesce(operation->'values',operation->'changes')->>'quantity')::numeric) THEN
      RAISE EXCEPTION 'PRIVATE_ORDER_QUANTITY_INVALID' USING ERRCODE='22023';
    END IF;
  END LOOP;

  BEGIN
    INSERT INTO public.erp_idempotency_keys(actor_id,idempotency_key,operation_type,request_fingerprint,request_payload,status)
      VALUES(actor,p_idempotency_key,CASE WHEN action='create' THEN 'create' ELSE 'edit' END,md5(p_request::text),p_request,'processing')
      ON CONFLICT(actor_id,idempotency_key) DO NOTHING RETURNING true INTO claimed;
    IF NOT coalesce(claimed,false) THEN
      SELECT * INTO old_request FROM public.erp_idempotency_keys
        WHERE actor_id=actor AND idempotency_key=p_idempotency_key FOR UPDATE;
      IF old_request.request_payload IS DISTINCT FROM p_request THEN
        RETURN jsonb_build_object('ok',false,'code','IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
      END IF;
      IF old_request.status <> 'completed' THEN RAISE EXCEPTION 'PRIVATE_ORDER_INCOMPLETE'; END IF;
      RETURN jsonb_set(old_request.canonical_result,'{replayed}','true',true);
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('private_orders:'||order_id::text,0));
    SELECT version INTO current_version FROM public.private_orders WHERE id=order_id AND deleted_at IS NULL FOR UPDATE;
    IF action='create' THEN
      IF FOUND OR p_request->'expectedParentVersion' IS DISTINCT FROM 'null'::jsonb THEN
        RAISE EXCEPTION 'PRIVATE_ORDER_DUPLICATE_CREATE';
      END IF;
    ELSIF current_version IS NULL OR current_version IS DISTINCT FROM (p_request->>'expectedParentVersion')::integer THEN
      failure := jsonb_build_object('ok',false,'code','FIELD_CONFLICT','entity','private_orders','recordId',order_id);
      RAISE EXCEPTION 'PRIVATE_ORDER_ROLLBACK' USING ERRCODE='P0001';
    END IF;
    PERFORM 1 FROM public.private_order_items WHERE private_order_id=order_id AND deleted_at IS NULL ORDER BY id FOR UPDATE;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) ORDER BY id),'[]') INTO current_items
      FROM public.private_order_items WHERE private_order_id=order_id AND deleted_at IS NULL;
    IF current_items IS DISTINCT FROM p_request->'expectedItems' THEN
      failure := jsonb_build_object('ok',false,'code','FIELD_CONFLICT','entity','private_order_items','recordId',order_id);
      RAISE EXCEPTION 'PRIVATE_ORDER_ROLLBACK' USING ERRCODE='P0001';
    END IF;
    FOR operation IN SELECT value FROM jsonb_array_elements(p_request->'itemOperations') WHERE value->>'kind'<>'create' LOOP
      SELECT private_order_id INTO actual_parent FROM public.private_order_items
        WHERE id=(operation->>'id')::uuid AND deleted_at IS NULL FOR UPDATE;
      IF actual_parent IS DISTINCT FROM order_id THEN RAISE EXCEPTION 'PRIVATE_ORDER_CHILD_SCOPE_INVALID'; END IF;
    END LOOP;
    IF action<>'delete' AND jsonb_array_length(p_request->'orderOperations')>0 THEN
      result := public.erp_apply_field_mutations('private_orders',p_request->'orderOperations');
      IF result->>'ok' IS DISTINCT FROM 'true' THEN failure:=result; RAISE EXCEPTION 'PRIVATE_ORDER_ROLLBACK'; END IF;
    END IF;
    IF jsonb_array_length(p_request->'itemOperations')>0 THEN
      result := public.erp_apply_field_mutations('private_order_items',p_request->'itemOperations');
      IF result->>'ok' IS DISTINCT FROM 'true' THEN failure:=result; RAISE EXCEPTION 'PRIVATE_ORDER_ROLLBACK'; END IF;
    END IF;
    IF action='delete' THEN
      IF EXISTS(SELECT 1 FROM public.private_order_items WHERE private_order_id=order_id AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'PRIVATE_ORDER_ACTIVE_CHILDREN';
      END IF;
      result := public.erp_apply_field_mutations('private_orders',p_request->'orderOperations');
      IF result->>'ok' IS DISTINCT FROM 'true' THEN failure:=result; RAISE EXCEPTION 'PRIVATE_ORDER_ROLLBACK'; END IF;
    ELSE
      IF EXISTS(SELECT 1 FROM public.private_orders WHERE id=order_id AND deleted_at IS NULL AND btrim(customer_name)='') THEN
        RAISE EXCEPTION 'PRIVATE_ORDER_CUSTOMER_REQUIRED';
      END IF;
      IF EXISTS(SELECT 1 FROM public.private_order_items i
        JOIN public.private_orders o ON o.id=i.private_order_id
        LEFT JOIN public.product_variants v ON v.id=i.product_variant_id
        WHERE i.private_order_id=order_id AND i.deleted_at IS NULL AND
          (v.id IS NULL OR v.deleted_at IS NOT NULL OR v.product_group_id IS DISTINCT FROM o.product_group_id
           OR i.quantity<=0 OR i.amount<0)) THEN RAISE EXCEPTION 'PRIVATE_ORDER_RELATIONSHIP_INVALID'; END IF;
    END IF;
    SELECT to_jsonb(o) INTO parent FROM public.private_orders o WHERE id=order_id AND deleted_at IS NULL;
    SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY id),'[]') INTO children FROM public.private_order_items i
      WHERE private_order_id=order_id AND deleted_at IS NULL;
    result:=jsonb_build_object('ok',true,'replayed',false,'idempotencyKey',p_idempotency_key,'order',parent,'items',children);
    UPDATE public.erp_idempotency_keys SET status='completed',canonical_result=result,completed_at=clock_timestamp()
      WHERE actor_id=actor AND idempotency_key=p_idempotency_key;
    RETURN result;
  EXCEPTION WHEN OTHERS THEN
    IF failure IS NOT NULL THEN RETURN failure; END IF;
    -- The exception block rolls back *all* business rows and the replay claim.
    RETURN jsonb_build_object('ok',false,'code','TRANSACTION_REJECTED','sqlstate',SQLSTATE);
  END;
END; $$;
REVOKE ALL ON FUNCTION public.erp_apply_private_order_transaction(uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_private_order_transaction(uuid,jsonb) TO authenticated;
-- Read-only closure for an acknowledged/lost response. Never relax write or
-- draft guards merely to replay an operation which may already be committed.
CREATE OR REPLACE FUNCTION public.erp_reconcile_private_order_transaction(p_idempotency_key uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid(); prior public.erp_idempotency_keys%ROWTYPE;
BEGIN
  IF actor IS NULL OR NOT public.is_editor(actor) THEN RAISE EXCEPTION 'PRIVATE_ORDER_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_idempotency_key IS NULL OR p_request->>'family' IS DISTINCT FROM 'private-order' THEN
    RAISE EXCEPTION 'PRIVATE_ORDER_INVALID_REQUEST' USING ERRCODE='22023'; END IF;
  SELECT * INTO prior FROM public.erp_idempotency_keys WHERE actor_id=actor AND idempotency_key=p_idempotency_key;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'committed',false); END IF;
  IF prior.request_payload IS DISTINCT FROM p_request THEN RAISE EXCEPTION 'PRIVATE_ORDER_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('ok',true,'committed',prior.status='completed');
END; $$;
REVOKE ALL ON FUNCTION public.erp_reconcile_private_order_transaction(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.erp_reconcile_private_order_transaction(uuid,jsonb) TO authenticated;
COMMIT;
