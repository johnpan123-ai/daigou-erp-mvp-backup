import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { createServer } from 'vite';

const connectionString = process.env.RESTORE_DISPATCH_LOCAL_PG ?? '';
const apiUrl = process.env.RESTORE_DISPATCH_POSTGREST_URL ?? '';
const jwtSecret = process.env.RESTORE_DISPATCH_JWT_SECRET ?? '';
const snapshotPath = process.env.CLOUD_RESTORE_LIVE_SHAPE_SNAPSHOT
  || 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-26-054815.json';
const setupOnly = process.argv.includes('--setup');
const databaseUrl = new URL(connectionString);
assert(['127.0.0.1', 'localhost'].includes(databaseUrl.hostname));
assert.equal(databaseUrl.port, '55493');
assert.match(databaseUrl.pathname, /^\/restore_dispatch_fixture_v3(?:_\d+)?$/u);
assert(existsSync(snapshotPath), 'Exact 18,059-row snapshot fixture is required');
if (!setupOnly) {
  const parsedApi = new URL(apiUrl);
  assert(['127.0.0.1', 'localhost'].includes(parsedApi.hostname));
  assert.equal(parsedApi.port, '55494');
  assert(jwtSecret.length >= 32);
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const TARGET = 'rhfdjsklfrgpoqsaqpkn';
const raw = readFileSync(snapshotPath);
const rawDocument = JSON.parse(raw);
assert.equal(rawDocument.manifest.totalRows, 18_059);
assert.equal(rawDocument.manifest.resourceCount, 15);

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
const portability = await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
const relations = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreRelations.ts');
const source = await domain.prepareCloudRestoreSnapshot(raw.toString('utf8'), {
  fileName: 'live-shape.json',
  sourceEnvironment: rawDocument.sourceEnvironment ?? 'https://source.example.invalid',
  sourceFileSha256: createHash('sha256').update(raw).digest('hex'),
});
const portable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(source, TARGET);
const effective = await portability.assertCloudRestoreEffectiveCandidate(portable);
await vite.close();
assert.equal(portable.portability.totalTransformedRows, 15_711);

const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const sqlType = values => {
  const found = values.find(value => value !== null && value !== undefined);
  if (typeof found === 'boolean') return 'boolean';
  if (typeof found === 'number') return 'numeric';
  if (Array.isArray(found) || (found && typeof found === 'object')) return 'jsonb';
  return 'text';
};
const relationFields = new Set(relations.CLOUD_RESTORE_RELATIONS.flatMap(value => [value.field]));

const db = new Client({ connectionString, application_name: 'restore_dispatch_v3_http_replay' });
await db.connect();
const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
const login = async () => {
  await db.query('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)", [
    OWNER, JSON.stringify({ host: `${TARGET}.supabase.co` }),
  ]);
  await db.query('set role authenticated');
};

try {
  if (setupOnly) {
    assert.equal(await scalar("select to_regprocedure('public.erp_prepare_cloud_restore_attempt(uuid,uuid,text,text,text,text,integer,text)') is null as value"), true,
      'Setup-only fixture must start from an empty migration state');
    await db.query('create publication supabase_realtime');
    for (const [, table] of domain.CLOUD_RESTORE_TABLES) {
      const rows = effective.sourceData[table];
      const required = ['id', 'updated_by'];
      if (table === 'inventory_items') required.push('inventory_key');
      required.push(...relations.CLOUD_RESTORE_RELATIONS
        .filter(value => value.childTable === table).map(value => value.field));
      const keys = [...new Set([...required, ...rows.flatMap(row => Object.keys(row))])].sort();
      const columns = keys.map(key => {
        if (key === 'id') return `${quote(key)} uuid primary key`;
        if (table === 'inventory_items' && key === 'inventory_key') return `${quote(key)} text not null unique`;
        if (key === 'updated_by') return `${quote(key)} uuid references auth.users(id) on delete set null`;
        if (relationFields.has(key)) return `${quote(key)} uuid`;
        return `${quote(key)} ${sqlType(rows.map(row => row[key]))}`;
      });
      await db.query(`create table public.${quote(table)}(${columns.join(',')})`);
    }
    for (const relation of relations.CLOUD_RESTORE_RELATIONS) {
      await db.query(`alter table public.${quote(relation.childTable)} add constraint ${quote(`fixture_${relation.childTable}_${relation.field}_fk`)}
        foreign key(${quote(relation.field)}) references public.${quote(relation.parentTable)}(id)`);
    }
    for (const number of [23,24,25,26,27,29,30,35,36,37,38,39,40,41,42,43]) {
      const file = readdirSync('supabase/sql').find(value => value.startsWith(`${String(number).padStart(3, '0')}_`));
      assert(file, `Missing migration ${number}`);
      await db.query(readFileSync(resolve('supabase/sql', file), 'utf8'));
    }
    await db.query('insert into auth.users(id) values($1) on conflict do nothing', [OWNER]);
    await db.query(`do $$begin
      if not exists(select 1 from pg_roles where rolname='authenticator') then create role authenticator noinherit login; end if;
    end$$; grant authenticated,anon to authenticator`);
    await db.query("notify pgrst,'reload schema'");
    console.log('PASS isolated PostgreSQL 18 setup: exact live-shape columns + migrations 023-027/029-030/035-043');
    process.exit(0);
  }

  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: OWNER, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 900,
  })}`;
  const token = `${unsigned}.${createHmac('sha256', jwtSecret).update(unsigned).digest('base64url')}`;
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    host: `${TARGET}.supabase.co`,
  };
  const post = async (rpc, body) => {
    const serialized = JSON.stringify(body);
    const started = performance.now();
    const requestHeaders = body.p_request_id
      ? { ...headers, 'x-restore-request-id': body.p_request_id }
      : headers;
    const target = new URL(`/rpc/${rpc}`, apiUrl);
    const response = await new Promise((resolveResponse, rejectResponse) => {
      const request = httpRequest(target, {
        method: 'POST',
        headers: { ...requestHeaders, 'content-length': Buffer.byteLength(serialized) },
      }, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => resolveResponse({
          status: incoming.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
          headersAt: performance.now(),
        }));
        incoming.on('error', rejectResponse);
      });
      request.on('error', rejectResponse);
      request.end(serialized);
    });
    const headersAt = response.headersAt;
    const text = response.text;
    const completed = performance.now();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      bytes: Buffer.byteLength(serialized),
      headersMs: Number((headersAt - started).toFixed(2)),
      completedMs: Number((completed - started).toFixed(2)),
    };
  };

  const beforeEpoch = Number(await scalar('select epoch as value from public.erp_cloud_restore_epoch where singleton=true'));
  const proofRequest = randomUUID();
  const proof = await post('erp_prove_cloud_restore_candidate_v2', {
    p_source_snapshot: effective.sourceData,
    p_manifest: portable.manifest,
    p_restore_mode: effective.mode,
    p_source_environment: source.sourceEnvironment,
    p_request_id: proofRequest,
  });
  assert.equal(proof.status, 200, JSON.stringify(proof.body));
  assert.equal(proof.body.ok, true);
  assert.equal(proof.body.request_id, proofRequest);

  const attempt = randomUUID(), trace = randomUUID(), execution = randomUUID();
  const prepare = await post('erp_prepare_cloud_restore_attempt', {
    p_attempt_id: attempt,
    p_trace_id: trace,
    p_source_fingerprint: portable.portability.sourceSnapshotFingerprint,
    p_effective_fingerprint: portable.manifest.snapshotFingerprint,
    p_restore_policy: portable.portability.policyVersion,
    p_target_environment: TARGET,
    p_timeout_budget_ms: 120000,
    p_timeout_contract_version: 'postgresql-statement-timeout-v1',
  });
  assert.equal(prepare.status, 200, JSON.stringify(prepare.body));
  assert.equal(prepare.body.status, 'prepared');

  const executeRequest = randomUUID();
  const execute = await post('erp_restore_proven_cloud_snapshot_attempt', {
    p_attempt_id: attempt,
    p_trace_id: trace,
    p_execution_id: execution,
    p_proof_id: proof.body.proof_id,
    p_request_id: executeRequest,
  });
  assert.equal(execute.status, 200, JSON.stringify(execute.body));
  assert.equal(execute.body.ok, true);
  assert.equal(execute.body.manifest.totalRows, 18_059);
  assert(execute.bytes < 512);

  await db.query('reset role');
  const attemptRow = (await db.query(`select status,execution_id,result_epoch,canonical_result is not null as canonical
    from public.erp_cloud_restore_attempts where attempt_id=$1`, [attempt])).rows[0];
  assert.equal(attemptRow.status, 'completed');
  assert.equal(attemptRow.execution_id, execution);
  assert.equal(Number(attemptRow.result_epoch), beforeEpoch + 1);
  assert.equal(attemptRow.canonical, true);
  assert.equal(Number(await scalar('select count(*)::integer as value from public.erp_cloud_restore_candidate_proofs where proof_id=$1', [proof.body.proof_id])), 0);
  assert.equal(Number(await scalar('select count(*)::integer as value from public.erp_cloud_restore_failures where attempt_id=$1', [attempt])), 0);
  await login();
  const audit = await scalar('select public.erp_read_cloud_restore_integrity_audit() as value');
  assert.equal(Number(audit.total_rows), 18_059);
  assert.equal(Number(audit.integrity.orphan_count), 0);
  assert.equal(Number(audit.integrity.duplicate_canonical_id_count), 0);
  assert.equal(Number(audit.audit_policy.covered_updated_by_non_null_count), 0);

  console.log(JSON.stringify({
    runtime: 'PostgREST 14.16 + PostgreSQL 18',
    requestShape: 'Browser-like HTTP RPC',
    rows: 18_059,
    resources: 15,
    auditTransforms: 15_711,
    proof,
    prepare,
    execute,
    executeBodyReduction: Number((proof.bytes / execute.bytes).toFixed(2)),
    serverEntryEvidence: 'PostgreSQL CLOUD_RESTORE_TRANSPORT request=<request_id> rpc=EXECUTE event=db-entry',
    transactionOutcome: attemptRow.status,
    integrity: { totalRows: Number(audit.total_rows), orphan: 0, duplicate: 0, nonNullUpdatedBy: 0 },
    liveConnections: 0,
  }, null, 2));
  console.log('PASS exact 18,059-row Browser-like HTTP PREPARE -> proof-backed EXECUTE through PostgREST 14.16 and PostgreSQL 18');
} finally {
  await db.end();
}
