-- Reduce only the independent OPS maintenance envelope after Live profiling.
-- Preserve 067, all Execute contracts, all Business resources and ACL.
BEGIN;
DO $bounded_cleanup$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.erp_cleanup_expired_restore_ops(uuid)'::regprocedure);
 IF strpos(d,'row_budget integer:=4096')=0 OR strpos(d,'LIMIT 16')=0
  OR strpos(d,'8388608')=0 THEN
  RAISE EXCEPTION 'RESTORE_OPS_MAINTENANCE_SOURCE_CONTRACT_MISMATCH';
 END IF;
 d:=replace(d,'row_budget integer:=4096','row_budget integer:=1024');
 d:=replace(d,'LIMIT 16','LIMIT 4');
 d:=replace(d,'8388608','2097152');
 d:=replace(d,'IF row_budget>0 THEN',
  'IF row_budget>0 AND extract(epoch FROM clock_timestamp()-started)*1000<1000 THEN');
 EXECUTE d;
END;
$bounded_cleanup$;
NOTIFY pgrst,'reload schema';
COMMIT;
