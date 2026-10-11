// proveInventoryRows scheduling benchmark: old setTimeout(0) vs new budgeted
// MessageChannel, unthrottled ("foreground") and throttled ("background" model).
// Reports wall time, CPU time, yields, max synchronous slice and heap delta.
import { createServer } from 'vite';
globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
const realSetTimeout = globalThis.setTimeout;
const PENALTY_MS = Number(process.env.THROTTLE_PENALTY_MS || 1000);
let throttled = false;
globalThis.setTimeout = (fn, ms = 0, ...a) => realSetTimeout(fn, throttled ? Math.max(ms, PENALTY_MS) : ms, ...a);
try {
  const R = await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
  const { planCloudInventoryImport } = await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
  const fixture = async n => {
    const rows = Array.from({ length: n }, (_, i) => ({ id: crypto.randomUUID(), myacg_item_code: `G-BENCH-${i}`, product_title: `Bench synthetic ${i} ${'x'.repeat(40)}`,
      raw_variant_name: String(i % 7), listing_type: '', final_price: 100 + i, myacg_available_quantity: 99 - (i % 9), myacg_sold_quantity: i % 9,
      myacg_listed_at: '2026/10/11', latest_catalog_import_id: 'catalog_import_be7c0000-0000-4000-8000-000000000001', catalog_last_seen_at: '2026-10-11T01:00:00.000Z' }));
    const imported = planCloudInventoryImport([], rows).imported;
    return { imported, record: { expected: await Promise.all(imported.map(R.inventoryProof)) } };
  };
  const oldProve = async (record, rows) => {
    const byId = new Map(rows.map(row => [row.database_id || row.id, row])); let maxSync = 0, yields = 0;
    for (let offset = 0; offset < record.expected.length; offset += 150) {
      const s = performance.now();
      const p = Promise.all(record.expected.slice(offset, offset + 150).map(async expected => {
        const row = byId.get(expected.id); const proof = await R.inventoryProof(row);
        if (JSON.stringify(proof) !== JSON.stringify(expected)) throw new Error('MISMATCH');
      }));
      maxSync = Math.max(maxSync, performance.now() - s); await p;
      if (offset + 150 < record.expected.length) { await new Promise(r => setTimeout(r, 0)); yields++; }
    }
    return { yields, maxSyncMs: Math.round(maxSync * 10) / 10 };
  };
  const measure = async fn => {
    global.gc?.(); const h0 = process.memoryUsage().heapUsed; const c0 = process.cpuUsage(); const t0 = performance.now();
    const r = await fn(); const wall = performance.now() - t0; const c = process.cpuUsage(c0);
    return { wallMs: Math.round(wall), cpuMs: Math.round((c.user + c.system) / 1000), heapDeltaMB: +((process.memoryUsage().heapUsed - h0) / 1048576).toFixed(1), ...r };
  };
  const out = [];
  for (const n of [500, 1600, 5000, 10000]) {
    const { imported, record } = await fixture(n);
    await R.proveInventoryRows(record, imported); // warm JIT once per size
    const row = { rows: n };
    for (const bg of [false, true]) {
      const tag = bg ? 'background' : 'foreground';
      const reps = 3; const neu = []; const old = [];
      for (let i = 0; i < reps; i++) { throttled = bg; neu.push(await measure(() => R.proveInventoryRows(record, imported))); throttled = false; }
      // Old strategy under the 1 s background model costs yields*1 s; measure it for <=1600, model it above.
      if (!bg || n <= 1600) for (let i = 0; i < (bg ? 1 : reps); i++) { throttled = bg; old.push(await measure(() => oldProve(record, imported))); throttled = false; }
      const med = a => [...a].sort((x, y) => x.wallMs - y.wallMs)[Math.floor(a.length / 2)];
      row[tag] = { new: med(neu), old: old.length ? med(old) : { modeledWallMs: Math.ceil(n / 150 - 1) * PENALTY_MS, yields: Math.ceil(n / 150) - 1 } };
    }
    out.push(row); console.error(JSON.stringify(row));
  }
  console.log(JSON.stringify({ result: 'PASS', throttlePenaltyMs: PENALTY_MS, out }, null, 1));
} finally { globalThis.setTimeout = realSetTimeout; await vite.close(); }
