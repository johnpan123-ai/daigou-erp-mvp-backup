-- Japan Package daily status (Owner decision 2026-10-21): new operations only use 'registered' / 'confirmed'.
-- Receiving no longer moves a package to the historical 'arrived' state:
--   * every active item checked             -> 'confirmed' (unchanged rule)
--   * partially checked                     -> status unchanged (registered stays registered); arrived_at is still
--                                              stamped once, so outbound availability (status OR arrived_at) is unchanged
--   * un-checking a 'confirmed' package     -> 'registered' (was 'arrived'); arrived_at kept
--   * 'problem' packages                    -> never changed by receiving (unchanged rule)
--   * historical 'arrived' / 'problem' rows -> never converted here; no data is rewritten by this migration
-- Surgical, anchor-verified replacement inside two existing functions (same technique as 034); no table, column,
-- constraint, enum, ACL or signature change. Allowed status values remain registered / arrived / confirmed / problem.

BEGIN;

DO $migration$
DECLARE
  v_jp_oid oid := pg_catalog.to_regprocedure('public.erp_apply_japan_package_transaction(uuid,jsonb)');
  v_rel_oid oid := pg_catalog.to_regprocedure('public.erp_apply_related_transaction(uuid,jsonb)');
  v_config_before text[];
  v_config_after text[];
  v_definition text;
  v_next text;
  v_updated text;
  v_count integer;
  v_jp_old_state text := $old$
      v_target_status := v_current_package.status;
      IF v_current_package.status <> 'problem' THEN
        IF COALESCE(v_all_checked, false) THEN
          v_target_status := 'confirmed';
        ELSIF COALESCE(v_any_checked, false)
              OR v_current_package.status IN ('arrived', 'confirmed') THEN
          v_target_status := 'arrived';
        END IF;
      END IF;
$old$;
  v_jp_new_state text := $new$
      v_target_status := v_current_package.status;
      IF v_current_package.status <> 'problem' THEN
        IF COALESCE(v_all_checked, false) THEN
          v_target_status := 'confirmed';
        ELSIF v_current_package.status = 'confirmed' THEN
          v_target_status := 'registered';
        END IF;
      END IF;
$new$;
  v_jp_old_update text := $old$
      IF v_transaction_type = 'attach-items'
         OR v_target_status IS DISTINCT FROM v_current_package.status THEN
        UPDATE public.japan_packages
           SET status = v_target_status,
               arrived_at = CASE WHEN v_target_status IN ('arrived','confirmed') THEN COALESCE(arrived_at, CURRENT_DATE) ELSE arrived_at END,
$old$;
  v_jp_new_update text := $new$
      IF v_transaction_type = 'attach-items'
         OR v_target_status IS DISTINCT FROM v_current_package.status
         OR (v_current_package.status <> 'problem' AND COALESCE(v_any_checked, false)
             AND v_current_package.arrived_at IS NULL) THEN
        UPDATE public.japan_packages
           SET status = v_target_status,
               arrived_at = CASE WHEN v_target_status IN ('arrived','confirmed')
                                   OR (v_target_status <> 'problem' AND COALESCE(v_any_checked, false))
                                 THEN COALESCE(arrived_at, CURRENT_DATE) ELSE arrived_at END,
$new$;
  v_rel_old text := $old$ELSE CASE WHEN p.status='confirmed' THEN 'arrived' ELSE p.status END END$old$;
  v_rel_new text := $new$ELSE CASE WHEN p.status='confirmed' THEN 'registered' ELSE p.status END END$new$;
  v_norm text;
BEGIN
  IF v_jp_oid IS NULL OR v_rel_oid IS NULL THEN
    RAISE EXCEPTION 'JP_DAILY_STATUS_BASE_FUNCTION_MISSING' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('erp_apply_japan_package_transaction', 'erp_apply_related_transaction')) <> 2 THEN
    RAISE EXCEPTION 'JP_DAILY_STATUS_OVERLOAD_MISMATCH' USING ERRCODE = '55000';
  END IF;

  -- 1) erp_apply_japan_package_transaction: exactly one state fragment and one update fragment.
  SELECT p.proconfig, pg_catalog.pg_get_functiondef(p.oid) INTO v_config_before, v_definition
    FROM pg_catalog.pg_proc p WHERE p.oid = v_jp_oid;
  v_norm := pg_catalog.replace(pg_catalog.replace(v_definition, E'\r\n', E'\n'), E'\r', E'\n');
  v_count := (pg_catalog.length(v_norm) - pg_catalog.length(pg_catalog.replace(v_norm, v_jp_old_state, ''))) / pg_catalog.length(v_jp_old_state);
  IF v_count IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'JP_DAILY_STATUS_STATE_ANCHOR_MISMATCH:%', v_count USING ERRCODE = '55000'; END IF;
  v_count := (pg_catalog.length(v_norm) - pg_catalog.length(pg_catalog.replace(v_norm, v_jp_old_update, ''))) / pg_catalog.length(v_jp_old_update);
  IF v_count IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'JP_DAILY_STATUS_UPDATE_ANCHOR_MISMATCH:%', v_count USING ERRCODE = '55000'; END IF;
  IF pg_catalog.strpos(v_norm, 'bool_or(item.checked)') = 0 OR pg_catalog.strpos(v_norm, 'v_any_checked boolean') = 0
     OR pg_catalog.strpos(v_norm, 'F3_STRUCTURED_ROLLBACK') = 0 OR pg_catalog.strpos(v_norm, 'pg_advisory_xact_lock') = 0 THEN
    RAISE EXCEPTION 'JP_DAILY_STATUS_TRANSACTION_CONTRACT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  v_next := pg_catalog.replace(pg_catalog.replace(v_norm, v_jp_old_state, v_jp_new_state), v_jp_old_update, v_jp_new_update);
  EXECUTE v_next;
  SELECT p.proconfig, pg_catalog.pg_get_functiondef(p.oid) INTO v_config_after, v_updated
    FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.erp_apply_japan_package_transaction(uuid,jsonb)');
  v_updated := pg_catalog.replace(pg_catalog.replace(v_updated, E'\r\n', E'\n'), E'\r', E'\n');
  IF v_config_after IS DISTINCT FROM v_config_before
     OR pg_catalog.strpos(v_updated, v_jp_new_state) = 0 OR pg_catalog.strpos(v_updated, v_jp_new_update) = 0
     OR pg_catalog.strpos(v_updated, v_jp_old_state) > 0 OR pg_catalog.strpos(v_updated, v_jp_old_update) > 0
     OR pg_catalog.strpos(v_updated, 'v_target_status := ''arrived''') > 0 THEN
    RAISE EXCEPTION 'JP_DAILY_STATUS_JP_POSTCHECK_FAILED' USING ERRCODE = '55000';
  END IF;

  -- 2) erp_apply_related_transaction (manual package item edit / delete): exactly two occurrences.
  SELECT p.proconfig, pg_catalog.pg_get_functiondef(p.oid) INTO v_config_before, v_definition
    FROM pg_catalog.pg_proc p WHERE p.oid = v_rel_oid;
  v_norm := pg_catalog.replace(pg_catalog.replace(v_definition, E'\r\n', E'\n'), E'\r', E'\n');
  v_count := (pg_catalog.length(v_norm) - pg_catalog.length(pg_catalog.replace(v_norm, v_rel_old, ''))) / pg_catalog.length(v_rel_old);
  IF v_count IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'JP_DAILY_STATUS_RELATED_ANCHOR_MISMATCH:%', v_count USING ERRCODE = '55000'; END IF;
  EXECUTE pg_catalog.replace(v_norm, v_rel_old, v_rel_new);
  SELECT p.proconfig, pg_catalog.pg_get_functiondef(p.oid) INTO v_config_after, v_updated
    FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.erp_apply_related_transaction(uuid,jsonb)');
  v_updated := pg_catalog.replace(pg_catalog.replace(v_updated, E'\r\n', E'\n'), E'\r', E'\n');
  IF v_config_after IS DISTINCT FROM v_config_before OR pg_catalog.strpos(v_updated, v_rel_old) > 0
     OR (pg_catalog.length(v_updated) - pg_catalog.length(pg_catalog.replace(v_updated, v_rel_new, ''))) / pg_catalog.length(v_rel_new) <> 2 THEN
    RAISE EXCEPTION 'JP_DAILY_STATUS_RELATED_POSTCHECK_FAILED' USING ERRCODE = '55000';
  END IF;
END;
$migration$;

REVOKE ALL ON FUNCTION public.erp_apply_japan_package_transaction(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_apply_japan_package_transaction(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_japan_package_transaction(uuid, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.erp_apply_related_transaction(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_apply_related_transaction(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_related_transaction(uuid, jsonb) TO authenticated;

COMMIT;
