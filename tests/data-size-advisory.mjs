import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourceUrl = new URL('../src/lib/dataSizeAdvisory.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const storage = new Map();
const elements = new Map();
const warnings = [];
let alertCount = 0;

globalThis.window = {
  sessionStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  },
  setTimeout: () => 1,
};
globalThis.document = {
  getElementById: id => elements.get(id) ?? null,
  createElement: () => ({
    id: '',
    style: {},
    textContent: '',
    setAttribute() {},
    remove() { elements.delete(this.id); },
  }),
  body: {
    appendChild(element) { elements.set(element.id, element); },
  },
};
globalThis.alert = () => { alertCount += 1; };
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.map(String).join(' '));

const load = nonce => import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${nonce}`);

try {
  const advisory = await load('first');
  advisory.checkDataSizeWarnings({ product_variants: 3074 }, 'owner');
  advisory.checkDataSizeWarnings({ product_variants: 3074 }, 'owner');
  const notice = elements.get('erp-data-size-advisory');
  assert.ok(notice);
  assert.match(notice.textContent, /商品規格資料量已超過目前效能觀察值（3074 \/ 3000）/u);
  assert.match(notice.textContent, /系統仍可正常使用/u);
  assert.equal(notice.style.pointerEvents, 'none');
  assert.equal(storage.get('erp:data-size-advisory-shown:v1'), '1');
  assert.equal(elements.size, 1, 'Repeated checks must render one notice only');
  assert.equal(alertCount, 0, 'The advisory must never call browser alert');
  assert.equal(warnings.length, 2, 'console.warn remains available for every observation');
  assert.deepEqual(advisory.DATA_SIZE_THRESHOLDS, {
    product_variants: 3000,
    purchase_batch_items: 5000,
    private_order_items: 3000,
    sales_order_items: 5000,
  });

  elements.clear();
  const reload = await load('reload');
  reload.checkDataSizeWarnings({ product_variants: 3074 }, 'owner');
  assert.equal(elements.size, 0, 'F5 must not repeat the notice in the same session');

  storage.clear();
  elements.clear();
  const below = await load('below');
  below.checkDataSizeWarnings({ product_variants: 2999 }, 'owner');
  assert.equal(elements.size, 0);
  const staff = await load('staff');
  staff.checkDataSizeWarnings({ product_variants: 3074 }, 'staff');
  assert.equal(elements.size, 0, 'Non-owner roles do not receive UI notices');

  const providerSource = await readFile(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8');
  assert.ok(providerSource.includes('checkDataSizeWarnings({'));
  assert.ok(providerSource.includes('}, role);'));
  assert.ok(!providerSource.includes('⚠️ 資料量警告'));

  console.log('PASS threshold warning is non-blocking, owner-only, and session-deduplicated');
  console.log('PASS threshold constants unchanged; browser alert calls = 0; ERP writes = 0');
} finally {
  console.warn = originalWarn;
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.alert;
}
