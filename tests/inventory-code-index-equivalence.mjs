// findMatchingInventoryItem with the SKU index returns exactly what the former full scan returned.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
try {
  const { findMatchingInventoryItem, calculateFinalMyacgDemand } = await vite.ssrLoadModule('/src/lib/db.ts');
  const legacy = (variantOrCode, inventory) => {
    if (!variantOrCode) return undefined;
    let cleanCode, raw, name;
    if (typeof variantOrCode === 'string') cleanCode = variantOrCode.trim().toUpperCase();
    else { cleanCode = (variantOrCode.myacg_item_code || '').trim().toUpperCase(); raw = variantOrCode.raw_variant_name; name = variantOrCode.variant_name; }
    if (!cleanCode) return undefined;
    const matches = inventory.filter(i => i.myacg_item_code.trim().toUpperCase() === cleanCode);
    if (!matches.length) return undefined;
    if (raw) { const m = matches.find(i => i.raw_variant_name?.trim() === raw.trim()); if (m) return m; }
    if (name) { const m = matches.find(i => i.raw_variant_name?.trim() === name.trim()); if (m) return m; }
    if (!raw && !name) return matches[0];
    return matches.find(i => !i.raw_variant_name || i.raw_variant_name.trim() === '');
  };
  let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const codes = ['a1', 'A1 ', ' b2', 'B2', 'c3', 'C3_1', 'd4', ''], specs = [undefined, '', '款 A', ' 款 A', '款 B', '眼罩'];
  const inventory = Array.from({ length: 400 }, (_, i) => ({ inventory_key: `k${i}`, myacg_item_code: codes[rnd(codes.length - 1)], raw_variant_name: specs[rnd(specs.length)], myacg_sold_quantity: i }));
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    const v = rnd(4) === 0 ? codes[rnd(codes.length)] : { myacg_item_code: codes[rnd(codes.length)], raw_variant_name: specs[rnd(specs.length)], variant_name: specs[rnd(specs.length)], effective_myacg_quantity: rnd(3) };
    assert.equal(findMatchingInventoryItem(v, inventory), legacy(v, inventory)); checked++;
    assert.equal(calculateFinalMyacgDemand(v, inventory), (() => { const m = legacy(v, inventory); if (m) return m.myacg_sold_quantity ?? 0; if (typeof v === 'object') { const e = v.effective_myacg_quantity ?? v.myacg_auto_quantity; if (e !== undefined && e !== null && e >= 0) return e; } return -1; })());
  }
  // A new inventory array (or a changed length) is re-indexed.
  const grown = [...inventory, { inventory_key: 'new', myacg_item_code: 'ZZ9', raw_variant_name: '', myacg_sold_quantity: 5 }];
  assert.equal(findMatchingInventoryItem('zz9', grown)?.inventory_key, 'new');
  inventory.push({ inventory_key: 'pushed', myacg_item_code: 'YY8', myacg_sold_quantity: 1 });
  assert.equal(findMatchingInventoryItem('yy8', inventory)?.inventory_key, 'pushed');
  console.log(JSON.stringify({ result: 'PASS', checked }));
} finally { await vite.close(); }
