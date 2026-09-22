import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const runtime = process.env.RESTORE_AUDIT_PGLITE_PATH
  || resolve('scratch/restore-audit-pg-runtime/node_modules/@electric-sql/pglite/dist');
const { PGlite } = await import(pathToFileURL(resolve(runtime, 'index.js')));
const { pgcrypto } = await import(pathToFileURL(resolve(runtime, 'contrib/pgcrypto.js')));
const db = new PGlite({ extensions: { pgcrypto } });
const migration = readFileSync(new URL('../supabase/sql/040_cloud_restore_owner_builder_proof.sql', import.meta.url), 'utf8');
const sql030 = readFileSync(new URL('../supabase/sql/030_cloud_restore_cross_environment_audit_identity_portability.sql', import.meta.url), 'utf8');
const sql036 = readFileSync(new URL('../supabase/sql/036_cloud_restore_final_closure.sql', import.meta.url), 'utf8');
const sql039 = readFileSync(new URL('../supabase/sql/039_cloud_restore_integrity_audit.sql', import.meta.url), 'utf8');
const snapshotPath = process.env.CLOUD_RESTORE_REALISTIC_SNAPSHOT
  || 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-20-114903.json';
const snapshotBytes = readFileSync(snapshotPath);
const snapshotHash = createHash('sha256').update(snapshotBytes).digest('hex');
const rawDocument = JSON.parse(snapshotBytes);
const OWNER = '11111111-1111-4111-8111-111111111111';
const NON_OWNER = '22222222-2222-4222-8222-222222222222';
const TARGET_HOST = 'rhfdjsklfrgpoqsaqpkn.supabase.co';

const block = (sql, start, end) => {
  const from = sql.indexOf(start);
  const to = sql.indexOf(end, from);
  assert(from >= 0 && to > from, `Missing SQL block: ${start}`);
  return sql.slice(from, to);
};
const validatorSql = block(
  sql030,
  'create or replace function public.erp_cloud_restore_validate_portability(',
  'revoke all on function public.erp_cloud_restore_validate_portability',
);
const rejectSql = block(
  sql036,
  'create or replace function public.erp_cloud_restore_reject_invalid_portable_row(',
  'revoke all on function public.erp_cloud_restore_reject_invalid_portable_row',
);
const builderSql = block(
  sql036,
  'create or replace function public.erp_cloud_restore_build_effective_snapshot(',
  'revoke all on function public.erp_cloud_restore_build_effective_snapshot',
);
const auditSql = block(
  sql039,
  'create function public.erp_cloud_restore_audit_dataset(',
  'revoke all on function public.erp_cloud_restore_audit_dataset',
);
const proofBody = block(migration, 'as $proof$', '$proof$;');
const executableProof = proofBody.replace(/--[^\n]*/gu, '');

assert.match(migration, /^begin;$/mu);
assert.match(migration, /^commit;$/mu);
assert.match(migration, /create function public\.erp_prove_cloud_restore_candidate\([\s\S]+p_source_snapshot jsonb[\s\S]+p_manifest jsonb[\s\S]+p_restore_mode text/iu);
assert.match(migration, /security definer[\s\S]+statement_timeout = '120s'/iu);
assert.match(migration, /grant execute on function public\.erp_prove_cloud_restore_candidate\(jsonb,jsonb,text\) to authenticated/iu);
assert.match(migration, /create function public\.erp_cloud_restore_canonical_json_text\(p_value jsonb\)[\s\S]+immutable[\s\S]+parallel safe/iu);
assert.match(migration, /revoke all on function public\.erp_cloud_restore_canonical_json_text\(jsonb\) from public,anon,authenticated/iu);
assert.doesNotMatch(executableProof, /\b(insert|update|delete|upsert|truncate|create|alter|drop)\b/iu);
assert.doesNotMatch(executableProof, /pg_(try_)?advisory_(xact_)?lock|erp_(prepare|begin|reconcile|restore)_cloud_restore/iu);
assert.equal((executableProof.match(/erp_cloud_restore_build_effective_snapshot/gu) || []).length, 1);
assert.equal((executableProof.match(/erp_cloud_restore_validate_portability/gu) || []).length, 1);
assert.equal((executableProof.match(/erp_cloud_restore_audit_dataset/gu) || []).length, 1);
assert.doesNotMatch(executableProof, /'snapshot'\s*,\s*v_effective|'snapshot'\s*,\s*p_source_snapshot/iu);

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
const portability = await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
await vite.close();
const source = await domain.prepareCloudRestoreSnapshot(snapshotBytes.toString('utf8'), {
  fileName: 'cloud-erp-snapshot-2026-09-20-114903.json',
  sourceFileSha256: snapshotHash,
});
const portable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(source, 'rhfdjsklfrgpoqsaqpkn');
const effective = await portability.assertCloudRestoreEffectiveCandidate(portable);
const tables = domain.CLOUD_RESTORE_TABLES.map(([, table]) => table);
assert.equal(source.manifest.totalRows, 17658);
assert.equal(source.data.inventory_items.length, 5517);
assert.equal(portable.portability.totalTransformedRows, 15395);
assert.equal(portable.manifest.snapshotFingerprint, '2539b3f7b64b3b4b65463a5fe76d0fff2e9edbde9cf7970fdcfc80a4bbd2787f');
assert.equal(portable.manifest.relationshipHash, 'b0a6a7441ee4dfbcef62a4f2f18bc6f6146d924ae382cceb6bf770a3946e059d');

try {
  await db.exec(`
    create schema auth; create schema extensions;
    create extension pgcrypto with schema extensions;
    create role authenticated; create role anon;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function public.is_owner(p_user uuid) returns boolean language sql stable as
      $$select p_user='${OWNER}'::uuid$$;
    grant usage on schema auth,extensions to authenticated,anon;
  `);
  for (const table of tables) {
    await db.exec(`create table public.${table}(
      id uuid primary key,
      updated_by uuid null references auth.users(id) on delete set null
    )`);
  }
  await db.exec(`
    create table public.erp_cloud_restore_epoch(singleton boolean primary key,epoch bigint not null);
    create table public.erp_cloud_restore_requests(id uuid primary key,status text);
    create table public.erp_cloud_restore_snapshots(id uuid primary key);
    create table public.erp_cloud_restore_attempts(id uuid primary key,status text);
    insert into public.erp_cloud_restore_epoch values(true,7);
  `);
  await db.exec(validatorSql);
  await db.exec("alter function public.erp_cloud_restore_validate_portability(jsonb,jsonb,text) set statement_timeout='120s'");
  await db.exec('revoke all on function public.erp_cloud_restore_validate_portability(jsonb,jsonb,text) from public,anon; grant execute on function public.erp_cloud_restore_validate_portability(jsonb,jsonb,text) to authenticated');
  await db.exec(rejectSql);
  await db.exec('alter function public.erp_cloud_restore_reject_invalid_portable_row(text) volatile');
  await db.exec('revoke all on function public.erp_cloud_restore_reject_invalid_portable_row(text) from public,anon,authenticated');
  await db.exec(builderSql);
  await db.exec('revoke all on function public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text) from public,anon,authenticated');
  await db.exec(auditSql);
  await db.exec('revoke all on function public.erp_cloud_restore_audit_dataset(jsonb) from public,anon,authenticated');

  const stub = signature => `create function public.${signature} returns jsonb language plpgsql volatile security definer
    set search_path=pg_catalog,public,extensions set statement_timeout='120s'
    as $$begin return '{}'::jsonb; end$$;`;
  await db.exec(stub('erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)', 5));
  await db.exec(stub('erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text)', 6));
  await db.exec(stub('erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)', 8));
  await db.exec('revoke all on function public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text) from public,anon,authenticated');
  await db.exec('revoke all on function public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text) from public,anon,authenticated');
  await db.exec('revoke all on function public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text) from public,anon; grant execute on function public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text) to authenticated');

  await db.exec(migration);
  const proof = async (data = effective.sourceData, manifest = portable.manifest, mode = effective.mode) => (
    await db.query(
      'select public.erp_prove_cloud_restore_candidate($1::jsonb,$2::jsonb,$3::text) as proof',
      [JSON.stringify(data), JSON.stringify(manifest), mode],
    )
  ).rows[0].proof;
  const state = async () => {
    const values = {};
    for (const table of [...tables, 'erp_cloud_restore_epoch', 'erp_cloud_restore_requests', 'erp_cloud_restore_snapshots', 'erp_cloud_restore_attempts']) {
      values[table] = (await db.query(`select count(*)::int n,coalesce(encode(extensions.digest(string_agg(to_jsonb(t)::text,',' order by to_jsonb(t)::text),'sha256'),'hex'),'') h from public.${table} t`)).rows[0];
    }
    values.locks = (await db.query("select count(*)::int n from pg_locks where locktype='advisory'")).rows[0].n;
    return values;
  };
  const sourceFingerprintFor = async data => domain.sha256Hex(domain.stableCloudRestoreJson(data));
  const manifestForChangedSource = async data => {
    const changed = structuredClone(portable.manifest);
    changed.portability.sourceSnapshotFingerprint = await sourceFingerprintFor(data);
    return changed;
  };

  const before = await state();
  await db.exec(`set request.jwt.claim.sub='${OWNER}'; set request.headers='{"host":"${TARGET_HOST}"}'; set role authenticated`);
  await db.exec('begin read only');
  const result = await proof();
  await db.exec('rollback');
  assert.equal(result.ok, true);
  assert.equal(result.candidate_valid, true);
  assert.equal(result.policy, 'cross-environment-audit-null-v1');
  assert.equal(result.resource_count, 15);
  assert.equal(result.coverage_count, 15);
  assert.equal(result.total_rows, 17658);
  assert.equal(result.transformed_updated_by_count, 15395);
  assert.equal(result.source_fingerprint, '068c83250fe07116f53538a290427f6148aa858a4e37041f4b6f4aa1d2603341');
  assert.equal(result.effective_fingerprint, '2539b3f7b64b3b4b65463a5fe76d0fff2e9edbde9cf7970fdcfc80a4bbd2787f');
  assert.equal(result.relationship_hash, 'b0a6a7441ee4dfbcef62a4f2f18bc6f6146d924ae382cceb6bf770a3946e059d');
  assert.deepEqual(result.table_counts, portable.manifest.counts);
  assert(Object.values(result.integrity).every(value => value === 0));
  await db.exec('reset role');
  assert.deepEqual(await state(), before, 'Proof must not change business rows, epoch, requests, snapshots, attempts or locks');
  await db.exec(`set request.jwt.claim.sub='${OWNER}'; set request.headers='{"host":"${TARGET_HOST}"}'; set role authenticated`);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(OWNER, 'u'));
  assert(!('snapshot' in result) && !('effective_snapshot' in result));

  await db.exec('begin read only');
  const strictResult = await proof(source.data, source.manifest, 'strict');
  await db.exec('rollback');
  assert.equal(strictResult.candidate_valid, true);
  assert.equal(strictResult.policy, 'strict');
  assert.equal(strictResult.transformed_updated_by_count, 0);
  assert.equal(strictResult.source_fingerprint, '068c83250fe07116f53538a290427f6148aa858a4e37041f4b6f4aa1d2603341');
  assert.equal(strictResult.effective_fingerprint, strictResult.source_fingerprint);

  for (const invalid of ['bad-string', null, []]) {
    const changed = structuredClone(effective.sourceData);
    changed.inventory_items[0] = invalid;
    const manifest = await manifestForChangedSource(changed);
    await assert.rejects(() => proof(changed, manifest), error => (
      error.code === '22023' && error.message === 'CLOUD_RESTORE_PORTABILITY_ROW_INVALID:inventory_items'
    ));
  }
  const missing = structuredClone(effective.sourceData);
  delete missing.inventory_items;
  const missingManifest = await manifestForChangedSource(missing);
  await assert.rejects(
    () => proof(missing, missingManifest),
    /CLOUD_RESTORE_PORTABILITY_COVERAGE_INVALID:inventory_items/u,
  );
  const unknown = structuredClone(effective.sourceData);
  unknown.unknown_resource = [];
  const unknownManifest = await manifestForChangedSource(unknown);
  await assert.rejects(
    () => proof(unknown, unknownManifest),
    /CLOUD_RESTORE_AUDIT_DATASET_INVALID/u,
  );
  const coverage = structuredClone(portable.manifest);
  delete coverage.portability.transformedCounts.inventory_items;
  await assert.rejects(() => proof(effective.sourceData, coverage), /CLOUD_RESTORE_PORTABILITY_COVERAGE_INVALID:inventory_items/u);
  const wrongFingerprint = structuredClone(portable.manifest);
  wrongFingerprint.snapshotFingerprint = '0'.repeat(64);
  await assert.rejects(() => proof(effective.sourceData, wrongFingerprint), /CLOUD_RESTORE_PROOF_EFFECTIVE_FINGERPRINT_MISMATCH/u);
  const wrongPolicy = structuredClone(portable.manifest);
  wrongPolicy.portability.policyVersion = 'unknown-policy';
  await assert.rejects(() => proof(effective.sourceData, wrongPolicy), /CLOUD_RESTORE_PROOF_POLICY_INVALID/u);
  await db.exec("set request.headers='{\"host\":\"wrong-project.supabase.co\"}'");
  await assert.rejects(() => proof(), /CLOUD_RESTORE_PROOF_TARGET_MISMATCH/u);
  await db.exec(`set request.headers='{"host":"${TARGET_HOST}"}'`);

  await db.exec('reset role');
  await db.exec(`set request.jwt.claim.sub='${NON_OWNER}'; set request.headers='{"host":"${TARGET_HOST}"}'; set role authenticated`);
  await assert.rejects(() => proof(), error => error.code === '42501' && error.message === 'CLOUD_RESTORE_OWNER_REQUIRED');
  await db.exec('reset role');
  await db.exec(`set request.jwt.claim.sub=''; set request.headers='{"host":"${TARGET_HOST}"}'; set role anon`);
  await assert.rejects(() => proof(), error => error.code === '42501' && /permission denied/u.test(error.message));
  await db.exec('reset role');
  await db.exec(`set request.jwt.claim.sub='${OWNER}'; set request.headers='{"host":"${TARGET_HOST}"}'; set role authenticated`);
  for (const call of [
    "select public.erp_cloud_restore_build_effective_snapshot('{}','{}','strict')",
    "select public.erp_restore_cloud_snapshot(null,null,null,null,null)",
    "select public.erp_restore_cloud_snapshot_effective(null,null,null,null,null,null)",
  ]) await assert.rejects(() => db.exec(call), /permission denied/u);
  await db.exec('reset role');

  const postflight = migration.slice(migration.indexOf('do $proof_postflight$'), migration.lastIndexOf('commit;'));
  await db.exec('begin');
  await db.exec('grant execute on function public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text) to anon');
  await assert.rejects(() => db.exec(postflight), /CLOUD_RESTORE_PROOF_POSTFLIGHT_CONTRACT_MISMATCH/u);
  await db.exec('rollback');
  await assert.rejects(() => db.exec(migration), error => error.code === '42710' && error.message === 'CLOUD_RESTORE_PROOF_COLLISION');
  await db.exec('rollback');
  assert.equal(createHash('sha256').update(readFileSync(snapshotPath)).digest('hex'), snapshotHash);
  console.log(JSON.stringify({
    status: 'PASS',
    engine: (await db.query('select version() v')).rows[0].v,
    rpc: 'public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)',
    resources: result.resource_count,
    rows: result.total_rows,
    inventoryRows: result.table_counts.inventory_items,
    transformedUpdatedBy: result.transformed_updated_by_count,
    effectiveFingerprint: result.effective_fingerprint,
    relationshipHash: result.relationship_hash,
    destructiveCalls: 0,
    negativeCases: 11,
    stagingCalls: 0,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', code: error.code, message: error.message, location: error.where }));
  process.exitCode = 1;
} finally {
  await db.close();
}
