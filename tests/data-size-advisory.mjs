import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourceUrl = new URL('../src/lib/dataSizeAdvisory.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const load = nonce => import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${nonce}`);

const advisory = await load('settings-only');
let notifications = 0;
const unsubscribe = advisory.subscribeDataSizeObservations(() => { notifications += 1; });
advisory.checkDataSizeWarnings({ product_variants: 3074 }, 'owner');
assert.deepEqual(advisory.getDataSizeObservations(), [
  { table: 'product_variants', count: 3074, threshold: 3000 },
]);
assert.equal(notifications, 1);
advisory.checkDataSizeWarnings({ product_variants: 3074 }, 'owner');
assert.equal(notifications, 1, 'Same observation must not churn Settings');
advisory.checkDataSizeWarnings({ product_variants: 2999 }, 'owner');
assert.deepEqual(advisory.getDataSizeObservations(), []);
assert.equal(notifications, 2);
advisory.checkDataSizeWarnings({ product_variants: 9999 }, 'staff');
assert.deepEqual(advisory.getDataSizeObservations(), [], 'Non-owner observations are not exposed');
unsubscribe();

assert.deepEqual(advisory.DATA_SIZE_THRESHOLDS, {
  product_variants: 3000,
  purchase_batch_items: 5000,
  private_order_items: 3000,
  sales_order_items: 5000,
});
assert.doesNotMatch(source, /createElement|position:\s*'fixed'|sessionStorage/u,
  'Normal operation must not create a bottom-right data-size toast');
const settingsSource = await readFile(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8');
assert.match(settingsSource, /系統健康/u);
assert.match(settingsSource, /getDataSizeObservations/u);
const providerSource = await readFile(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8');
assert.ok(providerSource.includes('checkDataSizeWarnings({'));

console.log('PASS data-size observation is Settings-only, owner-only, non-blocking, and has no toast');
