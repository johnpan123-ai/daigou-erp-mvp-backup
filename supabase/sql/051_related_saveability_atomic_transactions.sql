-- Close related multi-write form/delete invariants. Existing ops replay store only.
BEGIN;
CREATE OR REPLACE FUNCTION public.erp_apply_related_transaction(p_idempotency_key uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor uuid:=auth.uid(); family text; root uuid; parent_id uuid; entities text[]; entity text;
  expected jsonb; actual jsonb; ops jsonb; op jsonb; result jsonb; failure jsonb; claimed boolean;
  prior public.erp_idempotency_keys%ROWTYPE; quantity_now integer; allocated integer;
BEGIN
  IF actor IS NULL OR NOT public.is_editor(actor) THEN RAISE EXCEPTION 'RELATED_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_idempotency_key IS NULL OR jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_request) k) IS DISTINCT FROM ARRAY['expectedRecords','family','operations','rootId']::text[]
    OR jsonb_typeof(p_request->'expectedRecords') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_request->'operations') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RELATED_INVALID_REQUEST' USING ERRCODE='22023'; END IF;
  family:=p_request->>'family'; root:=(p_request->>'rootId')::uuid;
  entities:=CASE family WHEN 'purchase-delete' THEN ARRAY['purchase_batch_items','purchase_batches']
    WHEN 'package-delete' THEN ARRAY['japan_package_items','japan_packages']
    WHEN 'package-item-delete' THEN ARRAY['japan_package_items']
    WHEN 'manual-package-edit' THEN ARRAY['japan_package_items','outbound_shipment_items']
    WHEN 'variant-delete' THEN ARRAY['product_variants'] END;
  IF root IS NULL OR entities IS NULL
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_request->'expectedRecords') k) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(entities) k)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_request->'operations') k) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(entities) k) THEN RAISE EXCEPTION 'RELATED_INVALID_SCOPE' USING ERRCODE='22023'; END IF;
  FOREACH entity IN ARRAY entities LOOP
    ops:=p_request->'operations'->entity; expected:=p_request->'expectedRecords'->entity;
    IF jsonb_typeof(ops) IS DISTINCT FROM 'array' OR jsonb_typeof(expected) IS DISTINCT FROM 'array'
      OR jsonb_array_length(ops)>10000 THEN RAISE EXCEPTION 'RELATED_INVALID_OPERATIONS' USING ERRCODE='22023'; END IF;
    FOR op IN SELECT value FROM jsonb_array_elements(ops) LOOP
      IF op->>'kind' IS DISTINCT FROM (CASE WHEN family='manual-package-edit' THEN 'patch' ELSE 'delete' END)
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected) e WHERE e->>'id'=op->>'id') THEN RAISE EXCEPTION 'RELATED_OPERATION_SCOPE_INVALID' USING ERRCODE='22023'; END IF;
      IF family='manual-package-edit' AND EXISTS(SELECT 1 FROM jsonb_object_keys(coalesce(op->'changes','{}')) k
        WHERE k NOT IN ('sku','product_title','variant_name','note') AND NOT(entity='japan_package_items' AND k='quantity')) THEN RAISE EXCEPTION 'RELATED_MANUAL_FIELDS_INVALID' USING ERRCODE='22023'; END IF;
    END LOOP;
    IF family<>'manual-package-edit' AND jsonb_array_length(ops)<>jsonb_array_length(expected) THEN RAISE EXCEPTION 'RELATED_DELETE_INCOMPLETE' USING ERRCODE='22023'; END IF;
  END LOOP;
  BEGIN
    INSERT INTO public.erp_idempotency_keys(actor_id,idempotency_key,operation_type,request_fingerprint,request_payload,status)
      VALUES(actor,p_idempotency_key,'edit',md5(p_request::text),p_request,'processing') ON CONFLICT(actor_id,idempotency_key) DO NOTHING RETURNING true INTO claimed;
    IF NOT coalesce(claimed,false) THEN
      SELECT * INTO prior FROM public.erp_idempotency_keys WHERE actor_id=actor AND idempotency_key=p_idempotency_key FOR UPDATE;
      IF prior.request_payload IS DISTINCT FROM p_request THEN RETURN jsonb_build_object('ok',false,'code','IDEMPOTENCY_KEY_PAYLOAD_MISMATCH'); END IF;
      IF prior.status<>'completed' THEN RAISE EXCEPTION 'RELATED_INCOMPLETE'; END IF;
      RETURN jsonb_set(prior.canonical_result,'{replayed}','true',true);
    END IF;
    LOCK TABLE public.product_variants,public.purchase_batches,public.purchase_batch_items,public.private_order_items,public.sales_order_items,
      public.japan_packages,public.japan_package_items,public.outbound_shipment_items,public.bundle_components,
      public.waca_order_items,public.waca_mappings,public.waca_master_links IN SHARE ROW EXCLUSIVE MODE;
    FOREACH entity IN ARRAY entities LOOP
      IF entity='product_variants' THEN
        SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) ORDER BY id),'[]') INTO actual FROM public.product_variants
          WHERE deleted_at IS NULL AND id IN(SELECT (e->>'id')::uuid FROM jsonb_array_elements(p_request->'expectedRecords'->entity) e);
        IF jsonb_array_length(actual)=0 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(actual) e WHERE e->>'id'=root::text) THEN
          RAISE EXCEPTION 'RELATED_VARIANT_SCOPE_INVALID';
        END IF;
      ELSIF entity='purchase_batches' OR entity='japan_packages' THEN
        EXECUTE format('SELECT coalesce(jsonb_agg(jsonb_build_object(''id'',id,''version'',version) ORDER BY id),''[]''::jsonb) FROM public.%I WHERE id=$1 AND deleted_at IS NULL',entity) INTO actual USING root;
      ELSIF entity='purchase_batch_items' THEN
        SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) ORDER BY id),'[]') INTO actual FROM public.purchase_batch_items WHERE purchase_batch_id=root AND deleted_at IS NULL;
      ELSIF entity='outbound_shipment_items' THEN
        SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) ORDER BY id),'[]') INTO actual FROM public.outbound_shipment_items WHERE japan_package_item_id=root AND deleted_at IS NULL;
      ELSE
        SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) ORDER BY id),'[]') INTO actual FROM public.japan_package_items
          WHERE deleted_at IS NULL AND CASE WHEN family='package-delete' THEN japan_package_id=root ELSE id=root END;
      END IF;
      IF actual IS DISTINCT FROM p_request->'expectedRecords'->entity OR
        (entity IN ('purchase_batches','japan_packages') AND jsonb_array_length(actual)<>1) OR
        (entity='japan_package_items' AND family IN ('package-item-delete','manual-package-edit') AND jsonb_array_length(actual)<>1) THEN
        failure:=jsonb_build_object('ok',false,'code','FIELD_CONFLICT','entity',entity); RAISE EXCEPTION 'RELATED_ROLLBACK';
      END IF;
    END LOOP;
    IF family='variant-delete' AND EXISTS(
      SELECT 1 FROM (
        SELECT product_variant_id id FROM public.purchase_batch_items WHERE deleted_at IS NULL
        UNION ALL SELECT product_variant_id FROM public.private_order_items WHERE deleted_at IS NULL
        UNION ALL SELECT product_variant_id FROM public.sales_order_items WHERE deleted_at IS NULL
        UNION ALL SELECT product_variant_id FROM public.japan_package_items WHERE deleted_at IS NULL
        UNION ALL SELECT product_variant_id FROM public.outbound_shipment_items WHERE deleted_at IS NULL
        UNION ALL SELECT bundle_variant_id FROM public.bundle_components
        UNION ALL SELECT component_variant_id FROM public.bundle_components
        UNION ALL SELECT product_variant_id FROM public.waca_order_items
        UNION ALL SELECT product_variant_id FROM public.waca_mappings
        UNION ALL SELECT product_variant_id FROM public.waca_master_links
      ) refs WHERE refs.id IN(SELECT (e->>'id')::uuid FROM jsonb_array_elements(p_request->'expectedRecords'->'product_variants') e)
    ) THEN failure:=jsonb_build_object('ok',false,'code','DEPENDENT_RECORDS_EXIST');RAISE EXCEPTION 'RELATED_ROLLBACK';END IF;
    IF family='variant-delete' AND EXISTS(SELECT 1 FROM public.product_variants WHERE deleted_at IS NULL
      AND id IN(SELECT (e->>'id')::uuid FROM jsonb_array_elements(p_request->'expectedRecords'->'product_variants') e)
      AND (coalesce(myacg_manual_adjustment,0)<>0 OR coalesce(waca_manual_adjustment,0)<>0
        OR coalesce(private_manual_adjustment,0)<>0 OR coalesce(purchased_manual_adjustment,0)<>0
        OR coalesce(myacg_auto_quantity,0)<>0 OR coalesce(effective_myacg_quantity,0)<>0 OR coalesce(waca_auto_quantity,0)<>0)) THEN
      failure:=jsonb_build_object('ok',false,'code','DEPENDENT_RECORDS_EXIST'); RAISE EXCEPTION 'RELATED_ROLLBACK';
    END IF;
    IF family='purchase-delete' AND EXISTS(SELECT 1 FROM public.japan_package_items j WHERE j.deleted_at IS NULL AND
      (j.purchase_batch_id=root OR j.purchase_batch_item_id IN(SELECT id FROM public.purchase_batch_items WHERE purchase_batch_id=root))) THEN
      failure:=jsonb_build_object('ok',false,'code','DEPENDENT_RECORDS_EXIST'); RAISE EXCEPTION 'RELATED_ROLLBACK';
    END IF;
    IF family IN('package-delete','package-item-delete') AND EXISTS(SELECT 1 FROM public.outbound_shipment_items o
      JOIN public.japan_package_items j ON j.id=o.japan_package_item_id WHERE o.deleted_at IS NULL AND
      CASE WHEN family='package-delete' THEN j.japan_package_id=root ELSE j.id=root END) THEN
      failure:=jsonb_build_object('ok',false,'code','DEPENDENT_RECORDS_EXIST'); RAISE EXCEPTION 'RELATED_ROLLBACK';
    END IF;
    IF family IN('package-item-delete','manual-package-edit') THEN
      SELECT japan_package_id INTO parent_id FROM public.japan_package_items WHERE id=root AND deleted_at IS NULL;
    END IF;
    IF family='manual-package-edit' AND EXISTS(SELECT 1 FROM public.japan_package_items WHERE id=root
      AND (product_variant_id IS NOT NULL OR purchase_batch_item_id IS NOT NULL)) THEN RAISE EXCEPTION 'RELATED_NOT_MANUAL_ITEM'; END IF;
    FOREACH entity IN ARRAY entities LOOP
      ops:=p_request->'operations'->entity;
      IF jsonb_array_length(ops)>0 THEN result:=public.erp_apply_field_mutations(entity,ops);
        IF result->>'ok' IS DISTINCT FROM 'true' THEN failure:=result; RAISE EXCEPTION 'RELATED_ROLLBACK'; END IF;
      END IF;
    END LOOP;
    IF family='manual-package-edit' THEN
      SELECT quantity INTO quantity_now FROM public.japan_package_items WHERE id=root;
      SELECT coalesce(sum(quantity),0) INTO allocated FROM public.outbound_shipment_items WHERE japan_package_item_id=root AND deleted_at IS NULL;
      IF quantity_now<=0 OR quantity_now<allocated THEN RAISE EXCEPTION 'RELATED_QUANTITY_INVALID'; END IF;
      IF EXISTS(SELECT 1 FROM public.outbound_shipment_items o JOIN public.japan_package_items j ON j.id=o.japan_package_item_id
        WHERE j.id=root AND o.deleted_at IS NULL AND
          (o.sku IS DISTINCT FROM j.sku OR o.product_title IS DISTINCT FROM j.product_title
            OR o.variant_name IS DISTINCT FROM j.variant_name OR o.note IS DISTINCT FROM j.note)) THEN RAISE EXCEPTION 'RELATED_MIRROR_INVALID'; END IF;
    END IF;
    IF parent_id IS NOT NULL THEN
      UPDATE public.japan_packages p SET
        status=CASE WHEN EXISTS(SELECT 1 FROM public.japan_package_items WHERE japan_package_id=parent_id AND deleted_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM public.japan_package_items WHERE japan_package_id=parent_id AND deleted_at IS NULL AND NOT checked)
          THEN 'confirmed' ELSE CASE WHEN p.status='confirmed' THEN 'arrived' ELSE p.status END END,
        arrived_at=CASE WHEN p.status='confirmed' AND p.arrived_at IS NULL THEN current_date ELSE p.arrived_at END
        WHERE p.id=parent_id AND p.status<>'problem' AND p.status IS DISTINCT FROM
          CASE WHEN EXISTS(SELECT 1 FROM public.japan_package_items WHERE japan_package_id=parent_id AND deleted_at IS NULL)
            AND NOT EXISTS(SELECT 1 FROM public.japan_package_items WHERE japan_package_id=parent_id AND deleted_at IS NULL AND NOT checked)
            THEN 'confirmed' ELSE CASE WHEN p.status='confirmed' THEN 'arrived' ELSE p.status END END;
    END IF;
    result:=jsonb_build_object('ok',true,'replayed',false,'idempotencyKey',p_idempotency_key,'parentId',parent_id);
    UPDATE public.erp_idempotency_keys SET status='completed',canonical_result=result,completed_at=clock_timestamp() WHERE actor_id=actor AND idempotency_key=p_idempotency_key;
    RETURN result;
  EXCEPTION WHEN OTHERS THEN
    IF failure IS NOT NULL THEN RETURN failure; END IF;
    RETURN jsonb_build_object('ok',false,'code','TRANSACTION_REJECTED','sqlstate',SQLSTATE);
  END;
END; $$;
REVOKE ALL ON FUNCTION public.erp_apply_related_transaction(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_related_transaction(uuid,jsonb) TO authenticated;
COMMIT;
