import { createHash } from 'node:crypto';
import pg from 'pg';
import {
  RESTORE_ORDER,
  assertConnectionTargetsProject,
  classifyPublicTables,
} from './policy.mjs';

const JSON_BEGIN = '__HIPPO_STAGING_REFRESH_JSON_BEGIN__';
const JSON_END = '__HIPPO_STAGING_REFRESH_JSON_END__';
const identifier = value => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`UNSAFE_SQL_IDENTIFIER:${value}`);
  return `"${value}"`;
};

const { Client } = pg;

export async function runPostgres({ connectionUrl, expectedRef, label, sql }) {
  assertConnectionTargetsProject(connectionUrl, expectedRef, label);
  const client = new Client({
    connectionString: connectionUrl,
    application_name: 'hippo_staging_refresh_tooling',
    connectionTimeoutMillis: 15_000,
  });
  try {
    await client.connect();
    return await client.query(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`POSTGRES_OPERATION_FAILED:${message}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function runPostgresJson(options) {
  const rawResult = await runPostgres(options);
  const results = Array.isArray(rawResult) ? rawResult : [rawResult];
  const payload = results.flatMap(result => result.rows || [])
    .map(row => row.hippo_payload)
    .find(value => typeof value === 'string');
  if (!payload) throw new Error('POSTGRES_JSON_RESULT_MISSING');
  const start = payload.indexOf(JSON_BEGIN);
  const end = payload.lastIndexOf(JSON_END);
  if (start < 0 || end <= start) throw new Error('PSQL_JSON_SENTINEL_MISSING');
  return JSON.parse(payload.slice(start + JSON_BEGIN.length, end));
}

const schemaJsonExpression = `jsonb_build_object(
  'publicTables', (SELECT COALESCE(jsonb_agg(table_name ORDER BY table_name), '[]'::jsonb)
    FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'),
  'columns', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'tableName', table_name, 'columnName', column_name, 'dataType', data_type,
      'udtName', udt_name, 'nullable', is_nullable = 'YES', 'defaultValue', column_default,
      'generated', is_generated, 'identityGeneration', identity_generation
    ) ORDER BY table_name, ordinal_position), '[]'::jsonb)
    FROM information_schema.columns WHERE table_schema = 'public'),
  'constraints', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'tableName', tc.table_name, 'constraintName', tc.constraint_name,
      'constraintType', tc.constraint_type, 'columnName', kcu.column_name,
      'ordinalPosition', kcu.ordinal_position
    ) ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position), '[]'::jsonb)
    FROM information_schema.table_constraints tc
    LEFT JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')),
  'foreignKeys', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'constraintName', constraint_name, 'childTable', table_name, 'childColumn', column_name,
      'parentSchema', foreign_table_schema, 'parentTable', foreign_table_name,
      'parentColumn', foreign_column_name
    ) ORDER BY table_name, constraint_name, ordinal_position), '[]'::jsonb)
    FROM (
      SELECT tc.constraint_name, tc.table_name, kcu.column_name, kcu.ordinal_position,
        ccu.table_schema AS foreign_table_schema, ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    ) fk)
)`;

export function buildSchemaInspectionSql() {
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SELECT '${JSON_BEGIN}' || (${schemaJsonExpression})::text || '${JSON_END}' AS hippo_payload;
COMMIT;`;
}

export function buildSnapshotSql(tables) {
  const tablePairs = tables.flatMap(table => [
    `'${table}'`,
    `(SELECT COALESCE(jsonb_agg(to_jsonb(source_row) ORDER BY COALESCE(to_jsonb(source_row)->>'id', to_jsonb(source_row)->>'myacg_item_code', '')), '[]'::jsonb) FROM public.${identifier(table)} source_row)`,
  ]);
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY DEFERRABLE;
SET LOCAL statement_timeout = '5min';
SELECT '${JSON_BEGIN}' || jsonb_build_object(
  'schema', ${schemaJsonExpression},
  'data', jsonb_build_object(${tablePairs.join(',\n')})
)::text || '${JSON_END}' AS hippo_payload;
COMMIT;`;
}

export async function inspectSchema(connection) {
  return runPostgresJson({ ...connection, sql: buildSchemaInspectionSql() });
}

export async function assertStagingActorExists(connection, actorId) {
  if (!/^[0-9a-f-]{36}$/i.test(actorId || '')) throw new Error('STAGING_ACTOR_UUID_INVALID');
  const sql = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT '${JSON_BEGIN}' || jsonb_build_object(
  'exists', EXISTS (SELECT 1 FROM auth.users WHERE id = '${actorId}'::uuid)
)::text || '${JSON_END}' AS hippo_payload;
COMMIT;`;
  const result = await runPostgresJson({ ...connection, sql });
  if (result.exists !== true) throw new Error('STAGING_ACTOR_NOT_FOUND');
}

export async function captureConsistentSnapshot(connection) {
  const schema = await inspectSchema(connection);
  const classification = classifyPublicTables(schema.publicTables || []);
  if (classification.requiredMissing.length) {
    throw new Error(`REQUIRED_TABLES_MISSING:${classification.requiredMissing.join(',')}`);
  }
  if (classification.unclassified.length) {
    throw new Error(`UNCLASSIFIED_PUBLIC_TABLES:${classification.unclassified.join(',')}`);
  }
  const captured = await runPostgresJson({ ...connection, sql: buildSnapshotSql(classification.included) });
  const capturedClassification = classifyPublicTables(captured.schema.publicTables || []);
  if (JSON.stringify(capturedClassification.included) !== JSON.stringify(classification.included)) {
    throw new Error('SCHEMA_CHANGED_DURING_SNAPSHOT');
  }
  return { ...captured, classification: capturedClassification };
}

const dollarQuote = json => {
  const digest = createHash('sha256').update(json).digest('hex').slice(0, 16);
  const tag = `$hippo_${digest}$`;
  if (json.includes(tag)) throw new Error('DOLLAR_QUOTE_COLLISION');
  return `${tag}${json}${tag}`;
};

export function buildTransactionalRestoreSql(snapshot) {
  const tables = RESTORE_ORDER.filter(table => snapshot.data[table]);
  const tempName = table => `refresh_${table}`;
  const stageStatements = tables.map(table => {
    const payload = dollarQuote(JSON.stringify(snapshot.data[table]));
    return `CREATE TEMP TABLE ${identifier(tempName(table))} (LIKE public.${identifier(table)} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY);
INSERT INTO ${identifier(tempName(table))}
SELECT * FROM jsonb_populate_recordset(NULL::public.${identifier(table)}, ${payload}::jsonb);
DO $$ BEGIN
  IF (SELECT count(*) FROM ${identifier(tempName(table))}) <> ${snapshot.data[table].length} THEN
    RAISE EXCEPTION 'STAGING_COUNT_MISMATCH:${table}';
  END IF;
END $$;`;
  }).join('\n');

  const deletes = [...tables].reverse().map(table => `DELETE FROM public.${identifier(table)};`).join('\n');
  const inserts = tables.map(table => `INSERT INTO public.${identifier(table)} SELECT * FROM ${identifier(tempName(table))};`).join('\n');
  const readbackChecks = tables.map(table => `DO $$ BEGIN
  IF EXISTS (
    (SELECT to_jsonb(source_row) FROM ${identifier(tempName(table))} source_row
      EXCEPT SELECT to_jsonb(target_row) FROM public.${identifier(table)} target_row)
    UNION ALL
    (SELECT to_jsonb(target_row) FROM public.${identifier(table)} target_row
      EXCEPT SELECT to_jsonb(source_row) FROM ${identifier(tempName(table))} source_row)
  ) THEN RAISE EXCEPTION 'STAGING_READBACK_MISMATCH:${table}'; END IF;
END $$;`).join('\n');

  return `BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '15min';
SELECT pg_advisory_xact_lock(hashtext('hippo-production-to-staging-refresh-v1'));
${stageStatements}
${deletes}
${inserts}
SET CONSTRAINTS ALL IMMEDIATE;
${readbackChecks}
COMMIT;`;
}

export function assertNoExternalIncomingReferences(schema, includedTables) {
  const included = new Set(includedTables);
  const unsafe = (schema.foreignKeys || []).filter(reference => (
    reference.parentSchema === 'public'
    && included.has(reference.parentTable)
    && !included.has(reference.childTable)
  ));
  if (unsafe.length) {
    throw new Error(`EXTERNAL_INCOMING_REFERENCE:${unsafe.map(item => `${item.childTable}->${item.parentTable}`).join(',')}`);
  }
}
