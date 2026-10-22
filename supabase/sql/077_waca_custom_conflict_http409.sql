-- WACA custom conflict transport only. Candidate: NOT approved for cloud apply.
-- Four exact v30 function definitions; ten reviewed RAISE SQLSTATE literals.
-- No catch-all / serialization_failure handler. Real PostgreSQL 40001 remains 40001.
-- No business DML, schema/table/column/ACL/config changes; historical SQL unchanged.
BEGIN;
DO $migration$
DECLARE
  r record; f oid; old_definition text; next_definition text; actual_definition text;
  metadata jsonb; reason text; anchor text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.erp_commit_waca_snapshot_v044(jsonb,bigint,boolean)','15e886d2c67ae9ded606ce968227bed4581a302f8fc059535b4cc923c3b11edd',ARRAY['WACA_STALE_REVISION']),
    ('public.erp_commit_waca_counted_snapshot_v074(jsonb,bigint,jsonb)','8d8c0c9f03b8e4be332c3a377fa48b49451c957b5b2ed002234c793dac049de2',ARRAY['WACA_STALE_REVISION','WACA_RESTORE_EPOCH_CHANGED','WACA_COUNTED_PREVIEW_MISMATCH']),
    ('public.erp_plan_waca_recognition(jsonb)','8c4c003d3d977336e923a6547aa0831de262b87918959bd1e98d20fa3d909b86',ARRAY['WACA_STALE_REVISION','WACA_RESTORE_EPOCH_CHANGED']),
    ('public.erp_commit_waca_recognition(jsonb,jsonb)','09a49e1476aa70c57017408db826491d458cc49eaee292300ae3f96d5dd3a7eb',ARRAY['WACA_RESTORE_EPOCH_CHANGED','WACA_RECOGNITION_PREVIEW_CHANGED','WACA_RECOGNITION_VARIANT_CHANGED','WACA_STALE_REVISION'])
  ) reviewed(signature,sha256,reasons) LOOP
    f:=pg_catalog.to_regprocedure(r.signature);
    IF f IS NULL THEN RAISE EXCEPTION 'WACA_TRANSPORT_FUNCTION_MISSING:%',r.signature USING ERRCODE='55000'; END IF;
    SELECT pg_catalog.pg_get_functiondef(f),to_jsonb(p)-'prosrc' INTO old_definition,metadata
      FROM pg_catalog.pg_proc p WHERE p.oid=f;
    IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(old_definition,E'\r\n',E'\n'),'UTF8')),'hex')
       IS DISTINCT FROM r.sha256 THEN
      RAISE EXCEPTION 'WACA_TRANSPORT_SOURCE_MISMATCH:%',r.signature USING ERRCODE='55000';
    END IF;
    next_definition:=old_definition;
    FOREACH reason IN ARRAY r.reasons LOOP
      anchor:='errcode=''40001'',message='''||reason||'''';
      IF (length(next_definition)-length(replace(next_definition,anchor,'')))/length(anchor)<>1 THEN
        RAISE EXCEPTION 'WACA_TRANSPORT_ANCHOR_MISMATCH:%:%',r.signature,reason USING ERRCODE='55000';
      END IF;
      next_definition:=replace(next_definition,anchor,'errcode=''PT409'',message='''||reason||'''');
    END LOOP;
    EXECUTE next_definition;
    SELECT pg_catalog.pg_get_functiondef(f) INTO actual_definition;
    IF actual_definition IS DISTINCT FROM next_definition
       OR (SELECT to_jsonb(p)-'prosrc' FROM pg_catalog.pg_proc p WHERE p.oid=f) IS DISTINCT FROM metadata THEN
      RAISE EXCEPTION 'WACA_TRANSPORT_POSTCHECK_FAILED:%',r.signature USING ERRCODE='55000';
    END IF;
  END LOOP;
END;
$migration$;
COMMIT;
