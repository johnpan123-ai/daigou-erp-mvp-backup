// P0-1 Phase 2 (G-1) isolated PostgreSQL + PostgREST integration test (never Live).
// Proves, against the real cleanup RPC (067/068) and real Prepare path:
//  S1 scheduler drains only expired OPS (incl. consumed upload requests), keeps active/in-flight,
//     and leaves every non-OPS table byte-identical (allowed delta = OPS tables only);
//  S2 cross-origin: a second origin's uncoordinated RPC stream + a concurrent real Prepare +
//     an Execute-style FOR UPDATE lock on an expired proof => only busy/progress/idle, no damage;
//  S3 UNKNOWN: connection lost after server commit => next run converges from true DB state;
//  S4 server-side interruption (statement timeout) leaves no partial state;
//  S5 no Web Locks => zero RPC; pagehide mid-run => clean stop, resumable;
//  S6 a real Execute on an unexpired proof running concurrently with cleanup succeeds.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';
import pg from 'pg';
import { isolatedDatabase, owner, viewer } from './helpers/saveability-isolated.mjs';

if (!process.env.WACA_ISOLATED_PG_URL) process.env.WACA_ISOLATED_PG_URL = 'postgresql://postgres@127.0.0.1:55492/waca_v3_base';
const fixture = process.env.ERP2_CURRENT_REAL_SNAPSHOT;
assert.ok(fixture, 'ERP2_CURRENT_REAL_SNAPSHOT is required (private local fixture)');
const db = await isolatedDatabase();
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
const report = { scope: 'ISOLATED_G1_OPS_SCHEDULER', liveAccess: 0, scenarios: [] };
const HOST = { host: 'rhfdjsklfrgpoqsaqpkn.supabase.co' };
try {
  const r = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const upload = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
  const S = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreOpsScheduler.ts');
  const M = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreOpsMaintenance.ts');
  const q = async (sql, args = []) => (await db.sql.query(sql, args)).rows;
  const def = (await q("select pg_get_functiondef('public.erp_cleanup_expired_restore_ops(uuid)'::regprocedure) d"))[0].d;
  for (const part of ['row_budget integer:=1024', 'LIMIT 4', '2097152', 'FOR UPDATE OF u NOWAIT', "NOT IN('completed','not_committed')", 'FOR UPDATE NOWAIT'])
    assert.ok(def.includes(part), `cleanup RPC contract fragment missing: ${part}`);

  // Load the business snapshot once (as the existing restore OPS test does), then Prepare through PostgREST.
  const c = await r.prepareCloudRestoreSnapshot(await readFile(fixture, 'utf8'));
  if (c.data.dashboard_category_images.every(x => !Object.hasOwn(x, 'local_id') && !Object.hasOwn(x, 'version')))
    await q('alter table public.dashboard_category_images drop column local_id,drop column version');
  for (const id of new Set(Object.values(c.data).flatMap(rows => rows.map(x => x.updated_by).filter(Boolean))))
    await q('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3) on conflict do nothing', [id, 'fixture@example.invalid', {}]);
  await q("select set_config('request.headers',$1,false)", [JSON.stringify(HOST)]);
  const legacy = (await q('select public.erp_prove_cloud_restore_candidate_v2($1,$2,$3,$4,$5) r', [c.data, c.manifest, 'strict', 'isolated', randomUUID()]))[0].r;
  await q('select public.erp_restore_staged_cloud_snapshot($1,$2,$3,$4,$5)', [randomUUID(), legacy.proof_id, c.manifest.snapshotFingerprint, c.manifest, 'isolated']);
  await db.startPostgrest();
  const rpc = async (name, args) => { const x = await db.http('/rpc/' + name, args, owner, { headers: HOST }); return { data: x.status === 200 ? x.data : null, error: x.status === 200 ? null : x.data, status: x.status }; };
  const prepare = async () => { const id = randomUUID(); const p = await upload.uploadCloudRestoreCandidate(rpc, c, c.data, 'strict', id); assert.equal(p.candidate_valid, true); return id; };

  // Fixture factory: clone a real prepared request (all OPS tables) and optionally age it.
  const seed = await prepare();
  const stageTables = (await q("select tablename from pg_tables where schemaname='public' and tablename like 'erp_restore_stage_%' order by tablename")).map(x => x.tablename);
  const cols = async (table, swap) => (await q("select attname from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum", ['public.' + table]))
    .map(x => (x.attname === swap ? '$2::uuid' : `"${x.attname}"`)).join(',');
  const clone = async ({ expired = false, consumed = false, fingerprint = null } = {}) => {
    const id = randomUUID();
    await q(`insert into public.erp_restore_upload_requests select ${await cols('erp_restore_upload_requests', 'request_id')} from public.erp_restore_upload_requests where request_id=$1`, [seed, id]);
    // erp_restore_initialize_upload_proof may already have created the draft proof row for this request id.
    const proofCols = (await q("select attname from pg_attribute where attrelid='public.erp_cloud_restore_candidate_proofs'::regclass and attnum>0 and not attisdropped and attname<>'proof_id' order by attnum")).map(x => `"${x.attname}"`).join(',');
    if (await exists(id) && Number((await q('select count(*) n from public.erp_cloud_restore_candidate_proofs where proof_id=$1', [id]))[0].n) > 0)
      await q(`update public.erp_cloud_restore_candidate_proofs t set (${proofCols})=(select ${proofCols} from public.erp_cloud_restore_candidate_proofs s where s.proof_id=$1) where t.proof_id=$2`, [seed, id]);
    else await q(`insert into public.erp_cloud_restore_candidate_proofs select ${await cols('erp_cloud_restore_candidate_proofs', 'proof_id')} from public.erp_cloud_restore_candidate_proofs where proof_id=$1`, [seed, id]);
    for (const t of stageTables) await q(`insert into public.${t} select ${await cols(t, 'restore_proof_id')} from public.${t} where restore_proof_id=$1`, [seed, id]);
    await q(`insert into public.erp_cloud_restore_prepared_chunks select ${await cols('erp_cloud_restore_prepared_chunks', 'proof_id')} from public.erp_cloud_restore_prepared_chunks where proof_id=$1`, [seed, id]);
    if (fingerprint) await q('update public.erp_cloud_restore_candidate_proofs set effective_fingerprint=$2 where proof_id=$1', [id, fingerprint]);
    if (consumed) await q('delete from public.erp_cloud_restore_candidate_proofs where proof_id=$1', [id]); // as Execute does
    if (expired || consumed) for (const [t, k] of [['erp_restore_upload_requests', 'request_id'], ['erp_cloud_restore_candidate_proofs', 'proof_id'], ['erp_cloud_restore_prepared_chunks', 'proof_id']])
      await q(`update public.${t} set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where ${k}=$1`, [id]);
    return id;
  };
  const exists = async id => Number((await q('select (select count(*) from public.erp_restore_upload_requests where request_id=$1)+(select count(*) from public.erp_cloud_restore_candidate_proofs where proof_id=$1) n', [id]))[0].n) > 0;
  const opsRows = async id => Number((await q(`select (select count(*) from public.erp_cloud_restore_prepared_chunks where proof_id=$1)
    ${stageTables.map(t => `+(select count(*) from public.${t} where restore_proof_id=$1)`).join('')} n`, [id]))[0].n);
  const OPS = new Set(['erp_restore_upload_requests', 'erp_cloud_restore_candidate_proofs', 'erp_cloud_restore_prepared_chunks', 'erp_restore_upload_chunks', 'erp_restore_upload_resource_proofs', ...stageTables]);
  const protectedTables = (await q("select tablename from pg_tables where schemaname='public' order by tablename")).map(x => x.tablename).filter(t => !OPS.has(t));
  const fingerprint = async () => { const out = {}; for (const t of protectedTables)
    out[t] = (await q(`select count(*)::int n, md5(coalesce(string_agg(md5(r::text),'' order by md5(r::text)),'')) h from public.${t} r`))[0]; return out; };

  // Scheduler wired exactly like the browser binding, with deterministic visibility and a memory origin.
  const lockManager = () => { const held = new Set(); return { held, async request(name, o, cb) { if (held.has(name)) return cb(null); held.add(name); try { return await cb({}); } finally { held.delete(name); } } }; };
  const memory = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
  const makeOrigin = ({ locks = lockManager(), rpcImpl = rpc } = {}) => {
    const stops = new Set(); const storage = memory(); let visible = true;
    const sched = S.createRestoreOpsScheduler({
      now: () => Date.now(), clock: () => performance.now(), storage, locks, rpc: rpcImpl,
      isVisible: () => visible, isOnline: () => true,
      wait: (ms, signal) => new Promise(res => { if (signal.aborted) return res(); const t = setTimeout(res, ms); signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); }),
      onStop: l => { stops.add(l); return () => stops.delete(l); },
    }, () => ({ cloud: true, owner: true, syncReady: true, buyAnimeActive: false, onSettingsRoute: false, unresolvedRestore: false }));
    sched.setMounted(true);
    const runDue = async reason => { storage.setItem('erp_restore_ops_maint:v1:state', JSON.stringify({ ...JSON.parse(storage.getItem('erp_restore_ops_maint:v1:state') || '{}'), nextDueAt: 0 })); return sched.trigger(reason); };
    return { sched, storage, runDue, stop: () => stops.forEach(l => l()), hide: () => { visible = false; stops.forEach(l => l()); } };
  };
  const drain = async (origin, limit = 400) => { const runs = []; for (let n = 0; n < limit; n++) { const x = await origin.runDue('drain'); runs.push(x); if (x?.outcome === 'idle') break; assert.ok(['progress', 'busy'].includes(x?.outcome), JSON.stringify(x)); } return runs; };

  // ---- S1: scheduler drains only eligible expired OPS; non-OPS tables byte-identical.
  const before1 = await fingerprint();
  const expired = [await clone({ expired: true }), await clone({ expired: true }), await clone({ expired: true })];
  const consumed = [await clone({ consumed: true }), await clone({ consumed: true })];
  const active = await clone();
  const inflight = await clone({ expired: true, fingerprint: 'f'.repeat(64) });
  await q(`insert into public.erp_cloud_restore_attempts(attempt_id,trace_id,actor_key,source_fingerprint,effective_fingerprint,restore_policy,target_environment,expected_epoch,timeout_budget_ms,timeout_contract_version,grace_ms,status)
    select $1,$2,actor_key,source_fingerprint,effective_fingerprint,restore_policy,target_environment,source_restore_epoch,120000,'postgresql-statement-timeout-v1',15000,'prepared' from public.erp_cloud_restore_candidate_proofs where proof_id=$3`, [randomUUID(), randomUUID(), inflight]);
  const attemptsFp = await fingerprint(); // includes the synthetic in-flight attempt row
  const a = makeOrigin();
  const s1 = await drain(a);
  for (const id of [...expired, ...consumed]) assert.equal(await exists(id), false, `expired/consumed ${id} must be removed`);
  for (const id of [...expired]) assert.equal(await opsRows(id), 0);
  for (const id of [active, inflight, seed]) { assert.equal(await exists(id), true, `${id} must remain`); assert.ok(await opsRows(id) > 0); }
  assert.deepEqual(await fingerprint(), attemptsFp, 'S1: non-OPS tables byte-identical (allowed delta = OPS only)');
  const snap1 = a.sched.getSnapshot();
  assert.equal(snap1.state.lastOutcome, 'idle'); assert.equal(snap1.health.level, 'OK');
  report.scenarios.push({ S1: 'PASS', runs: s1.length, outcomes: [...new Set(s1.map(x => x?.outcome))], maxRunMs: Math.max(...s1.map(x => x?.elapsedMs ?? 0)) });

  // ---- S2: cross-origin uncoordinated stream + concurrent Prepare + Execute-style lock on an expired proof.
  const e4 = await clone({ expired: true }); const e5 = await clone({ expired: true }); const c3 = await clone({ consumed: true });
  const fp2 = await fingerprint();
  const execLike = new pg.Client({ connectionString: db.url.toString() }); await execLike.connect();
  await execLike.query('begin'); await execLike.query('select proof_id from public.erp_cloud_restore_candidate_proofs where proof_id=$1 for update', [e4]);
  const statusesB = []; let stopB = false;
  const originB = (async () => { while (!stopB) { const x = await rpc('erp_cleanup_expired_restore_ops', { p_exclude_request_id: null }); assert.equal(x.error, null, JSON.stringify(x)); statusesB.push(x.data.status); } })();
  const runsA = []; for (let n = 0; n < 6; n++) runsA.push(await a.runDue('cross-origin'));
  const p2 = await prepare(); // a new Prepare during the cleanup storm
  assert.equal(await exists(e4), true, 'locked expired proof is never touched while Execute holds it');
  assert.ok(statusesB.includes('busy') || runsA.some(x => x?.outcome === 'busy'), 'contention resolves as busy');
  await execLike.query('rollback'); await execLike.end();
  await new Promise(res => setTimeout(res, 300)); stopB = true; await originB;
  await drain(a);
  for (const id of [e4, e5, c3]) assert.equal(await exists(id), false);
  for (const id of [active, inflight, seed, p2]) assert.equal(await exists(id), true);
  const fp2after = await fingerprint();
  assert.deepEqual(fp2after, fp2, 'S2: non-OPS tables byte-identical');
  report.scenarios.push({ S2: 'PASS', originBCalls: statusesB.length, originBStatuses: [...new Set(statusesB)], originARuns: runsA.map(x => x?.outcome ?? null), concurrentPrepare: 'candidate_valid' });

  // ---- S3: connection lost after the server committed => UNKNOWN, then convergence.
  const e6 = await clone({ expired: true });
  let dropped = 0;
  const lossy = makeOrigin({ rpcImpl: async (n, args) => { const x = await rpc(n, args); if (dropped++ === 0) throw new TypeError('Failed to fetch'); return x; } });
  const u = await lossy.runDue('lossy');
  assert.equal(u.outcome, 'unknown'); assert.equal(u.requests + u.chunks + u.typedRows, 0, 'nothing inferred from a lost response');
  assert.ok(await opsRows(e6) < (await opsRows(active)), 'the lost call did commit server-side');
  assert.equal(await lossy.sched.trigger('immediate'), null, 'UNKNOWN is not retried immediately');
  await drain(lossy); assert.equal(await exists(e6), false);
  report.scenarios.push({ S3: 'PASS', firstOutcome: u.outcome });

  // ---- S4: server-side interruption mid-function rolls back completely; next call is clean.
  const e7 = await clone({ expired: true });
  const rowsBefore = await opsRows(e7); const chunkProbe = async () => Number((await q('select count(*) n from public.erp_cloud_restore_prepared_chunks where proof_id=$1', [e7]))[0].n);
  const chunksBefore = await chunkProbe();
  const admin = new pg.Client({ connectionString: db.url.toString() }); await admin.connect();
  await admin.query('begin'); await admin.query("set local statement_timeout='1ms'");
  await assert.rejects(admin.query('select public.erp_cleanup_expired_restore_ops(null)'), e => e.code === '57014');
  await admin.query('rollback'); await admin.end();
  assert.equal(await opsRows(e7), rowsBefore); assert.equal(await chunkProbe(), chunksBefore);
  await drain(a); assert.equal(await exists(e7), false);
  report.scenarios.push({ S4: 'PASS', interruptedRowsRetained: rowsBefore });

  // ---- S5: no Web Locks => zero RPC; pagehide mid-run => clean stop, resumable.
  let calls = 0; const noLocks = makeOrigin({ locks: null, rpcImpl: async (...x) => { calls++; return rpc(...x); } });
  const sk = await noLocks.runDue('nolocks'); assert.equal(sk.outcome, 'skipped-no-web-locks'); assert.equal(calls, 0);
  const e8 = await clone({ expired: true });
  const hideOrigin = makeOrigin({ rpcImpl: async (...x) => { const res = await rpc(...x); hideOrigin.hide(); return res; } });
  const st = await hideOrigin.runDue('pagehide'); assert.equal(st.outcome, 'stopped'); assert.equal(st.batches, 1);
  assert.equal(await exists(e8), true, 'stopped after one bounded batch');
  await drain(a); assert.equal(await exists(e8), false);
  report.scenarios.push({ S5: 'PASS', noWebLocksRpcCalls: calls, pagehideBatches: st.batches });

  // Owner-only: viewer and anon are rejected by the RPC itself.
  assert.equal((await db.http('/rpc/erp_cleanup_expired_restore_ops', {}, viewer, { headers: HOST })).status, 403);
  assert.ok([401, 403].includes((await db.http('/rpc/erp_cleanup_expired_restore_ops', {}, null, { headers: HOST })).status));
  assert.deepEqual(await fingerprint(), fp2, 'non-OPS tables still byte-identical after S3-S5');

  // ---- S6: real Execute (unexpired proof, legacy staged path) concurrent with cleanup succeeds.
  const e9 = await clone({ expired: true });
  const proof = (await q('select public.erp_prove_cloud_restore_candidate_v2($1,$2,$3,$4,$5) r', [c.data, c.manifest, 'strict', 'isolated', randomUUID()]))[0].r;
  const exec = new pg.Client({ connectionString: db.url.toString() }); await exec.connect();
  await exec.query("select set_config('request.jwt.claim.sub',$1,false), set_config('request.headers',$2,false)", [owner, JSON.stringify(HOST)]);
  const executing = exec.query('select public.erp_restore_staged_cloud_snapshot($1,$2,$3,$4,$5) r', [randomUUID(), proof.proof_id, c.manifest.snapshotFingerprint, c.manifest, 'isolated']);
  const during = await drain(a);
  const done = (await executing).rows[0].r; await exec.end();
  assert.ok(done && typeof done === 'object', 'Execute completed');
  assert.equal(await exists(e9), false);
  for (const id of [active, inflight, p2]) assert.equal(await exists(id), true);
  report.scenarios.push({ S6: 'PASS', cleanupRunsDuringExecute: during.length });

  report.result = 'PASS'; report.businessMutationByCleanup = 0; report.allowedDelta = 'OPS tables only';
  console.log(JSON.stringify(report, null, 1));
} finally {
  await vite.close();
  await db.close();
}
