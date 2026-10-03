import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false } });
try {
  const { readCloudRowsByIds: read, bulkReadUrl, bulkReadUrlBytes, CLOUD_BULK_READ_POLICY } = await vite.ssrLoadModule('/src/providers/cloud/cloudBulkRead.ts');
  const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const scales = [];
  for (const count of [100,500,1505,5000,10000]) {
    const ids = Array.from({ length: count }, (_, n) => uuid(n));
    const metrics = [];
    const calls = new Map();
    let active = 0, maxActive = 0;
    const started = performance.now();
    const rows = await read({ ids: [...ids, ids[0]], table: 'inventory_items', onChunk: metric => metrics.push(metric),
      load: async chunk => {
        active++; maxActive = Math.max(maxActive, active);
        calls.set(chunk[0], (calls.get(chunk[0]) || 0) + 1);
        await new Promise(resolve => setTimeout(resolve, 2));
        active--;
        return [...chunk].reverse().map(id => ({ id, inventory_key: 'key:' + id }));
      } });
    assert.deepEqual(rows.map(row => row.id), ids, 'Request identity order, not response order');
    assert.ok(maxActive <= CLOUD_BULK_READ_POLICY.concurrency);
    assert.ok(metrics.every(m => m.urlBytes <= 7000 && m.ids <= 150));
    assert.ok([...calls.values()].every(n => n === 1));
    scales.push({ ids: count, chunks: metrics.length, maxUrlBytes: Math.max(...metrics.map(m => m.urlBytes)),
      totalMs: Math.round(performance.now() - started), largestChunkMs: Math.round(Math.max(...metrics.map(m => m.latencyMs))) });
  }
  const ids = Array.from({ length: 500 }, (_, n) => uuid(n));
  const calls = new Map();
  await read({ ids, table: 'inventory_items', policy: { retryDelayMs: 0 },
    load: async chunk => {
      const attempt = (calls.get(chunk[0]) || 0) + 1; calls.set(chunk[0], attempt);
      if (chunk[0] === uuid(150) && attempt === 1) throw new TypeError('Failed to fetch');
      return chunk.map(id => ({ id }));
    } });
  assert.equal(calls.get(uuid(150)), 2);
  assert.equal(calls.get(uuid(0)), 1); assert.equal(calls.get(uuid(300)), 1);
  for (const [kind, load, code] of [
    ['missing', async chunk => chunk.slice(1).map(id => ({ id })), 'MISSING_ID'],
    ['duplicate', async chunk => [...chunk, chunk[0]].map(id => ({ id })), 'DUPLICATE_ID'],
    ['unexpected', async chunk => [...chunk, uuid(50001)].map(id => ({ id })), 'UNEXPECTED_ID'],
    ['field', async chunk => chunk.map(id => ({ id, inventory_key: 'wrong' })), 'FIELD_MISMATCH'],
  ]) {
    await assert.rejects(() => read({ table: 'inventory_items', ids: ids.slice(0, 10), load,
      expected: kind === 'field' ? new Map(ids.map(id => [id, { inventory_key: 'key:' + id }])) : undefined }), new RegExp(code));
  }
  let attempts = 0;
  await assert.rejects(() => read({ table: 'inventory_items', ids: [ids[0]], policy: { retryDelayMs: 0 },
    load: async () => { attempts++; throw { status: 503, message: 'unavailable' }; } }));
  assert.equal(attempts, 3, 'Bounded retry; never mutation');
  attempts = 0;
  await assert.rejects(() => read({ table: 'inventory_items', ids: [ids[0]],
    load: async () => { attempts++; throw { status: 400, message: 'Bad Request' }; } }));
  assert.equal(attempts, 1, 'No retry on schema/transport-size rejection');
  assert.deepEqual(await read({ table: 'inventory_items', ids: [ids[0]], allowMissing: new Set([ids[0]]), load: async () => [] }), []);
  await assert.rejects(() => read({ table: 'inventory_items', ids: [ids[0]], signal: AbortSignal.abort(), load: async () => [] }));
  const shortened = [];
  await read({ table: 'inventory_items', ids, policy: { maxUrlBytes: 1200 }, onChunk: m => shortened.push(m),
    load: async chunk => chunk.map(id => ({ id })) });
  assert.ok(shortened.every(m => m.urlBytes <= 1200));
  const before = bulkReadUrlBytes(bulkReadUrl('inventory_items', Array.from({length:1505}, (_,n) => uuid(n)),
    '*','https://rhfdjsklfrgpoqsaqpkn.supabase.co/rest/v1/'));
  console.log(JSON.stringify({ result: 'PASS', transportPolicy: CLOUD_BULK_READ_POLICY,
    beforeMaxUrlBytes: before, scales, singleFailedChunkOnlyRetry: true, strictMissingDuplicateUnexpectedFields: true }));
} finally { await vite.close(); }
