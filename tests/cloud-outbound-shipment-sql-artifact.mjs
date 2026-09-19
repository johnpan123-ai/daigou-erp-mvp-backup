import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertPostgresFunctionDiagnosticMatrix,
  LIVE_STAGING_CATALOG_REFERENCES,
  POSTGRES_TYPE_OIDS,
  retargetLiveCatalog,
} from './helpers/postgres-function-contract-fixture.mjs';

const SQL = await readFile(new URL('../supabase/sql/032_outbound_shipment_atomic_delete.sql', import.meta.url), 'utf8');
assert.match(SQL, /BEGIN;[\s\S]+COMMIT;\s*$/u);
assert.match(SQL, /to_regprocedure\('public\.erp_apply_outbound_shipment_transaction\(uuid,jsonb\)'\)/u);
assert.match(SQL, /F4_OUTBOUND_RPC_ALREADY_EXISTS/u);
assert.match(SQL, /SECURITY DEFINER[\s\S]+SET search_path = ''[\s\S]+SET statement_timeout = '15s'/u);
assert.match(SQL, /NOT public\.is_editor\(v_actor\)/u);
assert.match(SQL, /current_setting\('request\.headers', true\)/u);
assert.match(SQL, /v_request_host IS DISTINCT FROM \(p_request->>'targetProjectRef'\) \|\| '\.supabase\.co'/u);
assert.doesNotMatch(SQL, /rhfdjsklfrgpoqsaqpkn|twzpqyesbtnfxdkorluf|service_role/u);
assert.match(SQL, /v_requested_item_ids IS DISTINCT FROM v_active_item_ids/u);
assert.match(SQL, /erp_apply_field_mutations\('outbound_shipment_items'/u);
assert.match(SQL, /erp_apply_field_mutations\('outbound_shipments'/u);
assert.ok(SQL.indexOf("erp_apply_field_mutations('outbound_shipment_items'") < SQL.indexOf("erp_apply_field_mutations('outbound_shipments'"));
assert.match(SQL, /ON CONFLICT \(actor_id, idempotency_key\) DO NOTHING/u);
assert.match(SQL, /request_payload IS DISTINCT FROM p_request/u);
assert.match(SQL, /canonical_result/u);
assert.match(SQL, /REVOKE ALL ON FUNCTION public\.erp_apply_outbound_shipment_transaction\(uuid, jsonb\) FROM PUBLIC/u);
assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.erp_apply_outbound_shipment_transaction\(uuid, jsonb\) TO authenticated/u);
assert.doesNotMatch(SQL, /pg_get_function_(?:identity_)?arguments/u);
assert.match(SQL, /function_record\.pronargs/u);
assert.match(SQL, /function_record\.proargtypes/u);
assert.match(SQL, /function_record\.proargnames/u);
assert.match(SQL, /v_overload_count IS DISTINCT FROM 1/u);
assert.match(SQL, /v_argument_types\[0\] IS DISTINCT FROM 'uuid'::pg_catalog\.regtype::oid/u);
assert.match(SQL, /v_argument_types\[1\] IS DISTINCT FROM 'jsonb'::pg_catalog\.regtype::oid/u);
assert.match(SQL, /v_argument_names IS DISTINCT FROM ARRAY\['p_idempotency_key', 'p_request'\]::text\[\]/u);
assert.match(SQL, /v_security_definer IS DISTINCT FROM true/u);
assert.match(SQL, /v_public_execute/u);
assert.match(SQL, /v_search_path_values IS DISTINCT FROM ARRAY\['""'\]::text\[\]/u);
assert.match(SQL, /v_statement_timeout_values IS DISTINCT FROM ARRAY\['15s'\]::text\[\]/u);
assert.doesNotMatch(SQL, /F4_OUTBOUND_POSTFLIGHT_FUNCTION_CONTRACT_MISMATCH|F4_OUTBOUND_POSTFLIGHT_ACL_MISMATCH/u);
for (const diagnosticCode of [
  'F4_OUTBOUND_POSTFLIGHT_SIGNATURE_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_OVERLOAD_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_ARG_COUNT_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_ARG_TYPES_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_ARG_NAMES_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_RETURN_TYPE_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_KIND_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_OWNER_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_SECURITY_DEFINER_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_SEARCH_PATH_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_TIMEOUT_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_PUBLIC_ACL_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_ANON_ACL_MISMATCH',
  'F4_OUTBOUND_POSTFLIGHT_AUTHENTICATED_ACL_MISMATCH',
]) assert.match(SQL, new RegExp(diagnosticCode, 'u'));
assert.doesNotMatch(SQL, /ALTER TABLE public\.(?:outbound_shipments|outbound_shipment_items)|DISABLE TRIGGER|DROP POLICY/u);

const expectedContract = {
  schemaName: 'public',
  functionName: 'erp_apply_outbound_shipment_transaction',
  argumentTypes: [POSTGRES_TYPE_OIDS.uuid, POSTGRES_TYPE_OIDS.jsonb],
  argumentNames: ['p_idempotency_key', 'p_request'],
  returnType: POSTGRES_TYPE_OIDS.jsonb,
  configValues: { search_path: '""', statement_timeout: '15s' },
};
const diagnosticCodes = {
  signatureMissing: 'F4_OUTBOUND_POSTFLIGHT_FUNCTION_MISSING',
  signature: 'F4_OUTBOUND_POSTFLIGHT_SIGNATURE_MISMATCH',
  overload: 'F4_OUTBOUND_POSTFLIGHT_OVERLOAD_MISMATCH',
  argumentCount: 'F4_OUTBOUND_POSTFLIGHT_ARG_COUNT_MISMATCH',
  argumentTypes: 'F4_OUTBOUND_POSTFLIGHT_ARG_TYPES_MISMATCH',
  argumentNames: 'F4_OUTBOUND_POSTFLIGHT_ARG_NAMES_MISMATCH',
  returnType: 'F4_OUTBOUND_POSTFLIGHT_RETURN_TYPE_MISMATCH',
  kind: 'F4_OUTBOUND_POSTFLIGHT_KIND_MISMATCH',
  owner: 'F4_OUTBOUND_POSTFLIGHT_OWNER_MISMATCH',
  securityDefiner: 'F4_OUTBOUND_POSTFLIGHT_SECURITY_DEFINER_MISMATCH',
  config: {
    search_path: 'F4_OUTBOUND_POSTFLIGHT_SEARCH_PATH_MISMATCH',
    statement_timeout: 'F4_OUTBOUND_POSTFLIGHT_TIMEOUT_MISMATCH',
  },
  publicAcl: 'F4_OUTBOUND_POSTFLIGHT_PUBLIC_ACL_MISMATCH',
  anonAcl: 'F4_OUTBOUND_POSTFLIGHT_ANON_ACL_MISMATCH',
  authenticatedAcl: 'F4_OUTBOUND_POSTFLIGHT_AUTHENTICATED_ACL_MISMATCH',
};
const liveShapedCatalogFixture = retargetLiveCatalog(
  LIVE_STAGING_CATALOG_REFERENCES.purchaseBatch,
  expectedContract,
);
assertPostgresFunctionDiagnosticMatrix(
  assert,
  liveShapedCatalogFixture,
  expectedContract,
  diagnosticCodes,
);

console.log('PASS 032 transaction, owner, target, exact-child-scope, CAS/idempotency and ACL artifact contract');
console.log('PASS 032 calibrated Live-shaped catalog fixture and per-predicate diagnostic matrix');
console.log('NOTE static SQL validation only; PostgreSQL apply remains pending');
