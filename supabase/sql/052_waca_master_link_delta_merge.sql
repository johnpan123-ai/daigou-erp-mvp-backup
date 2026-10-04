-- BuyAnime imports may merge only affected WACA master-link evidence. The
-- existing full snapshot RPC remains unchanged for WACA/Backup/Restore flows.
BEGIN;

CREATE OR REPLACE FUNCTION public.erp_merge_waca_master_links(
  p_idempotency_key uuid,
  p_request jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE
  v_actor uuid:=auth.uid();
  v_claimed boolean;
  v_prior_request public.erp_idempotency_keys%ROWTYPE;
  v_prior_link public.waca_master_links%ROWTYPE;
  v_row jsonb;
  v_payload jsonb;
  v_variant_id uuid;
  v_expected_revision bigint;
  v_revision bigint;
  v_inserted integer:=0;
  v_updated integer:=0;
  v_unchanged integer:=0;
  v_failure jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR NOT public.is_owner(v_actor) THEN
    RAISE EXCEPTION 'WACA_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF p_idempotency_key IS NULL OR jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_request) k)
      IS DISTINCT FROM ARRAY['expectedRevision','family','links']::text[]
    OR p_request->>'family' IS DISTINCT FROM 'waca-master-links'
    OR coalesce(p_request->>'expectedRevision','') !~ '^[0-9]+$'
    OR jsonb_typeof(p_request->'links') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_request->'links')=0
    OR jsonb_array_length(p_request->'links')>10000 THEN
    RAISE EXCEPTION 'WACA_MASTER_LINK_DELTA_INVALID' USING ERRCODE='22023';
  END IF;
  v_expected_revision:=(p_request->>'expectedRevision')::bigint;
  IF (SELECT count(*) FROM jsonb_array_elements(p_request->'links')) IS DISTINCT FROM
     (SELECT count(DISTINCT value->>'childCode') FROM jsonb_array_elements(p_request->'links')) THEN
    RAISE EXCEPTION 'WACA_MASTER_LINK_DELTA_DUPLICATE' USING ERRCODE='22023';
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_request->'links') LOOP
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN (
      'mainCode','childCode','productGroupId','productVariantId','productTitle',
      'variantTitle','sourceFile','sourceFiles','observedAt'))
      OR coalesce(btrim(v_row->>'childCode'),'')=''
      OR coalesce(btrim(v_row->>'mainCode'),'')=''
      OR jsonb_typeof(coalesce(v_row->'sourceFiles','[]'::jsonb)) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'WACA_MASTER_LINK_DELTA_ROW_INVALID' USING ERRCODE='22023';
    END IF;
  END LOOP;

  BEGIN
    INSERT INTO public.erp_idempotency_keys(
      actor_id,idempotency_key,operation_type,request_fingerprint,request_payload,status
    ) VALUES(v_actor,p_idempotency_key,'edit',md5(p_request::text),p_request,'processing')
    ON CONFLICT(actor_id,idempotency_key) DO NOTHING RETURNING true INTO v_claimed;
    IF NOT coalesce(v_claimed,false) THEN
      SELECT * INTO v_prior_request FROM public.erp_idempotency_keys
       WHERE actor_id=v_actor AND idempotency_key=p_idempotency_key FOR UPDATE;
      IF v_prior_request.request_payload IS DISTINCT FROM p_request THEN
        RETURN jsonb_build_object('ok',false,'code','IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
      END IF;
      IF v_prior_request.status<>'completed' THEN
        RAISE EXCEPTION 'WACA_MASTER_LINK_DELTA_INCOMPLETE';
      END IF;
      RETURN jsonb_set(v_prior_request.canonical_result,'{replayed}','true',true);
    END IF;

    IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) THEN
      RAISE EXCEPTION 'CLOUD_RESTORE_MAINTENANCE_LOCKED' USING ERRCODE='55006';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('erp-waca-ledger-import',0));
    SELECT revision INTO v_revision FROM public.waca_state FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'WACA_STATE_MISSING' USING ERRCODE='55000'; END IF;
    IF v_revision IS DISTINCT FROM v_expected_revision THEN
      v_failure:=jsonb_build_object('ok',false,'code','WACA_STALE_REVISION',
        'expectedRevision',v_expected_revision,'actualRevision',v_revision);
      RAISE EXCEPTION 'WACA_MASTER_LINK_DELTA_ROLLBACK';
    END IF;

    FOR v_row IN SELECT value FROM jsonb_array_elements(p_request->'links') ORDER BY value->>'childCode' LOOP
      v_variant_id:=public.erp_waca_variant_id(v_row->>'productVariantId');
      v_payload:=jsonb_set(v_row,'{productVariantId}',to_jsonb(coalesce(v_variant_id::text,'')),true);
      SELECT * INTO v_prior_link FROM public.waca_master_links WHERE child_code=v_row->>'childCode';
      IF FOUND AND (v_prior_link.main_code IS DISTINCT FROM v_row->>'mainCode'
        OR (v_prior_link.product_variant_id IS NOT NULL AND v_variant_id IS NOT NULL
          AND v_prior_link.product_variant_id IS DISTINCT FROM v_variant_id)
        OR (coalesce(v_prior_link.payload->>'productGroupId','')<>''
          AND coalesce(v_row->>'productGroupId','')<>''
          AND v_prior_link.payload->>'productGroupId' IS DISTINCT FROM v_row->>'productGroupId')) THEN
        v_failure:=jsonb_build_object('ok',false,'code','WACA_MASTER_LINK_CONFLICT',
          'childCode',v_row->>'childCode');
        RAISE EXCEPTION 'WACA_MASTER_LINK_DELTA_ROLLBACK';
      END IF;
      IF FOUND AND v_prior_link.main_code IS NOT DISTINCT FROM v_row->>'mainCode'
        AND v_prior_link.product_variant_id IS NOT DISTINCT FROM v_variant_id
        AND v_prior_link.payload IS NOT DISTINCT FROM v_payload THEN
        v_unchanged:=v_unchanged+1;
      ELSIF FOUND THEN
        UPDATE public.waca_master_links SET main_code=v_row->>'mainCode',
          product_variant_id=v_variant_id,payload=v_payload,updated_at=clock_timestamp(),updated_by=v_actor
         WHERE id=v_prior_link.id;
        v_updated:=v_updated+1;
      ELSE
        INSERT INTO public.waca_master_links(child_code,main_code,product_variant_id,payload,updated_by)
        VALUES(v_row->>'childCode',v_row->>'mainCode',v_variant_id,v_payload,v_actor);
        v_inserted:=v_inserted+1;
      END IF;
    END LOOP;

    IF v_inserted+v_updated>0 THEN
      UPDATE public.waca_state SET revision=revision+1,
        payload=payload||jsonb_build_object('lastMasterLinkMerge',jsonb_build_object(
          'requestId',p_idempotency_key,'actorId',v_actor,'changed',v_inserted+v_updated,
          'mergedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
        updated_at=clock_timestamp(),updated_by=v_actor
       RETURNING revision INTO v_revision;
    END IF;
    v_result:=jsonb_build_object('ok',true,'replayed',false,'idempotencyKey',p_idempotency_key,
      'revision',v_revision,'inserted',v_inserted,'updated',v_updated,'unchanged',v_unchanged,
      'changed',v_inserted+v_updated);
    UPDATE public.erp_idempotency_keys SET status='completed',canonical_result=v_result,
      completed_at=clock_timestamp() WHERE actor_id=v_actor AND idempotency_key=p_idempotency_key;
    RETURN v_result;
  EXCEPTION WHEN OTHERS THEN
    IF v_failure IS NOT NULL THEN RETURN v_failure; END IF;
    RETURN jsonb_build_object('ok',false,'code','TRANSACTION_REJECTED','sqlstate',SQLSTATE);
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_merge_waca_master_links(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erp_merge_waca_master_links(uuid,jsonb) TO authenticated;

COMMIT;
