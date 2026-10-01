import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';

const url = new URL(process.env.WACA_ISOLATED_PG_URL || 'invalid:');
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55492');
assert.ok(url.pathname.startsWith('/waca_v3_'));
const name = `waca_v3_fields_${randomBytes(4).toString('hex')}`;
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const testUrl = new URL(url); testUrl.pathname = `/${name}`;
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const sql = new pg.Client({ connectionString: testUrl.toString() });
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = '00000000-0000-4000-8000-000000000099';
const mutation = async (entity, operations) => (await sql.query('select public.erp_apply_field_mutations($1,$2::jsonb) result', [entity, JSON.stringify(operations)])).rows[0].result;
const readVariant = async () => (await sql.query('select * from public.product_variants where id=$1', [id(3)])).rows[0];
const patch = (row, changes) => ({ kind: 'patch', id: row.id, observedVersion: row.version,
  expected: Object.fromEntries(Object.keys(changes).map(field => [field,
    field === 'default_jpy_cost' || field === 'default_twd_cost' ? (row[field] === null ? null : Number(row[field])) : row[field]])), changes });
await admin.connect();
await admin.query(`create database ${name}`);
try {
  await sql.connect();
  await sql.query(`create schema extensions; create extension pgcrypto with schema extensions;
    do $$ begin
      if to_regrole('anon') is null then create role anon nologin; end if;
      if to_regrole('authenticated') is null then create role authenticated nologin; end if;
      if to_regrole('service_role') is null then create role service_role nologin; end if;
    end $$;
    create schema auth; create schema storage; create schema realtime;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub',true),'')::uuid,
        (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid)
    $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create publication supabase_realtime;`);
  for (const file of CANONICAL_FRESH_INSTALL_V3) await sql.query(readFileSync(`supabase/sql/${file}`, 'utf8'));
  await sql.query(`insert into auth.users(id,email,raw_user_meta_data) values($1,'isolated@example.invalid','{}');`, [owner]);
  await sql.query('update public.profiles set role=$1 where user_id=$2', ['owner', owner]);
  await sql.query('select set_config($1,$2,false)', ['request.jwt.claim.sub', owner]);
  await sql.query(`insert into public.product_groups(id,title) values($1,'Isolated 玩偶');
  `, [id(1)]);
  await sql.query('insert into public.product_categories(id,product_group_id,title) values($1,$2,$3)', [id(2), id(1), '規格']);
  await sql.query(`insert into public.product_variants(id,product_group_id,product_category_id,myacg_item_code,product_title,variant_name,default_jpy_cost)
    values($1,$2,$3,'TEST-G001','Isolated 玩偶','玩偶',100)`, [id(3), id(1), id(2)]);
  for (const [field, value] of Object.entries({ default_jpy_cost: 4500, default_twd_cost: 1200,
    myacg_manual_adjustment: 3, waca_manual_adjustment: 2, private_manual_adjustment: 4,
    purchased_manual_adjustment: 1, note: 'isolated', variant_name: '玩偶 B', myacg_item_code: 'TEST-G002' })) {
    const before = await readVariant();
    const result = await mutation('product_variants', [patch(before, { [field]: value })]);
    assert.equal(result.ok, true, field);
    const after = await readVariant();
    assert.equal(typeof value === 'number' ? Number(after[field]) : after[field], value); assert.equal(after.version, before.version + 1);
    assert.equal(after.updated_by, owner);
    assert.ok(new Date(after.updated_at) >= new Date(before.updated_at));
  }
  // A second save uses the acknowledged server value/version; stale clients
  // still conflict on the touched field, not last-write-wins.
  const stale = await readVariant();
  assert.equal((await mutation('product_variants', [patch(stale, { default_jpy_cost: 4600 })])).ok, true);
  const conflict = await mutation('product_variants', [patch(stale, { default_jpy_cost: 4700 })]);
  assert.equal(conflict.code, 'FIELD_CONFLICT');
  assert.equal(Number((await readVariant()).default_jpy_cost), 4600);
  assert.equal((await mutation('product_variants', [patch(await readVariant(), { default_jpy_cost: 4800, default_twd_cost: 1300 })])).ok, true);
  for (const field of ['updated_at', 'created_at', 'version', 'id', 'unknown_field']) {
    const before = await readVariant();
    await assert.rejects(mutation('product_variants', [patch(before, { [field]: field.endsWith('_at') ? new Date().toISOString() : 99 })]));
    assert.deepEqual(await readVariant(), before, `${field} rejection changed data`);
  }
  await sql.query('insert into public.private_orders(id,product_group_id,customer_name,status) values($1,$2,$3,$4)', [id(4), id(1), 'Synthetic', 'pending']);
  assert.equal((await mutation('private_orders', [{ kind: 'patch', id: id(4), observedVersion: 1,
    expected: { status: 'pending' }, changes: { status: 'completed' } }])).ok, true);
  const beforeRollback = await readVariant();
  const badSecond = { ...patch(beforeRollback, { note: 'uncommitted' }), id: id(999) };
  assert.equal((await mutation('product_variants', [patch(beforeRollback, { default_jpy_cost: 9900 }), badSecond])).ok, false);
  assert.deepEqual(await readVariant(), beforeRollback, 'Multi-operation failure partially committed');
  const backup = (await sql.query('select public.erp_export_cloud_restore_snapshot() result')).rows[0].result;
  assert.ok(backup && typeof backup === 'object');
  console.log('PASS native PostgreSQL canonical chain; price/status/quantities/private/multi-field/second-save readback');
  console.log('PASS server-owned timestamps; system/identity/unknown rejection; CAS stale conflict; atomic multi-operation rollback');
  console.log('Live business writes=0; disposable database only');
} finally {
  await sql.end();
  await admin.query(`drop database ${name} with (force)`);
  await admin.end();
}
