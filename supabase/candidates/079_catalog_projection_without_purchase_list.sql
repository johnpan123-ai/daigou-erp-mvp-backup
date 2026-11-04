-- 079 Candidate only. Owner approval + Codex review required before applying to ERP2; never apply to ERP1.
-- Location: supabase/candidates/ (outside the canonical chain on purpose). Adoption = move to supabase/sql/ and add to
-- supabase/canonicalFreshInstallV3.mjs after Owner approval and Codex review (release-control step).
-- Business rule (Owner 2026-11-04): 採購總表 only lists products the Owner explicitly added.
-- Importing / projecting BuyAnime rows into 訂購紀錄 (Catalog 'create'), BuyAnime sync ('sync') and
-- reparse must not add or remove a product from 採購總表 (product_groups.show_in_purchase_list).
-- Change: erp_apply_catalog_transaction only (validation block). CAS, dependency versions, idempotency,
-- receipts, exact-replay handling, locks and the write helper are unchanged. No schema/data change.
-- Rollback: re-run the erp_apply_catalog_transaction definition from 070 (restores the paired
-- projection rule); existing rows are not touched by either direction.
BEGIN;

CREATE OR REPLACE FUNCTION public.erp_apply_catalog_transaction(p_idempotency_key uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor uuid:=auth.uid(); claimed boolean; exact_replay boolean:=false;
  old_request public.erp_idempotency_keys%ROWTYPE;
  entity text; current_versions jsonb; ops jsonb; result jsonb; failure jsonb; op jsonb;
  categories_written boolean:=false; started_at timestamptz:=clock_timestamp(); phase_at timestamptz:=clock_timestamp();
  phases jsonb:='{}'::jsonb;
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
      -- 079: Purchase Records projection (explicit 'create') is a provenance change only. It no longer
      -- requires, and never performs, a 採購總表 (show_in_purchase_list) change; the identity checks stay.
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
              AND v.myacg_item_code<>''
              AND (SELECT count(*) FROM public.inventory_items i
                   WHERE i.deleted_at IS NULL
                     AND i.myacg_item_code=v.myacg_item_code
                     AND i.product_title=v.product_title
                     AND coalesce(i.raw_variant_name,'')=coalesce(v.raw_variant_name,'')
                     AND coalesce(nullif(i.normalized_product_title,''),lower(btrim(i.product_title)))
                       =coalesce(nullif(g.normalized_title,''),lower(btrim(g.title))))=1
          )
        ) THEN
        RAISE EXCEPTION 'CATALOG_PROVENANCE_TRANSITION_FORBIDDEN' USING ERRCODE='22023';
      END IF;
      -- 079: 採購總表 membership is changed only by the explicit add/remove action (field CAS path).
      -- A Catalog transaction (BuyAnime sync, projection, reparse) may neither set nor clear it, and a
      -- group it creates starts outside 採購總表. Exact completed replays are answered before any write.
      IF entity='product_groups' AND NOT exact_replay AND (
          (op->>'kind'='patch' AND coalesce(op->'changes','{}') ? 'show_in_purchase_list')
          OR (op->>'kind'='create' AND coalesce(op->'values'->'show_in_purchase_list','false'::jsonb) IS DISTINCT FROM 'false'::jsonb)
        ) THEN
        RAISE EXCEPTION 'CATALOG_PURCHASE_LIST_CHANGE_FORBIDDEN' USING ERRCODE='22023';
      END IF;
    END LOOP;
  END LOOP;
  phases:=jsonb_build_object('validationMs',extract(epoch from clock_timestamp()-started_at)*1000); phase_at:=clock_timestamp();
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
    phases:=phases||jsonb_build_object('lockIdempotencyMs',extract(epoch from clock_timestamp()-phase_at)*1000); phase_at:=clock_timestamp();
    FOREACH entity IN ARRAY ARRAY['inventory_items','product_groups','product_categories','product_variants'] LOOP
      EXECUTE format('SELECT coalesce(jsonb_agg(jsonb_build_object(''id'',id,''version'',version) ORDER BY id),''[]''::jsonb) FROM public.%I WHERE deleted_at IS NULL',entity) INTO current_versions;
      IF current_versions IS DISTINCT FROM p_request->'dependencies'->entity THEN
        failure:=jsonb_build_object('ok',false,'code','FIELD_CONFLICT','entity',entity); RAISE EXCEPTION 'CATALOG_ROLLBACK';
      END IF;
    END LOOP;
    phases:=phases||jsonb_build_object('dependencyCasMs',extract(epoch from clock_timestamp()-phase_at)*1000); phase_at:=clock_timestamp();
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_request->'operations'->'product_groups') o
      JOIN public.product_groups g ON g.title=o->'values'->>'title' AND g.deleted_at IS NULL WHERE o->>'kind'='create') THEN
      RAISE EXCEPTION 'CATALOG_DUPLICATE_GROUP';
    END IF;
    FOREACH entity IN ARRAY ARRAY['product_groups','product_categories','product_variants','product_categories'] LOOP
      SELECT coalesce(jsonb_agg(o),'[]') INTO ops FROM jsonb_array_elements(p_request->'operations'->entity) o
        WHERE CASE WHEN entity='product_categories' THEN
          CASE WHEN categories_written THEN o->>'kind'='delete' ELSE o->>'kind'<>'delete' END ELSE true END;
      IF jsonb_array_length(ops)>0 THEN
        phase_at:=clock_timestamp(); result:=public.erp_apply_catalog_fields_set_based(entity,ops);
        phases:=phases||jsonb_build_object(entity||CASE WHEN entity='product_categories' AND categories_written THEN '_delete' ELSE '' END||'Ms',extract(epoch from clock_timestamp()-phase_at)*1000);
        IF result->>'ok' IS DISTINCT FROM 'true' THEN failure:=result; RAISE EXCEPTION 'CATALOG_ROLLBACK'; END IF;
      END IF;
      IF entity='product_categories' THEN categories_written:=true; END IF;
    END LOOP;
    phase_at:=clock_timestamp();
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
    phases:=phases||jsonb_build_object('integrityMs',extract(epoch from clock_timestamp()-phase_at)*1000,'totalMs',extract(epoch from clock_timestamp()-started_at)*1000);
    result:=jsonb_build_object('ok',true,'replayed',false,'idempotencyKey',p_idempotency_key,'serverPhases',phases);
    UPDATE public.erp_idempotency_keys SET status='completed',canonical_result=result,completed_at=clock_timestamp()
      WHERE actor_id=actor AND idempotency_key=p_idempotency_key;
    RETURN result;
  EXCEPTION WHEN OTHERS THEN
    IF failure IS NOT NULL THEN RETURN failure; END IF;
    RETURN jsonb_build_object('ok',false,'code','TRANSACTION_REJECTED','sqlstate',SQLSTATE);
  END;
END; $$;
COMMENT ON FUNCTION public.erp_apply_catalog_transaction(uuid,jsonb) IS
  'Atomic Catalog transaction (079): create mode permits only guarded inventory_import to myacg_order_import projection; no Catalog mode may change 採購總表 (show_in_purchase_list), new groups start outside it.';
REVOKE ALL ON FUNCTION public.erp_apply_catalog_transaction(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_catalog_transaction(uuid,jsonb) TO authenticated;
COMMIT;
