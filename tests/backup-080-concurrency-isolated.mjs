// 080 candidate: authoritative backup RPC under concurrency (synthetic data sized from the real 24-resource
// snapshot, 1x and 2x). Measures, per work_mem setting and concurrency 1/2/3/5: wall time per backup,
// failures, peak private memory of all PostgreSQL processes, CPU, temp spill (pg_stat_database), and the
// latency of ordinary reads running at the same time. Isolated PostgreSQL only; no network, no real data.
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';

const SCALES = (process.env.B080_SCALES || '1,2').split(',').map(Number);
const SETTINGS = (process.env.B080_WORKMEM || 'default,16MB,32MB,64MB').split(',');
const CONC = (process.env.B080_CONC || '1,2,3,5').split(',').map(Number);
const ROWS = { inventory_items: [6397, 1044], product_groups: [1638, 728], product_categories: [820, 386], product_variants: [6854, 961],
  bundle_components: [344, 335], purchase_batches: [822, 406], purchase_batch_items: [3301, 435], private_orders: [117, 407], private_order_items: [148, 429],
  import_batches: [3, 300857], japan_packages: [114, 443], japan_package_items: [1414, 819], outbound_shipments: [48, 450], outbound_shipment_items: [1466, 669],
  waca_orders: [10, 407], waca_order_items: [12, 1485], waca_mappings: [10, 967], waca_import_batches: [1, 3443], waca_cutover_audit: [5776, 723] };

const pgProcs = () => readdirSync('/proc').filter(p => /^\d+$/u.test(p)).filter(p => { try { return readFileSync(`/proc/${p}/comm`, 'utf8').trim() === 'postgres'; } catch { return false; } });
const privateKB = pid => { try { const t = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'); return ['Private_Clean', 'Private_Dirty'].reduce((s, k) => s + Number((t.match(new RegExp(`${k}:\\s+(\\d+)`, 'u')) || [0, 0])[1]), 0); } catch { return 0; } };
const cpuTicks = pid => { try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); } catch { return 0; } };

const db = await isolatedDatabase();
const report = { host: { memMB: Math.round(Number(readFileSync('/proc/meminfo', 'utf8').match(/MemTotal:\s+(\d+)/u)[1]) / 1024), cpus: (await import('node:os')).cpus().length }, runs: [] };
try {
  const { sql } = db;
  report.pg = (await sql.query("select current_setting('server_version') v, current_setting('work_mem') wm, current_setting('shared_buffers') sb, pg_jit_available() jit")).rows[0];
  const connect = async () => { const c = new pg.Client({ connectionString: db.url.toString() }); await c.connect(); return c; };
  // Generic synthetic loader: FK/check triggers off (isolated superuser), required columns filled by type, one text column padded.
  const load = async scale => {
    await sql.query('set session_replication_role = replica');
    for (const [table, [n, width]] of Object.entries(ROWS)) {
      await sql.query(`truncate public.${table} cascade`);
      // Disposable DB: CHECK constraints do not affect the export plan; drop them so synthetic values load.
      for (const { conname } of (await sql.query(`select conname from pg_constraint where conrelid=('public.'||$1)::regclass and contype='c'`, [table])).rows)
        await sql.query(`alter table public.${table} drop constraint "${conname}"`);
      const cols = (await sql.query(`select column_name c, data_type t, is_nullable n, column_default d from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [table])).rows;
      const pad = cols.find(c => ['note', 'description', 'raw_payload', 'details', 'title', 'product_title', 'name', 'file_name', 'reason'].includes(c.c) && /text|character/u.test(c.t)) || cols.find(c => /text|character/u.test(c.t) && c.c !== 'id');
      const exprs = []; const names = [];
      for (const c of cols) {
        const needed = (c.n === 'NO' && c.d === null) || c === pad;
        if (!needed) continue;
        names.push(`"${c.c}"`);
        if (c === pad) { exprs.push(`left(repeat(md5(g::text), ${Math.ceil(width / 32) + 1}), ${Math.max(16, width - 200)})`); continue; }
        if (c.t === 'uuid') exprs.push('gen_random_uuid()');
        else if (/int|numeric|double|real/u.test(c.t)) exprs.push('g');
        else if (c.t === 'boolean') exprs.push('false');
        else if (/timestamp|date/u.test(c.t)) exprs.push('now()');
        else if (/json/u.test(c.t)) exprs.push(`'{}'::${c.t}`);
        else exprs.push(`'${table}-'||g`);
      }
      await sql.query(`insert into public.${table}(${names.join(',')}) select ${exprs.join(',')} from generate_series(1, ${n * scale}) g`);
    }
    await sql.query('set session_replication_role = origin');
    await sql.query('analyze');
    const size = (await sql.query('select length(t)::int n from (select public.erp_export_cloud_restore_snapshot_json()::text t) s'.replace('select public', "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role','authenticated')::text, false) x, public"), [owner]).catch(() => null));
    return size;
  };
  const backupAs = async (client, timeoutMs) => {
    const t = performance.now();
    try {
      await client.query('begin');
      await client.query(`set local statement_timeout = ${timeoutMs}`);
      await client.query("select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role','authenticated')::text, true)", [owner]);
      await client.query('set local role authenticated');
      const r = await client.query('select length(public.erp_export_cloud_restore_snapshot_json()::text)::int n');
      await client.query('commit');
      return { ms: Math.round(performance.now() - t), bytes: r.rows[0].n };
    } catch (error) { await client.query('rollback').catch(() => {}); return { ms: Math.round(performance.now() - t), error: error.code || error.message }; }
  };
  const TIMEOUT = Number(process.env.B080_TIMEOUT_MS || 60000);
  for (const scale of SCALES) {
    await load(scale);
    if (process.env.B080_APPLY) await sql.query(readFileSync('supabase/candidates/080_backup_export_function_timeout_single_flight.sql', 'utf8'));
    const probe = await connect(); report[`bytes_x${scale}`] = (await backupAs(probe, TIMEOUT)).bytes; await probe.end();
    for (const setting of SETTINGS) {
      await sql.query(setting === 'default' ? 'alter function public.erp_export_cloud_restore_snapshot_json() reset work_mem'
        : `alter function public.erp_export_cloud_restore_snapshot_json() set work_mem = '${setting}'`);
      for (const n of CONC) {
        const clients = await Promise.all(Array.from({ length: n }, connect));
        const reader = await connect();
        const temp0 = (await sql.query('select temp_files::int f, temp_bytes::bigint b from pg_stat_database where datname=current_database()')).rows[0];
        const procs0 = Object.fromEntries(pgProcs().map(p => [p, cpuTicks(p)]));
        const idleKB = pgProcs().reduce((s, p) => s + privateKB(p), 0);
        let peakKB = 0, sampling = true; const readLat = [];
        const sampler = (async () => { while (sampling) { peakKB = Math.max(peakKB, pgProcs().reduce((s, p) => s + privateKB(p), 0)); await new Promise(r => setTimeout(r, 25)); } })();
        let readsOn = true;
        const reads = (async () => { while (readsOn) { const t = performance.now(); await reader.query('select * from public.product_variants order by id limit 500'); readLat.push(performance.now() - t); } })();
        const t0 = performance.now();
        const results = await Promise.all(clients.map(c => backupAs(c, TIMEOUT)));
        const wall = performance.now() - t0;
        readsOn = false; await reads; sampling = false; await sampler;
        const cpu = pgProcs().reduce((s, p) => s + (cpuTicks(p) - (procs0[p] ?? 0)), 0) / 100;
        const temp1 = (await sql.query('select temp_files::int f, temp_bytes::bigint b from pg_stat_database where datname=current_database()')).rows[0];
        readLat.sort((a, b) => a - b);
        const q = p => Math.round(readLat[Math.min(readLat.length - 1, Math.floor(readLat.length * p))] ?? 0);
        report.runs.push({ scale, work_mem: setting, concurrency: n, maxMs: Math.max(...results.map(r => r.ms)), minMs: Math.min(...results.map(r => r.ms)),
          failures: results.filter(r => r.error).map(r => r.error), succeeded: results.filter(r => !r.error).length, peakPgPrivateMB: Math.round(peakKB / 1024), backupDeltaMB: Math.round((peakKB - idleKB) / 1024), cpuCoreSeconds: +cpu.toFixed(1), cpuCoresAvg: +(cpu / (wall / 1000)).toFixed(2),
          tempFiles: temp1.f - temp0.f, tempMB: +((Number(temp1.b) - Number(temp0.b)) / 1048576).toFixed(1), readP50: q(0.5), readP95: q(0.95), readMax: Math.round(readLat.at(-1) ?? 0), reads: readLat.length });
        await Promise.all([...clients, reader].map(c => c.end()));
        console.log(JSON.stringify(report.runs.at(-1)));
      }
    }
  }
  // Idle reference for the mixed reads.
  const reader = await connect(); const lat = []; for (let i = 0; i < 40; i++) { const t = performance.now(); await reader.query('select * from public.product_variants order by id limit 500'); lat.push(performance.now() - t); } await reader.end();
  lat.sort((a, b) => a - b); report.idleRead = { p50: Math.round(lat[20]), p95: Math.round(lat[37]) };
  console.log('REPORT ' + JSON.stringify(report));
} finally { await db.close(); }
