-- Finalize only. No business table/write, no Execute or Begin changes.
-- Server-authored resource proof rows retain missing/NULL/raw semantics.
-- All 24 canonical, manifest and both relationship representations remain exact.
BEGIN;
DO $preflight$
BEGIN
 IF current_user<>'postgres' OR to_regprocedure('public.erp_finalize_restore_upload(uuid)') IS NULL
  OR to_regclass('public.erp_restore_upload_resource_proofs') IS NULL THEN
  RAISE EXCEPTION USING errcode='55000',message='RESTORE_069_PRECONDITION_MISSING'; END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.erp_restore_upload_semantic_audit(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
declare
  v_result jsonb;
  -- ECMAScript String.trim whitespace; match the existing TS manifest checks.
  v_ws constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if (select count(*) from public.erp_restore_upload_resource_proofs where request_id=p_request_id)<>24 then
    raise exception using errcode='22023',message='CLOUD_RESTORE_UPLOAD_INCOMPLETE';
  end if;
  if exists(select 1 from public.erp_restore_upload_resource_proofs p
    cross join lateral jsonb_array_elements(p.validation_rows) r
    where p.request_id=p_request_id and jsonb_typeof(r) is distinct from 'object') then
    raise exception using errcode='22023',message='CLOUD_RESTORE_AUDIT_ROW_INVALID';
  end if;
  with
    spec(table_name, fields) as (values
      ('inventory_items', array['product_id','latest_catalog_import_id']::text[]),
      ('product_groups', array[]::text[]),
      ('product_categories', array['product_group_id']::text[]),
      ('product_variants', array['product_group_id','product_category_id']::text[]),
      ('bundle_components', array['bundle_variant_id','component_variant_id']::text[]),
      ('purchase_batches', array['product_group_id']::text[]),
      ('purchase_batch_items', array['purchase_batch_id','product_variant_id']::text[]),
      ('private_orders', array['product_group_id']::text[]),
      ('private_order_items', array['private_order_id','product_variant_id']::text[]),
      ('sales_orders', array[]::text[]),
      ('sales_order_items', array['order_id','product_variant_id']::text[]),
      ('japan_packages', array[]::text[]),
      ('japan_package_items', array['japan_package_id','product_group_id','product_variant_id','purchase_batch_id','purchase_batch_item_id']::text[]),
      ('outbound_shipments', array[]::text[]),
      ('outbound_shipment_items', array['outbound_shipment_id','japan_package_item_id','product_group_id','product_variant_id']::text[])
    , ('dashboard_category_images', array[]::text[]),
      ('import_batches', array[]::text[]),
      ('waca_orders', array[]::text[]),
      ('waca_order_items', array['order_id','product_variant_id']::text[]),
      ('waca_mappings', array['product_variant_id']::text[]),
      ('waca_master_links', array['product_variant_id']::text[]),
      ('waca_import_batches', array[]::text[]),
      ('waca_cutover_audit', array['product_variant_id']::text[]),
      ('waca_state', array[]::text[])
    ),
    relspec(child_table, field, parent_table, optional) as (values
      ('product_categories','product_group_id','product_groups',false),
      ('product_variants','product_group_id','product_groups',false),
      ('product_variants','product_category_id','product_categories',true),
      ('bundle_components','bundle_variant_id','product_variants',false),
      ('bundle_components','component_variant_id','product_variants',false),
      ('purchase_batches','product_group_id','product_groups',false),
      ('purchase_batch_items','purchase_batch_id','purchase_batches',false),
      ('purchase_batch_items','product_variant_id','product_variants',false),
      ('private_orders','product_group_id','product_groups',false),
      ('private_order_items','private_order_id','private_orders',false),
      ('private_order_items','product_variant_id','product_variants',false),
      ('sales_order_items','order_id','sales_orders',false),
      ('sales_order_items','product_variant_id','product_variants',true),
      ('japan_package_items','japan_package_id','japan_packages',false),
      ('japan_package_items','product_group_id','product_groups',true),
      ('japan_package_items','product_variant_id','product_variants',true),
      ('japan_package_items','purchase_batch_id','purchase_batches',true),
      ('japan_package_items','purchase_batch_item_id','purchase_batch_items',true),
      ('outbound_shipment_items','outbound_shipment_id','outbound_shipments',false),
      ('outbound_shipment_items','japan_package_item_id','japan_package_items',true),
      ('outbound_shipment_items','product_group_id','product_groups',true),
      ('outbound_shipment_items','product_variant_id','product_variants',true)
    , ('waca_order_items','order_id','waca_orders',false),
      ('waca_order_items','product_variant_id','product_variants',true),
      ('waca_mappings','product_variant_id','product_variants',false),
      ('waca_master_links','product_variant_id','product_variants',true),
      ('waca_cutover_audit','product_variant_id','product_variants',false)
    ),
    rows as materialized (
      select s.table_name,s.fields,r.value as row,
             lower(btrim(coalesce(r.value->>'id',''),v_ws)) as id
      from public.erp_restore_upload_resource_proofs rp join spec s on s.table_name=rp.resource
      cross join lateral jsonb_array_elements(rp.validation_rows) r
      where rp.request_id=p_request_id
    ),
    identities as (select distinct table_name,id from rows),
    counts as (select resource table_name,jsonb_array_length(validation_rows) as n
      from public.erp_restore_upload_resource_proofs where request_id=p_request_id),
    duplicates as (select table_name,id,count(*)-1 as n from rows group by table_name,id),
    local_ids as (
      select btrim(row->>'local_id',v_ws) as id from rows
      where table_name='product_variants' and coalesce(btrim(row->>'local_id',v_ws),'')<>''
    ),
    missing as (
      select rel.optional from rows r join relspec rel on r.table_name=rel.child_table
      left join identities parent on parent.table_name=rel.parent_table
        and parent.id=lower(btrim(r.row->>rel.field,v_ws))
      where parent.id is null and (not rel.optional or coalesce(btrim(r.row->>rel.field,v_ws),'')<>'')
    ),
    execute_projection as (
      select table_name,row->>'id' record_id,
        jsonb_build_object('table',table_name,'id',row->>'id','relations',
          (select jsonb_object_agg(f,row->f) from unnest(fields) f)) value
      from rows where cardinality(fields)>0 and table_name<>'inventory_items'
    ),
    projection as (
      select table_name,id,
        '{"id":'||to_json(id)::text||',"relations":{'||
        coalesce((select string_agg(to_json(f)::text||':'||
          coalesce(to_json(nullif(row->>f,''))::text,'null'),',' order by f collate "C")
          from unnest(fields) f),'')||
        '},"table":'||to_json(table_name)::text||'}' as compact
      from rows
    )
  select jsonb_build_object(
    'execute_relationship_hash',(select encode(extensions.digest(convert_to(
      coalesce(jsonb_agg(value order by table_name,record_id),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex') from execute_projection),
    'table_counts',(select jsonb_object_agg(table_name,n) from counts),
    'total_rows',(select sum(n) from counts),
    'relationship_hash',(select encode(extensions.digest(
      '['||coalesce(string_agg(compact,',' order by (table_name||':'||id) collate "C"),'')||']','sha256'),'hex') from projection),
    'integrity',jsonb_build_object(
      'orphan_count',(select count(*) from missing where not optional),
      'optional_metadata_missing_reference_count',(select count(*) from missing where optional),
      'duplicate_variant_id_count',(select coalesce(sum(n),0) from duplicates where table_name='product_variants'),
      'duplicate_variant_local_id_count',(select count(*)-count(distinct id) from local_ids),
      'duplicate_canonical_id_count',(select coalesce(sum(n),0) from duplicates),
      'canonical_identity_anomaly_count',(select count(*) from rows where id !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
      'unknown_product_count',(select count(*) from rows where table_name='product_groups'
        and lower(btrim(coalesce(row->>'normalized_title',row->>'title',''),v_ws)) in ('未知商品','unknown product')),
      'duplicate_inventory_key_count',(select count(*)-count(distinct btrim(coalesce(row->>'inventory_key',''),v_ws)) from rows where table_name='inventory_items'),
      'missing_inventory_key_count',(select count(*) from rows where table_name='inventory_items' and coalesce(btrim(row->>'inventory_key',v_ws),'')='')
    ),
    'audit_policy',jsonb_build_object(
      'covered_updated_by_non_null_count',(select count(*) from rows where row->>'updated_by' is not null),
      'covered_updated_by_null_count',(select count(*) from rows where row->>'updated_by' is null)
    )
  ) into v_result;
  return v_result;
end;
$function$;

REVOKE ALL ON FUNCTION public.erp_restore_upload_semantic_audit(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.erp_finalize_restore_upload(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions' SET statement_timeout TO '25s'
SET work_mem TO '16MB'
AS $function$
DECLARE r public.erp_restore_upload_requests%rowtype;d jsonb;a jsonb;i jsonb;result jsonb;resource_name text;
 profiles jsonb;columns_by_resource jsonb;bytes bigint;rows bigint;payload_hash text;relationship_hash text;
 transformed bigint;policy text;source_fp text;started timestamptz:=clock_timestamp();phase text:='authorization';
 assembled timestamptz;resource_timings jsonb;phase_at timestamptz:=started;phase_timings jsonb:='{}';
BEGIN
 r:=public.erp_restore_upload_owner(p_request_id);
 IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-restore-upload:'||p_request_id::text,0)) THEN
  RAISE EXCEPTION USING errcode='55006',message='CLOUD_RESTORE_UPLOAD_BUSY'; END IF;
 IF r.completed_result IS NOT NULL THEN RETURN r.completed_result; END IF;
 IF r.source_generation IS DISTINCT FROM (SELECT generation FROM public.erp_restore_business_generation WHERE singleton)
  OR r.source_epoch IS DISTINCT FROM (SELECT epoch FROM public.erp_cloud_restore_epoch WHERE singleton) THEN
  RAISE EXCEPTION USING errcode='55000',message='STALE_RESTORE_PREPARE'; END IF;
 phase_timings:=phase_timings||jsonb_build_object('authorization',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 phase_at:=clock_timestamp();phase:='resource-stage';
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
 phase_timings:=phase_timings||jsonb_build_object('resourceCoverage',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 phase_at:=clock_timestamp();phase:='validation-input';
 SELECT json_object_agg(resource,validation_rows) FILTER(WHERE r.restore_mode='cross-environment'
   OR resource IN('product_variants','outbound_shipments','import_batches','waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state'))::jsonb,jsonb_object_agg(resource,profile),
  jsonb_object_agg(resource,supplied_columns),sum(transformed_rows),jsonb_object_agg(resource,server_ms)
 INTO d,profiles,columns_by_resource,transformed,resource_timings
 FROM public.erp_restore_upload_resource_proofs WHERE request_id=p_request_id;
 assembled:=clock_timestamp();
 phase_timings:=phase_timings||jsonb_build_object('validationInput',(extract(epoch FROM assembled-phase_at)*1000)::bigint);
 phase_at:=clock_timestamp();phase:='portability';
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
 phase_timings:=phase_timings||jsonb_build_object('portability',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 phase_at:=clock_timestamp();phase:='waca-validation';
 PERFORM public.erp_cloud_restore_validate_waca_dataset(d);
 phase_timings:=phase_timings||jsonb_build_object('wacaValidation',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 phase_at:=clock_timestamp();phase:='projected-semantic-proof';
 -- Exact erp_cloud_restore_audit_dataset and erp_cloud_restore_relationship_hash
 -- representations are combined over SERVER resource proofs, never client hashes.
 a:=public.erp_restore_upload_semantic_audit(p_request_id);i:=a->'integrity';
 -- Keep BOTH contracts: the public manifest hash and Execute's staged proof
 -- hash use different canonical representations. Neither can replace the other.
 relationship_hash:=a->>'execute_relationship_hash';
 phase_timings:=phase_timings||jsonb_build_object('projectedSemanticProof',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 phase_at:=clock_timestamp();phase:='manifest-validation';
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
 phase_timings:=phase_timings||jsonb_build_object('manifestValidation',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 phase_at:=clock_timestamp();phase:='prepared-chunk-proof';
 SELECT coalesce(sum(row_count),0),coalesce(sum(pg_column_size(ch.rows)),0),
  encode(extensions.digest(convert_to(coalesce(string_agg(resource||':'||chunk_ordinal||':'||ch.payload_hash,E'\n'
   ORDER BY resource COLLATE "C",chunk_ordinal),''),'UTF8'),'sha256'),'hex')
 INTO rows,bytes,payload_hash FROM public.erp_cloud_restore_prepared_chunks ch WHERE proof_id=p_request_id;
 IF rows IS DISTINCT FROM (a->>'total_rows')::bigint THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_STAGE_ROW_COUNT_MISMATCH'; END IF;
 IF r.source_generation IS DISTINCT FROM (SELECT generation FROM public.erp_restore_business_generation WHERE singleton)
  OR r.source_epoch IS DISTINCT FROM (SELECT epoch FROM public.erp_cloud_restore_epoch WHERE singleton) THEN
  RAISE EXCEPTION USING errcode='55000',message='STALE_RESTORE_PREPARE'; END IF;
 phase_timings:=phase_timings||jsonb_build_object('preparedChunkProof',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 phase_at:=clock_timestamp();phase:='proof-write';
 result:=jsonb_build_object('ok',true,'candidate_valid',true,'schema_version','cloud-restore-candidate-proof-v1',
  'policy',policy,'resource_count',24,'coverage_count',24,'total_rows',rows,'table_counts',a->'table_counts',
  'transformed_updated_by_count',transformed,'source_fingerprint',source_fp,
  'effective_fingerprint',r.manifest->>'snapshotFingerprint','relationship_hash',a->>'relationship_hash','integrity',i,
  'proof_id',p_request_id,'proof_expires_at',r.expires_at,'request_id',p_request_id,
  'prepared_row_count',rows,'prepared_byte_count',bytes,'prepared_payload_hash',payload_hash,
  'uploadAssemblyMs',(extract(epoch FROM assembled-started)*1000)::bigint,
  'finalizeServerMs',(extract(epoch FROM clock_timestamp()-started)*1000)::bigint,
  'resourceStageTimingsMs',resource_timings,'validationProjectionBytes',pg_column_size(d),
  'phaseTimingsMs',phase_timings,'semanticProofRepresentation','server-resource-proofs-v1',
  'statementTimeout',current_setting('statement_timeout'),
  'prepareTimingsMs',jsonb_build_object('semanticProof',(extract(epoch FROM clock_timestamp()-assembled)*1000)::bigint),
  'elapsed_ms',(extract(epoch FROM clock_timestamp()-started)*1000)::bigint);
 UPDATE public.erp_cloud_restore_candidate_proofs SET proof_result=result,expected_profiles=profiles,
  prepared_columns=columns_by_resource,prepared_row_count=rows,prepared_byte_count=bytes,prepared_payload_hash=payload_hash,
  expected_relationship_hash=relationship_hash,source_generation=r.source_generation,source_restore_epoch=r.source_epoch
 WHERE proof_id=p_request_id AND actor_key=r.actor_key;
 UPDATE public.erp_restore_upload_requests SET completed_result=result WHERE request_id=p_request_id;
 phase:='request-cleanup';
 DELETE FROM public.erp_restore_upload_chunks WHERE request_id=p_request_id;
 DELETE FROM public.erp_restore_upload_resource_proofs WHERE request_id=p_request_id;
 phase_timings:=phase_timings||jsonb_build_object('proofWriteAndCleanup',(extract(epoch FROM clock_timestamp()-phase_at)*1000)::bigint);
 result:=result||jsonb_build_object('phaseTimingsMs',phase_timings,
  'finalizeServerMs',(extract(epoch FROM clock_timestamp()-started)*1000)::bigint,
  'elapsed_ms',(extract(epoch FROM clock_timestamp()-started)*1000)::bigint);
 UPDATE public.erp_cloud_restore_candidate_proofs SET proof_result=result WHERE proof_id=p_request_id AND actor_key=r.actor_key;
 UPDATE public.erp_restore_upload_requests SET completed_result=result WHERE request_id=p_request_id;
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
