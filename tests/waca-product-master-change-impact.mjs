import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertReviewedProviderContract, classifyDescendantFile } from '../scripts/post-adoption-descendant.mjs';

const base = '0fca8fd13ad90cc59fc73443f5eba9a1663341b0';
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const changed = git(['diff', '--name-only', '--no-renames', base, '--']).trim().split(/\r?\n/u).filter(Boolean);

assert.equal(changed.some(file => file.startsWith('supabase/sql/') || file.startsWith('migrations/')), false);
assert.equal(changed.includes('src/lib/durableResourceRegistry.ts'), false);
assert.equal(changed.some(file => file.startsWith('tools/schema-reconciliation/')), false);
const catalog = readFileSync('src/providers/cloud/catalogTransaction.ts', 'utf8');
const beforeCatalog = git(['show', `${base}:src/providers/cloud/catalogTransaction.ts`]);
assert.equal(catalog.match(/CATALOG_RPC\s*=\s*['"]([^'"]+)/u)?.[1],
  beforeCatalog.match(/CATALOG_RPC\s*=\s*['"]([^'"]+)/u)?.[1]);
assert.match(catalog, /mode:mode==='master'\?'sync':mode/u, 'master planner must use the adopted sync wire mode');
assert.doesNotMatch(catalog, /CATALOG_RPC\s*=\s*['"](?!erp_apply_catalog_transaction)/u);
assert.doesNotThrow(() => assertReviewedProviderContract(
  'src/providers/cloud/catalogTransaction.ts', beforeCatalog, catalog));
assert.throws(() => assertReviewedProviderContract(
  'src/providers/cloud/catalogTransaction.ts', beforeCatalog,
  catalog.replace("mode:mode==='master'?'sync':mode", "mode:mode==='master'?'create':mode")),
/adopted sync wire contract/u);
const provider = readFileSync('src/providers/cloud/supabaseProvider.ts', 'utf8');
assert.match(provider, /commitCatalog\('master',itemCodes\)/u);
assert.doesNotMatch(provider, /erp_apply_product_master|p_master_request/u,
  'no new Product Master RPC or payload contract is permitted');
const providerTypes = readFileSync('src/providers/types.ts', 'utf8');
const beforeProviderTypes = git(['show', `${base}:src/providers/types.ts`]);
assert.doesNotThrow(() => assertReviewedProviderContract('src/providers/types.ts', beforeProviderTypes, providerTypes));
assert.throws(() => assertReviewedProviderContract('src/providers/types.ts', beforeProviderTypes,
  providerTypes.replace('ensureProductMasterFromInventory(itemCodes: string[]): Promise<void>;',
    'ensureProductMasterFromInventory(itemCodes: string[]): Promise<{ durableField: string }>;')),
/provider interface contract changed|unreviewed provider interface member changed/u);
const domain = readFileSync('src/waca/orderCore.ts', 'utf8');
assert.doesNotMatch(domain, /PurchaseBatch|purchaseRecords|purchase_record/u,
  'WACA resolution must not depend on Purchase Records');
const page = readFileSync('src/pages/WacaIntegration.tsx', 'utf8');
assert.match(page, /pendingItems = nextSnapshot\.items\.filter/u);
assert.match(page, /ensureProductMasterFromInventory/u);
assert.match(page, /commitAndVerifyWacaRematch/u);
assert.match(page, /relevantLinks/u, 'page-load repair must remain pending-scoped');

for (const file of ['supabase/sql/056_future.sql', 'src/lib/durableResourceRegistry.ts',
  'tools/schema-reconciliation/schemaContract.mjs', 'src/providers/cloud/unreviewedProductMaster.ts']) {
  assert.equal(classifyDescendantFile(file, null, 'future required persistence contract'),
    'SCHEMA_SENSITIVE_OR_UNREVIEWED');
}

console.log('PASS Product Master resolver exact review: existing Catalog sync RPC/fields only, no schema/registry change');
console.log('PASS Purchase Records decoupled, pending-scoped page repair, future provider/schema/registry changes fail closed');
