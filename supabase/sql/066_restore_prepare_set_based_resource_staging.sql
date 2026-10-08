-- Prepare OPS only. Keep Execute, all canonical validators, immutable chunk
-- identities, owner gates, source CAS, proof format and 25-second budget intact.
BEGIN;
DO $preflight$
BEGIN
 IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM pg_trigger
  WHERE tgrelid='public.erp_restore_upload_requests'::regclass AND tgname='erp_restore_initialize_upload_proof' AND tgenabled='O')
  OR to_regprocedure('public.erp_cloud_restore_prepared_profile(uuid,text)') IS NULL THEN
  RAISE EXCEPTION USING errcode='55000',message='RESTORE_066_PRECONDITION_MISSING'; END IF;
END;
$preflight$;
CREATE OR REPLACE FUNCTION public.erp_stage_restore_upload_resource(p_request_id uuid,p_resource text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions' SET statement_timeout TO '25s'
AS $function$
DECLARE r public.erp_restore_upload_requests%rowtype;c record;rows jsonb;projected jsonb:='[]';
 columns_sql text;select_sql text;profile jsonb;transformed bigint:=0;n bigint:=0;
 started timestamptz:=clock_timestamp();existing jsonb;policy text;source_fp text;invalid_row jsonb;phase_at timestamptz;phase_timings jsonb:='{}';
BEGIN
 r:=public.erp_restore_upload_owner(p_request_id);
 IF r.completed_result IS NOT NULL THEN RETURN jsonb_build_object('resource',p_resource,'completed',true); END IF;
 IF NOT(r.manifest->'counts' ? p_resource) OR p_resource<>ALL(ARRAY[
  'inventory_items','product_groups','product_categories','product_variants','bundle_components',
  'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
  'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
  'waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state']) THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_RESOURCE_NOT_ALLOWED'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-restore-stage:'||p_request_id||':'||p_resource,0)) THEN
  RAISE EXCEPTION USING errcode='55006',message='CLOUD_RESTORE_UPLOAD_BUSY'; END IF;
 IF r.source_generation IS DISTINCT FROM (SELECT generation FROM public.erp_restore_business_generation WHERE singleton)
  OR r.source_epoch IS DISTINCT FROM (SELECT epoch FROM public.erp_cloud_restore_epoch WHERE singleton) THEN
  RAISE EXCEPTION USING errcode='55000',message='STALE_RESTORE_PREPARE'; END IF;
 SELECT rp.profile INTO existing FROM public.erp_restore_upload_resource_proofs rp WHERE request_id=p_request_id AND resource=p_resource;
 IF FOUND THEN RETURN jsonb_build_object('resource',p_resource,'profile',existing,'replayed',true); END IF;
 IF (SELECT coalesce(sum(jsonb_array_length(ch.rows)),0) FROM public.erp_restore_upload_chunks ch
  WHERE request_id=p_request_id AND resource=p_resource) IS DISTINCT FROM (r.manifest->'counts'->>p_resource)::bigint THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_INCOMPLETE'; END IF;
 policy:=CASE WHEN r.restore_mode='strict' THEN 'strict' ELSE 'cross-environment-audit-null-v1' END;
 source_fp:=CASE WHEN r.restore_mode='strict' THEN r.manifest->>'snapshotFingerprint'
  ELSE r.manifest->'portability'->>'sourceSnapshotFingerprint' END;
 -- An incomplete proof is deliberately unexecutable: hash, relationship and
 -- source CAS stay NULL until final canonical validation succeeds atomically.
 IF NOT EXISTS(SELECT 1 FROM public.erp_cloud_restore_candidate_proofs p WHERE p.proof_id=p_request_id
  AND p.actor_key=r.actor_key AND p.manifest=r.manifest AND p.prepared_payload_hash IS NULL) THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_IDENTITY_MISMATCH'; END IF;
 phase_at:=clock_timestamp();
 WITH supplied_columns AS MATERIALIZED (
  SELECT DISTINCT supplied.key FROM public.erp_restore_upload_chunks ch
   CROSS JOIN LATERAL jsonb_array_elements(ch.rows) row_value
   CROSS JOIN LATERAL jsonb_object_keys(row_value) supplied(key)
  WHERE ch.request_id=p_request_id AND ch.resource=p_resource
  UNION SELECT 'updated_by' WHERE r.restore_mode='cross-environment'
 ) SELECT string_agg(quote_ident(a.attname),',' ORDER BY a.attnum),
  string_agg('v.'||quote_ident(a.attname),',' ORDER BY a.attnum)
 INTO columns_sql,select_sql FROM pg_attribute a JOIN supplied_columns s ON s.key=a.attname
 WHERE a.attrelid=format('public.%I',p_resource)::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='';
 phase_timings:=jsonb_build_object('columns',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 phase_at:=clock_timestamp();
 FOR c IN SELECT * FROM public.erp_restore_upload_chunks WHERE request_id=p_request_id AND resource=p_resource ORDER BY ordinal LOOP
  rows:=c.rows;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(rows) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object') THEN
   RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_AUDIT_ROW_INVALID'; END IF;
  SELECT x INTO invalid_row FROM jsonb_array_elements(rows) x
   WHERE coalesce(btrim(x->>'id'),'') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' LIMIT 1;
  IF FOUND THEN
   IF p_resource=ANY(ARRAY['waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state']) THEN
    PERFORM public.erp_cloud_restore_validation_error(p_resource,coalesce(invalid_row->>'id','unknown'),'WACA_CANONICAL_IDENTITY_MISSING');
   END IF;
   RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_IDENTITY_REQUIRED:'||p_resource;
  END IF;
  IF r.restore_mode='cross-environment' THEN
   SELECT count(*) FILTER(WHERE x ? 'updated_by' AND jsonb_typeof(x->'updated_by') IS DISTINCT FROM 'null'),
    json_agg(x||jsonb_build_object('updated_by',NULL) ORDER BY ord)::jsonb
   INTO n,rows FROM jsonb_array_elements(rows) WITH ORDINALITY s(x,ord);
   transformed:=transformed+n;
  END IF;
  INSERT INTO public.erp_cloud_restore_prepared_chunks(proof_id,actor_key,resource,chunk_ordinal,row_count,rows,payload_hash,expires_at)
  SELECT p_request_id,r.actor_key,p_resource,c.ordinal*2+((ord-1)/256)::integer,count(*)::integer,
   json_agg(x ORDER BY ord)::jsonb,
   encode(extensions.digest(convert_to((json_agg(x ORDER BY ord)::jsonb)::text,'UTF8'),'sha256'),'hex'),r.expires_at
  FROM jsonb_array_elements(rows) WITH ORDINALITY s(x,ord) GROUP BY ((ord-1)/256)::integer;

 END LOOP;
 phase_timings:=phase_timings||jsonb_build_object('immutableChunks',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 phase_at:=clock_timestamp();
 -- Aggregate each resource ONCE; preserve exact transformed rows and ordering.
  SELECT coalesce(json_agg(public.erp_restore_validation_projection(x)||
   CASE WHEN NOT(x ? 'payload') THEN '{}'::jsonb
    WHEN jsonb_typeof(x->'payload')='object' THEN jsonb_build_object('payload',
     CASE WHEN x->'payload' ? 'key' THEN jsonb_build_object('key',x->'payload'->'key') ELSE '{}'::jsonb END)
    ELSE jsonb_build_object('payload',x->'payload') END ORDER BY ch.chunk_ordinal,ord),'[]'::json)::jsonb
  INTO projected FROM public.erp_cloud_restore_prepared_chunks ch
   CROSS JOIN LATERAL jsonb_array_elements(ch.rows) WITH ORDINALITY s(x,ord)
  WHERE ch.proof_id=p_request_id AND ch.resource=p_resource;
 phase_timings:=phase_timings||jsonb_build_object('validationProjection',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 phase_at:=clock_timestamp();
 profile:=public.erp_cloud_restore_prepared_profile(p_request_id,p_resource);
 IF (profile->>'missingIdentityCount')::bigint>0 THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_IDENTITY_REQUIRED:'||p_resource; END IF;
 IF (profile->>'duplicateIdentityCount')::bigint>0 THEN
  RAISE EXCEPTION USING errcode='23505',message='DUPLICATE_CANONICAL_ID:'||p_resource; END IF;
 IF p_resource='product_variants' AND (profile->>'duplicateAuxiliaryIdentityCount')::bigint>0 THEN
  RAISE EXCEPTION USING errcode='23505',message='DUPLICATE_VARIANT_LOCAL_ID'; END IF;
 phase_timings:=phase_timings||jsonb_build_object('identityProof',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 phase_at:=clock_timestamp();
 IF columns_sql IS NOT NULL THEN
  -- One set-based typed write per resource, not one dynamic INSERT per chunk.
  -- Omitted columns/defaults, supplied-column order and raw types are unchanged.
  EXECUTE format('insert into public.%I (restore_proof_id,%s) select $1,%s from public.erp_cloud_restore_prepared_chunks ch cross join lateral jsonb_populate_recordset(null::public.%I,ch.rows) v where ch.proof_id=$1 and ch.resource=$2',
   'erp_restore_stage_'||p_resource,columns_sql,select_sql,p_resource) USING p_request_id,p_resource;
 END IF;
 phase_timings:=phase_timings||jsonb_build_object('typedStage',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 INSERT INTO public.erp_restore_upload_resource_proofs(request_id,resource,validation_rows,supplied_columns,profile,transformed_rows,server_ms)
 VALUES(p_request_id,p_resource,projected,columns_sql,profile,transformed,(extract(epoch FROM clock_timestamp()-started)*1000)::bigint);
 RETURN jsonb_build_object('resource',p_resource,'profile',profile,'phaseTimingsMs',phase_timings,'serverMs',(extract(epoch FROM clock_timestamp()-started)*1000)::bigint);
END;
$function$;

REVOKE ALL ON FUNCTION public.erp_stage_restore_upload_resource(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erp_stage_restore_upload_resource(uuid,text) TO authenticated;
CREATE OR REPLACE FUNCTION public.erp_finalize_restore_upload(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions' SET statement_timeout TO '25s'
-- Exact-A EXPLAIN: 2184kB/4MB/8MB spill; 16MB is the smallest tested
-- budget with zero temp blocks. Only the single finalizer inherits this budget.
SET work_mem TO '16MB'
AS $function$
DECLARE r public.erp_restore_upload_requests%rowtype;d jsonb;a jsonb;i jsonb;result jsonb;resource_name text;
 profiles jsonb;columns_by_resource jsonb;bytes bigint;rows bigint;payload_hash text;relationship_hash text;
 transformed bigint;policy text;source_fp text;started timestamptz:=clock_timestamp();phase text:='authorization';
 assembled timestamptz;resource_timings jsonb;
BEGIN
 r:=public.erp_restore_upload_owner(p_request_id);
 IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-restore-upload:'||p_request_id::text,0)) THEN
  RAISE EXCEPTION USING errcode='55006',message='CLOUD_RESTORE_UPLOAD_BUSY'; END IF;
 IF r.completed_result IS NOT NULL THEN RETURN r.completed_result; END IF;
 IF r.source_generation IS DISTINCT FROM (SELECT generation FROM public.erp_restore_business_generation WHERE singleton)
  OR r.source_epoch IS DISTINCT FROM (SELECT epoch FROM public.erp_cloud_restore_epoch WHERE singleton) THEN
  RAISE EXCEPTION USING errcode='55000',message='STALE_RESTORE_PREPARE'; END IF;
 phase:='resource-stage';
 -- Backward-compatible older clients use the same bounded stages, never a full
 -- 24 MB aggregate. New clients stage resources with bounded concurrency.
 FOR resource_name IN SELECT jsonb_object_keys(r.manifest->'counts') LOOP
  IF NOT EXISTS(SELECT 1 FROM public.erp_restore_upload_resource_proofs WHERE request_id=p_request_id AND resource=resource_name) THEN
   PERFORM public.erp_stage_restore_upload_resource(p_request_id,resource_name); END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.erp_restore_upload_resource_proofs WHERE request_id=p_request_id)<>24
  OR EXISTS(SELECT 1 FROM public.erp_restore_upload_resource_proofs rp WHERE rp.request_id=p_request_id
   AND (rp.profile->>'count')::bigint IS DISTINCT FROM (r.manifest->'counts'->>rp.resource)::bigint) THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_INCOMPLETE'; END IF;
 phase:='projected-semantic-proof';
 SELECT json_object_agg(resource,validation_rows)::jsonb,jsonb_object_agg(resource,profile),
  jsonb_object_agg(resource,supplied_columns),sum(transformed_rows),jsonb_object_agg(resource,server_ms)
 INTO d,profiles,columns_by_resource,transformed,resource_timings
 FROM public.erp_restore_upload_resource_proofs WHERE request_id=p_request_id;
 assembled:=clock_timestamp();
 IF r.restore_mode='cross-environment' THEN
  policy:='cross-environment-audit-null-v1';source_fp:=r.manifest->'portability'->>'sourceSnapshotFingerprint';
  IF r.manifest->'portability'->>'mode' IS DISTINCT FROM 'cross-environment'
   OR transformed IS DISTINCT FROM (r.manifest->'portability'->>'totalTransformedRows')::bigint
   OR EXISTS(SELECT 1 FROM public.erp_restore_upload_resource_proofs rp WHERE rp.request_id=p_request_id
    AND rp.transformed_rows IS DISTINCT FROM (r.manifest->'portability'->'transformedCounts'->>rp.resource)::bigint) THEN
   RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PORTABILITY_TRANSFORM_COUNT_MISMATCH'; END IF;
  PERFORM public.erp_cloud_restore_validate_portability(d,r.manifest,'rhfdjsklfrgpoqsaqpkn');
 ELSIF r.restore_mode='strict' AND NOT(r.manifest ? 'portability') THEN
  policy:='strict';source_fp:=r.manifest->>'snapshotFingerprint';
 ELSE RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_POLICY_INVALID'; END IF;
 PERFORM public.erp_cloud_restore_validate_waca_dataset(d);
 a:=public.erp_cloud_restore_audit_dataset(d);i:=a->'integrity';
 -- Keep BOTH contracts: the public manifest hash and Execute's staged proof
 -- hash use different canonical representations. Neither can replace the other.
 relationship_hash:=public.erp_cloud_restore_relationship_hash(d);
 IF r.manifest->'counts' IS DISTINCT FROM a->'table_counts'
  OR (r.manifest->>'totalRows')::bigint IS DISTINCT FROM (a->>'total_rows')::bigint
  OR r.manifest->>'relationshipHash' IS DISTINCT FROM a->>'relationship_hash'
  OR (r.manifest->>'orphanCount')::bigint IS DISTINCT FROM (i->>'orphan_count')::bigint
  OR (r.manifest->>'duplicateVariantIdCount')::bigint IS DISTINCT FROM (i->>'duplicate_variant_id_count')::bigint
  OR (r.manifest->>'duplicateVariantLocalIdCount')::bigint IS DISTINCT FROM (i->>'duplicate_variant_local_id_count')::bigint
  OR (r.manifest->>'duplicateCanonicalIdCount')::bigint IS DISTINCT FROM (i->>'duplicate_canonical_id_count')::bigint
  OR (r.manifest->>'canonicalIdentityAnomalyCount')::bigint IS DISTINCT FROM (i->>'canonical_identity_anomaly_count')::bigint
  OR (r.manifest->>'unknownProductCount')::bigint IS DISTINCT FROM (i->>'unknown_product_count')::bigint
  OR (r.manifest->>'optionalMetadataMissingReferenceCount')::bigint IS DISTINCT FROM (i->>'optional_metadata_missing_reference_count')::bigint
  OR (i->>'duplicate_inventory_key_count')::bigint<>0 OR (i->>'missing_inventory_key_count')::bigint<>0 THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_CANDIDATE_INVALID'; END IF;
 SELECT coalesce(sum(row_count),0),coalesce(sum(pg_column_size(ch.rows)),0),
  encode(extensions.digest(convert_to(coalesce(string_agg(resource||':'||chunk_ordinal||':'||ch.payload_hash,E'\n'
   ORDER BY resource COLLATE "C",chunk_ordinal),''),'UTF8'),'sha256'),'hex')
 INTO rows,bytes,payload_hash FROM public.erp_cloud_restore_prepared_chunks ch WHERE proof_id=p_request_id;
 IF rows IS DISTINCT FROM (a->>'total_rows')::bigint THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_STAGE_ROW_COUNT_MISMATCH'; END IF;
 IF r.source_generation IS DISTINCT FROM (SELECT generation FROM public.erp_restore_business_generation WHERE singleton)
  OR r.source_epoch IS DISTINCT FROM (SELECT epoch FROM public.erp_cloud_restore_epoch WHERE singleton) THEN
  RAISE EXCEPTION USING errcode='55000',message='STALE_RESTORE_PREPARE'; END IF;
 result:=jsonb_build_object('ok',true,'candidate_valid',true,'schema_version','cloud-restore-candidate-proof-v1',
  'policy',policy,'resource_count',24,'coverage_count',24,'total_rows',rows,'table_counts',a->'table_counts',
  'transformed_updated_by_count',transformed,'source_fingerprint',source_fp,
  'effective_fingerprint',r.manifest->>'snapshotFingerprint','relationship_hash',a->>'relationship_hash','integrity',i,
  'proof_id',p_request_id,'proof_expires_at',r.expires_at,'request_id',p_request_id,
  'prepared_row_count',rows,'prepared_byte_count',bytes,'prepared_payload_hash',payload_hash,
  'uploadAssemblyMs',(extract(epoch FROM assembled-started)*1000)::bigint,
  'finalizeServerMs',(extract(epoch FROM clock_timestamp()-started)*1000)::bigint,
  'resourceStageTimingsMs',resource_timings,'validationProjectionBytes',pg_column_size(d),
  'prepareTimingsMs',jsonb_build_object('semanticProof',(extract(epoch FROM clock_timestamp()-assembled)*1000)::bigint),
  'elapsed_ms',(extract(epoch FROM clock_timestamp()-started)*1000)::bigint);
 UPDATE public.erp_cloud_restore_candidate_proofs SET proof_result=result,expected_profiles=profiles,
  prepared_columns=columns_by_resource,prepared_row_count=rows,prepared_byte_count=bytes,prepared_payload_hash=payload_hash,
  expected_relationship_hash=relationship_hash,source_generation=r.source_generation,source_restore_epoch=r.source_epoch
 WHERE proof_id=p_request_id AND actor_key=r.actor_key;
 UPDATE public.erp_restore_upload_requests SET completed_result=result WHERE request_id=p_request_id;
 DELETE FROM public.erp_restore_upload_chunks WHERE request_id=p_request_id;
 DELETE FROM public.erp_restore_upload_resource_proofs WHERE request_id=p_request_id;
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
