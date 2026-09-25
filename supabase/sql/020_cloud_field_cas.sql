-- Experimental Cloud P0-3: field-aware compare-and-set mutation gateway.
-- Staging review artifact only. Do not apply to Production.
-- This migration intentionally does not include import idempotency or parent/items transactions (P0-4).

BEGIN;

-- All mutable resources need server-visible ordering metadata. Existing columns and values are preserved.
ALTER TABLE public.japan_packages
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';
ALTER TABLE public.japan_package_items
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';
ALTER TABLE public.outbound_shipments
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';
ALTER TABLE public.outbound_shipment_items
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';
ALTER TABLE public.bundle_components
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';

DROP TRIGGER IF EXISTS trigger_update_japan_packages_audit ON public.japan_packages;
CREATE TRIGGER trigger_update_japan_packages_audit
  BEFORE UPDATE ON public.japan_packages FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();
DROP TRIGGER IF EXISTS trigger_update_japan_package_items_audit ON public.japan_package_items;
CREATE TRIGGER trigger_update_japan_package_items_audit
  BEFORE UPDATE ON public.japan_package_items FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();
DROP TRIGGER IF EXISTS trigger_update_outbound_shipments_audit ON public.outbound_shipments;
CREATE TRIGGER trigger_update_outbound_shipments_audit
  BEFORE UPDATE ON public.outbound_shipments FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();
DROP TRIGGER IF EXISTS trigger_update_outbound_shipment_items_audit ON public.outbound_shipment_items;
CREATE TRIGGER trigger_update_outbound_shipment_items_audit
  BEFORE UPDATE ON public.outbound_shipment_items FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();
DROP TRIGGER IF EXISTS trigger_update_bundle_components_audit ON public.bundle_components;
CREATE TRIGGER trigger_update_bundle_components_audit
  BEFORE UPDATE ON public.bundle_components FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

CREATE OR REPLACE FUNCTION public.erp_apply_field_mutations(
  p_entity text,
  p_operations jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_table regclass;
  v_create_allowed text[];
  v_patch_allowed text[];
  v_reorder_allowed text[] := ARRAY[]::text[];
  v_operation jsonb;
  v_kind text;
  v_id uuid;
  v_current jsonb;
  v_values jsonb;
  v_changes jsonb;
  v_expected jsonb;
  v_keys text[];
  v_key text;
  v_set_sql text;
  v_columns_sql text;
  v_values_sql text;
  v_result_row jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_conflicts jsonb;
  v_expected_version integer;
  v_seen_ids text[] := ARRAY[]::text[];
  v_protected constant text[] := ARRAY[
    'id', 'created_at', 'updated_at', 'updated_by', 'version', 'deleted_at', 'sync_status'
  ];
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_editor(auth.uid()) THEN
    RAISE EXCEPTION 'CLOUD_FIELD_CAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_operations) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'CLOUD_FIELD_CAS_OPERATIONS_MUST_BE_ARRAY' USING ERRCODE = '22023';
  END IF;

  -- Both table and fields are resolved exclusively from this server-owned whitelist.
  CASE p_entity
    WHEN 'product_groups' THEN
      v_table := 'public.product_groups'::regclass;
      v_create_allowed := ARRAY['local_id','title','normalized_title','listing_type','priority','purchase_date','closing_date','release_month','has_official_site','product_url','proxy_agent','show_in_purchase_list'];
      v_patch_allowed := array_remove(v_create_allowed, 'local_id');
    WHEN 'product_categories' THEN
      v_table := 'public.product_categories'::regclass;
      v_create_allowed := ARRAY['local_id','product_group_id','title','sort_order'];
      v_patch_allowed := array_remove(v_create_allowed, 'local_id');
      v_reorder_allowed := ARRAY['sort_order'];
    WHEN 'product_variants' THEN
      v_table := 'public.product_variants'::regclass;
      v_create_allowed := ARRAY['local_id','product_group_id','product_category_id','myacg_item_code','product_title','variant_name','raw_variant_name','myacg_auto_quantity','effective_myacg_quantity','myacg_manual_adjustment','waca_auto_quantity','waca_manual_adjustment','private_manual_adjustment','purchased_manual_adjustment','note','sort_order','catalog_missing','source','default_jpy_cost','default_twd_cost'];
      v_patch_allowed := array_remove(v_create_allowed, 'local_id');
      v_reorder_allowed := ARRAY['sort_order'];
    WHEN 'inventory_items' THEN
      v_table := 'public.inventory_items'::regclass;
      v_create_allowed := ARRAY['inventory_key','myacg_item_code','product_id','product_title','normalized_product_title','raw_variant_name','listing_type','final_price','myacg_available_quantity','myacg_sold_quantity','myacg_demand_quantity','myacg_listed_at','import_sort_index','latest_catalog_import_id','catalog_last_seen_at'];
      v_patch_allowed := v_create_allowed;
    WHEN 'purchase_batches' THEN
      v_table := 'public.purchase_batches'::regclass;
      v_create_allowed := ARRAY['local_id','product_group_id','name','date','note','currency'];
      v_patch_allowed := array_remove(v_create_allowed, 'local_id');
    WHEN 'purchase_batch_items' THEN
      v_table := 'public.purchase_batch_items'::regclass;
      v_create_allowed := ARRAY['local_id','purchase_batch_id','product_variant_id','quantity','cost','note'];
      v_patch_allowed := array_remove(v_create_allowed, 'local_id');
    WHEN 'private_orders' THEN
      v_table := 'public.private_orders'::regclass;
      v_create_allowed := ARRAY['local_id','product_group_id','customer_name','contact','note','status'];
      v_patch_allowed := array_remove(v_create_allowed, 'local_id');
    WHEN 'private_order_items' THEN
      v_table := 'public.private_order_items'::regclass;
      v_create_allowed := ARRAY['local_id','private_order_id','product_variant_id','quantity','amount','note'];
      v_patch_allowed := array_remove(v_create_allowed, 'local_id');
    WHEN 'japan_packages' THEN
      v_table := 'public.japan_packages'::regclass;
      v_create_allowed := ARRAY['title','vendor_name','carrier','tracking_number','shipped_at','expected_arrival_at','arrived_at','status','note'];
      v_patch_allowed := v_create_allowed;
    WHEN 'japan_package_items' THEN
      v_table := 'public.japan_package_items'::regclass;
      v_create_allowed := ARRAY['japan_package_id','product_group_id','product_variant_id','purchase_batch_id','purchase_batch_item_id','product_title','category_name','variant_name','sku','quantity','note','checked','checked_at'];
      v_patch_allowed := v_create_allowed;
    WHEN 'outbound_shipments' THEN
      v_table := 'public.outbound_shipments'::regclass;
      v_create_allowed := ARRAY['title','status','carrier','tracking_number','weight_kg','shipping_cost','shipped_at','received_at','note'];
      v_patch_allowed := v_create_allowed;
    WHEN 'outbound_shipment_items' THEN
      v_table := 'public.outbound_shipment_items'::regclass;
      v_create_allowed := ARRAY['outbound_shipment_id','japan_package_item_id','product_group_id','product_variant_id','product_title','variant_name','sku','quantity','checked','checked_at','note'];
      v_patch_allowed := v_create_allowed;
    WHEN 'sales_orders' THEN
      v_table := 'public.sales_orders'::regclass;
      v_create_allowed := ARRAY['local_id','platform','order_number','buyer_name'];
      v_patch_allowed := array_remove(v_create_allowed, 'local_id');
    WHEN 'sales_order_items' THEN
      v_table := 'public.sales_order_items'::regclass;
      v_create_allowed := ARRAY['local_id','order_id','product_variant_id','myacg_item_code','product_name','variant_name','quantity','price','amount','order_status'];
      v_patch_allowed := array_remove(v_create_allowed, 'local_id');
    WHEN 'bundle_components' THEN
      v_table := 'public.bundle_components'::regclass;
      v_create_allowed := ARRAY['bundle_variant_id','component_variant_id'];
      v_patch_allowed := ARRAY[]::text[];
    ELSE
      RAISE EXCEPTION 'CLOUD_FIELD_CAS_ENTITY_NOT_ALLOWED:%', p_entity USING ERRCODE = '22023';
  END CASE;

  -- Phase 1: deterministic advisory locks + row locks + validation. No DML occurs here.
  FOR v_operation IN
    SELECT value FROM jsonb_array_elements(p_operations) ORDER BY value->>'id', value->>'kind'
  LOOP
    v_kind := v_operation->>'kind';
    BEGIN
      v_id := (v_operation->>'id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'CLOUD_FIELD_CAS_CANONICAL_UUID_REQUIRED' USING ERRCODE = '22023';
    END;
    IF v_id::text = ANY(v_seen_ids) THEN
      RAISE EXCEPTION 'CLOUD_FIELD_CAS_DUPLICATE_OPERATION_ID:%', v_id USING ERRCODE = '22023';
    END IF;
    v_seen_ids := array_append(v_seen_ids, v_id::text);
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_entity || ':' || v_id::text, 0));
    EXECUTE format('SELECT to_jsonb(target) FROM %s AS target WHERE target.id = $1 FOR UPDATE', v_table)
      INTO v_current USING v_id;

    IF v_kind = 'create' THEN
      IF v_current IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE_CREATE', 'entity', p_entity, 'recordId', v_id);
      END IF;
      v_values := COALESCE(v_operation->'values', '{}'::jsonb);
      IF jsonb_typeof(v_values) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'CLOUD_FIELD_CAS_VALUES_MUST_BE_OBJECT' USING ERRCODE = '22023';
      END IF;
      SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO v_keys FROM jsonb_object_keys(v_values) key;
      IF v_keys && v_protected OR NOT v_keys <@ v_create_allowed THEN
        RAISE EXCEPTION 'CLOUD_FIELD_CAS_CREATE_FIELD_NOT_ALLOWED' USING ERRCODE = '22023';
      END IF;
    ELSIF v_kind IN ('patch', 'reorder') THEN
      IF v_current IS NULL OR (v_current ? 'deleted_at' AND v_current->'deleted_at' <> 'null'::jsonb) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'RECORD_DELETED_OR_MISSING', 'entity', p_entity, 'recordId', v_id);
      END IF;
      v_changes := COALESCE(v_operation->'changes', '{}'::jsonb);
      v_expected := COALESCE(v_operation->'expected', '{}'::jsonb);
      IF jsonb_typeof(v_changes) IS DISTINCT FROM 'object' OR jsonb_typeof(v_expected) IS DISTINCT FROM 'object' OR v_changes = '{}'::jsonb THEN
        RAISE EXCEPTION 'CLOUD_FIELD_CAS_PATCH_INVALID' USING ERRCODE = '22023';
      END IF;
      SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO v_keys FROM jsonb_object_keys(v_changes) key;
      IF v_keys && v_protected OR (v_kind = 'patch' AND NOT v_keys <@ v_patch_allowed) OR (v_kind = 'reorder' AND NOT v_keys <@ v_reorder_allowed) THEN
        RAISE EXCEPTION 'CLOUD_FIELD_CAS_PATCH_FIELD_NOT_ALLOWED' USING ERRCODE = '22023';
      END IF;
      IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_expected) key) IS DISTINCT FROM v_keys THEN
        RAISE EXCEPTION 'CLOUD_FIELD_CAS_EXPECTED_KEYS_MISMATCH' USING ERRCODE = '22023';
      END IF;
      IF v_kind = 'reorder' AND (v_current->>'version')::integer IS DISTINCT FROM (v_operation->>'expectedVersion')::integer THEN
        RETURN jsonb_build_object('ok', false, 'code', 'REORDER_CONFLICT', 'entity', p_entity, 'recordId', v_id);
      END IF;
      IF v_kind = 'patch' AND jsonb_typeof(v_operation->'observedVersion') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'CLOUD_FIELD_CAS_OBSERVED_VERSION_REQUIRED' USING ERRCODE = '22023';
      END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('field', key, 'expected', v_expected->key, 'current', v_current->key) ORDER BY key), '[]'::jsonb)
        INTO v_conflicts
        FROM unnest(v_keys) key
       WHERE NOT (v_current->key IS NOT DISTINCT FROM v_expected->key);
      IF jsonb_array_length(v_conflicts) > 0 THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', CASE WHEN v_kind = 'reorder' THEN 'REORDER_CONFLICT' ELSE 'FIELD_CONFLICT' END,
          'entity', p_entity,
          'recordId', v_id,
          'conflicts', v_conflicts
        );
      END IF;
    ELSIF v_kind = 'delete' THEN
      IF v_current IS NULL OR (v_current ? 'deleted_at' AND v_current->'deleted_at' <> 'null'::jsonb) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'RECORD_DELETED_OR_MISSING', 'entity', p_entity, 'recordId', v_id);
      END IF;
      v_expected_version := (v_operation->>'expectedVersion')::integer;
      IF (v_current->>'version')::integer IS DISTINCT FROM v_expected_version THEN
        RETURN jsonb_build_object('ok', false, 'code', 'STALE_DELETE', 'entity', p_entity, 'recordId', v_id);
      END IF;
    ELSE
      RAISE EXCEPTION 'CLOUD_FIELD_CAS_OPERATION_NOT_ALLOWED:%', v_kind USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- Phase 2: all operations validated. Apply only the whitelisted touched fields.
  FOR v_operation IN
    SELECT value FROM jsonb_array_elements(p_operations) ORDER BY value->>'id', value->>'kind'
  LOOP
    v_kind := v_operation->>'kind';
    v_id := (v_operation->>'id')::uuid;
    IF v_kind = 'create' THEN
      v_values := v_operation->'values';
      SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO v_keys FROM jsonb_object_keys(v_values) key;
      v_columns_sql := array_to_string(ARRAY(SELECT format('%I', key) FROM unnest(v_keys) key), ', ');
      v_values_sql := array_to_string(ARRAY(SELECT format('typed.%I', key) FROM unnest(v_keys) key), ', ');
      IF cardinality(v_keys) = 0 THEN
        EXECUTE format('INSERT INTO %s AS target (id, updated_by) VALUES ($1, auth.uid()) RETURNING to_jsonb(target)', v_table)
          INTO v_result_row USING v_id;
      ELSE
        EXECUTE format(
          'INSERT INTO %s AS target (id, updated_by, %s) SELECT $1, auth.uid(), %s FROM jsonb_populate_record(NULL::%s, $2) AS typed RETURNING to_jsonb(target)',
          v_table, v_columns_sql, v_values_sql, v_table
        ) INTO v_result_row USING v_id, v_values;
      END IF;
    ELSIF v_kind IN ('patch', 'reorder') THEN
      v_changes := v_operation->'changes';
      SELECT array_agg(key ORDER BY key) INTO v_keys FROM jsonb_object_keys(v_changes) key;
      v_set_sql := array_to_string(ARRAY(SELECT format('%I = typed.%I', key, key) FROM unnest(v_keys) key), ', ');
      EXECUTE format(
        'UPDATE %s AS target SET %s, version = target.version + 1, updated_at = clock_timestamp(), updated_by = auth.uid(), sync_status = ''synced'' FROM jsonb_populate_record(NULL::%s, $2) AS typed WHERE target.id = $1 RETURNING to_jsonb(target)',
        v_table, v_set_sql, v_table
      ) INTO v_result_row USING v_id, v_changes;
    ELSE
      EXECUTE format(
        'UPDATE %s AS target SET deleted_at = clock_timestamp(), version = target.version + 1, updated_at = clock_timestamp(), updated_by = auth.uid(), sync_status = ''synced'' WHERE target.id = $1 RETURNING to_jsonb(target)',
        v_table
      ) INTO v_result_row USING v_id;
    END IF;
    v_rows := v_rows || jsonb_build_array(v_result_row);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'entity', p_entity, 'rows', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.erp_apply_field_mutations(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_apply_field_mutations(text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_field_mutations(text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_delete_product_group_trees(p_groups jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_group jsonb;
  v_group_id uuid;
  v_group_version integer;
  v_expected_categories jsonb;
  v_expected_variants jsonb;
  v_current_categories jsonb;
  v_current_variants jsonb;
  v_group_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_editor(auth.uid()) THEN
    RAISE EXCEPTION 'CLOUD_FIELD_CAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_groups) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'CLOUD_GROUP_DELETE_EXPECTATIONS_MUST_BE_ARRAY' USING ERRCODE = '22023';
  END IF;

  FOR v_group IN SELECT value FROM jsonb_array_elements(p_groups) ORDER BY value->>'id'
  LOOP
    v_group_id := (v_group->>'id')::uuid;
    v_group_version := (v_group->>'expectedVersion')::integer;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('product_group_tree:' || v_group_id::text, 0));
    PERFORM 1 FROM public.product_groups
      WHERE id = v_group_id AND deleted_at IS NULL AND version = v_group_version
      FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'STALE_DELETE', 'entity', 'product_groups', 'recordId', v_group_id);
    END IF;

    PERFORM 1 FROM public.product_categories WHERE product_group_id = v_group_id AND deleted_at IS NULL ORDER BY id FOR UPDATE;
    PERFORM 1 FROM public.product_variants WHERE product_group_id = v_group_id AND deleted_at IS NULL ORDER BY id FOR UPDATE;

    v_expected_categories := COALESCE(v_group->'categories', '[]'::jsonb);
    v_expected_variants := COALESCE(v_group->'variants', '[]'::jsonb);
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'expectedVersion', version) ORDER BY id), '[]'::jsonb)
      INTO v_current_categories FROM public.product_categories WHERE product_group_id = v_group_id AND deleted_at IS NULL;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'expectedVersion', version) ORDER BY id), '[]'::jsonb)
      INTO v_current_variants FROM public.product_variants WHERE product_group_id = v_group_id AND deleted_at IS NULL;

    SELECT COALESCE(jsonb_agg(value ORDER BY value->>'id'), '[]'::jsonb)
      INTO v_expected_categories FROM jsonb_array_elements(v_expected_categories);
    SELECT COALESCE(jsonb_agg(value ORDER BY value->>'id'), '[]'::jsonb)
      INTO v_expected_variants FROM jsonb_array_elements(v_expected_variants);
    IF v_current_categories IS DISTINCT FROM v_expected_categories OR v_current_variants IS DISTINCT FROM v_expected_variants THEN
      RETURN jsonb_build_object('ok', false, 'code', 'STALE_DELETE', 'entity', 'product_groups', 'recordId', v_group_id);
    END IF;
    v_group_ids := array_append(v_group_ids, v_group_id);
  END LOOP;

  UPDATE public.product_categories SET deleted_at = clock_timestamp(), version = version + 1,
    updated_at = clock_timestamp(), updated_by = auth.uid(), sync_status = 'synced'
    WHERE product_group_id = ANY(v_group_ids) AND deleted_at IS NULL;
  UPDATE public.product_variants SET deleted_at = clock_timestamp(), version = version + 1,
    updated_at = clock_timestamp(), updated_by = auth.uid(), sync_status = 'synced'
    WHERE product_group_id = ANY(v_group_ids) AND deleted_at IS NULL;
  UPDATE public.product_groups SET deleted_at = clock_timestamp(), version = version + 1,
    updated_at = clock_timestamp(), updated_by = auth.uid(), sync_status = 'synced'
    WHERE id = ANY(v_group_ids) AND deleted_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'entity', 'product_groups', 'rows', '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.erp_delete_product_group_trees(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_delete_product_group_trees(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.erp_delete_product_group_trees(jsonb) TO authenticated;

COMMIT;
