-- Prepare-only successor. Keep every proof, staged row, owner/CAS and Execute
-- contract. Avoid binary aggregate copies and one full array scan PER column.
BEGIN;
DO $preflight$
BEGIN
 IF current_user <> 'postgres'
  OR to_regprocedure('public.erp_finalize_restore_upload(uuid)') IS NULL
  OR to_regclass('public.erp_restore_stage_inventory_items') IS NULL THEN
  RAISE EXCEPTION USING errcode='55000',message='RESTORE_061_PRECONDITION_MISSING';
 END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.erp_cloud_restore_stage_candidate(
 p_proof_id uuid,p_actor_key text,p_effective_snapshot jsonb,p_expires_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_resource text;v_resource_rows jsonb;v_profile jsonb;v_profiles jsonb:='{}';
 v_total_rows bigint:=0;v_total_bytes bigint:=0;v_payload_hash text;
 v_columns text;v_select_columns text;v_columns_by_resource jsonb:='{}';
BEGIN
 IF p_actor_key !~ '^[0-9a-f]{64}$' OR p_expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_STAGE_IDENTITY_INVALID'; END IF;
 DELETE FROM public.erp_cloud_restore_prepared_chunks WHERE proof_id=p_proof_id;
 FOREACH v_resource IN ARRAY ARRAY[
  'inventory_items','product_groups','product_categories','product_variants','bundle_components',
  'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
  'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
  'waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state'
 ] LOOP
  v_resource_rows:=p_effective_snapshot->v_resource;
  IF jsonb_typeof(v_resource_rows) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_RESOURCE_REQUIRED:'||v_resource; END IF;
  INSERT INTO public.erp_cloud_restore_prepared_chunks(
   proof_id,actor_key,resource,chunk_ordinal,row_count,rows,payload_hash,expires_at
  )
  WITH grouped AS (
   SELECT ((ordinality-1)/256)::integer chunk_ordinal,count(*)::integer row_count,
    json_agg(row_value ORDER BY ordinality)::jsonb rows
   FROM jsonb_array_elements(v_resource_rows) WITH ORDINALITY source(row_value,ordinality)
   WHERE CASE WHEN jsonb_typeof(row_value)='object' THEN true
    ELSE public.erp_cloud_restore_reject_invalid_portable_row(v_resource) END
   GROUP BY ((ordinality-1)/256)::integer
  )
  SELECT p_proof_id,p_actor_key,v_resource,chunk_ordinal,row_count,rows,
   encode(extensions.digest(convert_to(rows::text,'UTF8'),'sha256'),'hex'),p_expires_at FROM grouped;

  -- One exact union of supplied keys across ALL rows, including fields first
  -- supplied in a later row. Never infer columns from only the first row.
  WITH supplied_columns AS MATERIALIZED (
   SELECT DISTINCT supplied.key FROM jsonb_array_elements(v_resource_rows) row_value
    CROSS JOIN LATERAL jsonb_object_keys(row_value) supplied(key)
  )
  SELECT string_agg(quote_ident(a.attname),',' ORDER BY a.attnum),
   string_agg('r.'||quote_ident(a.attname),',' ORDER BY a.attnum)
  INTO v_columns,v_select_columns FROM pg_attribute a
   JOIN supplied_columns supplied ON supplied.key=a.attname
  WHERE a.attrelid=format('public.%I',v_resource)::regclass AND a.attnum>0
   AND NOT a.attisdropped AND a.attgenerated='';
  IF v_columns IS NOT NULL THEN
   EXECUTE format('insert into public.%I (restore_proof_id,%s) select $1,%s from jsonb_populate_recordset(null::public.%I,$2) r',
    'erp_restore_stage_'||v_resource,v_columns,v_select_columns,v_resource)
    USING p_proof_id,v_resource_rows;
  END IF;
  v_columns_by_resource:=v_columns_by_resource||jsonb_build_object(v_resource,v_columns);
  v_profile:=public.erp_cloud_restore_prepared_profile(p_proof_id,v_resource);
  IF (v_profile->>'missingIdentityCount')::bigint>0 THEN
   RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_IDENTITY_REQUIRED:'||v_resource; END IF;
  IF (v_profile->>'duplicateIdentityCount')::bigint>0 THEN
   RAISE EXCEPTION USING errcode='23505',message='DUPLICATE_CANONICAL_ID:'||v_resource; END IF;
  IF v_resource='product_variants' AND (v_profile->>'duplicateAuxiliaryIdentityCount')::bigint>0 THEN
   RAISE EXCEPTION USING errcode='23505',message='DUPLICATE_VARIANT_LOCAL_ID'; END IF;
  v_profiles:=v_profiles||jsonb_build_object(v_resource,v_profile);
  v_total_rows:=v_total_rows+(v_profile->>'count')::bigint;
 END LOOP;
 SELECT coalesce(sum(pg_column_size(rows)),0),
  encode(extensions.digest(convert_to(coalesce(string_agg(resource||':'||chunk_ordinal::text||':'||payload_hash,E'\n'
   ORDER BY resource COLLATE "C",chunk_ordinal),''),'UTF8'),'sha256'),'hex')
 INTO v_total_bytes,v_payload_hash FROM public.erp_cloud_restore_prepared_chunks WHERE proof_id=p_proof_id;
 UPDATE public.erp_cloud_restore_candidate_proofs SET prepared_columns=v_columns_by_resource WHERE proof_id=p_proof_id;
 RETURN jsonb_build_object('profiles',v_profiles,'rowCount',v_total_rows,'byteCount',v_total_bytes,'payloadHash',v_payload_hash);
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_cloud_restore_stage_candidate(uuid,text,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.erp_finalize_restore_upload(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
SET statement_timeout TO '25s'
AS $function$
DECLARE r public.erp_restore_upload_requests%rowtype;d jsonb;result jsonb;
 started timestamptz:=clock_timestamp();assembled timestamptz;phase text:='authorization';
BEGIN
 r:=public.erp_restore_upload_owner(p_request_id);
 IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-restore-upload:'||p_request_id::text,0)) THEN
  RAISE EXCEPTION USING errcode='55006',message='CLOUD_RESTORE_UPLOAD_BUSY'; END IF;
 IF r.completed_result IS NOT NULL THEN RETURN r.completed_result; END IF;
 IF r.source_generation IS DISTINCT FROM (SELECT generation FROM public.erp_restore_business_generation WHERE singleton)
  OR r.source_epoch IS DISTINCT FROM (SELECT epoch FROM public.erp_cloud_restore_epoch WHERE singleton) THEN
  RAISE EXCEPTION USING errcode='55000',message='STALE_RESTORE_PREPARE'; END IF;
 phase:='assembly';
 IF EXISTS(SELECT 1 FROM jsonb_each_text(r.manifest->'counts') expected
  LEFT JOIN (SELECT resource,sum(jsonb_array_length(rows)) n FROM public.erp_restore_upload_chunks
   WHERE request_id=p_request_id GROUP BY resource) actual ON actual.resource=expected.key
  WHERE coalesce(actual.n,0)<>expected.value::bigint) THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_INCOMPLETE'; END IF;
 -- Same ordered object, JSON aggregation then ONE binary conversion. The
 -- proof sees the identical JSONB value; hashes are not trusted from client.
 SELECT json_object_agg(expected.key,coalesce(actual.rows,'[]'::json))::jsonb INTO d
 FROM jsonb_object_keys(r.manifest->'counts') expected(key)
 LEFT JOIN LATERAL (SELECT json_agg(x.row_value ORDER BY c.ordinal,x.ordinality) rows
  FROM public.erp_restore_upload_chunks c CROSS JOIN LATERAL
   jsonb_array_elements(c.rows) WITH ORDINALITY x(row_value,ordinality)
  WHERE c.request_id=p_request_id AND c.resource=expected.key) actual ON true;
 assembled:=clock_timestamp();
 RAISE LOG 'CLOUD_RESTORE_PREPARE request=% phase=assembly elapsed_ms=%',p_request_id,
  (extract(epoch FROM assembled-started)*1000)::bigint;
 phase:='semantic-proof-and-stage';
 result:=public.erp_prove_cloud_restore_candidate_v2(d,r.manifest,r.restore_mode,r.source_environment,p_request_id);
 IF r.source_generation IS DISTINCT FROM (SELECT generation FROM public.erp_restore_business_generation WHERE singleton)
  OR r.source_epoch IS DISTINCT FROM (SELECT epoch FROM public.erp_cloud_restore_epoch WHERE singleton) THEN
  RAISE EXCEPTION USING errcode='55000',message='STALE_RESTORE_PREPARE'; END IF;
 result:=result||jsonb_build_object('uploadAssemblyMs',(extract(epoch FROM assembled-started)*1000)::bigint,
  'finalizeServerMs',(extract(epoch FROM clock_timestamp()-started)*1000)::bigint);
 UPDATE public.erp_restore_upload_requests SET completed_result=result WHERE request_id=p_request_id;
 DELETE FROM public.erp_restore_upload_chunks WHERE request_id=p_request_id;
 RETURN result;
EXCEPTION WHEN query_canceled THEN
 RAISE EXCEPTION USING errcode='57014',message='CLOUD_RESTORE_PREPARE_TIMEOUT',
  detail=jsonb_build_object('phase',phase,'requestId',p_request_id,'reasonCode','CLOUD_RESTORE_PREPARE_TIMEOUT')::text;
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_finalize_restore_upload(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erp_finalize_restore_upload(uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
