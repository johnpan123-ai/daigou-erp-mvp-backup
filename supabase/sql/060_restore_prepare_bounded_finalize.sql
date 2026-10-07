-- Prepare only: one bounded assembly instead of 24 cumulative JSONB copies.
-- PostgREST hoists the TOP-LEVEL RPC timeout, not a nested proof's setting.
-- No business replacement, role setting, ACL relaxation or Execute changes.
BEGIN;
DO $preflight$
BEGIN
 IF current_user <> 'postgres'
  OR to_regprocedure('public.erp_finalize_restore_upload(uuid)') IS NULL
  OR to_regclass('public.erp_restore_business_generation') IS NULL THEN
  RAISE EXCEPTION USING errcode='55000',message='RESTORE_060_PRECONDITION_MISSING';
 END IF;
END;
$preflight$;
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
 -- Count checks use small chunk metadata before allocating the target JSONB.
 IF EXISTS(SELECT 1 FROM jsonb_each_text(r.manifest->'counts') expected
   LEFT JOIN (SELECT resource,sum(jsonb_array_length(rows)) n
     FROM public.erp_restore_upload_chunks WHERE request_id=p_request_id GROUP BY resource) actual
   ON actual.resource=expected.key WHERE coalesce(actual.n,0)<>expected.value::bigint) THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_INCOMPLETE'; END IF;
 SELECT jsonb_object_agg(expected.key,coalesce(actual.rows,'[]'::jsonb)) INTO d
 FROM jsonb_object_keys(r.manifest->'counts') expected(key)
 LEFT JOIN LATERAL (SELECT jsonb_agg(x.row_value ORDER BY c.ordinal,x.ordinality) rows
   FROM public.erp_restore_upload_chunks c
   CROSS JOIN LATERAL jsonb_array_elements(c.rows) WITH ORDINALITY x(row_value,ordinality)
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
NOTIFY pgrst, 'reload schema';
COMMIT;
