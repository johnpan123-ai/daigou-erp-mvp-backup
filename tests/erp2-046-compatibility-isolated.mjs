import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';
import { buildMigrationEffectRegistry } from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import { planSchemaDelta } from '../tools/schema-reconciliation/reconcile.mjs';
import { fingerprintStructuralSnapshot } from '../tools/schema-reconciliation/schemaContract.mjs';

const rawUrl = process.env.WACA_ISOLATED_PG_URL;
if (!rawUrl) throw new Error('Set WACA_ISOLATED_PG_URL to the disposable loopback PostgreSQL cluster.');
const baseUrl = new URL(rawUrl);
assert.equal(baseUrl.hostname, '127.0.0.1');
assert.equal(baseUrl.port, '55492');
assert.ok(baseUrl.pathname.startsWith('/waca_v3_'));

const databaseName = `waca_v3_046_${randomBytes(4).toString('hex')}`;
const adminUrl = new URL(baseUrl); adminUrl.pathname = '/postgres';
const testUrl = new URL(baseUrl); testUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const sql = new pg.Client({ connectionString: testUrl.toString() });
const original046Index = CANONICAL_FRESH_INSTALL_V3.indexOf('046_waca_myacg_parent_evidence.sql');
const secret = 'isolated-erp2-046-postgrest-secret-32-bytes';
const origin = 'http://127.0.0.1:4398';
const ownerId = '00000000-0000-4000-8000-000000000099';
let server;
let serverOutput = '';

const read = file => readFileSync(file, 'utf8');
const jwt = sub => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role: 'authenticated', sub,
    exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const content = `${header}.${payload}`;
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`;
};
const http = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${origin}${path}`, { method, headers: {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
};
const capture = async () => {
  const snapshot = (await sql.query(read('tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql')))
    .rows[0].erp_schema_snapshot;
  snapshot.integrity.inventoryItems = (await sql.query(read('tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql')))
    .rows[0].inventory_items_integrity;
  snapshot.completeness.inventoryIntegrity = true;
  snapshot.identity.projectRef = 'rhfdjsklfrgpoqsaqpkn';
  return snapshot;
};
const apply = async files => {
  for (const file of files) await sql.query(read(`supabase/sql/${file}`));
};
const rowDigest = async () => (await sql.query(`select md5(coalesce(string_agg(
  id::text||'|'||inventory_key||'|'||myacg_item_code||'|'||product_title||'|'||version::text,
  E'\\n' order by inventory_key),'')) digest from public.inventory_items`)).rows[0].digest;

await admin.connect();
await admin.query(`create database ${databaseName}`);
await sql.connect();
try {
  await sql.query(`
    create schema extensions;
    create extension pgcrypto with schema extensions;
    do $$ begin
      if to_regrole('anon') is null then create role anon nologin; end if;
      if to_regrole('authenticated') is null then create role authenticated nologin; end if;
      if to_regrole('service_role') is null then create role service_role nologin; end if;
    end $$;
    create schema auth;
    create schema storage;
    create schema realtime;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub',true),'')::uuid,
        (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid)
    $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    create publication supabase_realtime;
  `);
  await apply(CANONICAL_FRESH_INSTALL_V3.slice(0, original046Index));
  await sql.query(`
    insert into auth.users(id,email,raw_user_meta_data)
      values('${ownerId}','owner@example.com','{}'::jsonb),
        ('00000000-0000-4000-8000-000000000098','viewer@example.com','{}'::jsonb);
    update public.profiles set role='owner' where user_id='${ownerId}';
    insert into public.inventory_items(inventory_key,myacg_item_code,product_title)
      select 'inventory-'||lpad(value::text,5,'0'),'G'||lpad(value::text,8,'0'),'Product '||value
      from generate_series(1,5568) value;
    grant maintain,references,trigger,truncate on table public.inventory_items to anon;
    grant delete,insert,maintain,references,select,trigger,truncate,update
      on table public.inventory_items to authenticated;
    grant select,update on table public.inventory_items to service_role;
  `);
  const beforeCount = Number((await sql.query('select count(*) count from public.inventory_items')).rows[0].count);
  const beforeDigest = await rowDigest();
  assert.equal(beforeCount, 5568);
  const repairSql = read('supabase/sql/046b_waca_myacg_parent_compatibility_repair.sql');
  for (const [label, setup, expected] of [
    ['column', 'alter table public.inventory_items add column myacg_parent_code integer', /WACA_MYACG_REPAIR_COLUMN_CONFLICT/u],
    ['index', `alter table public.inventory_items add column myacg_parent_code text;
      create index inventory_items_myacg_parent_code_idx on public.inventory_items(myacg_parent_code)`,
    /WACA_MYACG_REPAIR_INDEX_CONFLICT/u],
    ['overload', `create function public.erp_apply_field_mutations(uuid,jsonb) returns jsonb
      language sql as $$ select '{}'::jsonb $$`, /WACA_MYACG_REPAIR_FUNCTION_SIGNATURE_CONFLICT/u],
    ['identity', `alter table public.inventory_items drop constraint inventory_items_pkey;
      alter table public.inventory_items add primary key(inventory_key)`, /WACA_MYACG_REPAIR_UUID_IDENTITY_MISMATCH/u],
    ['acl', 'grant select on table public.inventory_items to anon', /WACA_MYACG_REPAIR_TABLE_ACL_CONFLICT/u],
  ]) {
    await sql.query('begin');
    await sql.query(setup);
    await assert.rejects(() => sql.query(repairSql), expected, `${label} conflict must fail closed`);
    await sql.query('rollback');
  }
  assert.equal(await rowDigest(), beforeDigest);
  console.log('PASS native PostgreSQL unsafe column/index/overload/PK/ACL states fail closed and roll back');
  const preflight = (await sql.query(read('tools/schema-reconciliation/sql/046b-preconditions-readonly.sql')))
    .rows[0].waca_parent_repair_preconditions;
  assert.equal(preflight.result, 'PASS');
  assert.equal(preflight.state, 'SAFE_TO_CREATE');
  assert.equal(Number(preflight.rowCount), 5568);
  assert.deepEqual(preflight.primaryKey, ['id']);

  const registry = await buildMigrationEffectRegistry();
  const beforeSnapshot = await capture();
  const beforePlan = planSchemaDelta(beforeSnapshot, registry, { expectedSnapshot: beforeSnapshot });
  assert.equal(beforePlan.migrations.find(item => item.migrationId === '046').state, 'CONFLICT');
  assert.equal(beforePlan.migrations.find(item => item.migrationId === '046').coveredByRepair, '046b');
  assert.equal(beforePlan.migrations.find(item => item.migrationId === '046b').safeToApply, true);

  await apply(['046b_waca_myacg_parent_compatibility_repair.sql']);
  const repairedFingerprint = fingerprintStructuralSnapshot(await capture());
  await apply(['046b_waca_myacg_parent_compatibility_repair.sql']);
  assert.equal(fingerprintStructuralSnapshot(await capture()), repairedFingerprint);
  await apply(['047_erp_schema_migration_ledger.sql']);

  const postflight = (await sql.query(read('tools/schema-reconciliation/sql/046b-postflight-readonly.sql')))
    .rows[0].waca_parent_repair_postflight;
  assert.equal(postflight.result, 'PASS');
  assert.equal(Number(postflight.rowCount), 5568);
  assert.equal(await rowDigest(), beforeDigest);
  assert.deepEqual(postflight.anonPrivileges, []);
  assert.deepEqual(postflight.authenticatedPrivileges, ['SELECT']);
  const serviceAcl = (await sql.query(`select has_table_privilege('service_role','public.inventory_items','SELECT') can_select,
    has_table_privilege('service_role','public.inventory_items','UPDATE') can_update`)).rows[0];
  assert.deepEqual(serviceAcl, { can_select: true, can_update: true });
  console.log('PASS native PostgreSQL 18: 5,568 rows and UUID identity preserved; 046b replay is idempotent; ACL is canonical');

  server = spawn('wsl', ['-e', 'env', `PGRST_DB_URI=${testUrl.toString()}`,
    'PGRST_DB_SCHEMAS=public', 'PGRST_DB_ANON_ROLE=anon', `PGRST_JWT_SECRET=${secret}`,
    'PGRST_SERVER_HOST=127.0.0.1', 'PGRST_SERVER_PORT=4398',
    '/tmp/hippo-waca-v3-postgrest-bin/postgrest'], { stdio: ['ignore','pipe','pipe'] });
  server.stdout.on('data', bytes => { serverOutput += String(bytes); });
  server.stderr.on('data', bytes => { serverOutput += String(bytes); });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${origin}/`)).ok) { ready = true; break; } } catch { /* startup */ }
    if (server.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Isolated PostgREST did not start: ${serverOutput.slice(-2000)}`);

  const owner = jwt(ownerId);
  const nonOwner = jwt('00000000-0000-4000-8000-000000000098');
  assert.ok((await http('/inventory_items?select=id&limit=1')).status >= 400);
  assert.equal((await http('/inventory_items?select=id&limit=1', { token: owner })).status, 200);
  assert.equal((await http('/inventory_items?select=id&limit=1', { token: nonOwner })).status, 200);
  assert.ok((await http('/inventory_items', { method: 'POST', token: owner,
    body: { inventory_key: 'direct-write', myacg_item_code: 'G-DIRECT', product_title: 'Denied' } })).status >= 400);
  const first = (await sql.query(`select id,version from public.inventory_items order by inventory_key limit 1`)).rows[0];
  const patched = await http('/rpc/erp_apply_field_mutations', { method: 'POST', token: owner, body: {
    p_entity: 'inventory_items', p_operations: [{ kind: 'patch', id: first.id,
      observedVersion: first.version, changes: { myacg_parent_code: 'GP0001' }, expected: { myacg_parent_code: null } }],
  } });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  assert.equal(patched.data.ok, true);
  assert.equal((await http('/rpc/erp_apply_field_mutations', { method: 'POST', token: nonOwner, body: {
    p_entity: 'inventory_items', p_operations: [{ kind: 'patch', id: first.id,
      observedVersion: first.version + 1, changes: { myacg_parent_code: 'GP0002' }, expected: { myacg_parent_code: 'GP0001' } }],
  } })).status, 403);
  assert.equal((await http('/rpc/erp_read_waca_snapshot', { method: 'POST', token: owner, body: {} })).status, 200);
  assert.equal((await http('/rpc/erp_read_waca_snapshot', { method: 'POST', token: nonOwner, body: {} })).status, 403);
  console.log('PASS isolated PostgREST: anon denied, authenticated reads preserved, direct write denied, owner CAS/WACA RPC preserved, non-owner RPC denied');
} finally {
  server?.kill();
  await sql.end();
  await admin.query(`drop database ${databaseName} with (force)`);
  await admin.end();
}

console.log(JSON.stringify({ result: 'PASS', engine: 'PostgreSQL 18 + PostgREST 16.4', rows: 5568, liveMutation: 0 }));
