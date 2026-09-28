import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { CANONICAL_FRESH_INSTALL_V3 } from '../../supabase/canonicalFreshInstallV3.mjs';
import { fingerprintStructuralSnapshot } from './schemaContract.mjs';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
if (outputIndex < 0 || !args[outputIndex + 1] || args.length !== 2) {
  throw new Error('CANONICAL_SCHEMA_OUTPUT_REQUIRED: use --output <path>');
}

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const database = await PGlite.create({ extensions: { pgcrypto } });
try {
  await database.exec(`
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create role authenticated;
    create role anon;
    create schema auth;
    create schema storage;
    create schema realtime;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    create publication supabase_realtime;
  `);
  for (const file of CANONICAL_FRESH_INSTALL_V3) {
    await database.exec(await read(`../../supabase/sql/${file}`));
  }
  const snapshotSql = await read('./sql/live-schema-snapshot-readonly.sql');
  const inventorySql = await read('./sql/026b-inventory-preconditions-readonly.sql');
  const snapshot = (await database.query(snapshotSql)).rows[0].erp_schema_snapshot;
  snapshot.integrity.inventoryItems = (await database.query(inventorySql)).rows[0].inventory_items_integrity;
  snapshot.completeness.inventoryIntegrity = true;
  snapshot.identity.projectRef = 'rhfdjsklfrgpoqsaqpkn';
  snapshot.identity.environmentRole = 'ERP_2_CLOUD_CANDIDATE';
  snapshot.generation = { source: 'CANONICAL_FRESH_INSTALL_V3', engine: 'PGlite PostgreSQL 18' };
  const fingerprint = fingerprintStructuralSnapshot(snapshot);
  await writeFile(resolve(args[outputIndex + 1]), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ result: 'PASS', output: resolve(args[outputIndex + 1]), fingerprint }));
} finally {
  await database.close();
}
