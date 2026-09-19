import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertPostgresFunctionContractMatrix,
  POSTGRES_TYPE_OIDS,
} from './helpers/postgres-function-contract-fixture.mjs';

const SQL_PATH = new URL('../supabase/sql/031_japan_package_receiving_atomic_transaction.sql', import.meta.url);
const TRANSACTION_PATH = new URL('../src/providers/cloud/japanPackageTransaction.ts', import.meta.url);
const PROVIDER_PATH = new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url);
const [SQL, transactionSource, providerSource] = await Promise.all([
  readFile(SQL_PATH, 'utf8'),
  readFile(TRANSACTION_PATH, 'utf8'),
  readFile(PROVIDER_PATH, 'utf8'),
]);

assert.match(SQL, /BEGIN;[\s\S]+COMMIT;\s*$/u);
assert.match(SQL, /to_regprocedure\('public\.erp_apply_japan_package_transaction\(uuid,jsonb\)'\)/u);
assert.match(SQL, /F3_FUNCTION_COLLISION/u);
assert.doesNotMatch(SQL, /pg_get_function_(?:identity_)?arguments/u);
assert.match(SQL, /procedure\.pronargs/u);
assert.match(SQL, /procedure\.proargtypes/u);
assert.match(SQL, /procedure\.proargnames/u);
assert.match(SQL, /v_overload_count IS DISTINCT FROM 1/u);
assert.match(SQL, /v_argument_types\[0\] IS DISTINCT FROM 'uuid'::pg_catalog\.regtype::oid/u);
assert.match(SQL, /v_argument_types\[1\] IS DISTINCT FROM 'jsonb'::pg_catalog\.regtype::oid/u);
assert.match(SQL, /v_argument_names IS DISTINCT FROM ARRAY\['p_idempotency_key', 'p_request'\]::text\[\]/u);
assert.match(SQL, /v_return_type IS DISTINCT FROM 'jsonb'::pg_catalog\.regtype/u);
assert.match(SQL, /v_owner IS DISTINCT FROM pg_catalog\.to_regrole\(current_user\)/u);
assert.match(SQL, /v_security_definer IS DISTINCT FROM true/u);
assert.match(SQL, /'search_path=' = ANY\(v_config\)/u);
assert.match(SQL, /REVOKE ALL ON FUNCTION public\.erp_apply_japan_package_transaction\(uuid, jsonb\) FROM PUBLIC/u);
assert.match(SQL, /REVOKE ALL ON FUNCTION public\.erp_apply_japan_package_transaction\(uuid, jsonb\) FROM anon/u);
assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.erp_apply_japan_package_transaction\(uuid, jsonb\) TO authenticated/u);
assert.match(SQL, /has_function_privilege\('anon', v_function_oid, 'EXECUTE'\)/u);
assert.match(SQL, /has_function_privilege\('authenticated', v_function_oid, 'EXECUTE'\)/u);

assert.match(SQL, /current_setting\('request\.headers', true\)/u);
assert.match(SQL, /v_request_host IS DISTINCT FROM \(p_request->>'targetProjectRef'\) \|\| '\.supabase\.co'/u);
assert.doesNotMatch(SQL, /rhfdjsklfrgpoqsaqpkn|twzpqyesbtnfxdkorluf|service_role/u);
assert.match(transactionSource, /targetProjectRef: string/u);
assert.doesNotMatch(transactionSource, /rhfdjsklfrgpoqsaqpkn|twzpqyesbtnfxdkorluf/u);
assert.match(providerSource, /supabaseEnvironment\.projectRef/u);

assert.match(SQL, /erp_idempotency_keys%ROWTYPE/u);
assert.match(SQL, /ON CONFLICT \(actor_id, idempotency_key\) DO NOTHING/u);
assert.match(SQL, /v_existing\.status = 'completed'/u);
assert.doesNotMatch(SQL, /status\s*=\s*'failed'|status[^\n]+failed/u);

const expectedContract = {
  schemaName: 'public',
  functionName: 'erp_apply_japan_package_transaction',
  argumentTypes: [POSTGRES_TYPE_OIDS.uuid, POSTGRES_TYPE_OIDS.jsonb],
  argumentNames: ['p_idempotency_key', 'p_request'],
  returnType: POSTGRES_TYPE_OIDS.jsonb,
  requiredConfig: ['search_path='],
};
const liveNamedArgumentCatalogFixture = {
  resolved: true,
  schemaName: 'public',
  functionName: 'erp_apply_japan_package_transaction',
  overloadCount: 1,
  argumentCount: 2,
  argumentTypes: [POSTGRES_TYPE_OIDS.uuid, POSTGRES_TYPE_OIDS.jsonb],
  argumentNames: ['p_idempotency_key', 'p_request'],
  identityArguments: 'p_idempotency_key uuid, p_request jsonb',
  returnType: POSTGRES_TYPE_OIDS.jsonb,
  kind: 'f',
  securityDefiner: true,
  ownerMatchesCurrentUser: true,
  config: ['search_path='],
  publicExecute: false,
  anonExecute: false,
  authenticatedExecute: true,
};
assertPostgresFunctionContractMatrix(assert, liveNamedArgumentCatalogFixture, expectedContract);

console.log('PASS 031 signature postflight uses structured pg_proc fields, exact names and overload count');
console.log('PASS 031 live-shaped named-argument catalog fixture and fail-closed mismatch matrix');
console.log('PASS 031 validates return type, owner, security definer, search_path and ACLs');
console.log('PASS 031 is environment-portable and binds request target to the actual Supabase host');
console.log('PASS 031 preserves the processing/completed idempotency-store contract');
console.log('NOTE static SQL artifact validation only; PostgreSQL execution remains pending');
