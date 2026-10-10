-- BuyAnime Inventory only. Existing generic/Catalog writers remain unchanged.
-- Receipts reuse erp_idempotency_keys (OPS/environment-local, not a 24-resource
-- business resource). Epoch binding prevents retained receipts replaying after Restore.
BEGIN;
CREATE FUNCTION public.erp_inventory_import_core(p_key uuid,p_request jsonb,p_commit boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
DECLARE
  actor uuid:=auth.uid(); receipt public.erp_idempotency_keys%ROWTYPE;
  ops jsonb; problem jsonb; shape record; keys text[]; columns_sql text; values_sql text;
  affected integer; total integer:=0; epoch bigint; result jsonb; rows jsonb;
  started timestamptz:=clock_timestamp(); phase_at timestamptz; phases jsonb;
  allowed constant text[]:=ARRAY['inventory_key','myacg_item_code','myacg_parent_code','product_id',
    'product_title','normalized_product_title','raw_variant_name','listing_type','final_price',
    'myacg_available_quantity','myacg_sold_quantity','myacg_demand_quantity','myacg_listed_at',
    'import_sort_index','latest_catalog_import_id','catalog_last_seen_at'];
BEGIN
  IF actor IS NULL OR NOT public.is_editor(actor) THEN
    RAISE EXCEPTION 'INVENTORY_IMPORT_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p_key IS NULL OR jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR p_request->>'family' IS DISTINCT FROM 'inventory_import'
    OR coalesce(p_request->>'batchId','') !~ '^catalog_import_[0-9a-f-]{36}$'
    OR jsonb_typeof(p_request->'restoreEpoch') IS DISTINCT FROM 'number'
    OR (p_request->>'restoreEpoch') !~ '^[0-9]+$'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_request) k)
       IS DISTINCT FROM ARRAY['batchId','family','operations','restoreEpoch']::text[] THEN
    RAISE EXCEPTION 'INVENTORY_IMPORT_REQUEST_INVALID' USING ERRCODE='22023';
  END IF;
  ops:=p_request->'operations';
  IF jsonb_typeof(ops) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVENTORY_IMPORT_OPERATIONS_INVALID' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(ops)>10000 THEN
    RAISE EXCEPTION 'INVENTORY_IMPORT_OPERATIONS_LIMIT' USING ERRCODE='22023';
  END IF;
  -- Same maintenance fence as business-generation triggers. Never wait behind
  -- an active Restore and then apply an old-generation intent.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) THEN
    RAISE EXCEPTION 'CLOUD_RESTORE_MAINTENANCE_LOCKED' USING ERRCODE='55006';
  END IF;
  SELECT e.epoch INTO STRICT epoch FROM public.erp_cloud_restore_epoch e WHERE e.singleton;
  IF epoch IS DISTINCT FROM (p_request->>'restoreEpoch')::bigint THEN
    RETURN jsonb_build_object('ok',false,'code','STALE_AFTER_RESTORE');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('inventory-import:'||actor::text||':'||p_key::text,0));
  SELECT * INTO receipt FROM public.erp_idempotency_keys WHERE actor_id=actor AND idempotency_key=p_key;
  IF FOUND THEN
    IF receipt.request_payload IS DISTINCT FROM p_request THEN
      RETURN jsonb_build_object('ok',false,'code','IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
    END IF;
    IF receipt.status<>'completed' THEN RETURN jsonb_build_object('ok',false,'code','INVENTORY_COMMIT_UNKNOWN'); END IF;
    RETURN receipt.canonical_result||jsonb_build_object('outcome','COMMITTED','replayed',true);
  END IF;
  -- Shape validation occurs before casting/expanding untrusted JSON.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(ops) o WHERE jsonb_typeof(o)<>'object'
    OR coalesce(o->>'id','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
    OR coalesce(o->>'kind','') NOT IN ('create','patch')) THEN
    RAISE EXCEPTION 'INVENTORY_IMPORT_OPERATION_INVALID' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(ops) o GROUP BY (o->>'id')::uuid HAVING count(*)>1) THEN
    RAISE EXCEPTION 'CLOUD_FIELD_CAS_DUPLICATE_OPERATION_ID' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(ops) o WHERE
    (o->>'kind'='create' AND jsonb_typeof(o->'values') IS DISTINCT FROM 'object') OR
    (o->>'kind'='patch' AND (jsonb_typeof(o->'changes') IS DISTINCT FROM 'object'
      OR jsonb_typeof(o->'expected') IS DISTINCT FROM 'object' OR o->'changes'='{}'
      OR jsonb_typeof(o->'observedVersion') IS DISTINCT FROM 'number'))) THEN
    RAISE EXCEPTION 'CLOUD_FIELD_CAS_PATCH_INVALID' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(ops) o WHERE
    (CASE WHEN o->>'kind'='create' THEN o->'values' ELSE o->'changes' END) - allowed <> '{}') THEN
    RAISE EXCEPTION 'CLOUD_FIELD_CAS_FIELD_NOT_ALLOWED' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(ops) o
    CROSS JOIN LATERAL jsonb_object_keys(o->'changes') k WHERE o->>'kind'='patch' AND NOT (o->'expected' ? k))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(ops) o
    CROSS JOIN LATERAL jsonb_object_keys(o->'expected') k WHERE o->>'kind'='patch' AND NOT (o->'changes' ? k)) THEN
    RAISE EXCEPTION 'CLOUD_FIELD_CAS_EXPECTED_KEYS_MISMATCH' USING ERRCODE='22023';
  END IF;
  phases:=jsonb_build_object('validationMs',extract(epoch FROM clock_timestamp()-started)*1000);
  phase_at:=clock_timestamp();
  -- The shared business-generation maintenance fence above is already exclusive
  -- across business writers. Existing rows additionally use ordered row locks;
  -- PK/unique constraints arbitrate new identities. Do not allocate 10,000
  -- advisory lock entries: lock-table capacity is finite on small Live compute.
  PERFORM i.id FROM public.inventory_items i JOIN jsonb_array_elements(ops) o ON i.id=(o->>'id')::uuid
    ORDER BY i.id FOR UPDATE OF i;
  phases:=phases||jsonb_build_object('lockMs',extract(epoch FROM clock_timestamp()-phase_at)*1000);
  phase_at:=clock_timestamp();
  WITH candidates AS MATERIALIZED (
    SELECT o, i.id, i.deleted_at, to_jsonb(i) current_row
    FROM jsonb_array_elements(ops) o LEFT JOIN public.inventory_items i ON i.id=(o->>'id')::uuid
  ), failures AS (
    SELECT o->>'id' id, CASE
      WHEN o->>'kind'='create' AND id IS NOT NULL THEN 'DUPLICATE_CREATE'
      WHEN o->>'kind'='patch' AND (id IS NULL OR deleted_at IS NOT NULL) THEN 'RECORD_DELETED_OR_MISSING'
      WHEN o->>'kind'='patch' AND EXISTS(SELECT 1 FROM jsonb_each(o->'expected') e
        WHERE current_row->e.key IS DISTINCT FROM e.value) THEN 'FIELD_CONFLICT' END code
    FROM candidates
  ) SELECT jsonb_build_object('ok',false,'code',code,'recordId',id,'entity','inventory_items')
    INTO problem FROM failures WHERE code IS NOT NULL ORDER BY id LIMIT 1;
  IF problem IS NOT NULL THEN RETURN problem; END IF;
  -- Keys, including tombstones, are never transferred to a different UUID.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(ops) o JOIN public.inventory_items i ON
    i.inventory_key=(CASE WHEN o->>'kind'='create' THEN o->'values' ELSE o->'changes' END)->>'inventory_key'
    WHERE i.id<>(o->>'id')::uuid) THEN
    RETURN jsonb_build_object('ok',false,'code','INVENTORY_IDENTITY_REPLACEMENT_FORBIDDEN');
  END IF;
  phases:=phases||jsonb_build_object('casMs',extract(epoch FROM clock_timestamp()-phase_at)*1000);
  IF NOT p_commit THEN
    RETURN jsonb_build_object('ok',true,'outcome','NOT_COMMITTED','restoreEpoch',epoch);
  END IF;
  phase_at:=clock_timestamp();
  -- Field-shape batching preserves omitted-field defaults and explicit NULLs.
  -- Business replacement is ONE transaction; no per-row SQL or result concat.
  FOR shape IN
    SELECT kind, field_keys, jsonb_agg(payload ORDER BY payload->>'id') payloads, count(*) expected_count
    FROM (
      SELECT o->>'kind' kind,
        ARRAY(SELECT k FROM jsonb_object_keys(CASE WHEN o->>'kind'='create' THEN o->'values' ELSE o->'changes' END) k ORDER BY k) field_keys,
        (CASE WHEN o->>'kind'='create' THEN o->'values' ELSE o->'changes' END)||jsonb_build_object('id',o->>'id') payload
      FROM jsonb_array_elements(ops) o
    ) prepared GROUP BY kind,field_keys ORDER BY kind,field_keys
  LOOP
    keys:=shape.field_keys;
    IF shape.kind='create' THEN
      columns_sql:=array_to_string(ARRAY(SELECT format('%I',k) FROM unnest(keys) k),',');
      values_sql:=array_to_string(ARRAY(SELECT format('t.%I',k) FROM unnest(keys) k),',');
      EXECUTE format('INSERT INTO public.inventory_items(id,updated_by%s) SELECT t.id,auth.uid()%s FROM jsonb_populate_recordset(NULL::public.inventory_items,$1) t',
        CASE WHEN cardinality(keys)>0 THEN ','||columns_sql ELSE '' END,
        CASE WHEN cardinality(keys)>0 THEN ','||values_sql ELSE '' END) USING shape.payloads;
    ELSE
      columns_sql:=array_to_string(ARRAY(SELECT format('%I=t.%I',k,k) FROM unnest(keys) k),',');
      EXECUTE format('UPDATE public.inventory_items i SET %s,version=i.version+1,updated_at=clock_timestamp(),updated_by=auth.uid(),sync_status=''synced'' FROM jsonb_populate_recordset(NULL::public.inventory_items,$1) t WHERE i.id=t.id',columns_sql) USING shape.payloads;
    END IF;
    GET DIAGNOSTICS affected=ROW_COUNT;
    IF affected<>shape.expected_count THEN RAISE EXCEPTION 'INVENTORY_WRITE_COUNT_MISMATCH'; END IF;
    total:=total+affected;
  END LOOP;
  phases:=phases||jsonb_build_object('writeMs',extract(epoch FROM clock_timestamp()-phase_at)*1000);
  phase_at:=clock_timestamp();
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'version',i.version,'key',i.inventory_key) ORDER BY i.id),'[]')
    INTO rows FROM public.inventory_items i JOIN jsonb_array_elements(ops) o ON i.id=(o->>'id')::uuid;
  IF jsonb_array_length(rows)<>jsonb_array_length(ops) THEN RAISE EXCEPTION 'INVENTORY_RESULT_COUNT_MISMATCH'; END IF;
  phases:=phases||jsonb_build_object('resultMs',extract(epoch FROM clock_timestamp()-phase_at)*1000,
    'totalMs',extract(epoch FROM clock_timestamp()-started)*1000);
  result:=jsonb_build_object('ok',true,'outcome','COMMITTED','replayed',false,'idempotencyKey',p_key,
    'restoreEpoch',epoch,'affected',total,'rows',rows,'serverPhases',phases);
  INSERT INTO public.erp_idempotency_keys(actor_id,idempotency_key,operation_type,request_fingerprint,request_payload,status,canonical_result,completed_at)
    VALUES(actor,p_key,'edit',md5(p_request::text),p_request,'completed',result,clock_timestamp());
  RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.erp_inventory_import_core(uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.erp_apply_inventory_import(p_idempotency_key uuid,p_request jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT public.erp_inventory_import_core(p_idempotency_key,p_request,true)
$$;
CREATE FUNCTION public.erp_reconcile_inventory_import(p_idempotency_key uuid,p_request jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' AS $$
  SELECT public.erp_inventory_import_core(p_idempotency_key,p_request,false)
$$;
REVOKE ALL ON FUNCTION public.erp_apply_inventory_import(uuid,jsonb),public.erp_reconcile_inventory_import(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_inventory_import(uuid,jsonb),public.erp_reconcile_inventory_import(uuid,jsonb) TO authenticated;
COMMENT ON FUNCTION public.erp_reconcile_inventory_import(uuid,jsonb) IS
  'Read-only business reconciliation: exact actor/request receipt or all-before field CAS. No receipt writes or business mutation.';
COMMIT;
