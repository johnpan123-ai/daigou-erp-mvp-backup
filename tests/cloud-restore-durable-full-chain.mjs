import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';

// Synthetic, 15-row fixture only. Complete immutable Restore migration chain;
// no Live snapshots, credentials, DB connections, or business records are used.
const runtime = process.env.RESTORE_AUDIT_PGLITE_PATH
  || resolve('../experimental-cloud-atomic-json-restore/scratch/restore-audit-pg-runtime/node_modules/@electric-sql/pglite/dist');
const { PGlite } = await import(pathToFileURL(resolve(runtime, 'index.js')));
const { pgcrypto } = await import(pathToFileURL(resolve(runtime, 'contrib/pgcrypto.js')));
const db = new PGlite({ extensions: { pgcrypto } });
const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
const portability = await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
const { CLOUD_RESTORE_RELATIONS } = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreRelations.ts');
await vite.close();
const OWNER = '11111111-1111-4111-8111-111111111111';
const foreignActor = '22222222-2222-4222-8222-222222222222';
const tables = domain.CLOUD_RESTORE_TABLES;
const ids = Object.fromEntries(tables.map(([, table]) => [table, randomUUID()]));
const data = Object.fromEntries(tables.map(([resource, table]) => [resource, [{
  id: ids[table], local_id: `fixture-${table}`, updated_by: foreignActor,
  ...(table === 'inventory_items' ? { inventory_key: 'fixture::A', product_id: null, latest_catalog_import_id: null } : {}),
  ...(table === 'product_groups' ? { title: 'Synthetic Restore Fixture' } : {}),
  ...Object.fromEntries(CLOUD_RESTORE_RELATIONS.filter(r => r.childTable === table).map(r => [r.field, ids[r.parentTable]])),
}]]));
const built = await domain.buildCloudRestoreManifest(data, data);
const candidate = await domain.prepareCloudRestoreSnapshot({ schemaVersion: domain.CLOUD_RESTORE_SCHEMA_VERSION,
  sourceEnvironment: 'synthetic-fixture', manifest: built.manifest, data });
const portable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(candidate, 'rhfdjsklfrgpoqsaqpkn');
const effective = await portability.assertCloudRestoreEffectiveCandidate(portable);
const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
try {
  await db.exec(`create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
    create role authenticated; create role anon; create publication supabase_realtime;
    create table auth.users(id uuid primary key); insert into auth.users values('${OWNER}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function public.is_owner(id uuid) returns boolean language sql stable as $$select id='${OWNER}'::uuid$$;
    grant usage on schema auth,extensions to authenticated,anon;`);
  for (const [, table] of tables) {
    const relationFields = [...new Set(CLOUD_RESTORE_RELATIONS.filter(r => r.childTable === table).map(r => r.field))];
    await db.exec(`create table public.${table}(id uuid primary key,local_id text,updated_by uuid references auth.users(id) on delete set null
      ${table === 'inventory_items' ? ',inventory_key text not null unique,product_id uuid,latest_catalog_import_id uuid' : ''}
      ${table === 'product_groups' ? ',title text' : ''}
      ${relationFields.map(field => `,${field} uuid`).join('')})`);
  }
  for (const r of CLOUD_RESTORE_RELATIONS) await db.exec(`alter table public.${r.childTable}
    add foreign key(${r.field}) references public.${r.parentTable}(id)`);
  // 028 is the incompatible inventory_key-PK candidate, not a predecessor for
  // the canonical-id 029 baseline. Use the actual 027 -> 029 supported path.
  for (const number of [23,24,25,26,27,29,30,35,36,37,38,39,40,41,42]) {
    const file = readdirSync('supabase/sql').find(file => file.startsWith(String(number).padStart(3,'0')+'_'));
    await db.exec(readFileSync(resolve('supabase/sql', file), 'utf8'));
    console.log('PASS migration', file);
  }
  await db.exec(`create function public.fixture_fail_insert() returns trigger language plpgsql as $$begin
    if current_setting('fixture.fail',true)='on' then raise exception using errcode='23505',message='synthetic constraint'; end if;
    return new; end$$;
    create trigger fixture_fault after insert on public.outbound_shipment_items for each row execute function public.fixture_fail_insert();`);
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",
    [OWNER, JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
  await db.exec('set role authenticated');
  const proof = await scalar('select public.erp_prove_cloud_restore_candidate($1,$2,$3) as value',
    [JSON.stringify(effective.sourceData),JSON.stringify(portable.manifest),effective.mode]);
  assert.equal(proof.ok, true);
  for (const fail of [true, false]) {
    const attempt = randomUUID(), trace = randomUUID();
    await scalar('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,120000,$7) as value',
      [attempt, trace, candidate.manifest.snapshotFingerprint, portable.manifest.snapshotFingerprint,
        'cross-environment-audit-null-v1','rhfdjsklfrgpoqsaqpkn','postgresql-statement-timeout-v1']);
    const execution = randomUUID();
    await db.query("select set_config('fixture.fail',$1,false)",[fail ? 'on':'off']);
    const result = await scalar('select public.erp_restore_cloud_snapshot_attempt($1,$2,$3,$4,$5,$6,$7,$8) as value',
      [attempt,trace,execution,portable.manifest.snapshotFingerprint,JSON.stringify(effective.sourceData),
        JSON.stringify(portable.manifest),'synthetic-fixture',effective.mode]);
    if (fail) {
      assert.equal(result.ok,false); assert.equal(result.failure.category,'CONSTRAINT');
      assert.equal(result.failure.phase,'atomic-restore');
    } else assert.equal(result.ok,true, JSON.stringify(result));
    await db.exec('reset role');
    for (const [, table] of tables) {
      assert.equal(await scalar(`select count(*)::integer as value from public.${table}`), fail ? 0 : 1);
      assert.equal(await scalar(`select count(*)::integer as value from public.${table} where updated_by is not null`),0);
    }
    assert.equal(Number(await scalar('select epoch as value from public.erp_cloud_restore_epoch')), fail ? 0 : 1);
    assert.equal(await scalar('select count(*)::integer as value from public.erp_cloud_restore_snapshots'),fail ? 0 : 1);
    await db.exec('set role authenticated');
    if (!fail) {
      const audit = await scalar('select public.erp_read_cloud_restore_integrity_audit() as value');
      assert(audit && typeof audit === 'object');
    }
    console.log(fail ? 'PASS actual atomic restore late insert failure: all 15 tables/snapshot/epoch rolled back, failure durable'
      : 'PASS actual 037/038/040/041/042 prepared-direct portable restore: OWNER proof, 15 rows, updated_by null, final validation, epoch, integrity audit');
  }
} catch (error) {
  console.error('FAIL full-chain fixture', error.code, error.message, error.where ?? '');
  process.exitCode = 1;
} finally { await db.close(); }
