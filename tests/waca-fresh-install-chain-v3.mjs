import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';
import { CANONICAL_FRESH_INSTALL_V3, EXCLUDED_HISTORICAL_ARTIFACTS } from '../supabase/canonicalFreshInstallV3.mjs';

const url = process.env.WACA_ISOLATED_PG_URL;
if (!url) throw new Error('WACA_ISOLATED_PG_URL is required');
const target = new URL(url);
assert.equal(target.hostname, '127.0.0.1');
assert.equal(target.port, '55492');
assert.ok(target.pathname.startsWith('/waca_v3_'));
const databaseName = `waca_v3_fresh_${randomBytes(4).toString('hex')}`;
const upgradedName = `waca_v3_upgrade_${randomBytes(4).toString('hex')}`;
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const isolatedUrl = new URL(url);
isolatedUrl.pathname = `/${databaseName}`;
const upgradedUrl = new URL(url);
upgradedUrl.pathname = `/${upgradedName}`;
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const client = new pg.Client({ connectionString: isolatedUrl.toString() });
const upgraded = new pg.Client({ connectionString: upgradedUrl.toString() });
const owner = '00000000-0000-4000-8000-000000000099';
const group = '00000000-0000-4000-8000-000000000010';
const variant = '00000000-0000-4000-8000-000000000011';

const migrations = CANONICAL_FRESH_INSTALL_V3;
const sqlFiles = readdirSync('supabase/sql').filter(file => file.endsWith('.sql'));
assert.equal(new Set(migrations).size, migrations.length);
assert.deepEqual(sqlFiles.sort(), [...migrations, ...Object.keys(EXCLUDED_HISTORICAL_ARTIFACTS)].sort(),
  'every SQL artifact must be explicitly installed or classified as historical');

async function bootstrap(database) {
  await database.query(`
    create schema extensions;
    create extension if not exists pgcrypto with schema extensions;
    create schema auth;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    create publication supabase_realtime;
  `);
}

async function applyMigrations(database, files, label) {
  for (const file of files) {
    if (label === 'fresh' && file === '026b_cloud_inventory_uuid_identity_bridge.sql') {
      await assert.rejects(
        () => database.query(readFileSync('supabase/sql/027_cloud_restore_safeupdate_compatible_delete.sql', 'utf8')),
        /CLOUD_RESTORE_ID_PRIMARY_KEY_CONTRACT_MISMATCH:inventory_items/,
        'the historical unbridged path must fail closed, not be silently ignored',
      );
      await database.query('rollback');
      console.log('PASS unbridged 027 fails closed on inventory_key PK');
    }
    try {
      await database.query(readFileSync(`supabase/sql/${file}`, 'utf8'));
      console.log('PASS', label, file);
    } catch (error) {
      throw new Error(`${file}: ${error.message}`, { cause: error });
    }
  }
}

async function schemaFingerprint(database) {
  const queries = [
    `select c.relname, c.relrowsecurity,c.relacl::text table_acl,
       a.attname,format_type(a.atttypid,a.atttypmod) type,
       a.attnotnull,pg_get_expr(d.adbin,d.adrelid) default_value
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
     join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
     left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
     where n.nspname='public' and c.relkind in ('r','p') order by c.relname,a.attname`,
    `select c.conrelid::regclass::text table_name,c.conname,c.contype,pg_get_constraintdef(c.oid) definition
     from pg_constraint c join pg_namespace n on n.oid=c.connamespace
     where n.nspname='public' order by 1,2`,
    `select tablename,indexname,indexdef from pg_indexes where schemaname='public' order by 1,2`,
    `select c.relname table_name,t.tgname,pg_get_triggerdef(t.oid) definition
     from pg_trigger t join pg_class c on c.oid=t.tgrelid
     join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and not t.tgisinternal order by 1,2`,
    `select tablename,policyname,permissive,roles,cmd,qual,with_check
     from pg_policies where schemaname='public' order by 1,2`,
    `select p.proname,pg_get_function_identity_arguments(p.oid) arguments,
       pg_get_functiondef(p.oid) definition,p.proacl::text acl
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' order by 1,2`,
  ];
  const parts = [];
  for (const query of queries) parts.push((await database.query(query)).rows);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

await admin.connect();
await admin.query(`create database ${databaseName}`);
await admin.query(`create database ${upgradedName}`);
await client.connect();
await upgraded.connect();
try {
  await bootstrap(client);
  await applyMigrations(client, migrations, 'fresh');
  await bootstrap(upgraded);
  const v3Start = migrations.indexOf('044_waca_cloud_ledger.sql');
  await applyMigrations(upgraded, migrations.slice(0, v3Start), 'upgraded baseline');
  const baselineFingerprint = await schemaFingerprint(upgraded);
  assert.ok(baselineFingerprint);
  await upgraded.query('insert into auth.users(id,email) values($1,$2)', [owner, 'owner@example.com']);
  await upgraded.query("update public.profiles set role='owner' where user_id=$1", [owner]);
  await upgraded.query('insert into public.product_groups(id,title) values($1,$2)', [group, 'Old group']);
  await upgraded.query(`insert into public.product_variants(
    id,local_id,product_group_id,myacg_item_code,product_title,variant_name,waca_auto_quantity)
    values($1,'v-11',$2,'G001','Old group','Old variant',8)`, [variant, group]);
  await upgraded.query(readFileSync('supabase/sql/026b_cloud_inventory_uuid_identity_bridge.sql', 'utf8'));
  assert.equal(await schemaFingerprint(upgraded), baselineFingerprint,
    'the UUID-id bridge must be a schema no-op on an already-upgraded database');
  console.log('PASS representative upgraded baseline: 043 installed before WACA');
  await applyMigrations(upgraded, migrations.slice(v3Start), 'upgrade');
  const { rows: preservedLegacy } = await upgraded.query(
    'select waca_auto_quantity from public.product_variants where id=$1', [variant]);
  assert.equal(preservedLegacy[0].waca_auto_quantity, 8,
    'Cloud source installation must not alter existing legacy quantity before rebaseline');
  console.log('PASS existing-upgrade business data preserved (legacy WACA 8)');
  const freshFingerprint = await schemaFingerprint(client);
  const upgradedFingerprint = await schemaFingerprint(upgraded);
  assert.equal(freshFingerprint, upgradedFingerprint,
    'fresh and existing-upgrade paths must converge on the same schema contract');
  console.log('PASS schema fingerprint fresh = upgraded:', freshFingerprint);
  await client.query('insert into auth.users(id,email) values($1,$2)', [owner, 'owner@example.com']);
  await client.query("update public.profiles set role='owner' where user_id=$1", [owner]);
  await client.query('insert into public.product_groups(id,title) values($1,$2)', [group, 'Test group']);
  await client.query(`insert into public.product_variants(
    id,local_id,product_group_id,myacg_item_code,product_title,variant_name,waca_auto_quantity)
    values($1,'v-11',$2,'G001','Test group','Test variant',8)`, [variant, group]);
  await client.query('set role authenticated');
  await client.query(`set request.jwt.claim.sub='${owner}'`);
  const snapshot = {
    revision: 0,
    orders: [{ key: 'WACA::A', orderNumber: 'A', status: '完成付款', purchasedAt: '2026-09-28' }],
    items: [{ key: 'WACA::A::F', orderKey: 'WACA::A', feature: 'F', productCode: 'G001',
      productTitle: 'Test group', spec1: 'Test variant', spec2: '', specCode: '', quantity: 11,
      subtotal: 110, productVariantId: 'v-11', match: 'MANUAL_MATCH', diagnostic: null }],
    mappings: [{ feature: 'F', myacgMainId: 'GP001', myacgVariantId: 'G001', productVariantId: 'v-11',
      method: 'MANUAL', confirmedAt: '2026-09-28', historicalProductTitle: 'Test group',
      historicalVariantTitle: 'Test variant', masterStatus: 'ACTIVE' }],
    batches: [{ id: 'B1', fileName: 'waca.xlsx', importedAt: '2026-09-28', rows: 1,
      inserted: 1, updated: 0, unchanged: 0, conflictRows: [], result: {} }],
    masterLinks: [], cutoverAudit: [],
  };
  const imported = await client.query('select public.erp_commit_waca_snapshot($1::jsonb,0,true) as result', [snapshot]);
  assert.equal(imported.rows[0].result.revision, 1);
  for (let revision = 1; revision < 5; revision += 1) {
    const replay = await client.query('select public.erp_commit_waca_snapshot($1::jsonb,$2,true) as result',
      [snapshot, revision]);
    assert.equal(replay.rows[0].result.revision, revision + 1);
  }
  await client.query("set request.jwt.claim.sub='00000000-0000-4000-8000-000000000098'");
  assert.equal((await client.query('select count(*)::integer as count from public.waca_orders')).rows[0].count, 0);
  await assert.rejects(() => client.query('select public.erp_read_waca_snapshot()'), /WACA_OWNER_REQUIRED/);
  await client.query('reset role');
  const { rows: quantity } = await client.query('select waca_auto_quantity from public.product_variants where id=$1', [variant]);
  assert.equal(quantity[0].waca_auto_quantity, 11);
  assert.equal((await client.query('select count(*)::integer as count from public.waca_order_items')).rows[0].count, 1);
  console.log('PASS fresh import: 8 → 11, 5x idempotency, non-owner RLS');
  const { rows: exported } = await client.query('select public.erp_cloud_restore_snapshot() as snapshot');
  const source = exported[0].snapshot;
  assert.equal(Object.keys(source).length, 24);
  const { rows: audit } = await upgraded.query('select public.erp_cloud_restore_audit_dataset($1::jsonb) as report', [source]);
  assert.equal(Number(audit[0].report.integrity.orphan_count), 0);
  const manifest = {
    schemaVersion: 'cloud-erp-snapshot-v2', resourceCount: 24,
    counts: audit[0].report.table_counts,
    totalRows: Number(audit[0].report.total_rows),
    orphanCount: 0, duplicateVariantIdCount: 0, duplicateVariantLocalIdCount: 0,
  };
  await upgraded.query(`set request.jwt.claim.sub='${owner}'`);
  const { rows: restored } = await upgraded.query(`select public.erp_restore_cloud_snapshot(
    '00000000-0000-4000-8000-000000000041'::uuid,repeat('a',64),$1::jsonb,$2::jsonb,'isolated') as result`,
  [source, manifest]);
  assert.equal(restored[0].result.ok, true);
  const { rows: targetRows } = await upgraded.query('select public.erp_cloud_restore_snapshot() as snapshot');
  assert.deepEqual(targetRows[0].snapshot, source, 'cross-database 24-resource restore must preserve all rows');
  assert.equal(targetRows[0].snapshot.product_variants[0].waca_auto_quantity, 11);
  assert.equal(targetRows[0].snapshot.waca_order_items.length, 1);
  assert.equal(targetRows[0].snapshot.waca_mappings.length, 1);
  assert.equal(targetRows[0].snapshot.waca_state[0].mode, 'ORDER_DRIVEN_ACTIVE');
  console.log('PASS cross-database 24-resource backup → atomic restore → WACA 11 reconciliation');
} finally {
  await client.end();
  await upgraded.end();
  await admin.query(`drop database ${databaseName} with (force)`);
  await admin.query(`drop database ${upgradedName} with (force)`);
  await admin.end();
}
