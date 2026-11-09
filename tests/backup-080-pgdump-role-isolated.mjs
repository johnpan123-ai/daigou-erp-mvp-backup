// pg_dump least-privilege candidate: reproduces the LOCK/permission blocker for a role without SELECT,
// proves the candidate role dumps every public table (incl. RLS tables) completely, cannot write, and that
// the revoke script leaves nothing behind. Synthetic data; disposable cluster (pg_dump/pg_restore 17 = server 17).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';
const BIN = '/usr/lib/postgresql/17/bin/';
const db = await isolatedDatabase();
const out = {};
const dbName = db.url.pathname.slice(1);
const asRole = role => { const u = new URL(db.url.toString()); u.username = role; return u.toString(); };
const dump = (role, file) => { try { execFileSync(BIN + 'pg_dump', ['--format=custom', '--schema=public', '--no-owner', '--serializable-deferrable', '-f', file, asRole(role)], { env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' }, stdio: ['ignore', 'pipe', 'pipe'] }); return 'ok'; } catch (e) { return String(e.stderr).split('\n').find(l => /error/i.test(l)) ?? 'failed'; } };
const restoreDb = `${dbName}_r`;
const admin = new pg.Client({ connectionString: (() => { const u = new URL(db.url.toString()); u.pathname = '/postgres'; return u.toString(); })() }); await admin.connect();
try {
  const { sql } = db;
  await sql.query("insert into public.product_groups(id,title) select gen_random_uuid(),'G'||g from generate_series(1,500) g");
  out.version = (await sql.query('show server_version')).rows[0].server_version;
  const rlsTables = (await sql.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity")).rows[0].n;
  out.rlsTables = rlsTables;
  // 1) Blocker reproduction: read-only login role with only USAGE (no SELECT) -> LOCK/permission failure.
  await sql.query("do $$ begin if to_regrole('erp2_ro_nosel') is null then create role erp2_ro_nosel login; end if; end $$; grant usage on schema public to erp2_ro_nosel");
  out.blockerNoSelect = dump('erp2_ro_nosel', '/tmp/claude-0/b080-nosel.dump');
  assert.match(out.blockerNoSelect, /permission denied/u);
  // 1b) SELECT but no BYPASSRLS -> pg_dump refuses RLS tables (would otherwise be incomplete).
  await sql.query("grant select on all tables in schema public to erp2_ro_nosel");
  out.blockerNoBypassRls = dump('erp2_ro_nosel', '/tmp/claude-0/b080-norls.dump');
  assert.match(out.blockerNoBypassRls, /row-level security|row security/u);
  await sql.query("revoke all on all tables in schema public from erp2_ro_nosel; revoke usage on schema public from erp2_ro_nosel; drop role erp2_ro_nosel");
  // 2) Candidate role; activation step (login), dump.
  await sql.query(readFileSync('supabase/candidates/080_pgdump_readonly_role_candidate.sql', 'utf8'));
  await sql.query("alter role erp2_backup_reader login valid until 'infinity'");
  out.candidateDump = dump('erp2_backup_reader', '/tmp/claude-0/b080-ok.dump');
  assert.equal(out.candidateDump, 'ok');
  // 3) Cannot write (read-only default + no DML privilege), cannot execute functions.
  const reader = new pg.Client({ connectionString: asRole('erp2_backup_reader') }); await reader.connect();
  out.writeAttempt = await reader.query("insert into public.product_groups(id,title) values(gen_random_uuid(),'x')").then(() => 'WROTE', e => e.code);
  await reader.query('set default_transaction_read_only = off');
  out.writeAttemptRwSession = await reader.query("insert into public.product_groups(id,title) values(gen_random_uuid(),'x')").then(() => 'WROTE', e => e.code);
  out.execAttempt = await reader.query('select public.erp_export_cloud_restore_snapshot_json()').then(() => 'EXECUTED', e => e.code);
  await reader.end();
  assert.equal(out.writeAttempt, '25006'); assert.equal(out.writeAttemptRwSession, '42501'); assert.equal(out.execAttempt, '42501');
  // 4) Completeness: restore into an empty DB and compare exact row counts of every public table (RLS included).
  await admin.query(`create database ${restoreDb}`);
  const rUrl = (() => { const u = new URL(db.url.toString()); u.pathname = '/' + restoreDb; return u.toString(); })();
  const r = new pg.Client({ connectionString: rUrl }); await r.connect();
  await r.query("drop schema public cascade; create schema if not exists auth; create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$; create table if not exists auth.users(id uuid primary key); create schema if not exists extensions; create extension if not exists pgcrypto schema extensions;");
  await r.query("insert into auth.users(id) select id from (values ($1::uuid),('00000000-0000-4000-8000-000000000098'::uuid)) v(id)", [owner]).catch(() => {});
  try { execFileSync(BIN + 'pg_restore', ['--no-owner', '--exit-on-error', '--single-transaction', '-d', rUrl, '/tmp/claude-0/b080-ok.dump'], { stdio: ['ignore', 'pipe', 'pipe'] }); out.restore = 'ok'; } catch (e) { out.restore = String(e.stderr).split('\n').filter(Boolean).slice(0, 2).join(' | '); }
  console.log('PGDUMP080-PARTIAL ' + JSON.stringify(out)); assert.equal(out.restore, 'ok');
  const tables = (await sql.query("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1")).rows.map(x => x.relname);
  const mism = [];
  for (const t of tables) { const a = (await sql.query(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from public."${t}" x`)).rows[0]; const b = (await r.query(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from public."${t}" x`)).rows[0]; if (a.n !== b.n || a.h !== b.h) mism.push(t); }
  out.tables = tables.length; out.tableMismatches = mism;
  const policies = async c => (await c.query("select count(*)::int n from pg_policies where schemaname='public'")).rows[0].n;
  const acl = async c => (await c.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relacl is not null")).rows[0].n;
  const fns = async c => (await c.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'")).rows[0].n;
  out.schema = { policies: [await policies(sql), await policies(r)], aclObjects: [await acl(sql), await acl(r)], functions: [await fns(sql), await fns(r)] };
  out.readerGrantsCarriedIntoDump = (await r.query("select count(*)::int n from pg_class where relacl::text like '%erp2_backup_reader%'")).rows[0].n;
  await r.end(); await admin.query(`drop database ${restoreDb}`);
  assert.equal(out.restore, 'ok'); assert.deepEqual(mism, []);
  assert.equal(out.schema.policies[0], out.schema.policies[1]); assert.equal(out.schema.functions[0], out.schema.functions[1]);
  // 5) Revoke leaves nothing behind.
  await sql.query(readFileSync('supabase/candidates/080_pgdump_readonly_role_revoke.sql', 'utf8'));
  out.afterRevoke = (await sql.query("select (select count(*) from pg_roles where rolname='erp2_backup_reader')::int roles, (select count(*) from pg_class where relacl::text like '%erp2_backup_reader%')::int acl, (select count(*) from pg_db_role_setting s left join pg_roles r on r.oid=s.setrole where r.oid is null and s.setrole<>0)::int orphan_settings")).rows[0];
  assert.deepEqual(out.afterRevoke, { roles: 0, acl: 0, orphan_settings: 0 });
  // 6) PG16 rule: non-superuser CREATEROLE without BYPASSRLS cannot create a BYPASSRLS role; with BYPASSRLS it can.
  await sql.query("do $$ begin if to_regrole('supa_admin_like') is null then create role supa_admin_like createrole; end if; end $$");
  await sql.query('set role supa_admin_like');
  out.createBypassWithoutAttr = await sql.query('create role b080_t1 bypassrls').then(() => 'ALLOWED', e => e.code);
  await sql.query('reset role'); await sql.query('alter role supa_admin_like bypassrls'); await sql.query('set role supa_admin_like');
  out.createBypassWithAttr = await sql.query('create role b080_t2 bypassrls').then(() => 'ALLOWED', e => e.code);
  await sql.query('reset role'); await sql.query('drop role if exists b080_t1; drop role if exists b080_t2; drop role supa_admin_like');
  console.log('PGDUMP080 ' + JSON.stringify(out));
} finally {
  await db.sql.query('reset role').catch(() => {});
  for (const q of ['drop role if exists b080_t1', 'drop role if exists b080_t2', 'drop role if exists supa_admin_like']) await db.sql.query(q).catch(() => {});
  await db.close(); await admin.query(`drop database if exists ${restoreDb}`).catch(() => {});
  for (const q of ['drop role if exists erp2_backup_reader', 'drop role if exists erp2_ro_nosel']) await admin.query(q).catch(() => {});
  await admin.query('select 1').catch(() => {}); await admin.end();
}
