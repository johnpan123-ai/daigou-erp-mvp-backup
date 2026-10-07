-- Prepare only. Preserve immutable 512-row chunks and all existing validators.
-- Reduce transport round trips; materialize only identities for identity proof.
BEGIN;
DO $preflight$
BEGIN
 IF current_user<>'postgres' OR to_regprocedure('public.erp_restore_initialize_upload_proof()') IS NULL THEN
  RAISE EXCEPTION USING errcode='55000',message='RESTORE_064_PRECONDITION_MISSING'; END IF;
END;
$preflight$;
CREATE OR REPLACE FUNCTION public.erp_cloud_restore_prepared_profile(p_proof_id uuid,p_resource text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_profile jsonb;
BEGIN
 IF p_resource<>ALL(ARRAY[
  'inventory_items','product_groups','product_categories','product_variants','bundle_components',
  'purchase_batches','purchase_batch_items','private_orders','private_order_items','sales_orders','sales_order_items',
  'japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items','dashboard_category_images','import_batches',
  'waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state']) THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_RESOURCE_NOT_ALLOWED'; END IF;
 WITH flattened AS MATERIALIZED (
  SELECT CASE WHEN btrim(row_value->>'id') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    THEN lower(btrim(row_value->>'id')) END identity_value,
   CASE WHEN p_resource='product_variants' THEN nullif(btrim(row_value->>'local_id'),'')
    WHEN p_resource='inventory_items' THEN nullif(btrim(row_value->>'inventory_key'),'') END auxiliary_identity
  FROM public.erp_cloud_restore_prepared_chunks chunk CROSS JOIN LATERAL jsonb_array_elements(chunk.rows) row_value
  WHERE chunk.proof_id=p_proof_id AND chunk.resource=p_resource
 ) SELECT jsonb_build_object('count',count(*),'missingIdentityCount',count(*) FILTER(WHERE identity_value IS NULL),
  'duplicateIdentityCount',CASE WHEN p_resource='inventory_items'
   THEN (count(identity_value)-count(DISTINCT identity_value))+(count(auxiliary_identity)-count(DISTINCT auxiliary_identity))
   ELSE count(identity_value)-count(DISTINCT identity_value) END,
  'duplicateAuxiliaryIdentityCount',count(auxiliary_identity)-count(DISTINCT auxiliary_identity),
  'identityHash',encode(extensions.digest(convert_to(coalesce(string_agg(identity_value,E'\n' ORDER BY identity_value),''),'UTF8'),'sha256'),'hex'))
 INTO v_profile FROM flattened;
 RETURN v_profile;
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_cloud_restore_prepared_profile(uuid,text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.erp_upload_restore_chunk_batch(p_request_id uuid,p_chunks jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions' SET statement_timeout TO '25s'
AS $function$
DECLARE c jsonb;results jsonb:='[]';started timestamptz:=clock_timestamp();
BEGIN
 PERFORM public.erp_restore_upload_owner(p_request_id);
 IF jsonb_typeof(p_chunks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_chunks) NOT BETWEEN 1 AND 4 THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_BATCH_INVALID'; END IF;
 -- Fail BEFORE any OPS insert. Only this explicit size rejection can be split
 -- by the client; transport/permission/validation/unknown errors are not retried.
 IF pg_column_size(p_chunks)>2097152 THEN
  RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_BATCH_SIZE_LIMIT'; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p_chunks) LOOP
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR NOT(c ?& ARRAY['p_resource','p_ordinal','p_rows'])
   OR (SELECT count(*) FROM jsonb_object_keys(c))<>3 THEN
   RAISE EXCEPTION USING errcode='22023',message='CLOUD_RESTORE_UPLOAD_BATCH_INVALID'; END IF;
  results:=results||jsonb_build_array(public.erp_upload_restore_chunk(p_request_id,c->>'p_resource',(c->>'p_ordinal')::integer,c->'p_rows'));
 END LOOP;
 RETURN jsonb_build_object('chunks',results,'serverMs',(extract(epoch FROM clock_timestamp()-started)*1000)::bigint);
END;
$function$;
REVOKE ALL ON FUNCTION public.erp_upload_restore_chunk_batch(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erp_upload_restore_chunk_batch(uuid,jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
