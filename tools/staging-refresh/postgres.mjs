import { createHash } from 'node:crypto';
import pg from 'pg';
import {
  RESTORE_WRITER_ROLE,
  RESTORE_ORDER,
  SNAPSHOT_SCHEMA_CONTRACT_VERSION,
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
  'schemaContract', (SELECT jsonb_build_object(
      'version', ${SNAPSHOT_SCHEMA_CONTRACT_VERSION},
      'foreignKeysComplete', true,
      'foreignKeyConstraintCount', count(*) FILTER (WHERE constraint_record.contype::text = 'f'),
      'foreignKeyColumnCount', COALESCE(sum(cardinality(constraint_record.conkey))
        FILTER (WHERE constraint_record.contype::text = 'f'), 0),
      'primaryUniqueConstraintsComplete', true,
      'primaryUniqueConstraintCount', count(*)
        FILTER (WHERE constraint_record.contype::text IN ('p', 'u')),
      'primaryUniqueConstraintColumnCount', COALESCE(sum(cardinality(constraint_record.conkey))
        FILTER (WHERE constraint_record.contype::text IN ('p', 'u')), 0)
    )
    FROM pg_catalog.pg_constraint constraint_record
    JOIN pg_catalog.pg_class child_table ON child_table.oid = constraint_record.conrelid
    JOIN pg_catalog.pg_namespace child_namespace ON child_namespace.oid = child_table.relnamespace
    WHERE child_namespace.nspname = 'public'
      AND child_table.relkind::text IN ('r', 'p')),
  'columns', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'tableName', table_name, 'columnName', column_name, 'dataType', data_type,
      'udtName', udt_name, 'nullable', is_nullable = 'YES', 'defaultValue', column_default,
      'generated', is_generated, 'identityGeneration', identity_generation
    ) ORDER BY table_name, ordinal_position), '[]'::jsonb)
    FROM information_schema.columns WHERE table_schema = 'public'),
  'constraints', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'tableName', table_name, 'constraintName', constraint_name,
      'constraintType', constraint_type, 'columnName', column_name,
      'ordinalPosition', ordinal_position
    ) ORDER BY table_name, constraint_name, ordinal_position), '[]'::jsonb)
    FROM (
      SELECT child_table.relname AS table_name,
        constraint_record.conname AS constraint_name,
        CASE constraint_record.contype::text
          WHEN 'p' THEN 'PRIMARY KEY'
          WHEN 'u' THEN 'UNIQUE'
        END AS constraint_type,
        child_attribute.attname AS column_name,
        child_key.ordinal_position
      FROM pg_catalog.pg_constraint constraint_record
      JOIN pg_catalog.pg_class child_table
        ON child_table.oid = constraint_record.conrelid
      JOIN pg_catalog.pg_namespace child_namespace
        ON child_namespace.oid = child_table.relnamespace
      CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY
        AS child_key(attribute_number, ordinal_position)
      JOIN pg_catalog.pg_attribute child_attribute
        ON child_attribute.attrelid = child_table.oid
        AND child_attribute.attnum = child_key.attribute_number
      WHERE constraint_record.contype::text IN ('p', 'u')
        AND child_namespace.nspname = 'public'
        AND child_table.relkind::text IN ('r', 'p')
    ) primary_unique_constraint),
  'foreignKeys', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'constraintName', constraint_name, 'childSchema', child_schema,
      'childTable', child_table, 'childColumn', child_column,
      'parentSchema', foreign_table_schema, 'parentTable', foreign_table_name,
      'parentColumn', foreign_column_name, 'ordinalPosition', ordinal_position,
      'onDelete', CASE delete_action
        WHEN 'a' THEN 'NO ACTION'
        WHEN 'r' THEN 'RESTRICT'
        WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN 'SET NULL'
        WHEN 'd' THEN 'SET DEFAULT'
        ELSE 'UNKNOWN:' || delete_action
      END,
      'onUpdate', CASE update_action
        WHEN 'a' THEN 'NO ACTION'
        WHEN 'r' THEN 'RESTRICT'
        WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN 'SET NULL'
        WHEN 'd' THEN 'SET DEFAULT'
        ELSE 'UNKNOWN:' || update_action
      END,
      'validated', validated
    ) ORDER BY child_schema, child_table, constraint_name, ordinal_position), '[]'::jsonb)
    FROM (
      SELECT constraint_record.conname AS constraint_name,
        child_namespace.nspname AS child_schema,
        child_table.relname AS child_table,
        child_attribute.attname AS child_column,
        parent_namespace.nspname AS foreign_table_schema,
        parent_table.relname AS foreign_table_name,
        parent_attribute.attname AS foreign_column_name,
        child_key.ordinal_position,
        constraint_record.confdeltype::text AS delete_action,
        constraint_record.confupdtype::text AS update_action,
        constraint_record.convalidated AS validated
      FROM pg_catalog.pg_constraint constraint_record
      JOIN pg_catalog.pg_class child_table
        ON child_table.oid = constraint_record.conrelid
      JOIN pg_catalog.pg_namespace child_namespace
        ON child_namespace.oid = child_table.relnamespace
      JOIN pg_catalog.pg_class parent_table
        ON parent_table.oid = constraint_record.confrelid
      JOIN pg_catalog.pg_namespace parent_namespace
        ON parent_namespace.oid = parent_table.relnamespace
      CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY
        AS child_key(attribute_number, ordinal_position)
      JOIN LATERAL unnest(constraint_record.confkey) WITH ORDINALITY
        AS parent_key(attribute_number, ordinal_position)
        ON parent_key.ordinal_position = child_key.ordinal_position
      JOIN pg_catalog.pg_attribute child_attribute
        ON child_attribute.attrelid = child_table.oid
        AND child_attribute.attnum = child_key.attribute_number
      JOIN pg_catalog.pg_attribute parent_attribute
        ON parent_attribute.attrelid = parent_table.oid
        AND parent_attribute.attnum = parent_key.attribute_number
      WHERE constraint_record.contype::text = 'f'
        AND child_namespace.nspname = 'public'
        AND child_table.relkind::text IN ('r', 'p')
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

export function buildRestoreWriterInspectionSql() {
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT '${JSON_BEGIN}' || jsonb_build_object(
  'currentUser', current_user,
  'superuser', role.rolsuper,
  'createdb', role.rolcreatedb,
  'createrole', role.rolcreaterole,
  'replication', role.rolreplication,
  'bypassrls', role.rolbypassrls
)::text || '${JSON_END}' AS hippo_payload
FROM pg_catalog.pg_roles role
WHERE role.rolname = current_user;
COMMIT;`;
}

export function assertRestoreWriterInspection(result) {
  if (result?.currentUser !== RESTORE_WRITER_ROLE) {
    throw new Error(`RESTORE_WRITER_CURRENT_USER_MISMATCH:${result?.currentUser || 'missing'}`);
  }
  const forbiddenAttributes = ['superuser', 'createdb', 'createrole', 'replication', 'bypassrls'];
  const enabled = forbiddenAttributes.filter(attribute => result?.[attribute] !== false);
  if (enabled.length) throw new Error(`RESTORE_WRITER_FORBIDDEN_ATTRIBUTES:${enabled.join(',')}`);
  return result;
}

export async function assertRestoreWriterRole(connection) {
  const result = await runPostgresJson({ ...connection, sql: buildRestoreWriterInspectionSql() });
  return assertRestoreWriterInspection(result);
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
