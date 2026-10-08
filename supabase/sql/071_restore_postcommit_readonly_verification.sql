-- Read-only successor to the full-snapshot post-commit audit. Execute, staging,
-- replacement, Backup, and all historical migrations are unchanged.
BEGIN;
CREATE FUNCTION public.erp_verify_committed_cloud_restore(p_attempt_id uuid,p_trace_id uuid,p_execution_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
SET statement_timeout TO '15s'
AS $function$
DECLARE
 a public.erp_cloud_restore_attempts%rowtype;
 r public.erp_cloud_restore_requests%rowtype;
 actor uuid:=auth.uid(); epoch bigint; generation bigint;
 gx text; rx text; ex text; current_fp text;
 names constant text[]:=ARRAY['inventory_items','product_groups','product_categories','product_variants','bundle_components',
 'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
 'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
 'waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state'];
 name text; profile jsonb; counts jsonb:='{}'; total bigint:=0; duplicates bigint:=0;
 missing bigint:=0; orphans bigint:=0; relationships text; matched boolean:=true; coverage boolean:=true;
 started timestamptz:=clock_timestamp();
BEGIN
 IF actor IS NULL OR NOT public.is_owner(actor) THEN
  RAISE EXCEPTION USING errcode='42501',message='RESTORE_READBACK_PERMISSION_ERROR';
 END IF;
 SELECT * INTO a FROM public.erp_cloud_restore_attempts WHERE attempt_id=p_attempt_id AND trace_id=p_trace_id
  AND execution_id=p_execution_id AND actor_key=encode(extensions.digest(actor::text,'sha256'),'hex');
 IF NOT FOUND OR a.status<>'completed' THEN
  RAISE EXCEPTION USING errcode='22023',message='RESTORE_COMMITTED_RECEIPT_REQUIRED';
 END IF;
 SELECT * INTO r FROM public.erp_cloud_restore_requests WHERE idempotency_key=p_attempt_id AND actor_id=actor;
 IF NOT FOUND OR r.status<>'completed' OR r.canonical_result->>'ok'<>'true'
  OR r.canonical_result->>'restoreEpoch' IS DISTINCT FROM a.result_epoch::text
  OR r.canonical_result->>'snapshotFingerprint' IS DISTINCT FROM a.effective_fingerprint
  OR a.canonical_result->>'snapshotFingerprint' IS DISTINCT FROM a.effective_fingerprint THEN
  RAISE EXCEPTION USING errcode='22023',message='RESTORE_COMMITTED_RECEIPT_MISMATCH';
 END IF;
 SELECT e.epoch,e.snapshot_fingerprint,e.xmin::text INTO STRICT epoch,current_fp,ex FROM public.erp_cloud_restore_epoch e WHERE singleton;
 SELECT g.generation,g.xmin::text INTO STRICT generation,gx FROM public.erp_restore_business_generation g WHERE singleton;
 SELECT q.xmin::text INTO STRICT rx FROM public.erp_cloud_restore_requests q WHERE q.idempotency_key=p_attempt_id AND q.actor_id=actor;
 -- 058 advances the singleton in EVERY INSERT/UPDATE/DELETE statement on all
 -- 24 resources, in the same transaction/subtransaction as the epoch+receipt.
 -- Matching unfrozen MVCC provenance is an unchanged-business-generation proof,
 -- not merely a belief in the receipt. A changed field (even unchanged counts),
 -- missing/disabled generation trigger, frozen/old receipt or newer restore
 -- fails closed. No XIDs, business rows or auth identity leave this RPC.
 FOREACH name IN ARRAY names LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=format('public.%I',name)::regclass
   AND t.tgname='erp_restore_business_generation' AND t.tgfoid='public.erp_restore_track_business_generation()'::regprocedure
   AND t.tgenabled IN('O','A') AND t.tgtype=28) THEN coverage:=false; END IF;
  profile:=public.erp_cloud_restore_table_profile(format('public.%I',name)::regclass,NULL::jsonb);
  counts:=counts||jsonb_build_object(name,(profile->>'count')::bigint);
  total:=total+(profile->>'count')::bigint;
  duplicates:=duplicates+(profile->>'duplicateIdentityCount')::bigint+(profile->>'duplicateAuxiliaryIdentityCount')::bigint;
  missing:=missing+(profile->>'missingIdentityCount')::bigint;
  matched:=matched AND (profile->>'count') IS NOT DISTINCT FROM (r.canonical_result->'manifest'->'counts'->>name);
 END LOOP;
 relationships:=public.erp_cloud_restore_live_relationship_hash();
 SELECT count(*) INTO orphans FROM (
  SELECT 1 FROM public.product_categories i LEFT JOIN public.product_groups p ON p.id=i.product_group_id WHERE p.id IS NULL
  UNION ALL SELECT 1 FROM public.product_variants i LEFT JOIN public.product_groups p ON p.id=i.product_group_id WHERE p.id IS NULL
  UNION ALL SELECT 1 FROM public.purchase_batch_items i LEFT JOIN public.purchase_batches p ON p.id=i.purchase_batch_id WHERE p.id IS NULL
  UNION ALL SELECT 1 FROM public.private_order_items i LEFT JOIN public.private_orders p ON p.id=i.private_order_id WHERE p.id IS NULL
  UNION ALL SELECT 1 FROM public.sales_order_items i LEFT JOIN public.sales_orders p ON p.id=i.order_id WHERE p.id IS NULL
  UNION ALL SELECT 1 FROM public.japan_package_items i LEFT JOIN public.japan_packages p ON p.id=i.japan_package_id WHERE p.id IS NULL
  UNION ALL SELECT 1 FROM public.outbound_shipment_items i LEFT JOIN public.outbound_shipments p ON p.id=i.outbound_shipment_id WHERE p.id IS NULL
  UNION ALL SELECT 1 FROM public.waca_order_items i LEFT JOIN public.waca_orders p ON p.id=i.order_id WHERE p.id IS NULL
 ) orphan_rows;
 matched:=matched AND epoch=a.result_epoch AND current_fp=r.canonical_result->>'serverSnapshotFingerprint'
  AND total=(r.canonical_result->'manifest'->>'totalRows')::bigint
  AND (r.canonical_result->'manifest'->>'resourceCount')::integer=24
  AND relationships=r.canonical_result->>'serverRelationshipHash'
  AND gx=rx AND rx=ex AND gx::bigint>2 AND coverage AND duplicates=0 AND missing=0 AND orphans=0;
 -- The certified transaction already ran FK, WACA, canonical and relationship
 -- proofs. Validate WACA again against this statement's authoritative snapshot.
 PERFORM public.erp_cloud_restore_validate_live_waca();
 RETURN jsonb_build_object('contract','restore-committed-verification-v1',
  'status',CASE WHEN matched THEN 'RESTORE_COMMITTED_VERIFIED' ELSE 'RESTORE_COMMITTED_STATE_MISMATCH' END,
  'attemptId',p_attempt_id,'traceId',p_trace_id,'executionId',p_execution_id,
  'restoreEpoch',epoch,'businessGeneration',generation,'snapshotFingerprint',a.effective_fingerprint,
  'serverSnapshotFingerprint',current_fp,'serverRelationshipHash',relationships,
  'counts',counts,'totalRows',total,'duplicateCount',duplicates,'missingIdentityCount',missing,'orphanCount',orphans,
  'generationCertified',gx=rx AND rx=ex AND gx::bigint>2 AND coverage,
  'elapsedMs',(extract(epoch FROM clock_timestamp()-started)*1000)::bigint);
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_verify_committed_cloud_restore(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erp_verify_committed_cloud_restore(uuid,uuid,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
