-- 057: keep the 043 short execute envelope while moving repeated 24 MB JSONB
-- validation and decoding out of the atomic business transaction.
BEGIN;

DO $preflight$
BEGIN
  IF current_user <> 'postgres'
     OR to_regclass('public.erp_cloud_restore_candidate_proofs') IS NULL
     OR to_regclass('public.erp_cloud_restore_attempts') IS NULL
     OR to_regclass('public.erp_cloud_restore_failures') IS NULL
     OR to_regprocedure('public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)') IS NULL
     OR to_regprocedure('public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.erp_cloud_restore_insert_rows(regclass,jsonb)') IS NULL
     OR to_regprocedure('public.erp_cloud_restore_recompute_waca_quantities()') IS NULL THEN
    RAISE EXCEPTION USING errcode='55000', message='RESTORE_057_PRECONDITION_MISSING';
  END IF;
  IF to_regclass('public.erp_cloud_restore_prepared_chunks') IS NOT NULL
     OR to_regprocedure('public.erp_restore_staged_cloud_snapshot(uuid,uuid,text,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION USING errcode='42710', message='RESTORE_057_COLLISION';
  END IF;
END;
$preflight$;

ALTER TABLE public.erp_cloud_restore_candidate_proofs
  ADD COLUMN expected_profiles jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN expected_relationship_hash text,
  ADD COLUMN prepared_row_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN prepared_byte_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN prepared_payload_hash text;

CREATE TABLE public.erp_cloud_restore_prepared_chunks (
  proof_id uuid NOT NULL REFERENCES public.erp_cloud_restore_candidate_proofs(proof_id) ON DELETE CASCADE,
  actor_key text NOT NULL CHECK (actor_key ~ '^[0-9a-f]{64}$'),
  resource text NOT NULL CHECK (resource = ANY (ARRAY[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state'
  ])),
  chunk_ordinal integer NOT NULL CHECK (chunk_ordinal >= 0),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 256),
  rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array' AND jsonb_array_length(rows) = row_count),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (proof_id, resource, chunk_ordinal),
  CHECK (expires_at > created_at)
);
CREATE INDEX erp_cloud_restore_prepared_chunks_expiry_idx
  ON public.erp_cloud_restore_prepared_chunks(expires_at);
ALTER TABLE public.erp_cloud_restore_prepared_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_cloud_restore_prepared_chunks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.erp_cloud_restore_prepared_chunks FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.erp_cloud_restore_validation_error(
  p_resource text,
  p_row_identity text,
  p_reason_code text
) RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  RAISE EXCEPTION USING
    errcode = '22023',
    message = 'RESTORE_VALIDATION_ERROR|prepare|' || coalesce(nullif(p_resource,''),'unknown') || '|' ||
      coalesce(nullif(p_row_identity,''),'unknown') || '|' || coalesce(nullif(p_reason_code,''),'RESTORE_ROW_INVALID'),
    detail = jsonb_build_object(
      'category','RESTORE_VALIDATION_ERROR', 'phase','prepare',
      'resource',coalesce(nullif(p_resource,''),'unknown'),
      'rowIdentity',coalesce(nullif(p_row_identity,''),'unknown'),
      'reasonCode',coalesce(nullif(p_reason_code,''),'RESTORE_ROW_INVALID')
    )::text;
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_cloud_restore_validation_error(text,text,text) FROM PUBLIC, anon, authenticated;

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
REVOKE ALL ON FUNCTION public.erp_cloud_restore_validate_waca_dataset(jsonb) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.erp_cloud_restore_prepared_profile(p_proof_id uuid, p_resource text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
DECLARE
  v_profile jsonb;
BEGIN
  IF p_resource <> ALL (ARRAY[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links',
    'waca_import_batches','waca_cutover_audit','waca_state'
  ]) THEN
    RAISE EXCEPTION USING errcode='22023', message='CLOUD_RESTORE_RESOURCE_NOT_ALLOWED';
  END IF;
  WITH flattened AS MATERIALIZED (
    SELECT row_value,
      CASE WHEN btrim(row_value->>'id') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        THEN lower(btrim(row_value->>'id')) END identity_value,
      CASE WHEN p_resource='product_variants' THEN nullif(btrim(row_value->>'local_id'),'')
           WHEN p_resource='inventory_items' THEN nullif(btrim(row_value->>'inventory_key'),'') END auxiliary_identity
    FROM public.erp_cloud_restore_prepared_chunks chunk
    CROSS JOIN LATERAL jsonb_array_elements(chunk.rows) row_value
    WHERE chunk.proof_id=p_proof_id AND chunk.resource=p_resource
  )
  SELECT jsonb_build_object(
    'count',count(*),
    'missingIdentityCount',count(*) FILTER (WHERE identity_value IS NULL),
    'duplicateIdentityCount',
      CASE WHEN p_resource='inventory_items'
        THEN (count(identity_value)-count(DISTINCT identity_value))+
             (count(auxiliary_identity)-count(DISTINCT auxiliary_identity))
        ELSE count(identity_value)-count(DISTINCT identity_value) END,
    'duplicateAuxiliaryIdentityCount',count(auxiliary_identity)-count(DISTINCT auxiliary_identity),
    'identityHash',encode(extensions.digest(convert_to(coalesce(
      string_agg(identity_value,E'\n' ORDER BY identity_value),''),'UTF8'),'sha256'),'hex')
  ) INTO v_profile FROM flattened;
  RETURN v_profile;
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_cloud_restore_prepared_profile(uuid,text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.erp_cloud_restore_stage_candidate(
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

  RETURN jsonb_build_object(
    'profiles',v_profiles,'rowCount',v_total_rows,'byteCount',v_total_bytes,'payloadHash',v_payload_hash
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_cloud_restore_stage_candidate(uuid,text,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.erp_cloud_restore_insert_staged_rows(
  p_table regclass,
  p_proof_id uuid,
  p_resource text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_columns text;
  v_select_columns text;
  v_count bigint;
  v_timestamp_count bigint;
  v_timestamp_mismatch_count bigint;
BEGIN
  IF p_table NOT IN (
    'public.inventory_items'::regclass,'public.product_groups'::regclass,'public.product_categories'::regclass,
    'public.product_variants'::regclass,'public.bundle_components'::regclass,'public.purchase_batches'::regclass,
    'public.purchase_batch_items'::regclass,'public.private_orders'::regclass,'public.private_order_items'::regclass,
    'public.sales_orders'::regclass,'public.sales_order_items'::regclass,'public.japan_packages'::regclass,
    'public.japan_package_items'::regclass,'public.outbound_shipments'::regclass,'public.outbound_shipment_items'::regclass,
    'public.dashboard_category_images'::regclass,'public.import_batches'::regclass,
    'public.waca_orders'::regclass,'public.waca_order_items'::regclass,'public.waca_mappings'::regclass,
    'public.waca_master_links'::regclass,'public.waca_import_batches'::regclass,
    'public.waca_cutover_audit'::regclass,'public.waca_state'::regclass
  ) OR p_table IS DISTINCT FROM format('public.%I',p_resource)::regclass THEN
    RAISE EXCEPTION USING errcode='22023', message='CLOUD_RESTORE_TABLE_NOT_ALLOWED';
  END IF;
  SELECT string_agg(quote_ident(a.attname),',' ORDER BY a.attnum),
         string_agg('r.'||quote_ident(a.attname),',' ORDER BY a.attnum)
    INTO v_columns,v_select_columns
    FROM pg_attribute a
   WHERE a.attrelid=p_table AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated=''
     AND EXISTS (
       SELECT 1 FROM public.erp_cloud_restore_prepared_chunks chunk
       CROSS JOIN LATERAL jsonb_array_elements(chunk.rows) row_value
       WHERE chunk.proof_id=p_proof_id AND chunk.resource=p_resource AND row_value ? a.attname
     );
  IF v_columns IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.erp_cloud_restore_prepared_chunks WHERE proof_id=p_proof_id AND resource=p_resource) THEN
      RAISE EXCEPTION USING errcode='22023', message='CLOUD_RESTORE_NO_ALLOWED_COLUMNS';
    END IF;
    RETURN 0;
  END IF;
  EXECUTE format(
    'insert into %s (%s) select %s from public.erp_cloud_restore_prepared_chunks c '
    'cross join lateral jsonb_populate_recordset(null::%s,c.rows) r '
    'where c.proof_id=$1 and c.resource=$2 order by c.chunk_ordinal',
    p_table,v_columns,v_select_columns,p_table
  ) USING p_proof_id,p_resource;
  GET DIAGNOSTICS v_count=ROW_COUNT;

  IF p_table='public.outbound_shipments'::regclass THEN
    IF EXISTS (
      SELECT 1 FROM public.erp_cloud_restore_prepared_chunks chunk
      CROSS JOIN LATERAL jsonb_array_elements(chunk.rows) row_value
      WHERE chunk.proof_id=p_proof_id AND chunk.resource=p_resource
        AND (NOT (row_value ? 'id') OR NOT (row_value ? 'status_changed_at'))
    ) THEN
      RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_OUTBOUND_TIMESTAMP_EVIDENCE_MISSING';
    END IF;
    WITH restored AS (
      SELECT row_data.id,row_data.status_changed_at
      FROM public.erp_cloud_restore_prepared_chunks chunk
      CROSS JOIN LATERAL jsonb_to_recordset(chunk.rows) row_data(id uuid,status_changed_at timestamptz)
      WHERE chunk.proof_id=p_proof_id AND chunk.resource=p_resource
    )
    UPDATE public.outbound_shipments target SET status_changed_at=restored.status_changed_at
    FROM restored WHERE target.id=restored.id;
    GET DIAGNOSTICS v_timestamp_count=ROW_COUNT;
    IF v_timestamp_count IS DISTINCT FROM v_count THEN
      RAISE EXCEPTION USING errcode='55000',message='CLOUD_RESTORE_OUTBOUND_TIMESTAMP_ROW_COUNT_MISMATCH';
    END IF;
    WITH restored AS (
      SELECT row_data.id,row_data.status_changed_at
      FROM public.erp_cloud_restore_prepared_chunks chunk
      CROSS JOIN LATERAL jsonb_to_recordset(chunk.rows) row_data(id uuid,status_changed_at timestamptz)
      WHERE chunk.proof_id=p_proof_id AND chunk.resource=p_resource
    )
    SELECT count(*) INTO v_timestamp_mismatch_count
    FROM restored LEFT JOIN public.outbound_shipments target ON target.id=restored.id
    WHERE target.id IS NULL OR target.status_changed_at IS DISTINCT FROM restored.status_changed_at;
    IF v_timestamp_mismatch_count<>0 THEN
      RAISE EXCEPTION USING errcode='55000',message='CLOUD_RESTORE_OUTBOUND_TIMESTAMP_MISMATCH';
    END IF;
  END IF;
  RETURN v_count;
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_cloud_restore_insert_staged_rows(regclass,uuid,text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.erp_restore_staged_cloud_snapshot(
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
  v_before_counts jsonb:='{}'::jsonb;
  v_before_manifest jsonb;
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

  v_phase:='before_snapshot';v_phase_started_at:=clock_timestamp();
  v_before:=public.erp_cloud_restore_snapshot();
  FOREACH v_table IN ARRAY ARRAY[
    'inventory_items','product_groups','product_categories','product_variants','bundle_components',
    'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
    'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
    'waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state'
  ] LOOP
    v_before_counts:=v_before_counts||jsonb_build_object(v_table,jsonb_array_length(v_before->v_table));
  END LOOP;
  v_before_fingerprint:=encode(extensions.digest(convert_to(v_before::text,'UTF8'),'sha256'),'hex');
  v_before_manifest:=jsonb_build_object(
    'schemaVersion','cloud-erp-snapshot-v2','resourceCount',24,'counts',v_before_counts,
    'totalRows',(SELECT coalesce(sum(value::bigint),0) FROM jsonb_each_text(v_before_counts)),
    'snapshotFingerprint',v_before_fingerprint,
    'relationshipHash',public.erp_cloud_restore_relationship_hash(v_before),
    'restoreSourceEnvironment',p_source_environment
  );
  INSERT INTO public.erp_cloud_restore_snapshots(actor_id,source_environment,snapshot_fingerprint,manifest,snapshot)
  VALUES(v_actor,coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'host','unknown'),
    v_before_fingerprint,v_before_manifest,v_before) RETURNING id INTO v_rollback_id;
  v_phase_ms:=(extract(epoch FROM clock_timestamp()-v_phase_started_at)*1000)::bigint;
  v_phase_timings:=v_phase_timings||jsonb_build_object('beforeSnapshot',v_phase_ms);

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
  v_live_waca:=jsonb_build_object(
    'import_batches',coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM public.import_batches t),'[]'::jsonb),
    'waca_orders',coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM public.waca_orders t),'[]'::jsonb),
    'waca_order_items',coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM public.waca_order_items t),'[]'::jsonb),
    'waca_mappings',coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM public.waca_mappings t),'[]'::jsonb),
    'waca_master_links',coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM public.waca_master_links t),'[]'::jsonb),
    'waca_import_batches',coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM public.waca_import_batches t),'[]'::jsonb),
    'waca_cutover_audit',coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM public.waca_cutover_audit t),'[]'::jsonb),
    'waca_state',coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM public.waca_state t),'[]'::jsonb),
    'product_variants',coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM public.product_variants t),'[]'::jsonb)
  );
  PERFORM public.erp_cloud_restore_validate_waca_dataset(v_live_waca);
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
    'executeModel','prepared-chunks-v1'
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
REVOKE ALL ON FUNCTION public.erp_restore_staged_cloud_snapshot(uuid,uuid,text,jsonb,text) FROM PUBLIC, anon, authenticated;

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
  v_result:=v_result||jsonb_build_object(
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
REVOKE ALL ON FUNCTION public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid) TO authenticated;

-- Idempotency is scoped to the durable attempt identity. A later, separately
-- confirmed restore of the same snapshot is a new operation and must advance
-- the restore epoch exactly once; only an identical attempt id is replayed.
DROP INDEX public.erp_cloud_restore_attempts_completed_fingerprint_uq;
CREATE INDEX erp_cloud_restore_attempts_completed_fingerprint_idx
  ON public.erp_cloud_restore_attempts(actor_key,target_environment,effective_fingerprint)
  WHERE status='completed';

CREATE OR REPLACE FUNCTION public.erp_prepare_cloud_restore_attempt(
  p_attempt_id uuid,p_trace_id uuid,p_source_fingerprint text,p_effective_fingerprint text,
  p_restore_policy text,p_target_environment text,p_timeout_budget_ms integer,p_timeout_contract_version text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_actor uuid:=auth.uid();v_actor_key text;v_epoch bigint;
  v_existing public.erp_cloud_restore_attempts%rowtype;v_headers jsonb;v_host text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION USING errcode='42501',message='AUTHENTICATION_REQUIRED'; END IF;
  IF NOT public.is_owner(v_actor) THEN RAISE EXCEPTION USING errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; END IF;
  IF p_attempt_id IS NULL OR p_trace_id IS NULL
     OR p_source_fingerprint !~ '^[0-9a-f]{64}$' OR p_effective_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_restore_policy NOT IN ('strict','cross-environment-audit-null-v1')
     OR p_target_environment IS DISTINCT FROM 'rhfdjsklfrgpoqsaqpkn'
     OR p_timeout_budget_ms IS DISTINCT FROM 120000
     OR p_timeout_contract_version IS DISTINCT FROM 'postgresql-statement-timeout-v1' THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_ATTEMPT_INVALID';
  END IF;
  v_headers:=nullif(current_setting('request.headers',true),'')::jsonb;
  v_host:=lower(split_part(coalesce(v_headers->>'host',''),':',1));
  IF split_part(v_host,'.',1) IS DISTINCT FROM p_target_environment THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_ATTEMPT_TARGET_MISMATCH';
  END IF;
  v_actor_key:=encode(extensions.digest(v_actor::text,'sha256'),'hex');
  SELECT epoch INTO STRICT v_epoch FROM public.erp_cloud_restore_epoch WHERE singleton=true;
  SELECT * INTO v_existing FROM public.erp_cloud_restore_attempts
   WHERE attempt_id=p_attempt_id AND actor_key=v_actor_key;
  IF FOUND THEN
    IF v_existing.trace_id IS DISTINCT FROM p_trace_id
       OR v_existing.source_fingerprint IS DISTINCT FROM p_source_fingerprint
       OR v_existing.effective_fingerprint IS DISTINCT FROM p_effective_fingerprint
       OR v_existing.restore_policy IS DISTINCT FROM p_restore_policy
       OR v_existing.target_environment IS DISTINCT FROM p_target_environment
       OR v_existing.timeout_budget_ms IS DISTINCT FROM p_timeout_budget_ms
       OR v_existing.timeout_contract_version IS DISTINCT FROM p_timeout_contract_version THEN
      RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_ATTEMPT_PAYLOAD_MISMATCH';
    END IF;
    RETURN jsonb_build_object(
      'status',v_existing.status,'attemptId',v_existing.attempt_id,'traceId',v_existing.trace_id,
      'expectedEpoch',v_existing.expected_epoch,'effectiveFingerprint',v_existing.effective_fingerprint,
      'reconcileAfter',v_existing.submitted_at+(v_existing.timeout_budget_ms+v_existing.grace_ms)*interval '1 millisecond',
      'resultEpoch',v_existing.result_epoch,'restoreResult',v_existing.canonical_result
    );
  END IF;
  BEGIN
    INSERT INTO public.erp_cloud_restore_attempts(
      attempt_id,trace_id,actor_key,source_fingerprint,effective_fingerprint,restore_policy,
      target_environment,expected_epoch,timeout_budget_ms,timeout_contract_version,status
    ) VALUES(
      p_attempt_id,p_trace_id,v_actor_key,p_source_fingerprint,p_effective_fingerprint,p_restore_policy,
      p_target_environment,v_epoch,p_timeout_budget_ms,p_timeout_contract_version,'prepared'
    ) RETURNING * INTO v_existing;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING errcode='55006',message='CLOUD_RESTORE_ATTEMPT_PENDING';
  END;
  RETURN jsonb_build_object(
    'status','prepared','attemptId',v_existing.attempt_id,'traceId',v_existing.trace_id,
    'expectedEpoch',v_existing.expected_epoch,'effectiveFingerprint',v_existing.effective_fingerprint,
    'reconcileAfter',v_existing.submitted_at+(v_existing.timeout_budget_ms+v_existing.grace_ms)*interval '1 millisecond'
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_prepare_cloud_restore_attempt(uuid,uuid,text,text,text,text,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_prepare_cloud_restore_attempt(uuid,uuid,text,text,text,text,integer,text) TO authenticated;

-- Change only the destructive dispatch target. Durable attempts, small request
-- identity, response-loss reconciliation and failure audit stay on 041/042/043.
CREATE OR REPLACE FUNCTION public.erp_restore_proven_cloud_snapshot_attempt(
  p_attempt_id uuid,p_trace_id uuid,p_execution_id uuid,p_proof_id uuid,p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_actor uuid:=auth.uid();v_actor_key text;
  v_attempt public.erp_cloud_restore_attempts%rowtype;
  v_proof public.erp_cloud_restore_candidate_proofs%rowtype;
  v_result jsonb;v_epoch bigint;v_phase text:='PREPARING';v_state text;v_message text;v_category text;
  v_headers jsonb;
BEGIN
  RAISE LOG 'CLOUD_RESTORE_TRANSPORT request=% attempt=% trace=% execution=% rpc=EXECUTE event=db-entry',
    p_request_id,p_attempt_id,p_trace_id,p_execution_id;
  IF v_actor IS NULL THEN RAISE EXCEPTION USING errcode='42501',message='AUTHENTICATION_REQUIRED'; END IF;
  IF NOT public.is_owner(v_actor) THEN RAISE EXCEPTION USING errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; END IF;
  IF p_execution_id IS NULL OR p_proof_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_EXECUTION_ID_REQUIRED';
  END IF;
  v_headers:=nullif(current_setting('request.headers',true),'')::jsonb;
  IF v_headers->>'x-restore-request-id' IS NOT NULL AND v_headers->>'x-restore-request-id'<>p_request_id::text THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_REQUEST_CORRELATION_MISMATCH';
  END IF;
  v_actor_key:=encode(extensions.digest(v_actor::text,'sha256'),'hex');
  IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-attempt:'||p_attempt_id::text,0)) THEN
    RAISE EXCEPTION USING errcode='55006',message='CLOUD_RESTORE_ATTEMPT_EXECUTION_CONFLICT';
  END IF;
  SELECT * INTO v_attempt FROM public.erp_cloud_restore_attempts
   WHERE attempt_id=p_attempt_id AND trace_id=p_trace_id AND actor_key=v_actor_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_ATTEMPT_NOT_FOUND'; END IF;
  IF v_attempt.status='completed' THEN RETURN v_attempt.canonical_result||jsonb_build_object('replayed',true); END IF;
  IF v_attempt.status='not_committed' THEN
    v_result:=public.erp_cloud_restore_failure_result(p_attempt_id);IF v_result IS NOT NULL THEN RETURN v_result;END IF;
  END IF;
  SELECT * INTO v_proof FROM public.erp_cloud_restore_candidate_proofs
   WHERE proof_id=p_proof_id AND actor_key=v_actor_key FOR UPDATE;
  IF NOT FOUND OR v_proof.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_PROOF_NOT_FOUND';
  END IF;
  IF v_attempt.source_fingerprint IS DISTINCT FROM v_proof.source_fingerprint
     OR v_attempt.effective_fingerprint IS DISTINCT FROM v_proof.effective_fingerprint
     OR v_attempt.restore_policy IS DISTINCT FROM v_proof.restore_policy
     OR v_attempt.target_environment IS DISTINCT FROM v_proof.target_environment
     OR v_proof.effective_fingerprint IS DISTINCT FROM v_proof.manifest->>'snapshotFingerprint' THEN
    RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_ATTEMPT_PAYLOAD_MISMATCH';
  END IF;
  IF v_attempt.status='prepared' THEN
    UPDATE public.erp_cloud_restore_attempts SET status='executing',execution_id=p_execution_id,
      execution_started_at=clock_timestamp() WHERE attempt_id=p_attempt_id;
  ELSIF v_attempt.status<>'executing' OR v_attempt.execution_id IS DISTINCT FROM p_execution_id THEN
    RAISE EXCEPTION USING errcode='55006',message='CLOUD_RESTORE_ATTEMPT_NOT_EXECUTABLE';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) THEN
    RAISE EXCEPTION USING errcode='55006',message='CLOUD_RESTORE_LOCK_CONFLICT';
  END IF;
  BEGIN
    SELECT epoch INTO STRICT v_epoch FROM public.erp_cloud_restore_epoch WHERE singleton=true;
    IF v_epoch IS DISTINCT FROM v_attempt.expected_epoch THEN
      RAISE EXCEPTION USING errcode='55000',message='CLOUD_RESTORE_ATTEMPT_EPOCH_MISMATCH';
    END IF;
    v_phase:='ATOMIC_RESTORE';
    v_result:=public.erp_restore_staged_cloud_snapshot(
      p_attempt_id,p_proof_id,v_proof.effective_fingerprint,v_proof.manifest,v_proof.source_environment
    );
    v_phase:='FINAL_VALIDATION';
    IF v_result->>'ok' IS DISTINCT FROM 'true'
       OR (v_result->>'restoreEpoch')::bigint IS DISTINCT FROM v_attempt.expected_epoch+1 THEN
      RAISE EXCEPTION USING errcode='XX000',message='CLOUD_RESTORE_CANONICAL_RESULT_INVALID';
    END IF;
    UPDATE public.erp_cloud_restore_attempts SET status='completed',completed_at=clock_timestamp(),
      result_epoch=(v_result->>'restoreEpoch')::bigint,canonical_result=v_result WHERE attempt_id=p_attempt_id;
    DELETE FROM public.erp_cloud_restore_candidate_proofs WHERE proof_id=p_proof_id;
    RETURN v_result;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE,v_message=MESSAGE_TEXT;
    v_category:=public.erp_cloud_restore_failure_category(v_state,v_message);
  END;
  DELETE FROM public.erp_cloud_restore_candidate_proofs WHERE proof_id=p_proof_id;
  INSERT INTO public.erp_cloud_restore_failures(
    attempt_id,trace_id,execution_id,phase,category,code,sqlstate,timeout_classification,evidence
  ) VALUES(
    p_attempt_id,p_trace_id,p_execution_id,
    CASE WHEN v_phase='FINAL_VALIDATION' THEN 'canonical-result' ELSE 'atomic-restore' END,
    v_category,'CLOUD_RESTORE_FAILURE_'||v_category,v_state,
    CASE WHEN v_state='57014' THEN 'query-canceled' ELSE 'not-timeout' END,'caught-subtransaction'
  );
  UPDATE public.erp_cloud_restore_attempts SET status='not_committed',reconciled_at=clock_timestamp()
   WHERE attempt_id=p_attempt_id;
  RETURN public.erp_cloud_restore_failure_result(p_attempt_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid) TO authenticated;

DO $postflight$
DECLARE
  v_proof text:=pg_get_functiondef('public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)'::regprocedure);
  v_execute text:=pg_get_functiondef('public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)'::regprocedure);
BEGIN
  IF to_regclass('public.erp_cloud_restore_prepared_chunks') IS NULL
     OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.erp_cloud_restore_prepared_chunks'::regclass)
     OR has_table_privilege('public','public.erp_cloud_restore_prepared_chunks','SELECT')
     OR has_table_privilege('anon','public.erp_cloud_restore_prepared_chunks','SELECT')
     OR has_table_privilege('authenticated','public.erp_cloud_restore_prepared_chunks','SELECT')
     OR strpos(v_proof,'erp_cloud_restore_stage_candidate')=0
     OR strpos(v_execute,'erp_restore_staged_cloud_snapshot')=0
     OR strpos(v_execute,'v_proof.effective_snapshot')>0
     OR has_function_privilege('anon','public.erp_restore_staged_cloud_snapshot(uuid,uuid,text,jsonb,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.erp_restore_staged_cloud_snapshot(uuid,uuid,text,jsonb,text)','EXECUTE') THEN
    RAISE EXCEPTION USING errcode='55000',message='RESTORE_057_POSTFLIGHT_FAILED';
  END IF;
END;
$postflight$;

COMMIT;
