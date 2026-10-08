-- Prepare OPS maintenance only. No business replacement or Execute changes.
BEGIN;

CREATE OR REPLACE FUNCTION public.erp_begin_restore_upload(p_request_id uuid,p_manifest jsonb,p_restore_mode text,p_source_environment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE r public.erp_restore_upload_requests%rowtype;g bigint;e bigint;k text;
 started timestamptz:=clock_timestamp();
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_owner(auth.uid()) THEN
  RAISE EXCEPTION USING errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; END IF;
 IF split_part(lower(coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'host','')),'.',1)<>'rhfdjsklfrgpoqsaqpkn' THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_TARGET_MISMATCH'; END IF;
 IF p_request_id IS NULL OR p_restore_mode NOT IN ('strict','cross-environment')
  OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR p_manifest->>'resourceCount'<>'24'
  OR jsonb_typeof(p_manifest->'counts') IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(p_manifest->'counts'))<>24
  OR length(p_source_environment) NOT BETWEEN 1 AND 2048 THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_INPUT_INVALID'; END IF;
 SELECT generation INTO STRICT g FROM public.erp_restore_business_generation WHERE singleton;
 SELECT epoch INTO STRICT e FROM public.erp_cloud_restore_epoch WHERE singleton;
 k:=encode(extensions.digest(auth.uid()::text,'sha256'),'hex');
 -- Deliberately independent of all historical OPS cleanup.
 INSERT INTO public.erp_restore_upload_requests(request_id,actor_key,manifest,restore_mode,source_environment,source_generation,source_epoch,expires_at)
  VALUES(p_request_id,k,p_manifest,p_restore_mode,p_source_environment,g,e,clock_timestamp()+interval '30 minutes')
  ON CONFLICT DO NOTHING;
 r:=public.erp_restore_upload_owner(p_request_id);
 IF r.manifest IS DISTINCT FROM p_manifest OR r.restore_mode IS DISTINCT FROM p_restore_mode
  OR r.source_environment IS DISTINCT FROM p_source_environment THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_IDENTITY_MISMATCH'; END IF;
 RETURN jsonb_build_object('requestId',p_request_id,'sourceEpoch',r.source_epoch,'sourceGeneration',r.source_generation,
  'serverMs',extract(epoch FROM clock_timestamp()-started)*1000);
EXCEPTION WHEN query_canceled THEN
 RAISE EXCEPTION USING errcode='57014',message='RESTORE_PREPARE_BEGIN_TIMEOUT',
  detail=jsonb_build_object('phase','prepare-begin','requestId',p_request_id,'reasonCode','RESTORE_PREPARE_BEGIN_TIMEOUT')::text;
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_begin_restore_upload(uuid,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erp_begin_restore_upload(uuid,jsonb,text,text) TO authenticated;

-- The legacy proof entry must not retain a second unbounded janitor. Preserve
-- its complete validation/staging contract, removing only that exact statement.
DO $legacy_cleanup$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)'::regprocedure);
 IF strpos(d,'DELETE FROM public.erp_cloud_restore_candidate_proofs WHERE expires_at<clock_timestamp();')>0 THEN
  EXECUTE replace(d,'DELETE FROM public.erp_cloud_restore_candidate_proofs WHERE expires_at<clock_timestamp();',
   '-- Expired OPS are handled exclusively by bounded maintenance.');
 END IF;
END;
$legacy_cleanup$;

CREATE FUNCTION public.erp_cleanup_expired_restore_ops(p_exclude_request_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
SET statement_timeout TO '4s' SET lock_timeout TO '200ms'
AS $function$
DECLARE
 k text; r public.erp_restore_upload_requests%rowtype; p public.erp_cloud_restore_candidate_proofs%rowtype;
 v_resource text; n integer; chunk_n integer:=0; typed_n integer:=0; byte_n bigint:=0;
 row_budget integer:=4096; more boolean:=false; resource_more boolean; removed integer:=0;
 started timestamptz:=clock_timestamp();
 resources constant text[]:=ARRAY['inventory_items','product_groups','product_categories','product_variants','bundle_components',
 'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
 'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
 'waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state'];
BEGIN
 -- Administrative SQL is already privileged. A PostgREST role, even inside
 -- this definer, cannot use that branch (session_user remains authenticator).
 IF auth.uid() IS NOT NULL AND public.is_owner(auth.uid()) THEN
  k:=encode(extensions.digest(auth.uid()::text,'sha256'),'hex');
 ELSIF session_user='postgres' AND coalesce(current_setting('role',true),'none')='none' THEN
  k:=NULL;
 ELSE RAISE EXCEPTION USING errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; END IF;
 IF k IS NOT NULL AND split_part(lower(coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'host','')),'.',1)<>'rhfdjsklfrgpoqsaqpkn' THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_TARGET_MISMATCH'; END IF;
 -- No Execute/business lock is taken. Proof row NOWAIT makes cleanup yield to
 -- a transaction using the proof; expired proofs are already non-executable.
 SELECT u.* INTO r FROM public.erp_restore_upload_requests u
 LEFT JOIN public.erp_cloud_restore_candidate_proofs cp ON cp.proof_id=u.request_id
 WHERE u.expires_at<=started AND (k IS NULL OR u.actor_key=k)
  AND u.request_id IS DISTINCT FROM p_exclude_request_id
  AND (cp.proof_id IS NULL OR cp.expires_at<=started)
  AND NOT EXISTS(SELECT 1 FROM public.erp_cloud_restore_attempts a
   WHERE a.actor_key=u.actor_key AND a.effective_fingerprint=cp.effective_fingerprint
    AND a.status NOT IN('completed','not_committed'))
 ORDER BY u.created_at,u.request_id LIMIT 1 FOR UPDATE OF u NOWAIT;
 IF NOT FOUND THEN
  -- Legacy proof-only prepares share the same bounded drain; they are not
  -- forgotten just because the newer upload request table has no parent row.
  SELECT cp.* INTO p FROM public.erp_cloud_restore_candidate_proofs cp
  WHERE cp.expires_at<=started AND (k IS NULL OR cp.actor_key=k)
   AND cp.proof_id IS DISTINCT FROM p_exclude_request_id
   AND NOT EXISTS(SELECT 1 FROM public.erp_restore_upload_requests u WHERE u.request_id=cp.proof_id)
   AND NOT EXISTS(SELECT 1 FROM public.erp_cloud_restore_attempts a WHERE a.actor_key=cp.actor_key
    AND a.effective_fingerprint=cp.effective_fingerprint AND a.status NOT IN('completed','not_committed'))
  ORDER BY cp.created_at,cp.proof_id LIMIT 1 FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','idle','requests',0,'serverMs',extract(epoch FROM clock_timestamp()-started)*1000); END IF;
  r.request_id:=p.proof_id;
 END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-restore-upload:'||r.request_id::text,0)) THEN
  RETURN jsonb_build_object('status','busy','requests',0); END IF;
 SELECT * INTO p FROM public.erp_cloud_restore_candidate_proofs WHERE proof_id=r.request_id FOR UPDATE NOWAIT;

 -- Each chunk selection is bounded before TOAST deletion: <=16 chunks and
 -- <=8 MiB physical JSON bytes. One oversized chunk is handled alone, not lost.
 WITH candidates AS MATERIALIZED (
  SELECT resource,chunk_ordinal,pg_column_size(rows) bytes,
   sum(pg_column_size(rows)) OVER(ORDER BY resource,chunk_ordinal) total_bytes,
   row_number() OVER(ORDER BY resource,chunk_ordinal) position
  FROM (SELECT resource,chunk_ordinal,rows FROM public.erp_cloud_restore_prepared_chunks
   WHERE proof_id=r.request_id ORDER BY resource,chunk_ordinal LIMIT 16) limited
 ), deleted AS (
  DELETE FROM public.erp_cloud_restore_prepared_chunks c USING candidates x
   WHERE c.proof_id=r.request_id AND c.resource=x.resource AND c.chunk_ordinal=x.chunk_ordinal
    AND (x.total_bytes<=8388608 OR x.position=1) RETURNING x.bytes
 ) SELECT count(*),coalesce(sum(bytes),0) INTO chunk_n,byte_n FROM deleted;
 WITH candidates AS MATERIALIZED (
  SELECT resource,ordinal,pg_column_size(rows) bytes,
   sum(pg_column_size(rows)) OVER(ORDER BY resource,ordinal) total_bytes,
   row_number() OVER(ORDER BY resource,ordinal) position
  FROM (SELECT resource,ordinal,rows FROM public.erp_restore_upload_chunks
   WHERE request_id=r.request_id ORDER BY resource,ordinal LIMIT 16) limited
 ), deleted AS (
  DELETE FROM public.erp_restore_upload_chunks c USING candidates x
   WHERE c.request_id=r.request_id AND c.resource=x.resource AND c.ordinal=x.ordinal
    AND (x.total_bytes<=8388608 OR x.position=1) RETURNING x.bytes
 ) SELECT chunk_n+count(*),byte_n+coalesce(sum(bytes),0) INTO chunk_n,byte_n FROM deleted;
 FOREACH v_resource IN ARRAY resources LOOP
  IF row_budget>0 THEN
   EXECUTE format('WITH chosen AS MATERIALIZED (SELECT id FROM public.%I WHERE restore_proof_id=$1 ORDER BY id LIMIT $2)
    DELETE FROM public.%I t USING chosen c WHERE t.restore_proof_id=$1 AND t.id=c.id',
    'erp_restore_stage_'||v_resource,'erp_restore_stage_'||v_resource) USING r.request_id,row_budget;
   GET DIAGNOSTICS n=ROW_COUNT; row_budget:=row_budget-n; typed_n:=typed_n+n;
  END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE restore_proof_id=$1)','erp_restore_stage_'||v_resource)
   INTO resource_more USING r.request_id;
  more:=more OR resource_more;
 END LOOP;
 -- At most 24 fixed resource summaries, never business data or attempt audit.
 WITH chosen AS MATERIALIZED (SELECT resource FROM public.erp_restore_upload_resource_proofs
  WHERE request_id=r.request_id ORDER BY resource LIMIT 24)
 DELETE FROM public.erp_restore_upload_resource_proofs t USING chosen c
  WHERE t.request_id=r.request_id AND t.resource=c.resource;
 more:=more OR EXISTS(SELECT 1 FROM public.erp_cloud_restore_prepared_chunks WHERE proof_id=r.request_id)
  OR EXISTS(SELECT 1 FROM public.erp_restore_upload_chunks WHERE request_id=r.request_id)
  OR EXISTS(SELECT 1 FROM public.erp_restore_upload_resource_proofs WHERE request_id=r.request_id);
 IF NOT more THEN
  -- All cascade children were drained in bounded batches; preserve the
  -- existing referential trigger and immutable attempt/failure/receipt audit.
  DELETE FROM public.erp_cloud_restore_candidate_proofs WHERE proof_id=r.request_id;
  DELETE FROM public.erp_restore_upload_requests WHERE request_id=r.request_id;
  GET DIAGNOSTICS removed=ROW_COUNT;
 END IF;
 RETURN jsonb_build_object('status','progress','requestId',r.request_id,'requests',removed,
  'chunks',chunk_n,'approxBytes',byte_n,'typedRows',typed_n,'requestRemaining',more,
  'serverMs',extract(epoch FROM clock_timestamp()-started)*1000);
EXCEPTION WHEN lock_not_available THEN
 RETURN jsonb_build_object('status','busy','requests',0,'serverMs',extract(epoch FROM clock_timestamp()-started)*1000);
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_cleanup_expired_restore_ops(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erp_cleanup_expired_restore_ops(uuid) TO authenticated;
COMMENT ON FUNCTION public.erp_cleanup_expired_restore_ops(uuid) IS
 'Owner-scoped bounded expired Prepare OPS maintenance; admin-callable, retryable; never part of Begin or Execute. Preserve immutable audits.';
NOTIFY pgrst,'reload schema';
COMMIT;
