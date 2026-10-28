import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
try {
  const { fetchPartitionedKeyset } = await vite.ssrLoadModule('/src/providers/cloud/cloudKeysetParallel.ts');
  // Server model: rows ordered by key (string compare = test collation), PostgREST-like 1000-row cap.
  const makeServer = (count, latency = 0) => {
    let keys = Array.from({ length: count }, (_, i) => `k${String(i * 7).padStart(7, '0')}`);
    const metrics = { requests: 0, probes: 0, rowsSent: 0, inFlight: 0, maxInFlight: 0 };
    const sleep = () => latency ? new Promise(r => setTimeout(r, latency)) : Promise.resolve();
    const wrap = async fn => { metrics.requests++; metrics.inFlight++; metrics.maxInFlight = Math.max(metrics.maxInFlight, metrics.inFlight); await sleep(); try { return fn(); } finally { metrics.inFlight--; } };
    return {
      metrics, mutate: fn => { keys = fn(keys).sort(); },
      snapshot: () => [...keys],
      page: request => wrap(() => {
        let rows = keys.filter(k => (request.gt == null || k > request.gt) && (request.gte == null || k >= request.gte) && (request.lt == null || k < request.lt));
        const count = rows.length;
        rows = rows.slice(0, Math.min(request.limit, 1000)).map(key => ({ key }));
        metrics.rowsSent += rows.length;
        return { rows, count: request.count ? keys.length : null };
      }),
      probe: (afterKey, offset) => wrap(() => { metrics.probes++; return keys.filter(k => k > afterKey)[offset] ?? null; }),
      sequential: async () => { const out = []; let gt = null; for (;;) { const { rows } = await wrap(() => ({ rows: keys.filter(k => gt == null || k > gt).slice(0, 1000).map(key => ({ key })) })); out.push(...rows); if (rows.length < 1000) return out; gt = rows.at(-1).key; } },
    };
  };
  const read = server => fetchPartitionedKeyset({ keyColumn: 'key', page: server.page, probe: server.probe });

  // 1. Identical rows and order to the sequential keyset scan, every size boundary.
  for (const size of [0, 1, 999, 1000, 1001, 1998, 2500, 3500, 6250, 9500]) {
    const server = makeServer(size);
    const rows = (await read(server)).map(row => row.key);
    assert.deepEqual(rows, server.snapshot(), `size ${size}`);
  }
  console.log('PASS partitioned read returns identical rows/order for 0..9500 rows');

  // 2. Concurrent inserts/deletes after probing: every row present throughout is still read.
  {
    const server = makeServer(6250);
    const stable = server.snapshot().filter((_, i) => i % 3 !== 0);
    const originalProbe = server.probe;
    let mutated = false;
    server.probe = async (afterKey, offset) => {
      const key = await originalProbe(afterKey, offset);
      if (!mutated) { mutated = true; server.mutate(keys => [...keys.filter((_, i) => i % 3 !== 0), ...Array.from({ length: 400 }, (_, i) => `k${String(i * 7 + 3).padStart(7, '0')}`)]); }
      return key;
    };
    const rows = new Set((await read(server)).map(row => row.key));
    for (const key of stable) assert.ok(rows.has(key), `row ${key} existed throughout and must be read`);
    assert.equal(rows.size, new Set(rows).size);
  }
  console.log('PASS concurrent inserts/deletes never skip rows that existed throughout the read');

  // 3. Non-monotonic boundaries (empty bounded range) fall back to a sequential scan.
  {
    const server = makeServer(4000);
    server.probe = async (afterKey, offset) => (offset === 999 ? 'k0026000' : 'k0013000');
    const rows = (await read(server)).map(row => row.key);
    assert.deepEqual(rows, server.snapshot());
  }
  console.log('PASS non-monotonic probe boundaries fall back to the sequential scan');

  // 4. Simulated live latency (358 ms average per page, measured on ERP2 preview).
  const timed = async (fn, server) => { const t = performance.now(); await fn(server); return Math.round(performance.now() - t); };
  const results = {};
  for (const [name, size] of [['inventory_items', 6250], ['product_variants', 3500], ['purchase_batch_items', 2500], ['product_groups', 815]]) {
    const seqServer = makeServer(size, 358);
    const seqMs = await timed(s => s.sequential(), seqServer);
    const parServer = makeServer(size, 358);
    const parMs = await timed(read, parServer);
    results[name] = { rows: size, sequential: { ms: seqMs, requests: seqServer.metrics.requests, rows: seqServer.metrics.rowsSent || size },
      partitioned: { ms: parMs, requests: parServer.metrics.requests, probes: parServer.metrics.probes, dataRows: parServer.metrics.rowsSent, maxInFlight: parServer.metrics.maxInFlight } };
    assert.equal(parServer.metrics.rowsSent, size, `${name}: no row transferred twice`);
    if (size > 3000) assert.ok(parMs < seqMs, `${name}: must be faster`);
    else if (size > 1000) assert.ok(parServer.metrics.requests === seqServer.metrics.requests && parServer.metrics.probes === 0, `${name}: 2-3 page tables keep the sequential scan`);
    else assert.equal(parServer.metrics.requests, 1, `${name}: small tables stay one request`);
    assert.ok(parServer.metrics.maxInFlight <= 7, `${name}: bounded concurrency`);
  }
  console.log(JSON.stringify(results));
  console.log('PASS simulated latency: faster for multi-page tables, same data rows, small tables unchanged');
} finally { await vite.close(); }
