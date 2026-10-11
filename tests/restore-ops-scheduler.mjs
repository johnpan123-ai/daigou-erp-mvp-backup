// P0-1 Phase 2 (G-1) Restore OPS scheduler: unit + contract tests (no network, no database).
// Fake clock / storage / Web Locks / RPC. Proves: gates, fail-closed without Web Locks,
// same-origin single-flight, wall-clock budget under slow RPC / hidden tab / throttled timers,
// outcome classification + cooldown/backoff, UNKNOWN never retried immediately, pagehide stop,
// health classification, diagnostics cap, never-throw, and static wiring/isolation guards.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
const report = [];
const H = 3600_000, MIN = 60_000;
try {
  const S = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreOpsScheduler.ts');
  const M = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreOpsMaintenance.ts');
  const P = S.OPS_SCHEDULER;

  // Approved parameters (D2) are exact.
  assert.equal(P.maxBatches, 12); assert.equal(P.budgetMs, 8000); assert.equal(P.callTimeoutMs, 12000);
  assert.equal(P.cooldown.progress, 10 * MIN); assert.equal(P.cooldown.idle, 12 * H); assert.equal(P.cooldown.busy, 30 * MIN);
  assert.deepEqual(P.errorBackoff, [H, 6 * H, 24 * H]); assert.equal(P.cooldown.unknown, 30 * MIN);

  const lockManager = () => { const held = new Set(); return {
    held, async request(name, opts, cb) { assert.equal(opts.ifAvailable, true);
      if (held.has(name)) return cb(null); held.add(name); try { return await cb({ name }); } finally { held.delete(name); } } }; };
  const memoryStorage = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
  const okGates = () => ({ cloud: true, owner: true, syncReady: true, buyAnimeActive: false, onSettingsRoute: false, unresolvedRestore: false });
  // responses: array of { status } | { error, status } | 'throw' | 'hang'; latency in fake ms.
  function harness({ responses = [{ status: 'idle' }], latency = 100, storage = memoryStorage(), locks = lockManager(), gates = okGates(),
    waitAdvance = null, start = Date.UTC(2026, 9, 11, 2, 0, 0) } = {}) {
    const t = { wall: start, mono: 0, visible: true, online: true, calls: [], stops: new Set() };
    let i = 0;
    const env = {
      now: () => t.wall, clock: () => t.mono, storage, locks,
      rpc: async (name, args, signal) => {
        t.calls.push({ name, args, signal }); const r = responses[Math.min(i++, responses.length - 1)];
        const lat = typeof latency === 'function' ? latency(t.calls.length) : latency;
        await Promise.resolve(); t.mono += lat; t.wall += lat;
        if (r === 'throw') throw new TypeError('Failed to fetch');
        if (r?.onCall) r.onCall(t);
        if (r?.error) return { data: null, error: r.error, status: r.status };
        return { data: { status: r.status, requests: r.requests ?? 0, chunks: r.chunks ?? 4, typedRows: r.typedRows ?? 1024 }, error: null, status: 200 };
      },
      isVisible: () => t.visible, isOnline: () => t.online,
      wait: async (ms, signal) => { if (signal.aborted) return; const adv = waitAdvance ?? ms; t.mono += adv; t.wall += adv; },
      onStop: l => { t.stops.add(l); return () => t.stops.delete(l); },
    };
    const sched = S.createRestoreOpsScheduler(env, () => gates);
    sched.setMounted(true);
    return { t, env, sched, gates, storage, locks, fireStop: () => [...t.stops].forEach(l => l()) };
  }
  const state = h => h.sched.getSnapshot().state;

  // 1. Gate matrix: no RPC.
  for (const [label, mutate, oppExpected] of [
    ['not-owner', h => { h.gates.owner = false; }, false], ['not-cloud', h => { h.gates.cloud = false; }, false],
    ['hidden', h => { h.t.visible = false; }, false], ['offline', h => { h.t.online = false; }, false],
    ['sync-not-ready', h => { h.gates.syncReady = false; }, true], ['buyanime-active', h => { h.gates.buyAnimeActive = true; }, true],
    ['settings-route', h => { h.gates.onSettingsRoute = true; }, true], ['unresolved-restore', h => { h.gates.unresolvedRestore = true; }, true],
    ['other-tab-settings-heartbeat', h => { h.sched.noteSettingsActivity(); }, true],
  ]) {
    const h = harness(); mutate(h);
    assert.equal(await h.sched.trigger('t'), null, label); assert.equal(h.t.calls.length, 0, label);
    assert.equal(h.sched.getSnapshot().opportunity.lastAt !== null, oppExpected, `${label} opportunity`);
  }
  { const h = harness(); await h.sched.trigger('t'); const n = h.t.calls.length; h.t.wall += 5 * MIN;
    assert.equal(await h.sched.trigger('t'), null, 'cooldown'); assert.equal(h.t.calls.length, n); }
  report.push({ case: 'gate-matrix', pass: true });

  // 2. Budget: wall-clock rule start-if(elapsed + max(observed,1s) <= 8s), cap 12.
  const budget = async (opts) => { const h = harness({ responses: [{ status: 'progress' }], ...opts }); const r = await h.sched.trigger('t'); return { h, r }; };
  { const { r } = await budget({ latency: 5900 }); assert.equal(r.batches, 1); assert.equal(r.outcome, 'progress'); }
  { const { r } = await budget({ latency: 3000 }); assert.equal(r.batches, 2); }
  { const { r } = await budget({ latency: 50 }); assert.equal(r.batches, 12); }
  { const { r } = await budget({ latency: 11000 }); assert.equal(r.batches, 1); assert.ok(r.elapsedMs <= 11000); }
  { const { r } = await budget({ latency: 50, waitAdvance: 60_000 }); assert.equal(r.batches, 1, 'throttled timer: no batch after deadline'); }
  { // hidden during the inter-batch pause => stop at the boundary
    const h = harness({ responses: [{ status: 'progress', onCall: t => { t.visible = false; } }] });
    const origWait = h.env.wait; h.env.wait = async (ms, signal) => { h.fireStop(); return origWait(ms, signal); };
    const r = await h.sched.trigger('t'); assert.equal(r.batches, 1); assert.equal(r.outcome, 'stopped');
    assert.equal(state(h).nextDueAt, h.t.wall, 'stopped is due again at next trigger (not a failure)'); assert.equal(state(h).consecutiveFailures, 0); }
  report.push({ case: 'budget', latency5900: 1, latency3000: 2, latency50: 12, slowSingle: 1, throttled: 1, hiddenStop: 'stopped' });

  // 3. Outcomes -> cooldown / backoff; UNKNOWN never retried immediately.
  { const h = harness({ responses: [{ status: 'idle' }] }); const r = await h.sched.trigger('t');
    assert.equal(r.outcome, 'idle'); assert.equal(state(h).nextDueAt, h.t.wall + 12 * H); }
  { const h = harness({ responses: [{ status: 'progress' }], latency: 50 }); await h.sched.trigger('t');
    assert.equal(state(h).nextDueAt, h.t.wall + 10 * MIN); assert.ok(state(h).progressSince !== null); }
  { const h = harness({ responses: [{ status: 'busy' }] }); await h.sched.trigger('t');
    assert.equal(state(h).nextDueAt, h.t.wall + 30 * MIN); assert.equal(state(h).consecutiveFailures, 0); }
  { const h = harness({ responses: ['throw'] }); const r = await h.sched.trigger('t');
    assert.equal(r.outcome, 'unknown'); assert.equal(state(h).nextDueAt, h.t.wall + 30 * MIN);
    assert.equal(state(h).consecutiveFailures, 1); assert.equal(state(h).consecutiveErrors, 0);
    assert.equal(await h.sched.trigger('t'), null); assert.equal(h.t.calls.length, 1, 'UNKNOWN not retried immediately'); }
  { const h = harness({ responses: [{ error: { code: '42501', message: 'CLOUD_RESTORE_OWNER_REQUIRED' }, status: 403 }] });
    const due = []; for (let n = 0; n < 4; n++) { await h.sched.trigger('t'); due.push(state(h).nextDueAt - h.t.wall); h.t.wall = state(h).nextDueAt; }
    assert.deepEqual(due, [H, 6 * H, 24 * H, 24 * H]); assert.equal(state(h).consecutiveErrors, 4);
    assert.equal(h.sched.getSnapshot().log.at(-1).errorCode, '42501'); }
  { // a server timeout response is a definite error (rolled back), not UNKNOWN
    const r = await M.cleanupExpiredRestoreOps(async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, status: 500 }), null, { maxBatches: 2 });
    assert.equal(r.outcome, 'error'); assert.equal(r.errorCode, '57014'); }
  report.push({ case: 'outcomes', idle: '12h', progress: '10m', busy: '30m', unknown: '30m-no-retry', error: '1h/6h/24h' });

  // 4. Client call timeout => UNKNOWN (server may still commit); signal aborted; deletions not inferred.
  { let signal; const r = await M.cleanupExpiredRestoreOps((n, a, s) => { signal = s; return new Promise(() => {}); }, null, { callTimeoutMs: 30, maxBatches: 3 });
    assert.equal(r.outcome, 'unknown'); assert.equal(r.errorCode, 'CLIENT_CALL_TIMEOUT'); assert.equal(signal.aborted, true);
    assert.equal(r.requests + r.chunks + r.typedRows, 0); assert.equal(r.batches, 0); }
  report.push({ case: 'client-timeout-unknown', pass: true });

  // 5. Fail-closed without Web Locks.
  { const h = harness({ locks: null }); const r = await h.sched.trigger('t');
    assert.equal(r.outcome, 'skipped-no-web-locks'); assert.equal(h.t.calls.length, 0);
    assert.equal(state(h).nextDueAt, h.t.wall + 12 * H); assert.equal(await h.sched.trigger('t'), null); }
  report.push({ case: 'no-web-locks-fail-closed', rpcCalls: 0 });

  // 6. Same origin (shared storage + lock manager): exactly one tab runs.
  { const storage = memoryStorage(), locks = lockManager();
    const a = harness({ storage, locks, responses: [{ status: 'progress' }, { status: 'idle' }] });
    const b = harness({ storage, locks, responses: [{ status: 'idle' }] });
    const [ra, rb] = await Promise.all([a.sched.trigger('a'), b.sched.trigger('b')]);
    assert.ok(ra && ra.outcome === 'idle'); assert.equal(rb, null); assert.equal(b.t.calls.length, 0);
    b.t.wall = a.t.wall; assert.equal(await b.sched.trigger('b'), null, 'shared cooldown'); assert.equal(locks.held.size, 0); }
  { // Different origins share neither storage nor Web Locks, so the client cannot coordinate them
    // (each origin is a separate JS realm; here they share one realm, so run sequentially).
    // Concurrent cross-origin safety is proved server-side in restore-ops-scheduler-isolated.mjs.
    const a = harness(), b = harness(); await a.sched.trigger('a'); await b.sched.trigger('b');
    assert.equal(a.t.calls.length, 1); assert.equal(b.t.calls.length, 1); }
  report.push({ case: 'single-flight', sameOrigin: 'one', crossOrigin: 'both(server-guarded)' });

  // 7. pagehide during an in-flight call: the call completes, then stop; no persistent running state; lock released.
  { const h = harness({ responses: [{ status: 'progress', onCall: t => { t.stopNow = true; } }] });
    const rpc = h.env.rpc; h.env.rpc = async (...x) => { const r = await rpc(...x); h.fireStop(); return r; };
    const r = await h.sched.trigger('t'); assert.equal(r.outcome, 'stopped'); assert.equal(r.batches, 1);
    assert.equal(h.sched.getSnapshot().running, false); assert.equal(h.locks.held.size, 0);
    assert.ok(!JSON.stringify([...h.storage.m.values()]).includes('"running"')); }
  report.push({ case: 'pagehide-stop', pass: true });

  // 8. Health: no-opportunity vs scheduler fault; scope disclaimer.
  { const fresh = S.classifyOpsHealth({ nextDueAt: 0, lastAttemptAt: null, lastSuccessAt: null, lastOutcome: null, consecutiveFailures: 0, consecutiveErrors: 0, progressSince: null, progressDays: [], lastServerObservation: null }, { lastAt: null, daysSinceAttempt: [] }, 0);
    assert.equal(fresh.level, 'NO_OPPORTUNITY'); assert.match(fresh.scope, /不是全系統權威紀錄/u);
    const base = { nextDueAt: 0, lastAttemptAt: null, lastSuccessAt: null, lastOutcome: null, consecutiveFailures: 0, consecutiveErrors: 0, progressSince: null, progressDays: [], lastServerObservation: null };
    assert.equal(S.classifyOpsHealth(base, { lastAt: 10, daysSinceAttempt: ['2026-10-11'] }, 20).level, 'WAITING');
    assert.equal(S.classifyOpsHealth(base, { lastAt: 10, daysSinceAttempt: ['2026-10-11', '2026-10-12'] }, 20).level, 'ATTENTION');
    assert.equal(S.classifyOpsHealth({ ...base, nextDueAt: 99 }, { lastAt: 10, daysSinceAttempt: ['2026-10-11', '2026-10-12'] }, 20).level, 'WAITING', 'not due yet is not a fault');
    assert.equal(S.classifyOpsHealth({ ...base, lastSuccessAt: 10, nextDueAt: 99 }, { lastAt: 12, daysSinceAttempt: [] }, 20).level, 'OK');
    assert.equal(S.classifyOpsHealth({ ...base, consecutiveFailures: 3 }, { lastAt: 1, daysSinceAttempt: [] }, 2).level, 'ATTENTION');
    assert.equal(S.classifyOpsHealth({ ...base, progressSince: 1, progressDays: ['a', 'b', 'c'] }, { lastAt: 1, daysSinceAttempt: [] }, 2).level, 'ATTENTION');
    // Owner absent for 30 days, nothing ran: NO fault as long as no opportunity happened.
    const h = harness(); await h.sched.trigger('t'); h.t.wall += 30 * 24 * H;
    assert.notEqual(h.sched.getSnapshot().health.level, 'ATTENTION'); }
  report.push({ case: 'health', pass: true });

  // 9. Diagnostics ring capped at 20.
  { const h = harness({ responses: [{ status: 'idle' }] }); for (let n = 0; n < 25; n++) { h.t.wall = state(h).nextDueAt; await h.sched.trigger('t'); }
    assert.equal(h.sched.getSnapshot().log.length, 20); }
  // 10. Never throws (sync throwing RPC, throwing storage, throwing locks).
  { const h = harness(); h.env.rpc = () => { throw new Error('sync boom'); }; const r = await h.sched.trigger('t'); assert.equal(r.outcome, 'unknown'); }
  { const st = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const h = harness({ storage: st }); await assert.doesNotReject(h.sched.trigger('t')); }
  { const h = harness({ locks: { request: () => { throw new Error('lock boom'); } } }); assert.equal(await h.sched.trigger('t'), null); }
  report.push({ case: 'never-throw-and-log-cap', pass: true });

  // 11. Maintenance default path is unchanged (restore-expired-ops-cleanup.mjs:96-97 semantics).
  { await assert.doesNotReject(M.cleanupExpiredRestoreOps(async () => { throw Error('maintenance offline'); }, 'seed'));
    let count = 0; const args = [];
    await M.cleanupExpiredRestoreOps(async (name, a) => { args.push([name, a]); return { data: { status: ++count < 3 ? 'progress' : 'idle' }, error: null }; }, 'seed');
    assert.equal(count, 3); assert.deepEqual(args[0], ['erp_cleanup_expired_restore_ops', { p_exclude_request_id: 'seed' }]); }
  report.push({ case: 'maintenance-default-compat', pass: true });

  // 12. Static wiring / isolation guards.
  const src = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  for (const f of ['src/providers/cloud/supabaseProvider.ts', 'src/providers/cloud/cloudRestoreStagedUpload.ts', 'src/providers/cloud/cloudRestoreSubmit.ts',
    'src/components/CloudAtomicRestorePanel.tsx', 'src/contexts/CloudRealtimeSyncContext.tsx', 'src/providers/cloud/buyAnimeImportCoordinator.ts'])
    assert.doesNotMatch(src(f), /cloudRestoreOpsScheduler|useRestoreOpsMaintenance|cleanupExpiredRestoreOps|erp_cleanup_expired_restore_ops/u, `${f} must stay independent of OPS maintenance`);
  const layout = src('src/components/layout/AppLayout.tsx');
  assert.match(layout, /import \{ useRestoreOpsMaintenance \} from '\.\.\/\.\.\/hooks\/useRestoreOpsMaintenance';/u);
  assert.match(layout, /\n {2}useRestoreOpsMaintenance\(\);\n/u, 'AppLayout must mount the scheduler (anti-orphan)');
  const owned = ['src/providers/cloud/cloudRestoreOpsScheduler.ts', 'src/providers/cloud/cloudRestoreOpsMaintenance.ts', 'src/hooks/useRestoreOpsMaintenance.ts'].map(src).join('\n');
  // Only RPC-shaped identifier: the existing cleanup RPC (+ the read-only Restore storage key name).
  assert.deepEqual([...new Set(owned.match(/'erp_[a-z0-9_]+'/gu))].sort(), ["'erp_cleanup_expired_restore_ops'", "'erp_cloud_restore_unresolved_attempt'"]);
  assert.doesNotMatch(owned, /\.rpc\('(?!erp_cleanup_expired_restore_ops)/u);
  assert.doesNotMatch(owned, /supabase\s*\.\s*(from|schema|storage|channel)\b/u, 'no direct table/storage/realtime access');
  assert.equal((owned.match(/supabase\.rpc\(/gu) || []).length, 1, 'exactly one RPC call site');
  assert.doesNotMatch(owned, /lease/iu, 'no localStorage lease fallback');
  assert.match(src('src/providers/cloud/cloudRestoreSubmit.ts'), /CLOUD_RESTORE_UNRESOLVED_STORAGE_KEY = 'erp_cloud_restore_unresolved_attempt'/u);
  assert.doesNotMatch(src('src/hooks/useRestoreOpsMaintenance.ts'), /sessionStorage\.(setItem|removeItem)/u, 'Restore keys are read-only here');
  const settings = src('src/pages/Settings.tsx');
  assert.match(settings, /<RestoreOpsMaintenanceStatus \/>/u); assert.match(src('src/providers/cloud/cloudRestoreOpsScheduler.ts'), /不是全系統權威紀錄/u);
  report.push({ case: 'static-guards', pass: true });

  console.log(JSON.stringify({ result: 'PASS', test: 'RESTORE_OPS_SCHEDULER_G1', report }, null, 1));
} finally {
  await vite.close();
}
