-- Guarded Product Master -> Purchase Record provenance transition.
-- No durable tables/columns/resources are added by this migration.
BEGIN;
CREATE OR REPLACE FUNCTION public.erp_apply_catalog_transaction(p_idempotency_key uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor uuid:=auth.uid(); claimed boolean; exact_replay boolean:=false;
  old_request public.erp_idempotency_keys%ROWTYPE;
  entity text; current_versions jsonb; ops jsonb; result jsonb; failure jsonb; op jsonb;
  categories_written boolean:=false;
BEGIN
  IF actor IS NULL OR NOT public.is_editor(actor) THEN RAISE EXCEPTION 'CATALOG_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_idempotency_key IS NULL OR jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_request) k) IS DISTINCT FROM ARRAY['dependencies','family','mode','operations']::text[]
    OR p_request->>'family' IS DISTINCT FROM 'catalog'
    OR coalesce(p_request->>'mode','') NOT IN ('create','sync','reparse')
    OR jsonb_typeof(p_request->'dependencies') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_request->'operations') IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_request->'dependencies') k) IS DISTINCT FROM ARRAY['inventory_items','product_categories','product_groups','product_variants']::text[]
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_request->'operations') k) IS DISTINCT FROM ARRAY['product_categories','product_groups','product_variants']::text[] THEN
    RAISE EXCEPTION 'CATALOG_INVALID_REQUEST' USING ERRCODE='22023';
  END IF;

  -- A successful response-loss retry must be recognized before consulting the
  -- now-promoted row. Only an exact completed request may take this path.
  SELECT EXISTS(
    SELECT 1 FROM public.erp_idempotency_keys i
    WHERE i.actor_id=actor AND i.idempotency_key=p_idempotency_key
      AND i.status='completed' AND i.request_payload=p_request
  ) INTO exact_replay;

  FOREACH entity IN ARRAY ARRAY['product_groups','product_categories','product_variants'] LOOP
    ops:=p_request->'operations'->entity;
    IF jsonb_typeof(ops) IS DISTINCT FROM 'array' OR jsonb_array_length(ops)>10000 THEN
      RAISE EXCEPTION 'CATALOG_INVALID_OPERATIONS' USING ERRCODE='22023';
    END IF;
    FOR op IN SELECT value FROM jsonb_array_elements(ops) LOOP
      IF coalesce(op->>'kind','') NOT IN ('create','patch','reorder','delete')
        OR (entity<>'product_categories' AND op->>'kind'='delete') THEN
        RAISE EXCEPTION 'CATALOG_DESTRUCTIVE_OPERATION_FORBIDDEN' USING ERRCODE='22023';
      END IF;
      IF entity='product_variants' AND op->>'kind'<>'create' AND EXISTS(
        SELECT 1 FROM jsonb_object_keys(coalesce(op->'changes','{}')) k WHERE k NOT IN (
          'product_category_id','myacg_item_code','product_title','variant_name','raw_variant_name',
          'myacg_auto_quantity','effective_myacg_quantity','sort_order','catalog_missing','source')) THEN
        RAISE EXCEPTION 'CATALOG_MANUAL_METADATA_FORBIDDEN' USING ERRCODE='22023';
      END IF;
      IF entity='product_variants' AND op->>'kind'<>'create' AND coalesce(op->'changes','{}') ? 'source'
        AND NOT exact_replay AND NOT (
          p_request->>'mode'='create'
          AND op->>'kind'='patch'
          AND op->'expected'->>'source'='inventory_import'
          AND op->'changes'->>'source'='myacg_order_import'
          AND EXISTS(
            SELECT 1
            FROM public.product_variants v
            JOIN public.product_groups g ON g.id=v.product_group_id AND g.deleted_at IS NULL
            WHERE v.id=(op->>'id')::uuid
              AND v.deleted_at IS NULL
              AND v.source='inventory_import'
              AND coalesce(g.show_in_purchase_list,false)=false
              AND v.myacg_item_code<>''
              AND (SELECT count(*) FROM public.inventory_items i
                   WHERE i.deleted_at IS NULL
                     AND i.myacg_item_code=v.myacg_item_code
                     AND i.product_title=v.product_title
                     AND coalesce(i.raw_variant_name,'')=coalesce(v.raw_variant_name,'')
                     AND coalesce(nullif(i.normalized_product_title,''),lower(btrim(i.product_title)))
                       =coalesce(nullif(g.normalized_title,''),lower(btrim(g.title))))=1
              AND EXISTS(
                SELECT 1 FROM jsonb_array_elements(p_request->'operations'->'product_groups') group_op
                WHERE group_op->>'kind'='patch'
                  AND group_op->>'id'=v.product_group_id::text
                  AND group_op->'expected'->'show_in_purchase_list'='false'::jsonb
                  AND group_op->'changes'->'show_in_purchase_list'='true'::jsonb
              )
          )
        ) THEN
        RAISE EXCEPTION 'CATALOG_PROVENANCE_TRANSITION_FORBIDDEN' USING ERRCODE='22023';
      END IF;
    END LOOP;
  END LOOP;
  BEGIN
    INSERT INTO public.erp_idempotency_keys(actor_id,idempotency_key,operation_type,request_fingerprint,request_payload,status)
      VALUES(actor,p_idempotency_key,'edit',md5(p_request::text),p_request,'processing')
      ON CONFLICT(actor_id,idempotency_key) DO NOTHING RETURNING true INTO claimed;
    IF NOT coalesce(claimed,false) THEN
      SELECT * INTO old_request FROM public.erp_idempotency_keys WHERE actor_id=actor AND idempotency_key=p_idempotency_key FOR UPDATE;
      IF old_request.request_payload IS DISTINCT FROM p_request THEN RETURN jsonb_build_object('ok',false,'code','IDEMPOTENCY_KEY_PAYLOAD_MISMATCH'); END IF;
      IF old_request.status<>'completed' THEN RAISE EXCEPTION 'CATALOG_INCOMPLETE'; END IF;
      RETURN jsonb_set(old_request.canonical_result,'{replayed}','true',true);
    END IF;
    -- Full dependency CAS also prevents a fresh plan from creating a duplicate
    -- group/variant while another editor or import changes the catalog.
    LOCK TABLE public.inventory_items,public.product_groups,public.product_categories,public.product_variants IN SHARE ROW EXCLUSIVE MODE;
    FOREACH entity IN ARRAY ARRAY['inventory_items','product_groups','product_categories','product_variants'] LOOP
      EXECUTE format('SELECT coalesce(jsonb_agg(jsonb_build_object(''id'',id,''version'',version) ORDER BY id),''[]''::jsonb) FROM public.%I WHERE deleted_at IS NULL',entity) INTO current_versions;
      IF current_versions IS DISTINCT FROM p_request->'dependencies'->entity THEN
        failure:=jsonb_build_object('ok',false,'code','FIELD_CONFLICT','entity',entity); RAISE EXCEPTION 'CATALOG_ROLLBACK';
      END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_request->'operations'->'product_groups') o
      JOIN public.product_groups g ON g.title=o->'values'->>'title' AND g.deleted_at IS NULL WHERE o->>'kind'='create') THEN
      RAISE EXCEPTION 'CATALOG_DUPLICATE_GROUP';
    END IF;
    FOREACH entity IN ARRAY ARRAY['product_groups','product_categories','product_variants','product_categories'] LOOP
      SELECT coalesce(jsonb_agg(o),'[]') INTO ops FROM jsonb_array_elements(p_request->'operations'->entity) o
        WHERE CASE WHEN entity='product_categories' THEN
          CASE WHEN categories_written THEN o->>'kind'='delete' ELSE o->>'kind'<>'delete' END ELSE true END;
      IF jsonb_array_length(ops)>0 THEN
        result:=public.erp_apply_field_mutations(entity,ops);
        IF result->>'ok' IS DISTINCT FROM 'true' THEN failure:=result; RAISE EXCEPTION 'CATALOG_ROLLBACK'; END IF;
      END IF;
      IF entity='product_categories' THEN categories_written:=true; END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM public.product_variants v
      JOIN jsonb_array_elements(p_request->'operations'->'product_variants') o ON v.id=(o->>'id')::uuid
      LEFT JOIN public.product_groups g ON g.id=v.product_group_id AND g.deleted_at IS NULL
      LEFT JOIN public.product_categories c ON c.id=v.product_category_id AND c.deleted_at IS NULL
      WHERE v.deleted_at IS NULL AND (g.id IS NULL OR (v.product_category_id IS NOT NULL AND
        (c.id IS NULL OR c.product_group_id IS DISTINCT FROM v.product_group_id)))) THEN RAISE EXCEPTION 'CATALOG_RELATIONSHIP_INVALID'; END IF;
    IF EXISTS(SELECT 1 FROM public.product_variants v JOIN public.product_categories c ON c.id=v.product_category_id
      JOIN jsonb_array_elements(p_request->'operations'->'product_categories') o ON c.id=(o->>'id')::uuid
      WHERE v.deleted_at IS NULL AND c.deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'CATALOG_ACTIVE_CATEGORY_REFERENCE'; END IF;
    IF EXISTS(SELECT 1 FROM public.product_variants v
      JOIN jsonb_array_elements(p_request->'operations'->'product_variants') o ON v.id=(o->>'id')::uuid
      JOIN public.product_variants other ON other.id<>v.id AND other.deleted_at IS NULL
        AND other.product_group_id=v.product_group_id AND other.myacg_item_code=v.myacg_item_code
        AND coalesce(other.raw_variant_name,'')=coalesce(v.raw_variant_name,'') AND other.product_title=v.product_title
      WHERE o->>'kind'='create' AND v.deleted_at IS NULL) THEN RAISE EXCEPTION 'CATALOG_DUPLICATE_VARIANT'; END IF;
    result:=jsonb_build_object('ok',true,'replayed',false,'idempotencyKey',p_idempotency_key);
    UPDATE public.erp_idempotency_keys SET status='completed',canonical_result=result,completed_at=clock_timestamp()
      WHERE actor_id=actor AND idempotency_key=p_idempotency_key;
    RETURN result;
  EXCEPTION WHEN OTHERS THEN
    IF failure IS NOT NULL THEN RETURN failure; END IF;
    RETURN jsonb_build_object('ok',false,'code','TRANSACTION_REJECTED','sqlstate',SQLSTATE);
  END;
END; $$;
COMMENT ON FUNCTION public.erp_apply_catalog_transaction(uuid,jsonb) IS
  'Atomic Catalog transaction; create mode permits only guarded inventory_import to myacg_order_import projection.';
REVOKE ALL ON FUNCTION public.erp_apply_catalog_transaction(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_catalog_transaction(uuid,jsonb) TO authenticated;
COMMIT;
