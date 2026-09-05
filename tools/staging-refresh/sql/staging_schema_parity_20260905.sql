-- STAGING ONLY: targeted parity with the 2026-09-05 live Production catalog.
--
-- This is intentionally outside supabase/sql. It must never be included in a
-- normal Production migration or deployment. The exact legacy-Staging
-- preflight below also makes the current Production schema refuse this script
-- before the first ALTER statement.
--
-- Expected target: rhfdjsklfrgpoqsaqpkn
-- Forbidden target: twzpqyesbtnfxdkorluf
-- Apply only through an operator flow that verifies the connection project ref.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('hippo-staging-schema-parity-20260905-v1'));

-- Fail closed unless the database is exactly the audited legacy Staging shape.
DO $staging_parity_preflight$
DECLARE
  v_count bigint;
  v_raw text;
  v_date date;
BEGIN
  IF to_regprocedure('gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:gen_random_uuid_missing';
  END IF;

  IF to_regclass('public.inventory_items') IS NULL
     OR to_regclass('public.product_groups') IS NULL
     OR to_regclass('public.product_variants') IS NULL
     OR to_regclass('public.purchase_batches') IS NULL
     OR to_regclass('public.private_orders') IS NULL
     OR to_regclass('public.sales_orders') IS NULL
     OR to_regclass('public.sales_order_items') IS NULL THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:required_table_missing';
  END IF;

  -- Production already has these columns. Their presence means this is not the
  -- audited legacy Staging pre-state (or a previous attempt partially drifted).
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      (table_name = 'inventory_items' AND column_name IN ('id', 'latest_catalog_import_id', 'catalog_last_seen_at'))
      OR (table_name = 'sales_orders' AND column_name = 'version')
      OR (table_name = 'sales_order_items' AND column_name = 'version')
    );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:unexpected_or_partial_target_columns';
  END IF;

  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'inventory_items'
    AND column_name = 'inventory_key'
    AND data_type = 'text'
    AND is_nullable = 'NO';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:inventory_key_contract_mismatch';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'inventory_items'
    AND c.conname = 'inventory_items_pkey'
    AND c.contype = 'p'
    AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (inventory_key)';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:inventory_primary_key_mismatch';
  END IF;

  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      (table_name = 'product_groups' AND column_name = 'purchase_date')
      OR (table_name = 'purchase_batches' AND column_name = 'date')
    )
    AND data_type = 'text'
    AND is_nullable = 'YES'
    AND column_default IS NULL;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:legacy_date_column_contract_mismatch';
  END IF;

  FOR v_raw IN
    SELECT purchase_date FROM public.product_groups
    WHERE purchase_date IS NOT NULL AND purchase_date <> ''
  LOOP
    IF v_raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'UNSAFE_DATE_CAST:product_groups.purchase_date';
    END IF;
    BEGIN
      v_date := v_raw::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'UNSAFE_DATE_CAST:product_groups.purchase_date';
    END;
    IF to_char(v_date, 'YYYY-MM-DD') <> v_raw THEN
      RAISE EXCEPTION 'UNSAFE_DATE_CAST:product_groups.purchase_date';
    END IF;
  END LOOP;

  FOR v_raw IN
    SELECT date FROM public.purchase_batches
    WHERE date IS NOT NULL AND date <> ''
  LOOP
    IF v_raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'UNSAFE_DATE_CAST:purchase_batches.date';
    END IF;
    BEGIN
      v_date := v_raw::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'UNSAFE_DATE_CAST:purchase_batches.date';
    END;
    IF to_char(v_date, 'YYYY-MM-DD') <> v_raw THEN
      RAISE EXCEPTION 'UNSAFE_DATE_CAST:purchase_batches.date';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'product_variants'
    AND column_name IN ('private_manual_adjustment', 'purchased_manual_adjustment')
    AND data_type = 'integer'
    AND is_nullable = 'NO'
    AND column_default = '0';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:manual_adjustment_contract_mismatch';
  END IF;

  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'sales_orders'
    AND column_name = 'buyer_name'
    AND data_type = 'text'
    AND is_nullable = 'YES'
    AND column_default IS NULL;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:sales_orders_buyer_name_contract_mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_orders WHERE buyer_name IS NULL) THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:sales_orders_buyer_name_has_null';
  END IF;

  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'sales_order_items'
    AND column_name IN ('price', 'amount')
    AND data_type = 'numeric'
    AND is_nullable = 'NO'
    AND column_default = '0';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:sales_order_items_money_contract_mismatch';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND (
      (t.relname = 'purchase_batches' AND c.conname = 'purchase_batches_product_group_id_fkey')
      OR (t.relname = 'private_orders' AND c.conname = 'private_orders_product_group_id_fkey')
    )
    AND c.contype = 'f'
    AND c.confdeltype = 'r'
    AND c.confupdtype = 'a'
    AND pg_get_constraintdef(c.oid) = 'FOREIGN KEY (product_group_id) REFERENCES product_groups(id) ON DELETE RESTRICT'
    AND c.convalidated;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:product_group_fk_contract_mismatch';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'sales_orders'
    AND c.conname = 'sales_orders_order_number_key'
    AND c.contype = 'u'
    AND pg_get_constraintdef(c.oid) = 'UNIQUE (order_number)';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:sales_order_number_unique_constraint_missing';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'sales_orders'
    AND idx.relname = 'idx_sales_orders_order_number'
    AND i.indisunique
    AND NOT i.indisprimary
    AND pg_get_indexdef(i.indexrelid, 1, true) = 'order_number'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = i.indexrelid);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:sales_order_number_index_mismatch';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND (
      (t.relname = 'sales_orders' AND idx.relname = 'idx_sales_orders_deleted_at')
      OR (t.relname = 'sales_order_items' AND idx.relname = 'idx_sales_order_items_deleted_at')
    )
    AND NOT i.indisunique
    AND NOT i.indisprimary
    AND pg_get_indexdef(i.indexrelid, 1, true) = 'deleted_at'
    AND pg_get_expr(i.indpred, i.indrelid) = '(deleted_at IS NULL)'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = i.indexrelid);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'STAGING_PARITY_PREFLIGHT:staging_only_deleted_at_index_mismatch';
  END IF;
END
$staging_parity_preflight$;

-- Capture all existing row values that are not intentionally transformed.
-- Postflight compares these snapshots before COMMIT; any drift aborts the whole
-- transaction.
CREATE TEMP TABLE hippo_inventory_items_before ON COMMIT DROP AS
SELECT inventory_key,
       to_jsonb(row_value) AS row_value
FROM public.inventory_items row_value;

CREATE TEMP TABLE hippo_product_groups_before ON COMMIT DROP AS
SELECT id,
       to_jsonb(row_value) || jsonb_build_object(
         'purchase_date', CASE WHEN purchase_date = '' THEN NULL ELSE purchase_date END
       ) AS row_value
FROM public.product_groups row_value;

CREATE TEMP TABLE hippo_purchase_batches_before ON COMMIT DROP AS
SELECT id,
       to_jsonb(row_value) || jsonb_build_object(
         'date', CASE WHEN date = '' THEN NULL ELSE date END
       ) AS row_value
FROM public.purchase_batches row_value;

CREATE TEMP TABLE hippo_product_variants_before ON COMMIT DROP AS
SELECT id, to_jsonb(row_value) AS row_value
FROM public.product_variants row_value;

CREATE TEMP TABLE hippo_sales_orders_before ON COMMIT DROP AS
SELECT id, to_jsonb(row_value) AS row_value
FROM public.sales_orders row_value;

CREATE TEMP TABLE hippo_sales_order_items_before ON COMMIT DROP AS
SELECT id, to_jsonb(row_value) AS row_value
FROM public.sales_order_items row_value;

-- 1. inventory_items: preserve inventory_key as the upsert identity while
-- introducing the Production UUID primary key. Adding the volatile UUID
-- default through ALTER TABLE populates existing Staging fixture rows without
-- firing application UPDATE triggers.
ALTER TABLE public.inventory_items
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN latest_catalog_import_id text,
  ADD COLUMN catalog_last_seen_at timestamptz;

ALTER TABLE public.inventory_items
  DROP CONSTRAINT inventory_items_pkey,
  ADD CONSTRAINT inventory_items_pkey PRIMARY KEY (id),
  ADD CONSTRAINT inventory_items_inventory_key_key UNIQUE (inventory_key);

CREATE INDEX inventory_items_catalog_last_seen_at_idx
  ON public.inventory_items USING btree (catalog_last_seen_at);

-- 2-3. Exact ISO dates remain the same value. Empty strings explicitly map to
-- NULL; every other non-null value was validated above and cannot be coerced.
ALTER TABLE public.product_groups
  ALTER COLUMN purchase_date TYPE date
  USING CASE WHEN purchase_date = '' THEN NULL ELSE purchase_date::date END;

ALTER TABLE public.purchase_batches
  ALTER COLUMN date TYPE date
  USING CASE WHEN date = '' THEN NULL ELSE date::date END;

-- 4. Match Production nullable/no-default adjustment semantics without
-- changing any existing adjustment value.
ALTER TABLE public.product_variants
  ALTER COLUMN private_manual_adjustment DROP NOT NULL,
  ALTER COLUMN private_manual_adjustment DROP DEFAULT,
  ALTER COLUMN purchased_manual_adjustment DROP NOT NULL,
  ALTER COLUMN purchased_manual_adjustment DROP DEFAULT;

-- 5-6. Add optimistic versions without trigger-driven row updates, require
-- the already-validated buyer name, and allow nullable monetary values while
-- retaining the Production default of 0.
ALTER TABLE public.sales_orders
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ALTER COLUMN buyer_name SET NOT NULL;

ALTER TABLE public.sales_order_items
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ALTER COLUMN price DROP NOT NULL,
  ALTER COLUMN amount DROP NOT NULL;

-- Live Production uses CASCADE for these two group-owned headers.
ALTER TABLE public.purchase_batches
  DROP CONSTRAINT purchase_batches_product_group_id_fkey,
  ADD CONSTRAINT purchase_batches_product_group_id_fkey
    FOREIGN KEY (product_group_id)
    REFERENCES public.product_groups(id)
    ON DELETE CASCADE;

ALTER TABLE public.private_orders
  DROP CONSTRAINT private_orders_product_group_id_fkey,
  ADD CONSTRAINT private_orders_product_group_id_fkey
    FOREIGN KEY (product_group_id)
    REFERENCES public.product_groups(id)
    ON DELETE CASCADE;

-- Keep the constraint-backed UNIQUE order number and replace only the
-- redundant standalone index so its uniqueness matches live Production.
DROP INDEX public.idx_sales_orders_order_number;
CREATE INDEX idx_sales_orders_order_number
  ON public.sales_orders USING btree (order_number);

-- These two standalone legacy Staging indexes do not exist in Production and
-- are not constraint-backed. Removing them changes no rows or constraints.
DROP INDEX public.idx_sales_orders_deleted_at;
DROP INDEX public.idx_sales_order_items_deleted_at;

-- Verify the target contract and all preserved row projections before COMMIT.
DO $staging_parity_postflight$
DECLARE
  v_count bigint;
BEGIN
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'inventory_items'
    AND (
      (column_name = 'id' AND data_type = 'uuid' AND is_nullable = 'NO' AND column_default = 'gen_random_uuid()')
      OR (column_name = 'latest_catalog_import_id' AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL)
      OR (column_name = 'catalog_last_seen_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES' AND column_default IS NULL)
      OR (column_name = 'inventory_key' AND data_type = 'text' AND is_nullable = 'NO' AND column_default IS NULL)
    );
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:inventory_columns_mismatch';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'inventory_items'
    AND (
      (c.conname = 'inventory_items_pkey' AND c.contype = 'p' AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)')
      OR (c.conname = 'inventory_items_inventory_key_key' AND c.contype = 'u' AND pg_get_constraintdef(c.oid) = 'UNIQUE (inventory_key)')
    );
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:inventory_identity_constraints_mismatch';
  END IF;

  IF (SELECT count(*) FROM public.inventory_items) <> (SELECT count(DISTINCT id) FROM public.inventory_items)
     OR EXISTS (SELECT 1 FROM public.inventory_items WHERE id IS NULL OR inventory_key IS NULL) THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:inventory_identity_invalid';
  END IF;

  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      (table_name = 'product_groups' AND column_name = 'purchase_date')
      OR (table_name = 'purchase_batches' AND column_name = 'date')
    )
    AND data_type = 'date'
    AND is_nullable = 'YES'
    AND column_default IS NULL;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:date_columns_mismatch';
  END IF;

  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'product_variants'
    AND column_name IN ('private_manual_adjustment', 'purchased_manual_adjustment')
    AND data_type = 'integer'
    AND is_nullable = 'YES'
    AND column_default IS NULL;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:manual_adjustment_columns_mismatch';
  END IF;

  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      (table_name = 'sales_orders' AND column_name = 'buyer_name' AND data_type = 'text' AND is_nullable = 'NO' AND column_default IS NULL)
      OR (table_name = 'sales_orders' AND column_name = 'version' AND data_type = 'integer' AND is_nullable = 'NO' AND column_default = '1')
      OR (table_name = 'sales_order_items' AND column_name = 'version' AND data_type = 'integer' AND is_nullable = 'NO' AND column_default = '1')
      OR (table_name = 'sales_order_items' AND column_name = 'price' AND data_type = 'numeric' AND is_nullable = 'YES' AND column_default = '0')
      OR (table_name = 'sales_order_items' AND column_name = 'amount' AND data_type = 'numeric' AND is_nullable = 'YES' AND column_default = '0')
    );
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:sales_columns_mismatch';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND (
      (t.relname = 'purchase_batches' AND c.conname = 'purchase_batches_product_group_id_fkey')
      OR (t.relname = 'private_orders' AND c.conname = 'private_orders_product_group_id_fkey')
    )
    AND c.contype = 'f'
    AND c.confdeltype = 'c'
    AND c.confupdtype = 'a'
    AND pg_get_constraintdef(c.oid) = 'FOREIGN KEY (product_group_id) REFERENCES product_groups(id) ON DELETE CASCADE'
    AND c.convalidated;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:product_group_fk_delete_action_mismatch';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND (
      (t.relname = 'inventory_items' AND idx.relname = 'inventory_items_catalog_last_seen_at_idx'
        AND NOT i.indisunique AND pg_get_indexdef(i.indexrelid, 1, true) = 'catalog_last_seen_at')
      OR (t.relname = 'sales_orders' AND idx.relname = 'idx_sales_orders_order_number'
        AND NOT i.indisunique AND pg_get_indexdef(i.indexrelid, 1, true) = 'order_number')
    );
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:index_contract_mismatch';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'sales_orders'
    AND c.conname = 'sales_orders_order_number_key'
    AND c.contype = 'u'
    AND pg_get_constraintdef(c.oid) = 'UNIQUE (order_number)';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:sales_order_number_unique_constraint_missing';
  END IF;

  IF to_regclass('public.idx_sales_orders_deleted_at') IS NOT NULL
     OR to_regclass('public.idx_sales_order_items_deleted_at') IS NOT NULL THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:staging_only_index_still_present';
  END IF;

  IF EXISTS (
    (SELECT row_value FROM hippo_inventory_items_before
     EXCEPT
     SELECT to_jsonb(row_value) - ARRAY['id', 'latest_catalog_import_id', 'catalog_last_seen_at']
     FROM public.inventory_items row_value)
    UNION ALL
    (SELECT to_jsonb(row_value) - ARRAY['id', 'latest_catalog_import_id', 'catalog_last_seen_at']
     FROM public.inventory_items row_value
     EXCEPT
     SELECT row_value FROM hippo_inventory_items_before)
  ) THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:inventory_existing_data_changed';
  END IF;

  IF EXISTS (
    (SELECT row_value FROM hippo_product_groups_before
     EXCEPT SELECT to_jsonb(row_value) FROM public.product_groups row_value)
    UNION ALL
    (SELECT to_jsonb(row_value) FROM public.product_groups row_value
     EXCEPT SELECT row_value FROM hippo_product_groups_before)
  ) THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:product_groups_existing_data_changed';
  END IF;

  IF EXISTS (
    (SELECT row_value FROM hippo_purchase_batches_before
     EXCEPT SELECT to_jsonb(row_value) FROM public.purchase_batches row_value)
    UNION ALL
    (SELECT to_jsonb(row_value) FROM public.purchase_batches row_value
     EXCEPT SELECT row_value FROM hippo_purchase_batches_before)
  ) THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:purchase_batches_existing_data_changed';
  END IF;

  IF EXISTS (
    (SELECT row_value FROM hippo_product_variants_before
     EXCEPT SELECT to_jsonb(row_value) FROM public.product_variants row_value)
    UNION ALL
    (SELECT to_jsonb(row_value) FROM public.product_variants row_value
     EXCEPT SELECT row_value FROM hippo_product_variants_before)
  ) THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:product_variants_existing_data_changed';
  END IF;

  IF EXISTS (
    (SELECT row_value FROM hippo_sales_orders_before
     EXCEPT SELECT to_jsonb(row_value) - 'version' FROM public.sales_orders row_value)
    UNION ALL
    (SELECT to_jsonb(row_value) - 'version' FROM public.sales_orders row_value
     EXCEPT SELECT row_value FROM hippo_sales_orders_before)
  ) THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:sales_orders_existing_data_changed';
  END IF;

  IF EXISTS (
    (SELECT row_value FROM hippo_sales_order_items_before
     EXCEPT SELECT to_jsonb(row_value) - 'version' FROM public.sales_order_items row_value)
    UNION ALL
    (SELECT to_jsonb(row_value) - 'version' FROM public.sales_order_items row_value
     EXCEPT SELECT row_value FROM hippo_sales_order_items_before)
  ) THEN
    RAISE EXCEPTION 'STAGING_PARITY_POSTFLIGHT:sales_order_items_existing_data_changed';
  END IF;
END
$staging_parity_postflight$;

COMMIT;
