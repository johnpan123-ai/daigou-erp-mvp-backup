-- F3 follow-up: make partial receiving advance a registered Japan Package to arrived.
-- 031 is already applied. This migration surgically replaces only the state derivation
-- inside public.erp_apply_japan_package_transaction(uuid,jsonb).

BEGIN;

DO $migration$
DECLARE
  v_function_oid oid := pg_catalog.to_regprocedure('public.erp_apply_japan_package_transaction(uuid,jsonb)');
  v_overload_count bigint;
  v_argument_count smallint;
  v_argument_types oidvector;
  v_argument_names text[];
  v_return_type oid;
  v_owner oid;
  v_kind "char";
  v_security_definer boolean;
  v_config_before text[];
  v_config_after text[];
  v_public_execute boolean;
  v_source text;
  v_definition text;
  v_normalized_source text;
  v_normalized_definition text;
  v_next_definition text;
  v_updated_source text;
  v_updated_definition text;
  v_normalized_updated_source text;
  v_normalized_updated_definition text;
  v_old_declaration text := E'  v_all_checked boolean;\n';
  v_new_declaration text := E'  v_all_checked boolean;\n  v_any_checked boolean;\n';
  v_old_state_fragment text := $old$
      SELECT bool_and(item.checked) AND count(*) > 0 INTO v_all_checked
        FROM public.japan_package_items item
       WHERE item.japan_package_id = v_package_id AND item.deleted_at IS NULL;
      v_target_status := v_current_package.status;
      IF v_current_package.status <> 'problem' THEN
        IF COALESCE(v_all_checked, false) THEN
          v_target_status := 'confirmed';
        ELSIF v_current_package.status = 'confirmed' THEN
          v_target_status := 'arrived';
        END IF;
      END IF;
$old$;
  v_new_state_fragment text := $new$
      SELECT bool_and(item.checked) AND count(*) > 0,
             bool_or(item.checked)
        INTO v_all_checked, v_any_checked
        FROM public.japan_package_items item
       WHERE item.japan_package_id = v_package_id AND item.deleted_at IS NULL;
      v_target_status := v_current_package.status;
      IF v_current_package.status <> 'problem' THEN
        IF COALESCE(v_all_checked, false) THEN
          v_target_status := 'confirmed';
        ELSIF COALESCE(v_any_checked, false)
              OR v_current_package.status IN ('arrived', 'confirmed') THEN
          v_target_status := 'arrived';
        END IF;
      END IF;
$new$;
  v_normalized_old_declaration text;
  v_normalized_new_declaration text;
  v_normalized_old_state_fragment text;
  v_normalized_new_state_fragment text;
  v_source_old_declaration_count integer;
  v_source_old_state_count integer;
  v_definition_old_declaration_count integer;
  v_definition_old_state_count integer;
  v_updated_source_new_declaration_count integer;
  v_updated_source_new_state_count integer;
  v_updated_definition_new_declaration_count integer;
  v_updated_definition_new_state_count integer;
BEGIN
  IF v_function_oid IS NULL THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_BASE_FUNCTION_MISSING' USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.to_regprocedure('public.erp_apply_field_mutations(text,jsonb)') IS NULL
     OR pg_catalog.to_regclass('public.erp_idempotency_keys') IS NULL
     OR pg_catalog.to_regclass('public.japan_packages') IS NULL
     OR pg_catalog.to_regclass('public.japan_package_items') IS NULL THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_DEPENDENCY_MISSING' USING ERRCODE = '55000';
  END IF;

  SELECT count(*)
    INTO v_overload_count
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = 'public'
     AND procedure.proname = 'erp_apply_japan_package_transaction';
  IF v_overload_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_BASE_OVERLOAD_MISMATCH' USING ERRCODE = '55000';
  END IF;

  SELECT procedure.pronargs, procedure.proargtypes, procedure.proargnames,
         procedure.prorettype, procedure.proowner, procedure.prokind,
         procedure.prosecdef, procedure.proconfig, procedure.prosrc,
         pg_catalog.pg_get_functiondef(procedure.oid)
    INTO v_argument_count, v_argument_types, v_argument_names,
         v_return_type, v_owner, v_kind, v_security_definer,
         v_config_before, v_source, v_definition
    FROM pg_catalog.pg_proc procedure
   WHERE procedure.oid = v_function_oid;

  -- PostgreSQL preserves the submitted function body line endings in pg_proc.prosrc.
  -- Normalize only CRLF/CR to LF; indentation and every other byte remain contractual.
  v_normalized_source := pg_catalog.replace(
    pg_catalog.replace(v_source, E'\r\n', E'\n'), E'\r', E'\n'
  );
  v_normalized_definition := pg_catalog.replace(
    pg_catalog.replace(v_definition, E'\r\n', E'\n'), E'\r', E'\n'
  );
  v_normalized_old_declaration := pg_catalog.replace(
    pg_catalog.replace(v_old_declaration, E'\r\n', E'\n'), E'\r', E'\n'
  );
  v_normalized_new_declaration := pg_catalog.replace(
    pg_catalog.replace(v_new_declaration, E'\r\n', E'\n'), E'\r', E'\n'
  );
  v_normalized_old_state_fragment := pg_catalog.replace(
    pg_catalog.replace(v_old_state_fragment, E'\r\n', E'\n'), E'\r', E'\n'
  );
  v_normalized_new_state_fragment := pg_catalog.replace(
    pg_catalog.replace(v_new_state_fragment, E'\r\n', E'\n'), E'\r', E'\n'
  );

  v_source_old_declaration_count :=
    (pg_catalog.length(v_normalized_source)
      - pg_catalog.length(pg_catalog.replace(v_normalized_source, v_normalized_old_declaration, '')))
    / pg_catalog.length(v_normalized_old_declaration);
  v_source_old_state_count :=
    (pg_catalog.length(v_normalized_source)
      - pg_catalog.length(pg_catalog.replace(v_normalized_source, v_normalized_old_state_fragment, '')))
    / pg_catalog.length(v_normalized_old_state_fragment);
  v_definition_old_declaration_count :=
    (pg_catalog.length(v_normalized_definition)
      - pg_catalog.length(pg_catalog.replace(v_normalized_definition, v_normalized_old_declaration, '')))
    / pg_catalog.length(v_normalized_old_declaration);
  v_definition_old_state_count :=
    (pg_catalog.length(v_normalized_definition)
      - pg_catalog.length(pg_catalog.replace(v_normalized_definition, v_normalized_old_state_fragment, '')))
    / pg_catalog.length(v_normalized_old_state_fragment);

  IF v_argument_count IS DISTINCT FROM 2
     OR v_argument_types[0] IS DISTINCT FROM 'uuid'::pg_catalog.regtype::oid
     OR v_argument_types[1] IS DISTINCT FROM 'jsonb'::pg_catalog.regtype::oid
     OR v_argument_names IS DISTINCT FROM ARRAY['p_idempotency_key', 'p_request']::text[]
     OR v_return_type IS DISTINCT FROM 'jsonb'::pg_catalog.regtype
     OR v_kind IS DISTINCT FROM 'f'
     OR v_owner IS DISTINCT FROM pg_catalog.to_regrole(current_user)
     OR v_security_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_BASE_SIGNATURE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF NOT COALESCE(v_config_before, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[] THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_BASE_CONFIG_MISMATCH' USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      ) privilege
     WHERE procedure.oid = v_function_oid
       AND privilege.grantee = 0
       AND privilege.privilege_type = 'EXECUTE'
  ) INTO v_public_execute;
  IF v_public_execute
     OR pg_catalog.has_function_privilege('anon', v_function_oid, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', v_function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_BASE_ACL_MISMATCH' USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.strpos(v_source, 'NOT public.is_editor(v_actor)') = 0
     OR pg_catalog.strpos(v_source, 'current_setting(''request.headers'', true)') = 0
     OR pg_catalog.strpos(v_source, 'v_request_host IS DISTINCT FROM (p_request->>''targetProjectRef'') || ''.supabase.co''') = 0
     OR pg_catalog.strpos(v_source, 'ON CONFLICT (actor_id, idempotency_key) DO NOTHING') = 0
     OR pg_catalog.strpos(v_source, 'request_payload IS DISTINCT FROM p_request') = 0
     OR pg_catalog.strpos(v_source, 'v_existing.status = ''completed''') = 0
     OR pg_catalog.strpos(v_source, 'pg_advisory_xact_lock') = 0
     OR pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_source, 'public.erp_apply_field_mutations(''japan_package_items''') = 0
     OR pg_catalog.strpos(v_source, 'F3_STRUCTURED_ROLLBACK') = 0 THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_BASE_TRANSACTION_CONTRACT_MISMATCH' USING ERRCODE = '55000';
  END IF;

  IF v_source_old_declaration_count IS DISTINCT FROM 1
     OR v_source_old_state_count IS DISTINCT FROM 1
     OR v_definition_old_declaration_count IS DISTINCT FROM 1
     OR v_definition_old_state_count IS DISTINCT FROM 1
     OR pg_catalog.strpos(v_normalized_source, v_normalized_new_state_fragment) > 0
     OR pg_catalog.strpos(v_normalized_source, 'v_any_checked') > 0 THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_BASE_STATE_MACHINE_MISMATCH' USING ERRCODE = '55000';
  END IF;

  v_next_definition := pg_catalog.replace(
    v_normalized_definition, v_normalized_old_declaration, v_normalized_new_declaration
  );
  v_next_definition := pg_catalog.replace(
    v_next_definition, v_normalized_old_state_fragment, v_normalized_new_state_fragment
  );
  IF v_next_definition IS NOT DISTINCT FROM v_normalized_definition THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_REPLACEMENT_MISSING' USING ERRCODE = '55000';
  END IF;
  EXECUTE v_next_definition;

  SELECT procedure.proconfig, procedure.prosrc, pg_catalog.pg_get_functiondef(procedure.oid)
    INTO v_config_after, v_updated_source, v_updated_definition
    FROM pg_catalog.pg_proc procedure
   WHERE procedure.oid = pg_catalog.to_regprocedure('public.erp_apply_japan_package_transaction(uuid,jsonb)');
  v_normalized_updated_source := pg_catalog.replace(
    pg_catalog.replace(v_updated_source, E'\r\n', E'\n'), E'\r', E'\n'
  );
  v_normalized_updated_definition := pg_catalog.replace(
    pg_catalog.replace(v_updated_definition, E'\r\n', E'\n'), E'\r', E'\n'
  );
  v_updated_source_new_declaration_count :=
    (pg_catalog.length(v_normalized_updated_source)
      - pg_catalog.length(pg_catalog.replace(v_normalized_updated_source, v_normalized_new_declaration, '')))
    / pg_catalog.length(v_normalized_new_declaration);
  v_updated_source_new_state_count :=
    (pg_catalog.length(v_normalized_updated_source)
      - pg_catalog.length(pg_catalog.replace(v_normalized_updated_source, v_normalized_new_state_fragment, '')))
    / pg_catalog.length(v_normalized_new_state_fragment);
  v_updated_definition_new_declaration_count :=
    (pg_catalog.length(v_normalized_updated_definition)
      - pg_catalog.length(pg_catalog.replace(v_normalized_updated_definition, v_normalized_new_declaration, '')))
    / pg_catalog.length(v_normalized_new_declaration);
  v_updated_definition_new_state_count :=
    (pg_catalog.length(v_normalized_updated_definition)
      - pg_catalog.length(pg_catalog.replace(v_normalized_updated_definition, v_normalized_new_state_fragment, '')))
    / pg_catalog.length(v_normalized_new_state_fragment);
  IF v_config_after IS DISTINCT FROM v_config_before
     OR v_updated_source_new_declaration_count IS DISTINCT FROM 1
     OR v_updated_source_new_state_count IS DISTINCT FROM 1
     OR v_updated_definition_new_declaration_count IS DISTINCT FROM 1
     OR v_updated_definition_new_state_count IS DISTINCT FROM 1
     OR pg_catalog.strpos(v_normalized_updated_source, v_normalized_old_state_fragment) > 0
     OR pg_catalog.strpos(v_normalized_updated_definition, v_normalized_old_state_fragment) > 0 THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_REPLACEMENT_POSTCHECK_FAILED' USING ERRCODE = '55000';
  END IF;
END;
$migration$;

REVOKE ALL ON FUNCTION public.erp_apply_japan_package_transaction(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_apply_japan_package_transaction(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.erp_apply_japan_package_transaction(uuid, jsonb) TO authenticated;

DO $postflight$
DECLARE
  v_function_oid oid := pg_catalog.to_regprocedure('public.erp_apply_japan_package_transaction(uuid,jsonb)');
  v_overload_count bigint;
  v_argument_count smallint;
  v_argument_types oidvector;
  v_argument_names text[];
  v_return_type oid;
  v_owner oid;
  v_kind "char";
  v_security_definer boolean;
  v_config text[];
  v_source text;
  v_public_execute boolean;
BEGIN
  IF v_function_oid IS NULL THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_POSTFLIGHT_FUNCTION_MISSING' USING ERRCODE = '55000';
  END IF;
  SELECT count(*)
    INTO v_overload_count
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = 'public'
     AND procedure.proname = 'erp_apply_japan_package_transaction';
  SELECT procedure.pronargs, procedure.proargtypes, procedure.proargnames,
         procedure.prorettype, procedure.proowner, procedure.prokind,
         procedure.prosecdef, procedure.proconfig, procedure.prosrc
    INTO v_argument_count, v_argument_types, v_argument_names,
         v_return_type, v_owner, v_kind, v_security_definer, v_config, v_source
    FROM pg_catalog.pg_proc procedure
   WHERE procedure.oid = v_function_oid;

  IF v_overload_count IS DISTINCT FROM 1
     OR v_argument_count IS DISTINCT FROM 2
     OR v_argument_types[0] IS DISTINCT FROM 'uuid'::pg_catalog.regtype::oid
     OR v_argument_types[1] IS DISTINCT FROM 'jsonb'::pg_catalog.regtype::oid
     OR v_argument_names IS DISTINCT FROM ARRAY['p_idempotency_key', 'p_request']::text[]
     OR v_return_type IS DISTINCT FROM 'jsonb'::pg_catalog.regtype
     OR v_kind IS DISTINCT FROM 'f'
     OR v_owner IS DISTINCT FROM pg_catalog.to_regrole(current_user)
     OR v_security_definer IS DISTINCT FROM true
     OR NOT COALESCE(v_config, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[] THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_POSTFLIGHT_CATALOG_MISMATCH' USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      ) privilege
     WHERE procedure.oid = v_function_oid
       AND privilege.grantee = 0
       AND privilege.privilege_type = 'EXECUTE'
  ) INTO v_public_execute;
  IF v_public_execute
     OR pg_catalog.has_function_privilege('anon', v_function_oid, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', v_function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_POSTFLIGHT_ACL_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.strpos(v_source, 'NOT public.is_editor(v_actor)') = 0
     OR pg_catalog.strpos(v_source, 'current_setting(''request.headers'', true)') = 0
     OR pg_catalog.strpos(v_source, 'v_request_host IS DISTINCT FROM (p_request->>''targetProjectRef'') || ''.supabase.co''') = 0
     OR pg_catalog.strpos(v_source, 'ON CONFLICT (actor_id, idempotency_key) DO NOTHING') = 0
     OR pg_catalog.strpos(v_source, 'request_payload IS DISTINCT FROM p_request') = 0
     OR pg_catalog.strpos(v_source, 'v_existing.status = ''completed''') = 0
     OR pg_catalog.strpos(v_source, 'pg_advisory_xact_lock') = 0
     OR pg_catalog.strpos(v_source, 'F3_STRUCTURED_ROLLBACK') = 0
     OR pg_catalog.strpos(v_source, 'v_any_checked boolean') = 0
     OR pg_catalog.strpos(v_source, 'bool_or(item.checked)') = 0
     OR pg_catalog.strpos(v_source, 'ELSIF COALESCE(v_any_checked, false)') = 0
     OR pg_catalog.strpos(v_source, 'v_current_package.status IN (''arrived'', ''confirmed'')') = 0 THEN
    RAISE EXCEPTION 'F3_PARTIAL_RECEIVING_POSTFLIGHT_TRANSACTION_MISMATCH' USING ERRCODE = '55000';
  END IF;
END;
$postflight$;

COMMIT;
