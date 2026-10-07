-- Prepare-only optimization. Commit the unexecutable shared draft in the
-- small begin-upload transaction, before any independent resource worker.
-- This removes speculative INSERT waits across otherwise independent stages.
BEGIN;
DO $preflight$
BEGIN
 IF current_user<>'postgres' OR to_regclass('public.erp_restore_upload_resource_proofs') IS NULL
  OR to_regprocedure('public.erp_stage_restore_upload_resource(uuid,text)') IS NULL THEN
  RAISE EXCEPTION USING errcode='55000',message='RESTORE_063_PRECONDITION_MISSING'; END IF;
END;
$preflight$;
CREATE FUNCTION public.erp_restore_initialize_upload_proof() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
BEGIN
 -- No target proof, payload hash, relationship proof or source CAS is valid
 -- until the SAME canonical finalizer accepts every resource atomically.
 INSERT INTO public.erp_cloud_restore_candidate_proofs(proof_id,actor_key,source_fingerprint,effective_fingerprint,
  restore_policy,target_environment,restore_mode,source_environment,effective_snapshot,manifest,proof_result,expires_at)
 VALUES(NEW.request_id,NEW.actor_key,
  CASE WHEN NEW.restore_mode='strict' THEN NEW.manifest->>'snapshotFingerprint'
   ELSE NEW.manifest->'portability'->>'sourceSnapshotFingerprint' END,
  NEW.manifest->>'snapshotFingerprint',
  CASE WHEN NEW.restore_mode='strict' THEN 'strict' ELSE 'cross-environment-audit-null-v1' END,
  'rhfdjsklfrgpoqsaqpkn',NEW.restore_mode,NEW.source_environment,'{}',NEW.manifest,
  '{"ok":false,"candidate_valid":false,"status":"STAGING"}',NEW.expires_at);
 RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_restore_initialize_upload_proof() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER erp_restore_initialize_upload_proof AFTER INSERT ON public.erp_restore_upload_requests
 FOR EACH ROW EXECUTE FUNCTION public.erp_restore_initialize_upload_proof();
NOTIFY pgrst,'reload schema';
COMMIT;
