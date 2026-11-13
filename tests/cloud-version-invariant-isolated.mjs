// Server invariant behind the key/version verification read (cloudTargetedCache.ts): on every table the client
// verifies that way, any UPDATE (also a no-op one, or one that tries to set version / updated_at itself) is forced
// by an unconditional BEFORE UPDATE row trigger to version = OLD.version + 1 and a new updated_at.
// Also: the two excluded tables really are exceptions under the current server schema. This release does not
// include or exercise candidate 081. Isolated PostgreSQL, real migrations, synthetic rows.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isolatedDatabase } from './helpers/saveability-isolated.mjs';
const source = readFileSync('src/providers/cloud/cloudTargetedCache.ts', 'utf8');
const VERIFIABLE = [...source.match(/const KEY_VERSION_VERIFIABLE_TABLES[^[]*\[([^\]]*)\]/u)[1].matchAll(/'([a-z_]+)'/gu)].map(m => m[1]);
assert.equal(VERIFIABLE.length, 13, 'verifiable table list parsed');
assert.ok(!VERIFIABLE.includes('inventory_items') && !VERIFIABLE.includes('outbound_shipments'), 'exceptions are not in the static list');
assert.match(source, /SERVER_FORCED_VERSION_CAPABILITY[^=]*= \{ inventory_items: 'inventoryItemsVersionForced' \}/u);
const db = await isolatedDatabase();
try {
  const { sql } = db;
  // tgtype 19 = ROW + BEFORE + UPDATE; no WHEN clause, no column list.
  const forcing = async table => (await sql.query(`select t.tgname from pg_trigger t
    where t.tgrelid = $1::regclass and not t.tgisinternal and t.tgenabled in ('O','A') and t.tgtype = 19 and t.tgqual is null and t.tgattr::text = ''
      and t.tgfoid = 'public.sync_audit_columns()'::regprocedure`, ['public.' + table])).rows.map(r => r.tgname);
  // The shared trigger function: unconditional except the one documented outbound_shipments branch.
  const fn = (await sql.query("select prosrc from pg_proc where oid = 'public.sync_audit_columns()'::regprocedure")).rows[0].prosrc;
  assert.equal((fn.match(/RETURN NEW/giu) ?? []).length, 2, 'one early return + the final return');
  assert.match(fn, /IF TG_TABLE_SCHEMA = 'public'\s+AND TG_TABLE_NAME = 'outbound_shipments'[\s\S]*?RETURN NEW;\s+END IF;\s+NEW\.updated_at = now\(\);\s+NEW\.version = OLD\.version \+ 1;/u,
    'the only early return is the outbound_shipments branch; every other table is forced');
  const missing = [];
  for (const table of VERIFIABLE) {
    if ((await forcing(table)).length < 1) missing.push(table);
    const cols = (await sql.query(`select column_name from information_schema.columns where table_schema='public' and table_name=$1 and column_name in ('version','updated_at','id')`, [table])).rows.map(r => r.column_name).sort();
    assert.deepEqual(cols, ['id', 'updated_at', 'version'], `${table}: id / version / updated_at columns`);
  }
  assert.deepEqual(missing, [], 'every verifiable table has the unconditional forcing trigger');
  // Behaviour on seeded rows: plain, no-op and adversarial updates all advance version and updated_at.
  const behaves = async table => {
    const read = async () => (await sql.query(`select id, version, updated_at::text u from public.${table} limit 1`)).rows[0];
    let before = await read();
    assert.ok(before, `${table}: a synthetic row exists`);
    for (const set of ['id = id', 'version = version', 'version = version - 5, updated_at = updated_at', "updated_at = '2001-01-01'"]) {
      await sql.query(`update public.${table} set ${set} where id = $1`, [before.id]);
      const after = await read();
      if (Number(after.version) !== Number(before.version) + 1 || after.u === before.u) return `${set} => version ${before.version}->${after.version}`;
      before = after;
    }
    return 'forced';
  };
  for (const table of ['product_groups', 'product_variants']) assert.equal(await behaves(table), 'forced', table);

  // inventory_items today: no forcing trigger (so the client reads it in full), no direct write grants.
  await sql.query("insert into public.inventory_items(inventory_key, myacg_item_code, product_title, raw_variant_name) values ('synthetic-081','S081','合成','A')");
  assert.deepEqual(await forcing('inventory_items'), []);
  assert.notEqual(await behaves('inventory_items'), 'forced', 'without 081 a plain UPDATE does not advance version');
  const grants = (await sql.query("select privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='inventory_items' and grantee in ('authenticated','anon','PUBLIC') order by 1")).rows.map(r => r.privilege_type);
  assert.deepEqual(grants, ['SELECT']);
  assert.equal((await sql.query("select to_regprocedure('public.erp_sync_capabilities()') f")).rows[0].f, null, 'no capability function before 081 (client: complete read)');

  console.log('PASS version invariant: 13 current-schema tables forced by trigger; inventory_items / outbound_shipments remain fail-closed full-read exceptions');
} finally { await db.close(); }
