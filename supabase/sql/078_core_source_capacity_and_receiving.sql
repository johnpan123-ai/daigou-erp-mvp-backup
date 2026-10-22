-- Candidate only. Owner approval is required before applying to ERP2.
-- Uses the existing maintenance transaction lock, not a new history table/index.
-- checked remains a whole-row boolean. Partial unreceiving is deliberately unsupported.
BEGIN;

CREATE FUNCTION public.erp_core_restore_in_progress() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT current_setting('erp.cloud_restore_active',true) = 'on'
    AND public.is_owner(auth.uid()) AND EXISTS (
      SELECT 1 FROM public.erp_cloud_restore_requests
       WHERE actor_id=auth.uid() AND status='processing'
    )
$$;

CREATE FUNCTION public.erp_core_write_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CORE_READ_COMMITTED_REQUIRED' USING ERRCODE='25000';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) THEN
    RAISE EXCEPTION 'CLOUD_RESTORE_MAINTENANCE_LOCKED' USING ERRCODE='55006';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION public.erp_core_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE source_id uuid; source_row public.japan_package_items%ROWTYPE;
  allocated bigint; capacity bigint; package_ok boolean;
BEGIN
  IF public.erp_core_restore_in_progress() THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME='outbound_shipment_items' THEN
    IF TG_OP='DELETE' OR NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
    IF TG_OP='UPDATE' AND ROW(NEW.japan_package_item_id,NEW.outbound_shipment_id,NEW.quantity,NEW.deleted_at)
      IS NOT DISTINCT FROM ROW(OLD.japan_package_item_id,OLD.outbound_shipment_id,OLD.quantity,OLD.deleted_at)
      THEN RETURN NULL; END IF;
    IF NEW.quantity<=0 THEN RAISE EXCEPTION 'CORE_POSITIVE_QUANTITY_REQUIRED' USING ERRCODE='PT409'; END IF;
    IF TG_OP='UPDATE' THEN
      IF OLD.japan_package_item_id IS NOT NULL AND NEW.japan_package_item_id IS NULL THEN
        RAISE EXCEPTION 'CORE_SOURCE_LINK_CANNOT_CLEAR' USING ERRCODE='PT409';
      END IF;
    END IF;
    source_id:=NEW.japan_package_item_id;
    -- Manual outbound rows have no package source and consume no package capacity.
    IF source_id IS NULL THEN RETURN NULL; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.outbound_shipments WHERE id=NEW.outbound_shipment_id AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'CORE_OUTBOUND_PARENT_UNAVAILABLE' USING ERRCODE='PT409';
    END IF;
  ELSE
    IF TG_OP='INSERT' THEN RETURN NULL; END IF;
    IF TG_OP='UPDATE' AND ROW(NEW.checked,NEW.quantity,NEW.deleted_at,NEW.japan_package_id,
      NEW.product_variant_id,NEW.purchase_batch_item_id,NEW.purchase_batch_id)
      IS NOT DISTINCT FROM ROW(OLD.checked,OLD.quantity,OLD.deleted_at,OLD.japan_package_id,
      OLD.product_variant_id,OLD.purchase_batch_item_id,OLD.purchase_batch_id) THEN RETURN NULL; END IF;
    source_id:=OLD.id;
  END IF;
  SELECT * INTO source_row FROM public.japan_package_items WHERE id=source_id;
  SELECT coalesce(sum(greatest(o.quantity,0)),0) INTO allocated FROM public.outbound_shipment_items o
    JOIN public.outbound_shipments s ON s.id=o.outbound_shipment_id
   WHERE o.japan_package_item_id=source_id AND o.deleted_at IS NULL AND s.deleted_at IS NULL;
  IF TG_TABLE_NAME='japan_package_items' AND allocated=0 THEN RETURN NULL; END IF;
  capacity:=CASE WHEN source_row.deleted_at IS NULL AND source_row.checked THEN source_row.quantity ELSE 0 END;
  IF source_row.id IS NULL OR allocated>coalesce(capacity,0) THEN
    RAISE EXCEPTION 'CORE_SOURCE_CAPACITY' USING ERRCODE='PT409',
      DETAIL=jsonb_build_object('sourceId',source_id,'allocated',allocated,
        'quantity',coalesce(source_row.quantity,0),'cancelable',greatest(coalesce(source_row.quantity,0)-allocated,0),
        'wholeRowReceiving',true)::text;
  END IF;
  IF TG_TABLE_NAME='japan_package_items' AND TG_OP='UPDATE' THEN
    IF ROW(NEW.japan_package_id,NEW.product_variant_id,NEW.purchase_batch_item_id,NEW.purchase_batch_id)
       IS DISTINCT FROM ROW(OLD.japan_package_id,OLD.product_variant_id,OLD.purchase_batch_item_id,OLD.purchase_batch_id) THEN
      RAISE EXCEPTION 'CORE_ALLOCATED_SOURCE_IDENTITY_IMMUTABLE' USING ERRCODE='PT409';
    END IF;
  END IF;
  SELECT (status IN ('arrived','confirmed') OR arrived_at IS NOT NULL) INTO package_ok
    FROM public.japan_packages WHERE id=source_row.japan_package_id AND deleted_at IS NULL;
  IF NOT coalesce(package_ok,false) THEN RAISE EXCEPTION 'CORE_SOURCE_NOT_AVAILABLE' USING ERRCODE='PT409'; END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION public.erp_core_package_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE package_id uuid; all_checked boolean; any_checked boolean; remaining bigint;
BEGIN
  IF public.erp_core_restore_in_progress() THEN
    IF TG_WHEN='BEFORE' THEN RETURN NEW; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='japan_packages' THEN
    IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
      AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF NEW.deleted_at IS NOT NULL AND EXISTS(
      SELECT 1 FROM public.outbound_shipment_items o JOIN public.japan_package_items i ON i.id=o.japan_package_item_id
      JOIN public.outbound_shipments s ON s.id=o.outbound_shipment_id
      WHERE i.japan_package_id=NEW.id AND o.deleted_at IS NULL AND s.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'CORE_ALLOCATED_PACKAGE_CANNOT_DELETE' USING ERRCODE='PT409';
    END IF;
    IF NEW.deleted_at IS NOT NULL OR NEW.status IN ('arrived','problem') THEN RETURN NEW; END IF;
    SELECT count(*) FILTER(WHERE NOT checked) INTO remaining FROM public.japan_package_items
      WHERE japan_package_id=NEW.id AND deleted_at IS NULL;
    SELECT count(*)>0 AND bool_and(checked) INTO all_checked FROM public.japan_package_items
      WHERE japan_package_id=NEW.id AND deleted_at IS NULL;
    IF (NEW.status='confirmed') IS DISTINCT FROM coalesce(all_checked,false) THEN
      RAISE EXCEPTION 'CORE_PACKAGE_PROGRESS_MISMATCH' USING ERRCODE='PT409',
        DETAIL=jsonb_build_object('remainingRows',remaining,'allChecked',coalesce(all_checked,false))::text;
    END IF;
    RETURN NEW;
  END IF;
  FOR package_id IN SELECT DISTINCT x FROM unnest(ARRAY[
    CASE WHEN TG_OP<>'INSERT' THEN OLD.japan_package_id END,
    CASE WHEN TG_OP<>'DELETE' THEN NEW.japan_package_id END]) x WHERE x IS NOT NULL LOOP
    SELECT count(*)>0 AND bool_and(checked),bool_or(checked) INTO all_checked,any_checked
      FROM public.japan_package_items WHERE japan_package_id=package_id AND deleted_at IS NULL;
    UPDATE public.japan_packages SET status=CASE WHEN all_checked THEN 'confirmed' ELSE 'registered' END,
      arrived_at=CASE WHEN any_checked THEN coalesce(arrived_at,current_date) ELSE arrived_at END,
      version=version+1,updated_at=clock_timestamp(),updated_by=auth.uid()
      WHERE id=package_id AND deleted_at IS NULL AND status IN ('registered','confirmed')
      AND (status IS DISTINCT FROM CASE WHEN all_checked THEN 'confirmed' ELSE 'registered' END
        OR (any_checked AND arrived_at IS NULL));
  END LOOP;
  RETURN NULL;
END $$;

-- A deleted shipment releases its allocations. Reactivating must revalidate every source.
CREATE FUNCTION public.erp_core_shipment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item record; capacity integer; allocated bigint;
BEGIN
  IF public.erp_core_restore_in_progress() OR NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' AND OLD.deleted_at IS NULL THEN RETURN NULL; END IF;
  FOR item IN SELECT DISTINCT japan_package_item_id source_id FROM public.outbound_shipment_items
    WHERE outbound_shipment_id=NEW.id AND deleted_at IS NULL AND japan_package_item_id IS NOT NULL LOOP
    SELECT CASE WHEN checked AND deleted_at IS NULL THEN quantity ELSE 0 END INTO capacity
      FROM public.japan_package_items WHERE id=item.source_id;
    SELECT coalesce(sum(greatest(o.quantity,0)),0) INTO allocated FROM public.outbound_shipment_items o
      JOIN public.outbound_shipments s ON s.id=o.outbound_shipment_id
      WHERE o.japan_package_item_id=item.source_id AND o.deleted_at IS NULL AND s.deleted_at IS NULL;
    IF allocated>coalesce(capacity,0) THEN RAISE EXCEPTION 'CORE_SOURCE_CAPACITY' USING ERRCODE='PT409'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.japan_package_items i JOIN public.japan_packages p ON p.id=i.japan_package_id
      WHERE i.id=item.source_id AND p.deleted_at IS NULL AND (p.status IN ('arrived','confirmed') OR p.arrived_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'CORE_SOURCE_NOT_AVAILABLE' USING ERRCODE='PT409';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'] LOOP
    EXECUTE format('CREATE TRIGGER erp_core_write_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.erp_core_write_lock()',t);
  END LOOP;
END $$;
CREATE TRIGGER erp_core_capacity AFTER INSERT OR UPDATE OR DELETE ON public.outbound_shipment_items
  FOR EACH ROW EXECUTE FUNCTION public.erp_core_source_guard();
CREATE TRIGGER erp_core_capacity AFTER UPDATE OR DELETE ON public.japan_package_items
  FOR EACH ROW EXECUTE FUNCTION public.erp_core_source_guard();
CREATE TRIGGER erp_core_progress AFTER INSERT OR UPDATE OR DELETE ON public.japan_package_items
  FOR EACH ROW EXECUTE FUNCTION public.erp_core_package_progress();
CREATE TRIGGER erp_core_progress BEFORE INSERT OR UPDATE ON public.japan_packages
  FOR EACH ROW EXECUTE FUNCTION public.erp_core_package_progress();
CREATE TRIGGER erp_core_reactivate AFTER INSERT OR UPDATE ON public.outbound_shipments
  FOR EACH ROW EXECUTE FUNCTION public.erp_core_shipment_guard();

-- Preserve historical states during existing receiving/edit RPC recomputation.
DO $$ DECLARE signature text; definition text; BEGIN
  FOREACH signature IN ARRAY ARRAY['public.erp_apply_japan_package_transaction(uuid,jsonb)',
    'public.erp_apply_related_transaction(uuid,jsonb)'] LOOP
    SELECT pg_get_functiondef(to_regprocedure(signature)) INTO STRICT definition;
    IF signature LIKE '%erp_apply_japan_package_transaction%' THEN
      IF strpos(definition,'IF v_current_package.status <> ''problem'' THEN')=0 THEN
        RAISE EXCEPTION 'CORE_RECEIVING_STATE_ANCHOR_MISSING'; END IF;
      definition:=replace(definition,'IF v_current_package.status <> ''problem'' THEN',
        'IF v_current_package.status NOT IN (''arrived'',''problem'') THEN');
    ELSE
      IF strpos(definition,'p.status<>''problem''')=0 THEN RAISE EXCEPTION 'CORE_RELATED_STATE_ANCHOR_MISSING'; END IF;
      definition:=replace(definition,'p.status<>''problem''','p.status NOT IN (''arrived'',''problem'')');
    END IF;
    EXECUTE definition;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.erp_core_restore_in_progress(),public.erp_core_write_lock(),
  public.erp_core_source_guard(),public.erp_core_package_progress(),public.erp_core_shipment_guard() FROM PUBLIC,anon,authenticated;
COMMIT;
