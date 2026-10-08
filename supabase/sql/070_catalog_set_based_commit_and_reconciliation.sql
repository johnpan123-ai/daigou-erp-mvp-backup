-- Catalog heavy-commit reliability: same atomic/CAS contract, no new durable resources.
-- Shared field mutation RPC and all executed migrations remain unchanged.
BEGIN;
CREATE OR REPLACE FUNCTION public.erp_apply_catalog_fields_set_based(
  p_entity text,
  p_operations jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_table regclass;
  v_create_allowed text[];
  v_patch_allowed text[];
  v_reorder_allowed text[] := ARRAY[]::text[];
  v_operation jsonb;
  v_kind text;
  v_id uuid;
  v_current jsonb;
  v_values jsonb;
  v_changes jsonb;
  v_expected jsonb;
  v_keys text[];
  v_key text;
  v_set_sql text;
  v_columns_sql text;
  v_values_sql text;
  v_shape record;
  v_affected integer;
  v_total integer := 0;
  v_conflicts jsonb;
  v_expected_version integer;
  v_seen_ids text[] := ARRAY[]::text[];
  v_protected constant text[] := ARRAY[
    'id', 'created_at', 'updated_at', 'updated_by', 'version', 'deleted_at', 'sync_status'
  ];
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_editor(auth.uid()) THEN
    RAISE EXCEPTION 'CLOUD_FIELD_CAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_operations) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'CLOUD_FIELD_CAS_OPERATIONS_MUST_BE_ARRAY' USING ERRCODE = '22023';
  END IF;

  -- Both table and fields are resolved exclusively from this server-owned whitelist.
  CASE p_entity
    WHEN 'product_groups' THEN
      v_table := 'public.product_groups'::regclass;
      v_create_allowed := ARRAY['local_id','title','normalized_title','listing_type','priority','purchase_date','closing_date','release_month','has_official_site','product_url','proxy_agent','show_in_purchase_list'];
      v_patch_allowed := array_remove(v_create_allowed, 'local_id');
    WHEN 'product_categories' THEN
      v_table := 'public.product_categories'::regclass;
      v_create_allowed := ARRAY['local_id','product_group_id','title','sort_order'];
      v_patch_allowed := array_remove(v_create_allowed, 'local_id');
      v_reorder_allowed := ARRAY['sort_order'];
    WHEN 'product_variants' THEN
      v_table := 'public.product_variants'::regclass;
      v_create_allowed := ARRAY['local_id','product_group_id','product_category_id','myacg_item_code','product_title','variant_name','raw_variant_name','myacg_auto_quantity','effective_myacg_quantity','myacg_manual_adjustment','waca_auto_quantity','waca_manual_adjustment','private_manual_adjustment','purchased_manual_adjustment','note','sort_order','catalog_missing','source','default_jpy_cost','default_twd_cost'];
      v_patch_allowed := array_remove(v_create_allowed, 'local_id');
      v_reorder_allowed := ARRAY['sort_order'];
    ELSE
      RAISE EXCEPTION 'CLOUD_FIELD_CAS_ENTITY_NOT_ALLOWED:%', p_entity USING ERRCODE = '22023';
  END CASE;

  -- Phase 1: deterministic advisory locks + row locks + validation. No DML occurs here.
  FOR v_operation IN
    SELECT value FROM jsonb_array_elements(p_operations) ORDER BY value->>'id', value->>'kind'
  LOOP
    v_kind := v_operation->>'kind';
    BEGIN
      v_id := (v_operation->>'id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'CLOUD_FIELD_CAS_CANONICAL_UUID_REQUIRED' USING ERRCODE = '22023';
    END;
    IF v_id IS NULL THEN RAISE EXCEPTION 'CLOUD_FIELD_CAS_CANONICAL_UUID_REQUIRED' USING ERRCODE='22023'; END IF;
    IF v_id::text = ANY(v_seen_ids) THEN
      RAISE EXCEPTION 'CLOUD_FIELD_CAS_DUPLICATE_OPERATION_ID:%', v_id USING ERRCODE = '22023';
    END IF;
    v_seen_ids := array_append(v_seen_ids, v_id::text);
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_entity || ':' || v_id::text, 0));
    EXECUTE format('SELECT to_jsonb(target) FROM %s AS target WHERE target.id = $1 FOR UPDATE', v_table)
      INTO v_current USING v_id;

    IF v_kind = 'create' THEN
      IF v_current IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE_CREATE', 'entity', p_entity, 'recordId', v_id);
      END IF;
      v_values := COALESCE(v_operation->'values', '{}'::jsonb);
      IF jsonb_typeof(v_values) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'CLOUD_FIELD_CAS_VALUES_MUST_BE_OBJECT' USING ERRCODE = '22023';
      END IF;
      SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO v_keys FROM jsonb_object_keys(v_values) key;
      IF v_keys && v_protected OR NOT v_keys <@ v_create_allowed THEN
        RAISE EXCEPTION 'CLOUD_FIELD_CAS_CREATE_FIELD_NOT_ALLOWED' USING ERRCODE = '22023';
      END IF;
    ELSIF v_kind IN ('patch', 'reorder') THEN
      IF v_current IS NULL OR (v_current ? 'deleted_at' AND v_current->'deleted_at' <> 'null'::jsonb) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'RECORD_DELETED_OR_MISSING', 'entity', p_entity, 'recordId', v_id);
      END IF;
      v_changes := COALESCE(v_operation->'changes', '{}'::jsonb);
      v_expected := COALESCE(v_operation->'expected', '{}'::jsonb);
      IF jsonb_typeof(v_changes) IS DISTINCT FROM 'object' OR jsonb_typeof(v_expected) IS DISTINCT FROM 'object' OR v_changes = '{}'::jsonb THEN
        RAISE EXCEPTION 'CLOUD_FIELD_CAS_PATCH_INVALID' USING ERRCODE = '22023';
      END IF;
      SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO v_keys FROM jsonb_object_keys(v_changes) key;
      IF v_keys && v_protected OR (v_kind = 'patch' AND NOT v_keys <@ v_patch_allowed) OR (v_kind = 'reorder' AND NOT v_keys <@ v_reorder_allowed) THEN
        RAISE EXCEPTION 'CLOUD_FIELD_CAS_PATCH_FIELD_NOT_ALLOWED' USING ERRCODE = '22023';
      END IF;
      IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_expected) key) IS DISTINCT FROM v_keys THEN
        RAISE EXCEPTION 'CLOUD_FIELD_CAS_EXPECTED_KEYS_MISMATCH' USING ERRCODE = '22023';
      END IF;
      IF v_kind = 'reorder' AND (v_current->>'version')::integer IS DISTINCT FROM (v_operation->>'expectedVersion')::integer THEN
        RETURN jsonb_build_object('ok', false, 'code', 'REORDER_CONFLICT', 'entity', p_entity, 'recordId', v_id);
      END IF;
      IF v_kind = 'patch' AND jsonb_typeof(v_operation->'observedVersion') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'CLOUD_FIELD_CAS_OBSERVED_VERSION_REQUIRED' USING ERRCODE = '22023';
      END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('field', key, 'expected', v_expected->key, 'current', v_current->key) ORDER BY key), '[]'::jsonb)
        INTO v_conflicts
        FROM unnest(v_keys) key
       WHERE NOT (v_current->key IS NOT DISTINCT FROM v_expected->key);
      IF jsonb_array_length(v_conflicts) > 0 THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', CASE WHEN v_kind = 'reorder' THEN 'REORDER_CONFLICT' ELSE 'FIELD_CONFLICT' END,
          'entity', p_entity,
          'recordId', v_id,
          'conflicts', v_conflicts
        );
      END IF;
    ELSIF v_kind = 'delete' THEN
      IF v_current IS NULL OR (v_current ? 'deleted_at' AND v_current->'deleted_at' <> 'null'::jsonb) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'RECORD_DELETED_OR_MISSING', 'entity', p_entity, 'recordId', v_id);
      END IF;
      v_expected_version := (v_operation->>'expectedVersion')::integer;
      IF (v_current->>'version')::integer IS DISTINCT FROM v_expected_version THEN
        RETURN jsonb_build_object('ok', false, 'code', 'STALE_DELETE', 'entity', p_entity, 'recordId', v_id);
      END IF;
    ELSE
      RAISE EXCEPTION 'CLOUD_FIELD_CAS_OPERATION_NOT_ALLOWED:%', v_kind USING ERRCODE = '22023';
    END IF;
  END LOOP;


  -- A field shape is a server-validated set of touched columns. Keeping separate
  -- shapes preserves defaults for omitted CREATE fields and explicit NULL values.
  -- No full-row RETURNING or growing JSON result is needed by the Catalog caller.
  FOR v_shape IN
    SELECT kind, keys, jsonb_agg(payload ORDER BY payload->>'id') AS payloads, count(*) AS expected_count
    FROM (
      SELECT value->>'kind' AS kind,
        ARRAY(SELECT key FROM jsonb_object_keys(CASE WHEN value->>'kind'='create'
          THEN value->'values' WHEN value->>'kind' IN ('patch','reorder') THEN value->'changes'
          ELSE '{}'::jsonb END) key ORDER BY key) AS keys,
        CASE WHEN value->>'kind'='create' THEN coalesce(value->'values','{}'::jsonb)
          WHEN value->>'kind' IN ('patch','reorder') THEN value->'changes'
          ELSE '{}'::jsonb END || jsonb_build_object('id',value->>'id') AS payload
      FROM jsonb_array_elements(p_operations)
    ) prepared
    GROUP BY kind, keys ORDER BY kind, keys
  LOOP
    v_keys := v_shape.keys;
    IF v_shape.kind='create' THEN
      v_columns_sql := array_to_string(ARRAY(SELECT format('%I', key) FROM unnest(v_keys) key), ', ');
      v_values_sql := array_to_string(ARRAY(SELECT format('typed.%I', key) FROM unnest(v_keys) key), ', ');
      EXECUTE format(
        'INSERT INTO %s (id, updated_by%s) SELECT typed.id, auth.uid()%s FROM jsonb_populate_recordset(NULL::%s,$1) typed',
        v_table, CASE WHEN cardinality(v_keys)>0 THEN ', '||v_columns_sql ELSE '' END,
        CASE WHEN cardinality(v_keys)>0 THEN ', '||v_values_sql ELSE '' END, v_table
      ) USING v_shape.payloads;
    ELSIF v_shape.kind IN ('patch','reorder') THEN
      v_set_sql := array_to_string(ARRAY(SELECT format('%I = typed.%I', key, key) FROM unnest(v_keys) key), ', ');
      EXECUTE format(
        'UPDATE %s target SET %s, version=target.version+1, updated_at=clock_timestamp(), updated_by=auth.uid(), sync_status=''synced'' FROM jsonb_populate_recordset(NULL::%s,$1) typed WHERE target.id=typed.id',
        v_table,v_set_sql,v_table
      ) USING v_shape.payloads;
    ELSE
      EXECUTE format(
        'UPDATE %s target SET deleted_at=clock_timestamp(), version=target.version+1, updated_at=clock_timestamp(), updated_by=auth.uid(), sync_status=''synced'' FROM jsonb_to_recordset($1) typed(id uuid) WHERE target.id=typed.id',
        v_table
      ) USING v_shape.payloads;
    END IF;
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected IS DISTINCT FROM v_shape.expected_count THEN
      RAISE EXCEPTION 'CATALOG_WRITE_COUNT_MISMATCH' USING ERRCODE='22023';
    END IF;
    v_total := v_total+v_affected;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'entity',p_entity,'affected',v_total);
END;
$$;
REVOKE ALL ON FUNCTION public.erp_apply_catalog_fields_set_based(text,jsonb) FROM PUBLIC,anon,authenticated;
COMMENT ON FUNCTION public.erp_apply_catalog_fields_set_based(text,jsonb) IS
  'Private Catalog-only field CAS helper; validated field-shape set-based writes. No direct client grant.';

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
  'Atomic Catalog transaction; create mode permits only guarded inventory_import to myacg_order_import projection.';
REVOKE ALL ON FUNCTION public.erp_apply_catalog_transaction(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_catalog_transaction(uuid,jsonb) TO authenticated;


CREATE OR REPLACE FUNCTION public.erp_reconcile_catalog_transaction(p_idempotency_key uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='3s' SET lock_timeout='100ms' AS $$
DECLARE actor uuid:=auth.uid(); receipt public.erp_idempotency_keys%ROWTYPE;
BEGIN
  IF actor IS NULL OR NOT public.is_editor(actor) THEN RAISE EXCEPTION 'CATALOG_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_idempotency_key IS NULL OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' OR p_request->>'family' IS DISTINCT FROM 'catalog' THEN
    RAISE EXCEPTION 'CATALOG_INVALID_REQUEST' USING ERRCODE='22023';
  END IF;
  -- A read-only, NOWAIT fence cannot mistake an uncommitted receipt for absence.
  -- Any concurrent mutation yields UNKNOWN rather than waiting or replaying.
  BEGIN
    LOCK TABLE public.erp_idempotency_keys IN SHARE MODE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN jsonb_build_object('outcome','UNKNOWN','code','CATALOG_REQUEST_IN_FLIGHT');
  END;
  SELECT * INTO receipt FROM public.erp_idempotency_keys WHERE actor_id=actor AND idempotency_key=p_idempotency_key;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','NOT_COMMITTED','code','CATALOG_RECEIPT_ABSENT'); END IF;
  IF receipt.request_payload IS DISTINCT FROM p_request THEN
    RETURN jsonb_build_object('outcome','UNKNOWN','code','IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
  END IF;
  IF receipt.status='completed' AND receipt.canonical_result->>'ok'='true' THEN
    RETURN jsonb_build_object('outcome','COMMITTED','code','CATALOG_RECONCILED_COMMITTED','result',receipt.canonical_result);
  END IF;
  RETURN jsonb_build_object('outcome','UNKNOWN','code','CATALOG_RECEIPT_INCOMPLETE');
END; $$;
REVOKE ALL ON FUNCTION public.erp_reconcile_catalog_transaction(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.erp_reconcile_catalog_transaction(uuid,jsonb) TO authenticated;
COMMENT ON FUNCTION public.erp_reconcile_catalog_transaction(uuid,jsonb) IS
  'Editor actor-scoped exact-request receipt reconciliation; read-only fenced classification, no business replay.';

NOTIFY pgrst, 'reload schema';
COMMIT;
