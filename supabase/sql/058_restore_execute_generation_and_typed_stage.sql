-- 058: source generation CAS; typed decoding before the atomic transaction.
-- OPS/EPHEMERAL infrastructure is NOT part of the 24-resource business registry.
-- Historical migrations and full Backup/Restore format are unchanged.
BEGIN;
DO $preflight$
BEGIN
  IF current_user<>'postgres' OR to_regclass('public.erp_cloud_restore_prepared_chunks') IS NULL
     OR to_regclass('public.erp_restore_business_generation') IS NOT NULL THEN
    RAISE EXCEPTION USING errcode='55000',message='RESTORE_058_PRECONDITION_FAILED';
  END IF;
END;
$preflight$;
CREATE TABLE public.erp_restore_business_generation(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0)
);
INSERT INTO public.erp_restore_business_generation(singleton) VALUES(true);
ALTER TABLE public.erp_restore_business_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_restore_business_generation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_restore_business_generation FROM PUBLIC,anon,authenticated;
ALTER TABLE public.erp_cloud_restore_candidate_proofs ADD COLUMN source_generation bigint,
  ADD COLUMN source_restore_epoch bigint, ADD COLUMN prepared_columns jsonb NOT NULL DEFAULT '{}';

CREATE FUNCTION public.erp_restore_track_business_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $function$
BEGIN
  -- Uses the existing maintenance lock, not a new bypass; even Restore changes
  -- advance the generation transactionally. Rolled-back writes do not advance it.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) THEN
    RAISE EXCEPTION USING errcode='55006',message='CLOUD_RESTORE_MAINTENANCE_LOCKED';
  END IF;
  UPDATE public.erp_restore_business_generation SET generation=generation+1 WHERE singleton;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_restore_track_business_generation() FROM PUBLIC,anon,authenticated;
DO $staging$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['inventory_items','product_groups','product_categories','product_variants','bundle_components','purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items','japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches','waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state'] LOOP
    EXECUTE format('create table public.%I as select * from public.%I with no data','erp_restore_stage_'||r,r);
    EXECUTE format('alter table public.%I add column restore_proof_id uuid not null references public.erp_cloud_restore_candidate_proofs(proof_id) on delete cascade','erp_restore_stage_'||r);
    EXECUTE format('alter table public.%I add primary key(restore_proof_id,id)','erp_restore_stage_'||r);
    EXECUTE format('alter table public.%I enable row level security','erp_restore_stage_'||r);
    EXECUTE format('alter table public.%I force row level security','erp_restore_stage_'||r);
    EXECUTE format('revoke all on public.%I from public,anon,authenticated','erp_restore_stage_'||r);
    EXECUTE format('create trigger erp_restore_business_generation after insert or update or delete on public.%I for each statement execute function public.erp_restore_track_business_generation()',r);
  END LOOP;
END;
$staging$;

CREATE OR REPLACE FUNCTION public.erp_cloud_restore_stage_candidate(
  p_proof_id uuid,
  p_actor_key text,
  p_effective_snapshot jsonb,
  p_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
DECLARE
  v_resource text;
  v_profile jsonb;
  v_profiles jsonb := '{}'::jsonb;
  v_total_rows bigint := 0;
  v_total_bytes bigint := 0;
  v_payload_hash text;
  v_columns text; v_select_columns text; v_count bigint; v_columns_by_resource jsonb:='{}';
BEGIN
  IF p_actor_key !~ '^[0-9a-f]{64}$' OR p_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING errcode='22023', message='CLOUD_RESTORE_STAGE_IDENTITY_INVALID';
  END IF;
  DELETE FROM public.erp_cloud_restore_prepared_chunks WHERE proof_id=p_proof_id;
  FOREACH v_resource IN ARRAY ARRAY[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state'
  ] LOOP
    IF jsonb_typeof(p_effective_snapshot->v_resource) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING errcode='22023', message='CLOUD_RESTORE_RESOURCE_REQUIRED:'||v_resource;
    END IF;
    INSERT INTO public.erp_cloud_restore_prepared_chunks(
      proof_id,actor_key,resource,chunk_ordinal,row_count,rows,payload_hash,expires_at
    )
    WITH grouped AS (
      SELECT ((ordinality-1)/256)::integer chunk_ordinal,
        count(*)::integer row_count,
        jsonb_agg(row_value ORDER BY ordinality) rows
      FROM jsonb_array_elements(p_effective_snapshot->v_resource) WITH ORDINALITY source(row_value,ordinality)
      WHERE CASE WHEN jsonb_typeof(row_value)='object' THEN true
        ELSE public.erp_cloud_restore_reject_invalid_portable_row(v_resource) END
      GROUP BY ((ordinality-1)/256)::integer
    )
    SELECT p_proof_id,p_actor_key,v_resource,chunk_ordinal,row_count,rows,
      encode(extensions.digest(convert_to(rows::text,'UTF8'),'sha256'),'hex'),p_expires_at
    FROM grouped;

    -- Decode ONCE in prepare, not again inside the atomic business replacement.
    SELECT string_agg(quote_ident(a.attname),',' ORDER BY a.attnum),
           string_agg('r.'||quote_ident(a.attname),',' ORDER BY a.attnum)
      INTO v_columns,v_select_columns FROM pg_attribute a
      WHERE a.attrelid=format('public.%I',v_resource)::regclass AND a.attnum>0
        AND NOT a.attisdropped AND a.attgenerated=''
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_effective_snapshot->v_resource) row_value WHERE row_value ? a.attname);
    IF v_columns IS NOT NULL THEN
      EXECUTE format('insert into public.%I (restore_proof_id,%s) select $1,%s from jsonb_populate_recordset(null::public.%I,$2) r',
        'erp_restore_stage_'||v_resource,v_columns,v_select_columns,v_resource)
        USING p_proof_id,p_effective_snapshot->v_resource;
    END IF;
    v_columns_by_resource:=v_columns_by_resource||jsonb_build_object(v_resource,v_columns);
    v_profile := public.erp_cloud_restore_prepared_profile(p_proof_id,v_resource);
    IF (v_profile->>'missingIdentityCount')::bigint > 0 THEN
      RAISE EXCEPTION USING errcode='22023', message='CLOUD_RESTORE_IDENTITY_REQUIRED:'||v_resource;
    END IF;
    IF (v_profile->>'duplicateIdentityCount')::bigint > 0 THEN
      RAISE EXCEPTION USING errcode='23505', message='DUPLICATE_CANONICAL_ID:'||v_resource;
    END IF;
    IF v_resource='product_variants' AND (v_profile->>'duplicateAuxiliaryIdentityCount')::bigint > 0 THEN
      RAISE EXCEPTION USING errcode='23505', message='DUPLICATE_VARIANT_LOCAL_ID';
    END IF;
    v_profiles := v_profiles || jsonb_build_object(v_resource,v_profile);
    v_total_rows := v_total_rows + (v_profile->>'count')::bigint;
  END LOOP;

  SELECT coalesce(sum(pg_column_size(rows)),0),
    encode(extensions.digest(convert_to(coalesce(string_agg(
      resource||':'||chunk_ordinal::text||':'||payload_hash,E'\n'
      ORDER BY resource COLLATE "C",chunk_ordinal),''),'UTF8'),'sha256'),'hex')
  INTO v_total_bytes,v_payload_hash
  FROM public.erp_cloud_restore_prepared_chunks WHERE proof_id=p_proof_id;

  UPDATE public.erp_cloud_restore_candidate_proofs SET prepared_columns=v_columns_by_resource WHERE proof_id=p_proof_id;
  RETURN jsonb_build_object(
    'profiles',v_profiles,'rowCount',v_total_rows,'byteCount',v_total_bytes,'payloadHash',v_payload_hash
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.erp_cloud_restore_insert_staged_rows(p_table regclass,p_proof_id uuid,p_resource text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE v_columns text; v_count bigint; v_expected bigint;
BEGIN
  IF p_resource<>ALL(ARRAY['inventory_items','product_groups','product_categories','product_variants','bundle_components','purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items','japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches','waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state']) OR p_table IS DISTINCT FROM format('public.%I',p_resource)::regclass THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_TABLE_NOT_ALLOWED';
  END IF;
  SELECT prepared_columns->>p_resource INTO v_columns FROM public.erp_cloud_restore_candidate_proofs WHERE proof_id=p_proof_id;
  IF v_columns IS NULL THEN RETURN 0; END IF;
  EXECUTE format('insert into %s (%s) select %s from public.%I where restore_proof_id=$1',p_table,v_columns,v_columns,
    'erp_restore_stage_'||p_resource) USING p_proof_id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF p_resource='outbound_shipments' THEN
    UPDATE public.outbound_shipments t SET status_changed_at=s.status_changed_at
      FROM public.erp_restore_stage_outbound_shipments s WHERE s.restore_proof_id=p_proof_id AND t.id=s.id;
    GET DIAGNOSTICS v_expected=ROW_COUNT;
    IF v_expected<>v_count OR EXISTS(SELECT 1 FROM public.erp_restore_stage_outbound_shipments s
      LEFT JOIN public.outbound_shipments t USING(id) WHERE s.restore_proof_id=p_proof_id
      AND (t.id IS NULL OR t.status_changed_at IS DISTINCT FROM s.status_changed_at)) THEN
      RAISE EXCEPTION USING errcode='55000',message='CLOUD_RESTORE_OUTBOUND_TIMESTAMP_MISMATCH';
    END IF;
  END IF;
  RETURN v_count;
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_cloud_restore_insert_staged_rows(regclass,uuid,text) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.erp_prove_cloud_restore_candidate_v2(
  p_source_snapshot jsonb,
  p_manifest jsonb,
  p_restore_mode text,
  p_source_environment text,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_actor uuid:=auth.uid();
  v_actor_key text;
  v_effective jsonb;
  v_audit jsonb;
  v_integrity jsonb;
  v_result jsonb;
  v_stage jsonb;
  v_proof_id uuid:=gen_random_uuid();
  v_expires_at timestamptz:=clock_timestamp()+interval '30 minutes';
  v_policy text;
  v_source_fingerprint text;
  v_effective_fingerprint text;
  v_restore_relationship_hash text;
  v_transformed bigint:=0;
  v_started_at timestamptz:=clock_timestamp();
  v_headers jsonb;
  v_source_generation bigint; v_source_epoch bigint;
  v_phase_started timestamptz:=clock_timestamp(); v_prepare_timings jsonb:='{}';
BEGIN
  RAISE LOG 'CLOUD_RESTORE_TRANSPORT request=% rpc=PROOF event=db-entry',p_request_id;
  IF v_actor IS NULL THEN RAISE EXCEPTION USING errcode='42501',message='AUTHENTICATION_REQUIRED'; END IF;
  IF NOT public.is_owner(v_actor) THEN RAISE EXCEPTION USING errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; END IF;
  IF p_request_id IS NULL OR coalesce(length(p_source_environment),0) NOT BETWEEN 1 AND 2048
     OR jsonb_typeof(p_source_snapshot) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_INPUT_INVALID';
  END IF;
  v_headers:=nullif(current_setting('request.headers',true),'')::jsonb;
  IF lower(split_part(coalesce(v_headers->>'host',''),':',1)) NOT LIKE 'rhfdjsklfrgpoqsaqpkn.%'
     OR (v_headers->>'x-restore-request-id' IS NOT NULL AND v_headers->>'x-restore-request-id'<>p_request_id::text) THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_TARGET_MISMATCH';
  END IF;

  IF p_restore_mode='cross-environment' THEN
    IF jsonb_typeof(p_manifest->'portability') IS DISTINCT FROM 'object'
       OR p_manifest->'portability'->>'policyVersion'<>'cross-environment-audit-null-v1'
       OR p_manifest->'portability'->>'targetProjectRef'<>'rhfdjsklfrgpoqsaqpkn' THEN
      RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_POLICY_INVALID';
    END IF;
    v_policy:='cross-environment-audit-null-v1';
    v_source_fingerprint:=p_manifest->'portability'->>'sourceSnapshotFingerprint';
    v_transformed:=(p_manifest->'portability'->>'totalTransformedRows')::bigint;
  ELSIF p_restore_mode='strict' AND NOT (p_manifest ? 'portability') THEN
    v_policy:='strict';
    v_source_fingerprint:=p_manifest->>'snapshotFingerprint';
  ELSE
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_POLICY_INVALID';
  END IF;
  v_effective_fingerprint:=p_manifest->>'snapshotFingerprint';
  IF coalesce(v_source_fingerprint,'') !~ '^[0-9a-f]{64}$' OR coalesce(v_effective_fingerprint,'') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_FINGERPRINT_INVALID';
  END IF;
  SELECT generation INTO STRICT v_source_generation FROM public.erp_restore_business_generation WHERE singleton;
  SELECT epoch INTO STRICT v_source_epoch FROM public.erp_cloud_restore_epoch WHERE singleton;
  v_prepare_timings:=jsonb_build_object('auth',(extract(epoch FROM clock_timestamp()-v_started_at)*1000)::bigint);
  v_phase_started:=clock_timestamp();
  v_effective:=public.erp_cloud_restore_build_effective_snapshot(p_source_snapshot,p_manifest,p_restore_mode);
  IF p_restore_mode='cross-environment' THEN
    PERFORM public.erp_cloud_restore_validate_portability(v_effective,p_manifest,'rhfdjsklfrgpoqsaqpkn');
  END IF;
  PERFORM public.erp_cloud_restore_validate_waca_dataset(v_effective);
  v_audit:=public.erp_cloud_restore_audit_dataset(v_effective);
  v_integrity:=v_audit->'integrity';
  v_restore_relationship_hash:=public.erp_cloud_restore_relationship_hash(v_effective);
  IF (SELECT count(*) FROM jsonb_object_keys(v_audit->'table_counts'))<>24
     OR p_manifest->>'resourceCount'<>'24'
     OR p_manifest->'counts' IS DISTINCT FROM v_audit->'table_counts'
     OR (p_manifest->>'totalRows')::bigint IS DISTINCT FROM (v_audit->>'total_rows')::bigint
     OR p_manifest->>'relationshipHash' IS DISTINCT FROM v_audit->>'relationship_hash'
     OR (p_manifest->>'orphanCount')::bigint IS DISTINCT FROM (v_integrity->>'orphan_count')::bigint
     OR (p_manifest->>'duplicateVariantIdCount')::bigint IS DISTINCT FROM (v_integrity->>'duplicate_variant_id_count')::bigint
     OR (p_manifest->>'duplicateVariantLocalIdCount')::bigint IS DISTINCT FROM (v_integrity->>'duplicate_variant_local_id_count')::bigint
     OR (p_manifest->>'duplicateCanonicalIdCount')::bigint IS DISTINCT FROM (v_integrity->>'duplicate_canonical_id_count')::bigint
     OR (p_manifest->>'canonicalIdentityAnomalyCount')::bigint IS DISTINCT FROM (v_integrity->>'canonical_identity_anomaly_count')::bigint
     OR (p_manifest->>'unknownProductCount')::bigint IS DISTINCT FROM (v_integrity->>'unknown_product_count')::bigint
     OR (p_manifest->>'optionalMetadataMissingReferenceCount')::bigint IS DISTINCT FROM (v_integrity->>'optional_metadata_missing_reference_count')::bigint
     OR (v_integrity->>'duplicate_inventory_key_count')::bigint<>0
     OR (v_integrity->>'missing_inventory_key_count')::bigint<>0 THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_CANDIDATE_INVALID';
  END IF;
  v_prepare_timings:=v_prepare_timings||jsonb_build_object('semanticProof',(extract(epoch FROM clock_timestamp()-v_phase_started)*1000)::bigint);
  v_phase_started:=clock_timestamp();
  v_actor_key:=encode(extensions.digest(v_actor::text,'sha256'),'hex');
  DELETE FROM public.erp_cloud_restore_candidate_proofs WHERE expires_at<clock_timestamp();
  v_result:=jsonb_build_object(
    'ok',true,'candidate_valid',true,'schema_version','cloud-restore-candidate-proof-v1','policy',v_policy,
    'resource_count',24,'coverage_count',24,'total_rows',(v_audit->>'total_rows')::bigint,
    'table_counts',v_audit->'table_counts','transformed_updated_by_count',v_transformed,
    'source_fingerprint',v_source_fingerprint,'effective_fingerprint',v_effective_fingerprint,
    'relationship_hash',v_audit->>'relationship_hash','integrity',v_integrity
  );
  INSERT INTO public.erp_cloud_restore_candidate_proofs(
    proof_id,actor_key,source_fingerprint,effective_fingerprint,restore_policy,target_environment,
    restore_mode,source_environment,effective_snapshot,manifest,proof_result,expires_at,
    expected_relationship_hash
  ) VALUES(
    v_proof_id,v_actor_key,v_source_fingerprint,v_effective_fingerprint,v_policy,'rhfdjsklfrgpoqsaqpkn',
    p_restore_mode,p_source_environment,'{}'::jsonb,p_manifest,v_result,v_expires_at,v_restore_relationship_hash
  );
  v_stage:=public.erp_cloud_restore_stage_candidate(v_proof_id,v_actor_key,v_effective,v_expires_at);
  IF (v_stage->>'rowCount')::bigint IS DISTINCT FROM (v_audit->>'total_rows')::bigint THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_STAGE_ROW_COUNT_MISMATCH';
  END IF;
  UPDATE public.erp_cloud_restore_candidate_proofs SET
    expected_profiles=v_stage->'profiles',prepared_row_count=(v_stage->>'rowCount')::bigint,
    prepared_byte_count=(v_stage->>'byteCount')::bigint,prepared_payload_hash=v_stage->>'payloadHash'
  WHERE proof_id=v_proof_id;
  IF v_source_generation IS DISTINCT FROM (SELECT generation FROM public.erp_restore_business_generation WHERE singleton)
     OR v_source_epoch IS DISTINCT FROM (SELECT epoch FROM public.erp_cloud_restore_epoch WHERE singleton) THEN
    RAISE EXCEPTION USING errcode='55000',message='STALE_RESTORE_PREPARE';
  END IF;
  UPDATE public.erp_cloud_restore_candidate_proofs SET source_generation=v_source_generation,source_restore_epoch=v_source_epoch
    WHERE proof_id=v_proof_id;
  v_prepare_timings:=v_prepare_timings||jsonb_build_object('decodeAndStage',(extract(epoch FROM clock_timestamp()-v_phase_started)*1000)::bigint);
  v_result:=v_result||jsonb_build_object('prepareTimingsMs',v_prepare_timings,
    'proof_id',v_proof_id,'proof_expires_at',v_expires_at,'request_id',p_request_id,
    'elapsed_ms',(extract(epoch FROM clock_timestamp()-v_started_at)*1000)::bigint,
    'prepared_row_count',(v_stage->>'rowCount')::bigint,
    'prepared_byte_count',(v_stage->>'byteCount')::bigint,
    'prepared_payload_hash',v_stage->>'payloadHash'
  );
  UPDATE public.erp_cloud_restore_candidate_proofs SET proof_result=v_result WHERE proof_id=v_proof_id;
  RAISE LOG 'CLOUD_RESTORE_TRANSPORT request=% rpc=PROOF proof=% event=db-complete',p_request_id,v_proof_id;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.erp_restore_staged_cloud_snapshot(
  p_idempotency_key uuid,
  p_proof_id uuid,
  p_snapshot_fingerprint text,
  p_manifest jsonb,
  p_source_environment text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_actor uuid:=auth.uid();
  v_actor_key text;
  v_proof public.erp_cloud_restore_candidate_proofs%rowtype;
  v_existing public.erp_cloud_restore_requests%rowtype;
  v_rollback_id uuid;
  v_before jsonb;
  v_source_generation bigint;
  v_source_epoch bigint;
  v_before_fingerprint text;
  v_table text;
  v_expected_profile jsonb;
  v_actual_profile jsonb;
  v_actual_relationship_hash text;
  v_epoch bigint;
  v_result jsonb;
  v_live_waca jsonb;
  v_started_at timestamptz:=clock_timestamp();
  v_phase_started_at timestamptz:=clock_timestamp();
  v_phase_timings jsonb:='{}'::jsonb;
  v_phase text:='auth';
  v_phase_ms bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION USING errcode='42501',message='AUTHENTICATION_REQUIRED'; END IF;
  IF NOT public.is_owner(v_actor) THEN RAISE EXCEPTION USING errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; END IF;
  v_actor_key:=encode(extensions.digest(v_actor::text,'sha256'),'hex');
  SELECT * INTO v_proof FROM public.erp_cloud_restore_candidate_proofs
   WHERE proof_id=p_proof_id AND actor_key=v_actor_key FOR UPDATE;
  IF NOT FOUND OR v_proof.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_NOT_FOUND';
  END IF;
  IF v_proof.effective_fingerprint IS DISTINCT FROM p_snapshot_fingerprint
     OR v_proof.manifest IS DISTINCT FROM p_manifest
     OR v_proof.prepared_payload_hash IS NULL
     OR v_proof.expected_relationship_hash IS NULL
     OR (SELECT coalesce(sum(row_count),0) FROM public.erp_cloud_restore_prepared_chunks WHERE proof_id=p_proof_id)
        IS DISTINCT FROM v_proof.prepared_row_count THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_STAGED_PROOF_MISMATCH';
  END IF;
  v_phase_ms:=(extract(epoch FROM clock_timestamp()-v_phase_started_at)*1000)::bigint;
  v_phase_timings:=v_phase_timings||jsonb_build_object('auth',v_phase_ms);

  v_phase:='lock_idempotency';v_phase_started_at:=clock_timestamp();
  IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) THEN
    RAISE EXCEPTION USING errcode='55006',message='CLOUD_RESTORE_LOCK_CONFLICT';
  END IF;
  INSERT INTO public.erp_cloud_restore_requests(actor_id,idempotency_key,snapshot_fingerprint,status)
  VALUES(v_actor,p_idempotency_key,v_proof.prepared_payload_hash,'processing') ON CONFLICT(actor_id,idempotency_key) DO NOTHING;
  SELECT * INTO v_existing FROM public.erp_cloud_restore_requests
   WHERE actor_id=v_actor AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF v_existing.snapshot_fingerprint<>v_proof.prepared_payload_hash THEN
    RAISE EXCEPTION USING errcode='22023',message='RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH';
  END IF;
  IF v_existing.status='completed' THEN RETURN v_existing.canonical_result||jsonb_build_object('replayed',true); END IF;
  v_phase_ms:=(extract(epoch FROM clock_timestamp()-v_phase_started_at)*1000)::bigint;
  v_phase_timings:=v_phase_timings||jsonb_build_object('lockIdempotency',v_phase_ms);

  v_phase:='source_generation';v_phase_started_at:=clock_timestamp();
  SELECT generation INTO STRICT v_source_generation FROM public.erp_restore_business_generation WHERE singleton FOR UPDATE;
  SELECT epoch INTO STRICT v_source_epoch FROM public.erp_cloud_restore_epoch WHERE singleton;
  IF v_proof.source_generation IS NULL OR v_proof.source_restore_epoch IS NULL
     OR v_source_generation IS DISTINCT FROM v_proof.source_generation
     OR v_source_epoch IS DISTINCT FROM v_proof.source_restore_epoch THEN
    RAISE EXCEPTION USING errcode='55000',message='STALE_RESTORE_PREPARE';
  END IF;
  -- This is an immutable SOURCE GENERATION receipt, NOT a rollback backup.
  -- Full recovery artifacts are exported outside execute. PostgreSQL owns rollback.
  v_before:=jsonb_build_object('schemaVersion','restore-source-generation-v1',
    'restoreEpoch',v_source_epoch,'businessGeneration',v_source_generation,
    'proofId',p_proof_id,'targetFingerprint',p_snapshot_fingerprint);
  v_before_fingerprint:=encode(extensions.digest(convert_to(v_before::text,'UTF8'),'sha256'),'hex');
  INSERT INTO public.erp_cloud_restore_snapshots(actor_id,source_environment,snapshot_fingerprint,manifest,snapshot)
  VALUES(v_actor,'restore-source-generation',v_before_fingerprint,
    jsonb_build_object('evidenceKind','SOURCE_GENERATION','atomicRollback','POSTGRESQL_TRANSACTION'),v_before)
  RETURNING id INTO v_rollback_id;
  v_phase_timings:=v_phase_timings||jsonb_build_object('beforeSnapshot',0,'sourceGeneration',
    (extract(epoch FROM clock_timestamp()-v_phase_started_at)*1000)::bigint);

  PERFORM set_config('erp.cloud_restore_active','on',true);
  v_phase:='delete';v_phase_started_at:=clock_timestamp();
  DELETE FROM public.outbound_shipment_items WHERE id IS NOT NULL;
  DELETE FROM public.outbound_shipments WHERE id IS NOT NULL;
  DELETE FROM public.japan_package_items WHERE id IS NOT NULL;
  DELETE FROM public.japan_packages WHERE id IS NOT NULL;
  DELETE FROM public.private_order_items WHERE id IS NOT NULL;
  DELETE FROM public.purchase_batch_items WHERE id IS NOT NULL;
  DELETE FROM public.sales_order_items WHERE id IS NOT NULL;
  DELETE FROM public.bundle_components WHERE id IS NOT NULL;
  DELETE FROM public.private_orders WHERE id IS NOT NULL;
  DELETE FROM public.purchase_batches WHERE id IS NOT NULL;
  DELETE FROM public.dashboard_category_images WHERE id IS NOT NULL;
  DELETE FROM public.waca_order_items WHERE id IS NOT NULL;
  DELETE FROM public.waca_mappings WHERE id IS NOT NULL;
  DELETE FROM public.waca_master_links WHERE id IS NOT NULL;
  DELETE FROM public.waca_cutover_audit WHERE id IS NOT NULL;
  DELETE FROM public.waca_import_batches WHERE id IS NOT NULL;
  DELETE FROM public.waca_state WHERE id IS NOT NULL;
  DELETE FROM public.waca_orders WHERE id IS NOT NULL;
  DELETE FROM public.import_batches WHERE id IS NOT NULL;
  DELETE FROM public.product_variants WHERE id IS NOT NULL;
  DELETE FROM public.product_categories WHERE id IS NOT NULL;
  DELETE FROM public.sales_orders WHERE id IS NOT NULL;
  DELETE FROM public.product_groups WHERE id IS NOT NULL;
  DELETE FROM public.inventory_items WHERE id IS NOT NULL;
  v_phase_ms:=(extract(epoch FROM clock_timestamp()-v_phase_started_at)*1000)::bigint;
  v_phase_timings:=v_phase_timings||jsonb_build_object('delete',v_phase_ms);

  v_phase:='insert';v_phase_started_at:=clock_timestamp();
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.inventory_items',p_proof_id,'inventory_items');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.product_groups',p_proof_id,'product_groups');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.product_categories',p_proof_id,'product_categories');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.product_variants',p_proof_id,'product_variants');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.bundle_components',p_proof_id,'bundle_components');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.purchase_batches',p_proof_id,'purchase_batches');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.purchase_batch_items',p_proof_id,'purchase_batch_items');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.private_orders',p_proof_id,'private_orders');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.private_order_items',p_proof_id,'private_order_items');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.sales_orders',p_proof_id,'sales_orders');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.sales_order_items',p_proof_id,'sales_order_items');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.japan_packages',p_proof_id,'japan_packages');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.japan_package_items',p_proof_id,'japan_package_items');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.outbound_shipments',p_proof_id,'outbound_shipments');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.outbound_shipment_items',p_proof_id,'outbound_shipment_items');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.dashboard_category_images',p_proof_id,'dashboard_category_images');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.import_batches',p_proof_id,'import_batches');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.waca_orders',p_proof_id,'waca_orders');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.waca_order_items',p_proof_id,'waca_order_items');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.waca_mappings',p_proof_id,'waca_mappings');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.waca_master_links',p_proof_id,'waca_master_links');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.waca_import_batches',p_proof_id,'waca_import_batches');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.waca_cutover_audit',p_proof_id,'waca_cutover_audit');
  PERFORM public.erp_cloud_restore_insert_staged_rows('public.waca_state',p_proof_id,'waca_state');
  PERFORM public.erp_cloud_restore_recompute_waca_quantities();
  PERFORM public.erp_cloud_restore_validate_live_waca();
  v_phase_ms:=(extract(epoch FROM clock_timestamp()-v_phase_started_at)*1000)::bigint;
  v_phase_timings:=v_phase_timings||jsonb_build_object('insert',v_phase_ms);

  v_phase:='integrity';v_phase_started_at:=clock_timestamp();
  FOREACH v_table IN ARRAY ARRAY[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state'
  ] LOOP
    v_actual_profile:=public.erp_cloud_restore_table_profile(format('public.%I',v_table)::regclass,NULL::jsonb);
    v_expected_profile:=v_proof.expected_profiles->v_table;
    IF (v_actual_profile->>'count')::bigint IS DISTINCT FROM (v_expected_profile->>'count')::bigint THEN
      RAISE EXCEPTION USING errcode='23000',message='CLOUD_RESTORE_POST_INTEGRITY_COUNT_MISMATCH:'||v_table;
    END IF;
    IF v_actual_profile->>'identityHash' IS DISTINCT FROM v_expected_profile->>'identityHash' THEN
      RAISE EXCEPTION USING errcode='23000',message='CLOUD_RESTORE_POST_INTEGRITY_IDENTITY_HASH_MISMATCH:'||v_table;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.product_variants v LEFT JOIN public.product_groups g ON g.id=v.product_group_id WHERE g.id IS NULL
    UNION ALL SELECT 1 FROM public.purchase_batch_items i LEFT JOIN public.purchase_batches b ON b.id=i.purchase_batch_id WHERE b.id IS NULL
    UNION ALL SELECT 1 FROM public.private_order_items i LEFT JOIN public.private_orders o ON o.id=i.private_order_id WHERE o.id IS NULL
    UNION ALL SELECT 1 FROM public.sales_order_items i LEFT JOIN public.sales_orders o ON o.id=i.order_id WHERE o.id IS NULL
    UNION ALL SELECT 1 FROM public.japan_package_items i LEFT JOIN public.japan_packages p ON p.id=i.japan_package_id WHERE p.id IS NULL
    UNION ALL SELECT 1 FROM public.outbound_shipment_items i LEFT JOIN public.outbound_shipments s ON s.id=i.outbound_shipment_id WHERE s.id IS NULL
  ) THEN RAISE EXCEPTION USING errcode='23503',message='CLOUD_RESTORE_POST_INTEGRITY_ORPHAN'; END IF;
  v_actual_relationship_hash:=public.erp_cloud_restore_live_relationship_hash();
  IF v_actual_relationship_hash<>v_proof.expected_relationship_hash THEN
    RAISE EXCEPTION USING errcode='23000',message='CLOUD_RESTORE_POST_INTEGRITY_RELATIONSHIP_HASH_MISMATCH';
  END IF;
  v_phase_ms:=(extract(epoch FROM clock_timestamp()-v_phase_started_at)*1000)::bigint;
  v_phase_timings:=v_phase_timings||jsonb_build_object('integrity',v_phase_ms);

  v_phase:='commit';v_phase_started_at:=clock_timestamp();
  UPDATE public.erp_cloud_restore_epoch SET epoch=epoch+1,restored_at=now(),restored_by=v_actor,
    snapshot_fingerprint=v_proof.prepared_payload_hash WHERE singleton=true RETURNING epoch INTO v_epoch;
  v_phase_timings:=v_phase_timings||jsonb_build_object('commit',
    (extract(epoch FROM clock_timestamp()-v_phase_started_at)*1000)::bigint,
    'total',(extract(epoch FROM clock_timestamp()-v_started_at)*1000)::bigint);
  v_result:=jsonb_build_object(
    'ok',true,'replayed',false,'idempotencyKey',p_idempotency_key,
    'snapshotFingerprint',p_snapshot_fingerprint,'serverSnapshotFingerprint',v_proof.prepared_payload_hash,
    'rollbackSnapshotId',v_rollback_id,'restoreEpoch',v_epoch,'manifest',p_manifest,
    'serverRelationshipHash',v_actual_relationship_hash,'timingsMs',v_phase_timings,
    'executeModel','typed-staged-generation-v2','recoveryEvidenceKind','SOURCE_GENERATION'
  );
  UPDATE public.erp_cloud_restore_requests SET status='completed',rollback_snapshot_id=v_rollback_id,
    canonical_result=v_result,completed_at=now() WHERE actor_id=v_actor AND idempotency_key=p_idempotency_key;
  RETURN v_result;
EXCEPTION WHEN query_canceled THEN
  RAISE LOG 'CLOUD_RESTORE_STAGED_TIMING phase=failure failed_phase=% classification=statement_timeout total_ms=%',
    v_phase,(extract(epoch FROM clock_timestamp()-v_started_at)*1000)::bigint;
  RAISE;
WHEN OTHERS THEN
  RAISE LOG 'CLOUD_RESTORE_STAGED_TIMING phase=failure failed_phase=% sqlstate=% total_ms=%',
    v_phase,SQLSTATE,(extract(epoch FROM clock_timestamp()-v_started_at)*1000)::bigint;
  RAISE;
END;
$function$;

DO $postflight$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['inventory_items','product_groups','product_categories','product_variants','bundle_components','purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items','japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches','waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state'] LOOP
    IF has_table_privilege('anon',format('public.%I','erp_restore_stage_'||r),'SELECT')
       OR has_table_privilege('authenticated',format('public.%I','erp_restore_stage_'||r),'SELECT')
       OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=format('public.%I','erp_restore_stage_'||r)::regclass) THEN
      RAISE EXCEPTION USING errcode='55000',message='RESTORE_058_SECURITY_POSTFLIGHT_FAILED';
    END IF;
  END LOOP;
END;
$postflight$;
-- A server restart is classified only AFTER the existing epoch/receipt/lock
-- reconciliation has conclusively proved NONCOMMIT, never from fetch failure.
ALTER TABLE public.erp_cloud_restore_failures DROP CONSTRAINT erp_cloud_restore_failures_category_check;
ALTER TABLE public.erp_cloud_restore_failures ADD CONSTRAINT erp_cloud_restore_failures_category_check
 CHECK(category IN ('TIMEOUT','VALIDATION','PORTABILITY','CONSTRAINT','AUTHORIZATION','STALE','INTERNAL','UNKNOWN','DATABASE_INTERRUPTED'));
CREATE OR REPLACE FUNCTION public.erp_cloud_restore_failure_category(p_state text,p_message text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $function$
 SELECT CASE WHEN p_message='STALE_RESTORE_PREPARE' THEN 'STALE'
 WHEN p_state='57014' THEN 'TIMEOUT' WHEN p_state='42501' THEN 'AUTHORIZATION'
 WHEN p_message IN ('CLOUD_RESTORE_ATTEMPT_EPOCH_MISMATCH','CLOUD_RESTORE_STALE_EPOCH') THEN 'STALE'
 WHEN p_message LIKE 'CLOUD_RESTORE_PORTABILITY_%' OR p_message LIKE 'RESTORE_PORTABILITY_%' THEN 'PORTABILITY'
 WHEN left(p_state,2)='23' THEN 'CONSTRAINT' WHEN left(p_state,2)='22' THEN 'VALIDATION'
 WHEN left(p_state,2) IN ('XX','42','53','54','58') THEN 'INTERNAL' ELSE 'UNKNOWN' END
$function$;
create or replace function public.erp_reconcile_cloud_restore_attempt(p_attempt_id uuid,p_trace_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,extensions set statement_timeout='10s' as $$
declare
  v_actor uuid:=auth.uid();
  v_attempt public.erp_cloud_restore_attempts%rowtype;
  v_out jsonb;
  v_failure jsonb;
  v_epoch bigint;
  v_fingerprint text;
  v_after timestamptz;
  v_locked boolean;
begin
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  v_locked:=pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-attempt:'||p_attempt_id::text,0));
  select * into v_attempt from public.erp_cloud_restore_attempts where attempt_id=p_attempt_id
    and trace_id=p_trace_id and actor_key=encode(digest(v_actor::text,'sha256'),'hex');
  if not found then raise exception using errcode='22023',message='CLOUD_RESTORE_ATTEMPT_NOT_FOUND'; end if;
  v_after:=coalesce(v_attempt.execution_started_at,v_attempt.submitted_at)
    +(v_attempt.timeout_budget_ms+v_attempt.grace_ms)*interval '1 millisecond';
  v_out:=jsonb_build_object('status','pending','attemptId',p_attempt_id,'traceId',p_trace_id,
    'executionId',v_attempt.execution_id,'expectedEpoch',v_attempt.expected_epoch,
    'effectiveFingerprint',v_attempt.effective_fingerprint,'reconcileAfter',v_after);
  if not v_locked then return v_out||jsonb_build_object('reason','active-execution-lock'); end if;
  begin
    select * into strict v_attempt from public.erp_cloud_restore_attempts where attempt_id=p_attempt_id for update nowait;
  exception when lock_not_available then return v_out||jsonb_build_object('reason','active-execution-lock');
  end;
  if v_attempt.status='completed' then
    return v_out||jsonb_build_object('status','completed','resultEpoch',v_attempt.result_epoch,'restoreResult',v_attempt.canonical_result);
  end if;
  if v_attempt.status='not_committed' then
    v_failure:=public.erp_cloud_restore_failure_result(p_attempt_id);
    return coalesce(v_failure,v_out||jsonb_build_object('status','not_committed'));
  end if;
  if v_attempt.status in ('prepared','executing') and clock_timestamp()<v_after then
    return v_out||jsonb_build_object('reason','timeout-grace-active');
  end if;
  if v_attempt.status not in ('prepared','executing') then
    return v_out||jsonb_build_object('reason','nonterminal-state-unrecognized');
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) then
    return v_out||jsonb_build_object('reason','active-execution-lock');
  end if;
  select epoch,snapshot_fingerprint into strict v_epoch,v_fingerprint
    from public.erp_cloud_restore_epoch where singleton=true;
  if v_epoch is distinct from v_attempt.expected_epoch
     or v_fingerprint is not distinct from v_attempt.effective_fingerprint
     or exists(select 1 from public.erp_cloud_restore_requests where idempotency_key=p_attempt_id) then
    return v_out||jsonb_build_object('reason','epoch-or-request-ambiguous');
  end if;
  update public.erp_cloud_restore_attempts
     set status='not_committed',reconciled_at=clock_timestamp()
   where attempt_id=p_attempt_id;
  insert into public.erp_cloud_restore_failures(
    attempt_id,trace_id,execution_id,phase,category,code,timeout_classification,evidence
  ) values(
    p_attempt_id,p_trace_id,v_attempt.execution_id,'reconcile',case when pg_postmaster_start_time()>v_attempt.submitted_at and pg_postmaster_start_time()<=v_after then 'DATABASE_INTERRUPTED' else 'UNKNOWN' end,
    case when pg_postmaster_start_time()>v_attempt.submitted_at and pg_postmaster_start_time()<=v_after then 'CLOUD_RESTORE_FAILURE_DATABASE_INTERRUPTED' else 'CLOUD_RESTORE_FAILURE_UNKNOWN' end,'unobserved','reconciled-noncommit'
  );
  raise log 'CLOUD_RESTORE_ATTEMPT_PHASE attempt=% trace=% execution=% phase=RECONCILING event=closed-noncommit prior_status=%',
    p_attempt_id,p_trace_id,v_attempt.execution_id,v_attempt.status;
  return public.erp_cloud_restore_failure_result(p_attempt_id);
end;
$$;

-- Bounded authenticated prepare transport. Upload/stage are OPS writes, never
-- business writes. Finalize performs the unchanged canonical semantic proof.
CREATE TABLE public.erp_restore_upload_requests(
 request_id uuid PRIMARY KEY,actor_key text NOT NULL,manifest jsonb NOT NULL,
 restore_mode text NOT NULL CHECK(restore_mode IN ('strict','cross-environment')),
 source_environment text NOT NULL,source_generation bigint NOT NULL,source_epoch bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 completed_result jsonb,CHECK(expires_at>created_at)
);
CREATE TABLE public.erp_restore_upload_chunks(
 request_id uuid NOT NULL REFERENCES public.erp_restore_upload_requests(request_id) ON DELETE CASCADE,
 resource text NOT NULL,ordinal integer NOT NULL CHECK(ordinal>=0),
 rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows) BETWEEN 1 AND 512),
 payload_hash text NOT NULL,PRIMARY KEY(request_id,resource,ordinal)
);
ALTER TABLE public.erp_restore_upload_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_restore_upload_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.erp_restore_upload_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_restore_upload_chunks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_restore_upload_requests,public.erp_restore_upload_chunks FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.erp_restore_upload_owner(p_request_id uuid) RETURNS public.erp_restore_upload_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE r public.erp_restore_upload_requests%rowtype;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_owner(auth.uid()) THEN
  RAISE EXCEPTION USING errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; END IF;
 IF split_part(lower(coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'host','')),'.',1)<>'rhfdjsklfrgpoqsaqpkn' THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_TARGET_MISMATCH'; END IF;
 SELECT * INTO r FROM public.erp_restore_upload_requests
  WHERE request_id=p_request_id AND actor_key=encode(extensions.digest(auth.uid()::text,'sha256'),'hex');
 IF NOT FOUND OR r.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_NOT_FOUND'; END IF;
 RETURN r;
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_restore_upload_owner(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.erp_begin_restore_upload(p_request_id uuid,p_manifest jsonb,p_restore_mode text,p_source_environment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE r public.erp_restore_upload_requests%rowtype;g bigint;e bigint;k text;
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
 DELETE FROM public.erp_restore_upload_requests WHERE expires_at<clock_timestamp();
 INSERT INTO public.erp_restore_upload_requests(request_id,actor_key,manifest,restore_mode,source_environment,source_generation,source_epoch,expires_at)
  VALUES(p_request_id,k,p_manifest,p_restore_mode,p_source_environment,g,e,clock_timestamp()+interval '30 minutes')
  ON CONFLICT DO NOTHING;
 r:=public.erp_restore_upload_owner(p_request_id);
 IF r.manifest IS DISTINCT FROM p_manifest OR r.restore_mode IS DISTINCT FROM p_restore_mode
  OR r.source_environment IS DISTINCT FROM p_source_environment THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_IDENTITY_MISMATCH'; END IF;
 RETURN jsonb_build_object('requestId',p_request_id,'sourceEpoch',r.source_epoch,'sourceGeneration',r.source_generation);
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_begin_restore_upload(uuid,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erp_begin_restore_upload(uuid,jsonb,text,text) TO authenticated;

CREATE FUNCTION public.erp_upload_restore_chunk(p_request_id uuid,p_resource text,p_ordinal integer,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE r public.erp_restore_upload_requests%rowtype;h text;n integer;expected integer;previous text;
BEGIN
 r:=public.erp_restore_upload_owner(p_request_id);
 IF r.completed_result IS NOT NULL THEN RAISE EXCEPTION USING errcode='55000',message='CLOUD_RESTORE_UPLOAD_CLOSED'; END IF;
 IF NOT (r.manifest->'counts' ? p_resource) OR p_resource<>ALL(ARRAY[
  'inventory_items','product_groups','product_categories','product_variants','bundle_components',
  'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
  'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
  'waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state'])
  OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR p_ordinal IS NULL OR p_ordinal<0
  OR pg_column_size(p_rows)>2097152 THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_CHUNK_INVALID'; END IF;
 n:=jsonb_array_length(p_rows);expected:=(r.manifest->'counts'->>p_resource)::integer;
 IF n<>least(512,expected-p_ordinal*512) OR n NOT BETWEEN 1 AND 512 THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_CHUNK_COUNT_MISMATCH'; END IF;
 h:=encode(extensions.digest(convert_to(p_rows::text,'UTF8'),'sha256'),'hex');
 INSERT INTO public.erp_restore_upload_chunks(request_id,resource,ordinal,rows,payload_hash)
  VALUES(p_request_id,p_resource,p_ordinal,p_rows,h) ON CONFLICT DO NOTHING;
 SELECT payload_hash INTO STRICT previous FROM public.erp_restore_upload_chunks
  WHERE request_id=p_request_id AND resource=p_resource AND ordinal=p_ordinal;
 IF h<>previous THEN RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_CHUNK_IDENTITY_MISMATCH'; END IF;
 RETURN jsonb_build_object('resource',p_resource,'ordinal',p_ordinal,'rows',n,'hash',h);
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_upload_restore_chunk(uuid,text,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erp_upload_restore_chunk(uuid,text,integer,jsonb) TO authenticated;

CREATE FUNCTION public.erp_finalize_restore_upload(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE r public.erp_restore_upload_requests%rowtype;d jsonb:='{}';v_resource text;rows jsonb;
 result jsonb;started timestamptz:=clock_timestamp();assembled timestamptz;
BEGIN
 r:=public.erp_restore_upload_owner(p_request_id);
 IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-restore-upload:'||p_request_id::text,0)) THEN
  RAISE EXCEPTION USING errcode='55006',message='CLOUD_RESTORE_UPLOAD_BUSY'; END IF;
 IF r.completed_result IS NOT NULL THEN RETURN r.completed_result; END IF;
 IF r.source_generation IS DISTINCT FROM (SELECT generation FROM public.erp_restore_business_generation WHERE singleton)
  OR r.source_epoch IS DISTINCT FROM (SELECT epoch FROM public.erp_cloud_restore_epoch WHERE singleton) THEN
  RAISE EXCEPTION USING errcode='55000',message='STALE_RESTORE_PREPARE'; END IF;
 FOR v_resource IN SELECT jsonb_object_keys(r.manifest->'counts') LOOP
  SELECT coalesce(jsonb_agg(row_value ORDER BY c.ordinal,x.ordinality),'[]') INTO rows
   FROM public.erp_restore_upload_chunks c CROSS JOIN LATERAL jsonb_array_elements(c.rows) WITH ORDINALITY x(row_value,ordinality)
   WHERE c.request_id=p_request_id AND c.resource=v_resource;
  IF jsonb_array_length(rows)<>(r.manifest->'counts'->>v_resource)::integer THEN
   RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_INCOMPLETE'; END IF;
  d:=d||jsonb_build_object(v_resource,rows);
 END LOOP;
 assembled:=clock_timestamp();
 result:=public.erp_prove_cloud_restore_candidate_v2(d,r.manifest,r.restore_mode,r.source_environment,p_request_id);
 IF r.source_generation IS DISTINCT FROM (SELECT generation FROM public.erp_restore_business_generation WHERE singleton)
  OR r.source_epoch IS DISTINCT FROM (SELECT epoch FROM public.erp_cloud_restore_epoch WHERE singleton) THEN
  RAISE EXCEPTION USING errcode='55000',message='STALE_RESTORE_PREPARE'; END IF;
 result:=result||jsonb_build_object('uploadAssemblyMs',(extract(epoch FROM assembled-started)*1000)::bigint,
  'finalizeServerMs',(extract(epoch FROM clock_timestamp()-started)*1000)::bigint);
 UPDATE public.erp_restore_upload_requests SET completed_result=result WHERE request_id=p_request_id;
 DELETE FROM public.erp_restore_upload_chunks WHERE request_id=p_request_id;
 RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_finalize_restore_upload(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erp_finalize_restore_upload(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.erp_cloud_restore_validate_waca_dataset(p_data jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_mode text;
  v_row jsonb;
  v_identity text;
  v_payload_key text;
  v_resource text;
  v_key_name text;
BEGIN
  IF p_data ? 'outbound_shipments' THEN
    SELECT value INTO v_row FROM jsonb_array_elements(p_data->'outbound_shipments')
      WHERE NOT (value ? 'status_changed_at') LIMIT 1;
    IF FOUND THEN
      PERFORM public.erp_cloud_restore_validation_error('outbound_shipments',
        coalesce(v_row->>'id','unknown'),'OUTBOUND_TIMESTAMP_EVIDENCE_MISSING');
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'import_batches','waca_orders','waca_order_items','waca_mappings','waca_master_links',
      'waca_import_batches','waca_cutover_audit','waca_state'
    ]) resource WHERE jsonb_typeof(p_data->resource) IS DISTINCT FROM 'array'
  ) OR jsonb_array_length(p_data->'waca_state') <> 1 THEN
    PERFORM public.erp_cloud_restore_validation_error('waca_state','singleton','WACA_RESTORE_RESOURCE_MISSING');
  END IF;

  v_mode := p_data->'waca_state'->0->>'mode';
  IF p_data->'waca_state'->0->>'id' <> '00000000-0000-4000-8000-000000000001'
     OR v_mode NOT IN ('LEGACY_QUANTITY_ACTIVE','ORDER_REBASELINE_REQUIRED','ORDER_DRIVEN_ACTIVE')
     OR (p_data->'waca_state'->0->>'revision') !~ '^[0-9]+$' THEN
    PERFORM public.erp_cloud_restore_validation_error('waca_state','singleton','WACA_CUTOVER_STATE_INVALID');
  END IF;

  FOREACH v_resource IN ARRAY ARRAY[
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state'
  ] LOOP
    SELECT value INTO v_row
      FROM jsonb_array_elements(p_data->v_resource)
     WHERE coalesce(btrim(value->>'id'),'') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     LIMIT 1;
    IF FOUND THEN
      PERFORM public.erp_cloud_restore_validation_error(v_resource,coalesce(v_row->>'id','unknown'),'WACA_CANONICAL_IDENTITY_MISSING');
    END IF;
  END LOOP;

  FOR v_resource, v_key_name IN
    SELECT * FROM (VALUES
      ('waca_orders','order_key'),('waca_order_items','item_key'),('waca_mappings','feature'),
      ('waca_master_links','child_code'),('waca_import_batches','batch_key'),
      ('waca_cutover_audit','product_variant_id')
    ) spec(resource,key_name)
  LOOP
    SELECT value INTO v_row
      FROM jsonb_array_elements(p_data->v_resource)
     WHERE coalesce(btrim(value->>v_key_name),'')=''
     LIMIT 1;
    IF FOUND THEN
      PERFORM public.erp_cloud_restore_validation_error(v_resource,v_key_name,'WACA_BUSINESS_KEY_MISSING');
    END IF;
    SELECT value->>v_key_name INTO v_identity
      FROM jsonb_array_elements(p_data->v_resource)
     GROUP BY value->>v_key_name
    HAVING count(*) > 1
     LIMIT 1;
    IF FOUND THEN
      PERFORM public.erp_cloud_restore_validation_error(v_resource,coalesce(v_identity,v_key_name),'WACA_DUPLICATE_BUSINESS_KEY');
    END IF;
  END LOOP;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_data->'waca_orders') LOOP
    v_identity := coalesce(v_row->>'order_key', v_row->>'id', 'unknown');
    IF v_row->>'status' NOT IN ('處理中','完成付款','取消','失敗') THEN
      PERFORM public.erp_cloud_restore_validation_error('waca_orders',v_identity,'WACA_ORDER_STATUS_INVALID');
    END IF;
    IF jsonb_typeof(v_row->'payload') IS DISTINCT FROM 'object'
       OR coalesce(btrim(v_row->'payload'->>'key'),'') = '' THEN
      PERFORM public.erp_cloud_restore_validation_error('waca_orders',v_identity,'WACA_PAYLOAD_KEY_MISSING');
    END IF;
    v_payload_key := v_row->'payload'->>'key';
    IF v_payload_key IS DISTINCT FROM v_row->>'order_key' THEN
      PERFORM public.erp_cloud_restore_validation_error('waca_orders',v_identity,'WACA_PAYLOAD_KEY_MISMATCH');
    END IF;
  END LOOP;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_data->'waca_order_items') LOOP
    v_identity := coalesce(v_row->>'item_key', v_row->>'id', 'unknown');
    IF (v_row->>'quantity') !~ '^[0-9]+$' THEN
      PERFORM public.erp_cloud_restore_validation_error('waca_order_items',v_identity,'WACA_QUANTITY_INVALID');
    END IF;
    IF jsonb_typeof(v_row->'payload') IS DISTINCT FROM 'object'
       OR coalesce(btrim(v_row->'payload'->>'key'),'') = '' THEN
      PERFORM public.erp_cloud_restore_validation_error('waca_order_items',v_identity,'WACA_PAYLOAD_KEY_MISSING');
    END IF;
    v_payload_key := v_row->'payload'->>'key';
    IF v_payload_key IS DISTINCT FROM v_row->>'item_key' THEN
      PERFORM public.erp_cloud_restore_validation_error('waca_order_items',v_identity,'WACA_PAYLOAD_KEY_MISMATCH');
    END IF;
  END LOOP;

  SELECT item INTO v_row
    FROM jsonb_array_elements(p_data->'waca_order_items') item
   WHERE NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(p_data->'waca_orders') order_row
      WHERE order_row->>'id'=item->>'order_id'
   )
   LIMIT 1;
  IF FOUND THEN
    PERFORM public.erp_cloud_restore_validation_error(
      'waca_order_items',coalesce(v_row->>'item_key',v_row->>'id','unknown'),'WACA_ORDER_ITEM_ORPHAN'
    );
  END IF;

  SELECT mapping INTO v_row
    FROM jsonb_array_elements(p_data->'waca_mappings') mapping
   WHERE NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(p_data->'product_variants') variant
      WHERE variant->>'id'=mapping->>'product_variant_id'
   )
   LIMIT 1;
  IF FOUND THEN
    PERFORM public.erp_cloud_restore_validation_error(
      'waca_mappings',coalesce(v_row->>'feature',v_row->>'id','unknown'),'WACA_MAPPING_VARIANT_INVALID'
    );
  END IF;

  SELECT link INTO v_row
    FROM jsonb_array_elements(p_data->'waca_master_links') link
   WHERE coalesce(btrim(link->>'product_variant_id'),'')<>''
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_data->'product_variants') variant
        WHERE variant->>'id'=link->>'product_variant_id'
     )
   LIMIT 1;
  IF FOUND THEN
    PERFORM public.erp_cloud_restore_validation_error(
      'waca_master_links',coalesce(v_row->>'child_code',v_row->>'id','unknown'),'WACA_MASTER_LINK_INVALID'
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_data->'waca_order_items') item
      JOIN jsonb_array_elements(p_data->'waca_mappings') mapping
        ON mapping->>'feature'=item->>'feature'
     WHERE item->>'product_variant_id' IS NOT NULL
       AND item->>'product_variant_id' IS DISTINCT FROM mapping->>'product_variant_id'
  ) THEN
    PERFORM public.erp_cloud_restore_validation_error('waca_mappings','feature','WACA_MAPPING_MISMATCH');
  END IF;

  IF v_mode='ORDER_DRIVEN_ACTIVE' AND EXISTS (
    WITH quantities AS (
      SELECT item->>'product_variant_id' variant_id,
        sum((item->>'quantity')::integer) quantity
      FROM jsonb_array_elements(p_data->'waca_order_items') item
      JOIN jsonb_array_elements(p_data->'waca_orders') order_row
        ON order_row->>'id'=item->>'order_id'
      WHERE item->>'product_variant_id' IS NOT NULL
        AND order_row->>'status' IN ('處理中','完成付款')
      GROUP BY item->>'product_variant_id'
    )
    SELECT 1 FROM jsonb_array_elements(p_data->'product_variants') variant
    LEFT JOIN quantities q ON q.variant_id=variant->>'id'
    WHERE (variant->>'waca_auto_quantity')::integer IS DISTINCT FROM coalesce(q.quantity,0)
  ) THEN
    PERFORM public.erp_cloud_restore_validation_error('product_variants','waca_auto_quantity','WACA_QUANTITY_RECONCILIATION_FAILED');
  END IF;
END;
$function$;
-- Exact same-environment audit preservation; no auth data is returned. Legacy
-- or unknown target actor references still use the existing portability policy.
CREATE FUNCTION public.erp_restore_audit_identity_compatibility(p_actor_ids uuid[])
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $function$
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_owner(auth.uid()) THEN
  RAISE EXCEPTION USING errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; END IF;
 IF split_part(lower(coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'host','')),'.',1)<>'rhfdjsklfrgpoqsaqpkn'
  OR p_actor_ids IS NULL OR cardinality(p_actor_ids)>10000 THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_INPUT_INVALID'; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM unnest(p_actor_ids) actor_id WHERE actor_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=actor_id));
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_restore_audit_identity_compatibility(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erp_restore_audit_identity_compatibility(uuid[]) TO authenticated;
-- Set-based final WACA proof. No large business JSON aggregation in Execute.
CREATE FUNCTION public.erp_cloud_restore_validate_live_waca()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE mode_value text;
BEGIN
 SELECT mode INTO mode_value FROM public.waca_state WHERE id='00000000-0000-4000-8000-000000000001';
 IF mode_value IS NULL OR (SELECT count(*) FROM public.waca_state)<>1
  OR mode_value NOT IN ('LEGACY_QUANTITY_ACTIVE','ORDER_REBASELINE_REQUIRED','ORDER_DRIVEN_ACTIVE')
  OR EXISTS(SELECT 1 FROM public.waca_orders WHERE coalesce(btrim(payload->>'key'),'')='' OR payload->>'key' IS DISTINCT FROM order_key)
  OR EXISTS(SELECT 1 FROM public.waca_order_items WHERE coalesce(btrim(payload->>'key'),'')='' OR payload->>'key' IS DISTINCT FROM item_key OR quantity<0)
  OR EXISTS(SELECT 1 FROM public.waca_order_items i LEFT JOIN public.waca_orders o ON o.id=i.order_id WHERE o.id IS NULL)
  OR EXISTS(SELECT 1 FROM public.waca_mappings m LEFT JOIN public.product_variants v ON v.id=m.product_variant_id WHERE v.id IS NULL)
  OR EXISTS(SELECT 1 FROM public.waca_master_links m LEFT JOIN public.product_variants v ON v.id=m.product_variant_id WHERE m.product_variant_id IS NOT NULL AND v.id IS NULL)
  OR EXISTS(SELECT 1 FROM public.waca_order_items i JOIN public.waca_mappings m USING(feature)
     WHERE i.product_variant_id IS NOT NULL AND i.product_variant_id IS DISTINCT FROM m.product_variant_id) THEN
   RAISE EXCEPTION USING errcode='23000',message='CLOUD_RESTORE_POST_WACA_INTEGRITY_FAILED';
 END IF;
 IF mode_value='ORDER_DRIVEN_ACTIVE' AND EXISTS(
  WITH q AS(SELECT i.product_variant_id,sum(i.quantity) quantity FROM public.waca_order_items i
   JOIN public.waca_orders o ON o.id=i.order_id WHERE i.product_variant_id IS NOT NULL
    AND o.status IN ('處理中','完成付款') GROUP BY i.product_variant_id)
  SELECT 1 FROM public.product_variants v LEFT JOIN q ON q.product_variant_id=v.id
   WHERE v.waca_auto_quantity IS DISTINCT FROM coalesce(q.quantity,0)) THEN
   RAISE EXCEPTION USING errcode='23000',message='CLOUD_RESTORE_POST_WACA_QUANTITY_FAILED';
 END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_cloud_restore_validate_live_waca() FROM PUBLIC,anon,authenticated;
COMMIT;
