import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const BASELINE_PATH = new URL('../supabase/sql/031_japan_package_receiving_atomic_transaction.sql', import.meta.url);
const MIGRATION_PATH = new URL('../supabase/sql/034_japan_package_partial_receiving_state_machine.sql', import.meta.url);
const [baseline, migration] = await Promise.all([
  readFile(BASELINE_PATH, 'utf8'),
  readFile(MIGRATION_PATH, 'utf8'),
]);

const baselineBody = baseline.match(/AS \$\$([\s\S]+?)\$\$;/u)?.[1] ?? '';
const oldDeclaration = migration.match(/v_old_declaration text := E'([^']+)'/u)?.[1]?.replaceAll('\\n', '\n') ?? '';
const newDeclaration = migration.match(/v_new_declaration text := E'([^']+)'/u)?.[1]?.replaceAll('\\n', '\n') ?? '';
const oldState = migration.match(/v_old_state_fragment text := \$old\$([\s\S]+?)\$old\$;/u)?.[1] ?? '';
const newState = migration.match(/v_new_state_fragment text := \$new\$([\s\S]+?)\$new\$;/u)?.[1] ?? '';

assert.ok(baselineBody && oldDeclaration && newDeclaration && oldState && newState, '034 surgical replacement fixtures must be inspectable');
assert.equal(baselineBody.split(oldDeclaration).length - 1, 1);
assert.equal(baselineBody.split(oldState).length - 1, 1);
assert.equal(baselineBody.includes('v_any_checked'), false);
const migratedBody = baselineBody.replace(oldDeclaration, newDeclaration).replace(oldState, newState);
assert.match(migratedBody, /v_any_checked boolean/u);
assert.match(migratedBody, /bool_or\(item\.checked\)/u);
assert.match(migratedBody, /ELSIF COALESCE\(v_any_checked, false\)[\s\S]+v_current_package\.status IN \('arrived', 'confirmed'\)/u);
assert.doesNotMatch(migratedBody, /ELSIF v_current_package\.status = 'confirmed'/u);

assert.match(migration, /^--[\s\S]+BEGIN;[\s\S]+COMMIT;\s*$/u);
assert.match(migration, /to_regprocedure\('public\.erp_apply_japan_package_transaction\(uuid,jsonb\)'\)/u);
assert.match(migration, /pg_get_functiondef\(procedure\.oid\)/u);
assert.match(migration, /v_overload_count IS DISTINCT FROM 1/u);
assert.match(migration, /v_argument_types\[0\] IS DISTINCT FROM 'uuid'::pg_catalog\.regtype::oid/u);
assert.match(migration, /v_argument_types\[1\] IS DISTINCT FROM 'jsonb'::pg_catalog\.regtype::oid/u);
assert.match(migration, /v_argument_names IS DISTINCT FROM ARRAY\['p_idempotency_key', 'p_request'\]::text\[\]/u);
assert.match(migration, /v_return_type IS DISTINCT FROM 'jsonb'::pg_catalog\.regtype/u);
assert.match(migration, /v_owner IS DISTINCT FROM pg_catalog\.to_regrole\(current_user\)/u);
assert.match(migration, /v_security_definer IS DISTINCT FROM true/u);
assert.match(migration, /v_config_after IS DISTINCT FROM v_config_before/u);
assert.match(migration, /NOT COALESCE\(v_config_before, ARRAY\[\]::text\[\]\) @> ARRAY\['search_path=""'\]::text\[\]/u);
assert.match(migration, /has_function_privilege\('anon', v_function_oid, 'EXECUTE'\)/u);
assert.match(migration, /has_function_privilege\('authenticated', v_function_oid, 'EXECUTE'\)/u);
assert.match(migration, /REVOKE ALL ON FUNCTION public\.erp_apply_japan_package_transaction\(uuid, jsonb\) FROM PUBLIC/u);
assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.erp_apply_japan_package_transaction\(uuid, jsonb\) TO authenticated/u);

for (const preservedContract of [
  'NOT public.is_editor(v_actor)',
  "current_setting(''request.headers'', true)",
  "targetProjectRef'') || ''.supabase.co''",
  'ON CONFLICT (actor_id, idempotency_key) DO NOTHING',
  'request_payload IS DISTINCT FROM p_request',
  "v_existing.status = ''completed''",
  'pg_advisory_xact_lock',
  'FOR UPDATE',
  "public.erp_apply_field_mutations(''japan_package_items''",
  'F3_STRUCTURED_ROLLBACK',
]) assert.match(migration, new RegExp(preservedContract.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

for (const diagnosticCode of [
  'F3_PARTIAL_RECEIVING_BASE_FUNCTION_MISSING',
  'F3_PARTIAL_RECEIVING_DEPENDENCY_MISSING',
  'F3_PARTIAL_RECEIVING_BASE_OVERLOAD_MISMATCH',
  'F3_PARTIAL_RECEIVING_BASE_SIGNATURE_MISMATCH',
  'F3_PARTIAL_RECEIVING_BASE_CONFIG_MISMATCH',
  'F3_PARTIAL_RECEIVING_BASE_ACL_MISMATCH',
  'F3_PARTIAL_RECEIVING_BASE_TRANSACTION_CONTRACT_MISMATCH',
  'F3_PARTIAL_RECEIVING_BASE_STATE_MACHINE_MISMATCH',
  'F3_PARTIAL_RECEIVING_REPLACEMENT_POSTCHECK_FAILED',
  'F3_PARTIAL_RECEIVING_POSTFLIGHT_FUNCTION_MISSING',
  'F3_PARTIAL_RECEIVING_POSTFLIGHT_CATALOG_MISMATCH',
  'F3_PARTIAL_RECEIVING_POSTFLIGHT_ACL_MISMATCH',
  'F3_PARTIAL_RECEIVING_POSTFLIGHT_TRANSACTION_MISMATCH',
]) assert.match(migration, new RegExp(diagnosticCode, 'u'));

assert.doesNotMatch(migration, /pg_get_function_(?:identity_)?arguments/u);
assert.doesNotMatch(migration, /has_table_privilege\([^)]*'ALTER'/u);
assert.doesNotMatch(migration, /rhfdjsklfrgpoqsaqpkn|twzpqyesbtnfxdkorluf|service_role/u);
assert.doesNotMatch(migration, /ALTER TABLE|CREATE TABLE|DROP TABLE|DISABLE TRIGGER|DROP FUNCTION/iu);

console.log('PASS 034 accepts exactly the applied 031 state-machine source and rejects unknown variants');
console.log('PASS 034 changes only partial-receiving derivation while preserving function config and security contract');
console.log('PASS 034 structured catalog/ACL postflight is PostgreSQL-compatible and fail-closed');
console.log('NOTE static artifact validation only; PostgreSQL apply remains pending');
