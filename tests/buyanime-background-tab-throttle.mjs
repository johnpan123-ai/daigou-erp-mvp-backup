// BACKGROUND_TAB_TIMER_THROTTLE regression.
// Live evidence (2026-10-11): in a hidden tab, 10 chained setTimeout(0) yields in
// proveInventoryRows turned ~20 s of work into a 127.5 s T15->T16 idle. This test
// models hidden-tab timer throttling and proves:
//  - the old setTimeout strategy is dragged by the throttle (regression catcher),
//  - the new strategy is not, with identical proof results,
//  - visibility changes neither skip, repeat nor double-run the proof,
//  - small inputs do not yield at all; large inputs yield a bounded number of times.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
globalThis.indexedDB = { open: () => ({}) };
globalThis.window = { indexedDB: globalThis.indexedDB, location: { hostname: '127.0.0.1' }, localStorage: { getItem: () => null } };
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
const report = [];
const realSetTimeout = globalThis.setTimeout;
const PENALTY_MS = Number(process.env.THROTTLE_PENALTY_MS || 250);
let throttled = false; let timerCalls = 0;
// Hidden-tab model: every timer callback is delayed by at least PENALTY_MS.
globalThis.setTimeout = (fn, ms = 0, ...args) => { timerCalls++; return realSetTimeout(fn, throttled ? Math.max(ms, PENALTY_MS) : ms, ...args); };
let digestCalls = 0;
const subtle = globalThis.crypto.subtle; const realDigest = subtle.digest.bind(subtle);
subtle.digest = (...args) => { digestCalls++; return realDigest(...args); };
try {
  const R = await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
  const Y = R;
  const { planCloudInventoryImport } = await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
  const batch = 'catalog_import_7e57a000-0000-4000-8000-00000000b6b6';
  const fixture = async n => {
    const rows = Array.from({ length: n }, (_, i) => ({ id: crypto.randomUUID(), myacg_item_code: `G-SYN-${i}`, product_title: `Synthetic throttle ${i}`,
      raw_variant_name: String(i % 7), listing_type: '', final_price: 100 + i, myacg_available_quantity: 99 - (i % 9), myacg_sold_quantity: i % 9,
      myacg_listed_at: '2026/10/11', latest_catalog_import_id: batch, catalog_last_seen_at: '2026-10-11T01:00:00.000Z' }));
    const imported = planCloudInventoryImport([], rows).imported;
    const expected = await Promise.all(imported.map(R.inventoryProof));
    return { imported, record: { batchId: batch, expected } };
  };
  // Exact copy of the pre-fix scheduling (proof semantics identical).
  const oldProve = async (record, rows) => {
    const byId = new Map(rows.map(row => [row.database_id || row.id, row]));
    for (let offset = 0; offset < record.expected.length; offset += 150) {
      await Promise.all(record.expected.slice(offset, offset + 150).map(async expected => {
        const row = byId.get(expected.id);
        const proof = await R.inventoryProof(row);
        if (!row || JSON.stringify(proof) !== JSON.stringify(expected)) throw new Error('BUYANIME_READBACK_IDENTITY_OR_FIELDS_MISMATCH');
      }));
      if (offset + 150 < record.expected.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
  const time = async fn => { const t = performance.now(); const r = await fn(); return { ms: Math.round(performance.now() - t), r }; };

  // 1. Regression catcher: 1600 rows, throttled timers.
  {
    const { imported, record } = await fixture(1600);
    throttled = true;
    const before = timerCalls; const old = await time(() => oldProve(record, imported)); const oldTimers = timerCalls - before;
    const t2 = timerCalls; const neu = await time(() => R.proveInventoryRows(record, imported)); const newTimers = timerCalls - t2;
    throttled = false;
    assert.equal(oldTimers, 10, 'old strategy uses 10 timer yields for 1600 rows');
    assert.ok(old.ms >= 10 * PENALTY_MS * 0.9, `old strategy must be dragged by throttle (${old.ms} ms)`);
    assert.equal(newTimers, 0, 'new strategy must not schedule any timer');
    assert.ok(neu.ms < PENALTY_MS, `new strategy must not pay the throttle (${neu.ms} ms)`);
    assert.ok(neu.r.yields <= neu.r.chunks - 1 && neu.r.chunks === 11);
    report.push({ case: 'throttle-1600', penaltyMs: PENALTY_MS, oldMs: old.ms, newMs: neu.ms, oldTimers, newTimers, newYields: neu.r.yields, maxSyncMs: neu.r.maxSyncMs, ratio: +(old.ms / Math.max(1, neu.ms)).toFixed(1) });
  }
  // 2. Correctness identical to the old strategy (pass + every failure class).
  {
    const { imported, record } = await fixture(400);
    await R.proveInventoryRows(record, imported);
    await oldProve(record, imported);
    const tampered = imported.map((row, i) => i === 333 ? { ...row, myacg_sold_quantity: row.myacg_sold_quantity + 1 } : row);
    await assert.rejects(() => R.proveInventoryRows(record, tampered), e => e.code === 'BUYANIME_READBACK_IDENTITY_OR_FIELDS_MISMATCH');
    await assert.rejects(() => oldProve(record, tampered), /MISMATCH/);
    await assert.rejects(() => R.proveInventoryRows(record, imported.slice(1)), e => e.code === 'BUYANIME_READBACK_COUNT_MISMATCH');
    await assert.rejects(() => R.proveInventoryRows(record, [...imported.slice(1), imported[2]]), e => e.code === 'BUYANIME_READBACK_DUPLICATE_ID');
    const foreign = imported.map((row, i) => i === 7 ? { ...row, id: crypto.randomUUID() } : row);
    await assert.rejects(() => R.proveInventoryRows(record, foreign), e => e.code === 'BUYANIME_READBACK_IDENTITY_OR_FIELDS_MISMATCH');
    report.push({ case: 'correctness-identical', pass: true });
  }
  // 3. Visibility transitions: proof runs exactly once per row, never skipped or doubled.
  for (const mode of ['visible', 'hidden', 'hidden->visible', 'visible->hidden->visible']) {
    const { imported, record } = await fixture(1600);
    const states = { visible: ['visible'], hidden: ['hidden'], 'hidden->visible': ['hidden', 'visible'], 'visible->hidden->visible': ['visible', 'hidden', 'visible'] }[mode];
    let step = 0; let visibility = states[0];
    const yieldFn = async () => { step++; visibility = states[Math.min(states.length - 1, Math.floor(step * states.length / 10))]; throttled = visibility === 'hidden'; await Y.yieldToEventLoop(); };
    throttled = visibility === 'hidden';
    const d0 = digestCalls; const t = await time(() => R.proveInventoryRows(record, imported, { yieldFn, budgetMs: 0 }));
    throttled = false;
    assert.equal(digestCalls - d0, 1600, `${mode}: every row proven exactly once`);
    assert.equal(t.r.chunks, 11); assert.equal(t.r.yields, 10);
    assert.ok(t.ms < PENALTY_MS, `${mode}: no throttle cost (${t.ms} ms)`);
    report.push({ case: `visibility:${mode}`, digests: digestCalls - d0, yields: t.r.yields, ms: t.ms });
  }
  // 4. Work-based chunking: small input never yields; budget bounds the yield count.
  {
    const small = await fixture(150);
    const s = await R.proveInventoryRows(small.record, small.imported);
    assert.equal(s.yields, 0); assert.equal(s.chunks, 1);
    let clock = 0; const fake = await fixture(1600);
    const budgetOnly = await R.proveInventoryRows(fake.record, fake.imported, { clock: () => (clock += 1), budgetMs: 1000, yieldFn: async () => {} });
    assert.equal(budgetOnly.yields, 0, 'under budget => no yield');
    const always = await R.proveInventoryRows(fake.record, fake.imported, { budgetMs: 0, yieldFn: async () => {} });
    assert.equal(always.yields, 10, 'yield count bounded by chunk count');
    report.push({ case: 'work-based-chunking', small150Yields: s.yields, underBudgetYields: budgetOnly.yields, maxYields1600: always.yields });
  }
  // 5. Yield primitive is a real macrotask (not microtask starvation) and is timer-independent.
  {
    const order = []; throttled = true;
    const timer = new Promise(r => setTimeout(() => { order.push('timer'); r(); }, 0));
    await Promise.resolve().then(() => order.push('microtask'));
    await Y.yieldToEventLoop(); order.push('yield');
    throttled = false; await timer;
    assert.deepEqual(order, ['microtask', 'yield', 'timer'], 'MessageChannel yield runs before throttled timers, after microtasks');
    const src = readFileSync(new URL('../src/providers/cloud/buyAnimeImportResume.ts', import.meta.url), 'utf8');
    assert.ok(!/while\s*\(\s*true|Promise\.resolve\(\)\s*\.then\(\s*\(\)\s*=>\s*yield/u.test(src), 'no busy loop / microtask yield');
    report.push({ case: 'yield-primitive', order: order.join('>') });
  }
  // 6. Retirement loop and T31 instrumentation no longer depend on timers/animation frames when hidden.
  {
    const resume = readFileSync(new URL('../src/providers/cloud/buyAnimeImportResume.ts', import.meta.url), 'utf8');
    const timerYields = resume.match(/=>\s*setTimeout\(/gu) || [];
    assert.equal(timerYields.length, 1, 'only the MessageChannel-unavailable fallback may use a timer');
    assert.match(resume, /typeof Channel !== 'function'\) return new Promise<void>\(resolve => setTimeout\(resolve, 0\)\);/u);
    assert.equal((resume.match(/await budget\.checkpoint\(\)/gu) || []).length, 2, 'both proof loops use the budgeted yield');
    const inv = readFileSync(new URL('../src/pages/Inventory.tsx', import.meta.url), 'utf8');
    assert.match(inv, /document\.visibilityState === 'hidden'[\s\S]{0,80}finish\(true\)/u, 'T31 recorded without waiting for rAF in hidden documents');
    report.push({ case: 'static-guards', pass: true });
  }
  console.log(JSON.stringify({ result: 'PASS', test: 'BACKGROUND_TAB_TIMER_THROTTLE', report }, null, 1));
} finally {
  globalThis.setTimeout = realSetTimeout;
  await vite.close();
}
