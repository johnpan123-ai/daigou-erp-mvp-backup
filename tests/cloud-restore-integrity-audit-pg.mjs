import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createServer } from 'vite';

// Real isolated PostgreSQL (WASM), never a Staging connection. Install separately:
// npm install --prefix scratch/restore-audit-pg-runtime --no-save --package-lock=false --ignore-scripts @electric-sql/pglite@0.5.8
const runtime = process.env.RESTORE_AUDIT_PGLITE_PATH
  || resolve('scratch/restore-audit-pg-runtime/node_modules/@electric-sql/pglite/dist');
const { PGlite } = await import(pathToFileURL(resolve(runtime, 'index.js')));
const { pgcrypto } = await import(pathToFileURL(resolve(runtime, 'contrib/pgcrypto.js')));
const db = new PGlite({ extensions: { pgcrypto } });
const sql = readFileSync(new URL('../supabase/sql/039_cloud_restore_integrity_audit.sql', import.meta.url), 'utf8');
const snapshotPath = process.env.RESTORE_AUDIT_SNAPSHOT
  || 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-21-125752.json';
const bytes = readFileSync(snapshotPath);
const hash = data => createHash('sha256').update(data).digest('hex');
assert.equal(hash(bytes), '5a8e33d49da3d731cf4d876476a6eb341acadf7aa50abf3f971dbab6fc1dfaa6');
const document = JSON.parse(bytes);
const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
const auditDomain = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreIntegrityAudit.ts');
const { CLOUD_RESTORE_RELATIONS } = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreRelations.ts');
const candidate = await domain.prepareCloudRestoreSnapshot(document);
await vite.close();
const data = structuredClone(candidate.data);
let transformed = 0;
for (const rows of Object.values(data)) for (const row of rows) {
  if (row.updated_by != null) transformed++;
  row.updated_by = null;
}
assert.equal(transformed, 15443);
const tables = domain.CLOUD_RESTORE_TABLES.map(([, table]) => table);
const expectedHash = 'd735fe0de5b42684b798493a6928d5936dc5a93ead21d83c022ee9f94f1f7bad';
assert.equal(candidate.manifest.relationshipHash, expectedHash);
for (const rel of CLOUD_RESTORE_RELATIONS) assert(sql.includes(
  "('" + rel.childTable + "','" + rel.field + "','" + rel.parentTable + "'," + rel.optional + ')'
), 'SQL relation contract must match canonical TS relation spec');

// Runtime function bodies contain no write/restore/reconcile or dynamic SQL calls.
for (const body of [...sql.matchAll(/as \$(audit_dataset|audit_read)\$([\s\S]*?)\$\1\$/g)].map(m => m[2])) {
  const executable = body.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(executable, /\b(insert|update|delete|truncate|alter|create|execute|perform)\b/i);
  assert.doesNotMatch(executable, /pg_(try_)?advisory_(xact_)?lock|erp_(reconcile|prepare|begin|restore)_/i);
}

try {
  await db.exec(`
    create schema auth; create schema extensions;
    create extension pgcrypto with schema extensions;
    create role authenticated; create role anon;
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function public.is_owner(p_user uuid) returns boolean language sql stable as
      $$select p_user='11111111-1111-4111-8111-111111111111'::uuid$$;
    create table public.erp_cloud_restore_epoch(singleton boolean,epoch bigint);
    create table public.erp_cloud_restore_snapshots(id uuid);
    create table public.erp_cloud_restore_requests(
      idempotency_key uuid,status text,rollback_snapshot_id uuid,canonical_result jsonb,completed_at timestamptz);
    create table public.erp_cloud_restore_attempts(
      attempt_id uuid,status text,result_epoch bigint,completed_at timestamptz,canonical_result jsonb,
      source_fingerprint text,effective_fingerprint text,restore_policy text,actor_key text);
    alter table public.erp_cloud_restore_attempts enable row level security;
    create policy own_actor on public.erp_cloud_restore_attempts for select to authenticated
      using(actor_key=auth.uid()::text);
    grant usage on schema auth to authenticated,anon;
    grant select on public.erp_cloud_restore_attempts to authenticated;
  `);
  // Minimal real table fixtures contain normalized canonical rows and all their columns.
  // Column values used by the audit are text/NULL; no snapshot is printed or written.
  for (const table of tables) {
    const fields = [...new Set(['id', 'updated_by', ...data[table].flatMap(Object.keys),
      ...CLOUD_RESTORE_RELATIONS.filter(r=>r.childTable===table).map(r=>r.field)])];
    await db.exec('create table public.' + table + ' (' + fields.map(f => '"' + f + '" text').join(',') + ')');
    if (data[table].length) {
      const projected = data[table].map(row => Object.fromEntries(fields.map(f => [
        f, row[f] == null ? null : typeof row[f] === 'object' ? JSON.stringify(row[f]) : String(row[f]),
      ])));
      await db.query('insert into public.' + table + ' select * from jsonb_populate_recordset(null::public.' + table + ',$1::jsonb)', [JSON.stringify(projected)]);
    }
  }
  const effectiveFingerprint='5591800cd0c402e84312f66d9c8aaeecacd971b1a72f0e628dca1efcc6f93a8f';
  const manifest = { ...candidate.manifest, snapshotFingerprint:effectiveFingerprint, portability: { totalTransformedRows: transformed } };
  const attemptId = '22222222-2222-4222-8222-222222222222';
  const rollbackId = '33333333-3333-4333-8333-333333333333';
  const result = { manifest, replayed: false, restoreEpoch: 5, snapshotFingerprint:effectiveFingerprint };
  await db.exec('insert into public.erp_cloud_restore_epoch values(true,5)');
  await db.query('insert into public.erp_cloud_restore_snapshots values($1)', [rollbackId]);
  await db.query('insert into public.erp_cloud_restore_requests values($1,$2,$3,$4,now())', [attemptId,'completed',rollbackId,JSON.stringify(result)]);
  await db.query('insert into public.erp_cloud_restore_attempts values($1,$2,5,now(),$3,$4,$5,$6,$7)',
    [attemptId,'completed',JSON.stringify(result),candidate.manifest.snapshotFingerprint,'5591800cd0c402e84312f66d9c8aaeecacd971b1a72f0e628dca1efcc6f93a8f',
      'cross-environment-audit-null-v1','11111111-1111-4111-8111-111111111111']);
  const preflight=sql.slice(sql.indexOf('do $audit_preflight$'),sql.indexOf('-- Private pure computation;'));
  await db.exec('begin');
  await db.exec('alter table public.inventory_items rename column updated_by to unexpected_audit_column');
  await assert.rejects(()=>db.exec(preflight),e=>e.message==='CLOUD_RESTORE_AUDIT_SCHEMA_MISMATCH');
  await db.exec('rollback');
  await db.exec(sql); // Actual candidate, including preflight, function bodies, ACL and postflight.
  const audit = async () => (await db.query('select public.erp_read_cloud_restore_integrity_audit() as audit')).rows[0].audit;
  const summary = async d => (await db.query('select public.erp_cloud_restore_audit_dataset($1::jsonb) as audit', [JSON.stringify(d)])).rows[0].audit;
  const wholeState = async () => {
    const all=[...tables,'erp_cloud_restore_attempts','erp_cloud_restore_requests','erp_cloud_restore_epoch','erp_cloud_restore_snapshots'];
    const hashes=[];
    for(const table of all) {
      hashes.push((await db.query("select encode(extensions.digest(coalesce(string_agg(to_jsonb(t)::text,',' order by to_jsonb(t)::text),''),'sha256'),'hex') h from public."+table+" t")).rows[0].h);
    }
    return hashes;
  };
  const stateBefore=await wholeState();
  const before = await db.query(`select
    (select jsonb_agg(to_jsonb(t)) from public.erp_cloud_restore_attempts t) as attempts,
    (select jsonb_agg(to_jsonb(t)) from public.erp_cloud_restore_epoch t) as epoch,
    (select count(*) from pg_locks where locktype='advisory') as locks`);
  await db.exec("set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111'; set role authenticated;");
  await db.exec('begin read only');
  const actual = await audit();
  await db.exec('rollback; reset role;');
  assert.deepEqual(actual.table_counts, document.manifest.counts);
  assert.equal(actual.total_rows, 17776);
  assert.equal(actual.relationship_hash, expectedHash);
  assert.equal(actual.epoch, 5);
  assert.equal(actual.audit_policy.covered_updated_by_non_null_count, 0);
  assert.equal(actual.audit_policy.covered_updated_by_null_count, 17776);
  assert.equal(actual.restore_state.latest_completed.source_transformed_updated_by_count, 15443);
  assert.equal(actual.restore_state.partial_state, 'not_detected');
  assert.deepEqual(actual.comparison, { counts_match: true, relationship_hash_match: true });
  assert(Object.values(actual.integrity).every(n => n === 0));
  // Parity beyond this snapshot: relation values retain whitespace/escaping,
  // Unicode and NULL; empty sales resources must also participate when populated.
  const edge=structuredClone(data);
  edge.inventory_items[0].product_id=' spaced " Unicode 河馬 \\ \n ';
  edge.inventory_items[0].latest_catalog_import_id=null;
  edge.sales_orders.push({id:'77777777-7777-4777-8777-777777777777'});
  edge.sales_order_items.push({id:'88888888-8888-4888-8888-888888888888',order_id:edge.sales_orders[0].id,product_variant_id:null});
  const edgeManifest=await domain.rebuildCurrentCloudRestoreCandidate(edge);
  assert.equal((await summary(edge)).relationship_hash,edgeManifest.manifest.relationshipHash);
  const whitespace=structuredClone(data);
  whitespace.product_variants[0].local_id='\t trimmed\u00a0';
  whitespace.product_variants[1].local_id='trimmed';
  whitespace.product_groups[0].normalized_title='\ufeffunknown product\n';
  assert.equal((await summary(whitespace)).integrity.duplicate_variant_local_id_count,1);
  assert.equal((await summary(whitespace)).integrity.unknown_product_count,1);
  assert.equal(auditDomain.cloudRestoreAuditVerdict(auditDomain.parseCloudRestoreIntegrityAudit(actual)),'PASS',
    'Real PostgreSQL response must pass the production DTO parser and verdict');
  assert.deepEqual(await wholeState(),stateBefore,'All business values + request/snapshot/attempt metadata unchanged');
  const after = await db.query(`select
    (select jsonb_agg(to_jsonb(t)) from public.erp_cloud_restore_attempts t) as attempts,
    (select jsonb_agg(to_jsonb(t)) from public.erp_cloud_restore_epoch t) as epoch,
    (select count(*) from pg_locks where locktype='advisory') as locks`);
  assert.deepEqual(after.rows, before.rows, 'Read audit must not mutate epoch, attempts or locks');
  assert.equal((await audit()).relationship_hash, expectedHash);
  for (const [role, subject, message] of [
    ['authenticated','44444444-4444-4444-8444-444444444444','CLOUD_RESTORE_OWNER_REQUIRED'],
    ['authenticated','','AUTHENTICATION_REQUIRED'],
    ['anon','','permission denied'],
  ]) {
    await db.exec("set request.jwt.claim.sub='" + subject + "'; set role " + role);
    await assert.rejects(audit, e => e.code==='42501' && e.message.includes(message));
    await assert.rejects(() => summary(data), e => e.code==='42501', 'Private computation cannot be called by clients');
    await db.exec('reset role');
  }
  await db.exec("set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111'");
  const cases = [
    ['orphan_count', d => { d.product_variants[0].product_group_id='ffffffff-ffff-4fff-8fff-ffffffffffff'; }],
    ['duplicate_variant_id_count', d => { d.product_variants.push({...d.product_variants[0]}); }],
    ['duplicate_variant_local_id_count', d => { d.product_variants[1].local_id=d.product_variants[0].local_id='duplicate'; }],
    ['duplicate_canonical_id_count', d => { d.product_groups.push({...d.product_groups[0]}); }],
    ['canonical_identity_anomaly_count', d => { d.product_groups[0].id='invalid'; }],
    ['unknown_product_count', d => { d.product_groups[0].normalized_title='未知商品'; }],
    ['duplicate_inventory_key_count', d => { d.inventory_items[1].inventory_key=d.inventory_items[0].inventory_key; }],
    ['missing_inventory_key_count', d => { d.inventory_items[0].inventory_key=''; }],
  ];
  for (const [field, mutate] of cases) {
    const d=structuredClone(data); mutate(d);
    assert((await summary(d)).integrity[field]>0, field);
  }
  const nonnull=structuredClone(data); nonnull.inventory_items[0].updated_by='source-identity';
  assert.equal((await summary(nonnull)).audit_policy.covered_updated_by_non_null_count,1);
  for (const bad of ['string',null,[]]) {
    const d=structuredClone(data); d.inventory_items[0]=bad;
    await assert.rejects(() => summary(d), /CLOUD_RESTORE_AUDIT_ROW_INVALID/);
  }
  const missing=structuredClone(data); delete missing.inventory_items;
  await assert.rejects(() => summary(missing), /CLOUD_RESTORE_AUDIT_DATASET_INVALID/);
  // Pure observer sees OTHER owners' pending work despite the direct table RLS.
  await db.query("insert into public.erp_cloud_restore_attempts(attempt_id,status,actor_key) values($1,'executing','another-owner')",
    ['55555555-5555-4555-8555-555555555555']);
  await db.exec('set role authenticated');
  assert.equal((await db.query("select count(*)::int n from public.erp_cloud_restore_attempts where status='executing'")).rows[0].n,0);
  assert.equal((await audit()).restore_state.executing_count,1);
  assert.equal((await audit()).restore_state.partial_state,'unproven');
  await db.exec('reset role');
  await db.query("insert into public.erp_cloud_restore_attempts(attempt_id,status,actor_key) values($1,'prepared','another-owner')",
    ['66666666-6666-4666-8666-666666666666']);
  assert.equal((await audit()).restore_state.pending_count,1);
  // Only the isolated fixture acquires a test lock; audit must leave it unchanged.
  await db.exec("select pg_advisory_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0))");
  assert.equal((await audit()).restore_state.active_lock_count,1);
  assert.equal((await audit()).restore_state.active_lock_count,1);
  await db.exec("select pg_advisory_unlock(hashtextextended('erp-cloud-restore-maintenance-lock',0))");
  await db.exec('begin');
  await db.exec('update public.erp_cloud_restore_epoch set epoch=6');
  assert.equal((await audit()).restore_state.metadata_inconsistency_count,1);
  assert.equal((await audit()).restore_state.partial_state,'inconsistent');
  await db.exec('rollback');
  // Unknown overload/collision and weakened ACL are fail-closed, using actual artifact blocks.
  await assert.rejects(()=>db.exec(sql),e=>e.code==='42710'&&e.message==='CLOUD_RESTORE_AUDIT_COLLISION');
  await db.exec('rollback');
  const postflight=sql.slice(sql.indexOf('do $audit_postflight$'),sql.lastIndexOf('commit;'));
  await db.exec('begin');
  await db.exec('grant execute on function public.erp_cloud_restore_audit_dataset(jsonb) to authenticated');
  await assert.rejects(()=>db.exec(postflight),e=>e.message==='CLOUD_RESTORE_AUDIT_POSTFLIGHT_FAILED');
  await db.exec('rollback');
  assert.equal(hash(readFileSync(snapshotPath)),hash(bytes),'Original file unchanged');
  console.log(JSON.stringify({status:'PASS', engine:(await db.query('select version() v')).rows[0].v,
    resources:15,rawRows:17776,relationshipHash:actual.relationship_hash,sourceTransforms:transformed,
    targetAuditNonNull:0,authCases:3,negativeCases:cases.length+4,stagingCalls:0,
    fixtureScope:'isolated normalized tables + real 039; not a hosted migration apply'},null,2));
} catch (error) {
  console.error(JSON.stringify({status:'FAIL',code:error.code,message:error.message,location:error.where}));
  process.exitCode=1;
} finally { await db.close(); }
