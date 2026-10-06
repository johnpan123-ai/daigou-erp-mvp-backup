import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { CANONICAL_FRESH_INSTALL_V3, ERP2_MIGRATION_SOURCE_ORDER_V3 } from '../supabase/canonicalFreshInstallV3.mjs';

const migration=readFileSync('supabase/sql/056_catalog_materialized_purchase_projection.sql','utf8');
const previous=readFileSync('supabase/sql/050_catalog_atomic_transaction.sql','utf8');
assert.ok(CANONICAL_FRESH_INSTALL_V3.includes('056_catalog_materialized_purchase_projection.sql'));
assert.ok(ERP2_MIGRATION_SOURCE_ORDER_V3.includes('056_catalog_materialized_purchase_projection.sql'));
assert.match(migration,/inventory_import/u);
assert.match(migration,/myacg_order_import/u);
assert.match(migration,/p_request->>'mode'='create'/u);
assert.match(migration,/show_in_purchase_list/u);
assert.match(migration,/CATALOG_PROVENANCE_TRANSITION_FORBIDDEN/u);
assert.match(migration,/REVOKE ALL[^;]+PUBLIC,anon/iu);
assert.match(migration,/GRANT EXECUTE[^;]+authenticated/iu);
assert.match(migration,/SECURITY DEFINER SET search_path=''/u);
assert.doesNotMatch(migration,/CREATE\s+TABLE|ALTER\s+TABLE|ADD\s+COLUMN|DROP\s+COLUMN/iu);
assert.match(previous,/CATALOG_MANUAL_METADATA_FORBIDDEN/u);
assert.doesNotMatch(previous,/CATALOG_PROVENANCE_TRANSITION_FORBIDDEN/u,'050 history was retroactively modified');

globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false}});
try{
  const {classifyCatalogRpcError,catalogCanonicalResultError,CatalogOperationError}=await vite.ssrLoadModule('/src/providers/cloud/catalogTransaction.ts');
  const requestId='11111111-1111-4111-8111-111111111111';
  const protectedError=classifyCatalogRpcError({code:'22023',message:'CATALOG_PROVENANCE_TRANSITION_FORBIDDEN'},requestId);
  assert.ok(protectedError instanceof CatalogOperationError);
  assert.equal(protectedError.category,'CATALOG_PROTECTED_METADATA_ERROR');
  assert.match(protectedError.message,/22023/u); assert.match(protectedError.message,/CATALOG_PROVENANCE_TRANSITION_FORBIDDEN/u);
  assert.doesNotMatch(protectedError.message,/\[object Object\]/u);

  const validation=classifyCatalogRpcError({code:'22023',message:'CATALOG_INVALID_REQUEST'},requestId);
  assert.equal(validation.category,'CATALOG_VALIDATION_ERROR');
  const auth=classifyCatalogRpcError({code:'42501',message:'CATALOG_FORBIDDEN'},requestId);
  assert.equal(auth.category,'AUTH_PERMISSION_ERROR');
  const unknown=classifyCatalogRpcError({message:'Failed to fetch'},requestId);
  assert.equal(unknown.category,'COMMIT_UNKNOWN');
  assert.match(unknown.message,/NETWORK_ERROR/u);
  const network=classifyCatalogRpcError({code:'NETWORK_ERROR',message:'offline before send'},requestId);
  assert.equal(network.category,'NETWORK_ERROR');
  const readback=classifyCatalogRpcError({code:'PGRST000',message:'read timeout'},requestId,'readback');
  assert.equal(readback.category,'READBACK_FAILED');
  const stale=catalogCanonicalResultError('FIELD_CONFLICT',requestId);
  assert.equal(stale.category,'STALE_CONFLICT');
  const rejected=catalogCanonicalResultError('TRANSACTION_REJECTED',requestId);
  assert.equal(rejected.category,'COMMIT_REJECTED');
  for(const error of [validation,auth,unknown,network,readback,stale,rejected]){
    assert.match(error.message,/requestId=/u);
    assert.doesNotMatch(error.message,/\[object Object\]/u);
  }
  console.log('PASS guarded Catalog projection migration scope/history/ACL/search_path/fresh chain');
  console.log('PASS Catalog validation/protected/stale/rejected/unknown/readback/auth structured errors; [object Object]=0');
} finally { await vite.close(); }
