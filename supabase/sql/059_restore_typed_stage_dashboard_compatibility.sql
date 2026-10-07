-- OPS-only physical staging parity for the existing dashboard compatibility
-- contract. 058 is immutable; no business table or backup resource is changed.
BEGIN;
DO $preflight$
BEGIN
 IF current_user<>'postgres' OR to_regclass('public.erp_restore_stage_dashboard_category_images') IS NULL THEN
  RAISE EXCEPTION USING errcode='55000',message='RESTORE_059_PRECONDITION_FAILED';
 END IF;
END;
$preflight$;
ALTER TABLE public.erp_restore_stage_dashboard_category_images
 ADD COLUMN IF NOT EXISTS local_id text,
 ADD COLUMN IF NOT EXISTS version integer;
COMMIT;
