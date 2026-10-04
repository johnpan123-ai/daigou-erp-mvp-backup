import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { isolatedDatabase, owner, uuid } from './helpers/saveability-isolated.mjs';

const migration = readFileSync('supabase/sql/053_outbound_status_changed_at_restore_compatibility.sql', 'utf8');
const triggerSource = readFileSync('supabase/sql/033_outbound_status_transition_timestamp.sql', 'utf8');
assert.match(triggerSource, /IF TG_OP = 'INSERT' THEN\s+NEW\.status_changed_at := clock_timestamp\(\)/u);
assert.match(triggerSource, /ELSIF NEW\.status IS DISTINCT FROM OLD\.status THEN/u);
assert.doesNotMatch(migration, /session_replication_role|disable\s+trigger|current_setting|set_config/iu);
assert.doesNotMatch(migration, /alter\s+table|create\s+table|add\s+column/iu);

const db = await isolatedDatabase();
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { sql } = db;
  const { CLOUD_FIELD_ENTITY_CONTRACTS } = await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  assert.equal(CLOUD_FIELD_ENTITY_CONTRACTS.outbound_shipments.create.includes('status_changed_at'), false);
  assert.equal(CLOUD_FIELD_ENTITY_CONTRACTS.outbound_shipments.patch.includes('status_changed_at'), false);

  const normalId = uuid(700);
  const suppliedHistory = '2025-01-02T03:04:05.000Z';
  const normalInsert = (await sql.query(`
    insert into public.outbound_shipments(id,title,status,status_changed_at)
    values($1,'Normal business insert','draft',$2)
    returning status_changed_at`, [normalId, suppliedHistory])).rows[0];
  assert.notEqual(new Date(normalInsert.status_changed_at).toISOString(), suppliedHistory,
    'Normal INSERT trigger behavior must remain unchanged');
  assert.ok(Math.abs(Date.now() - new Date(normalInsert.status_changed_at).getTime()) < 30_000);

  await sql.query('select pg_sleep(0.01)');
  const statusUpdate = (await sql.query(`update public.outbound_shipments set status='packed'
    where id=$1 returning status_changed_at`, [normalId])).rows[0];
  assert.ok(new Date(statusUpdate.status_changed_at) > new Date(normalInsert.status_changed_at));
  await sql.query('select pg_sleep(0.01)');
  const nonStatusUpdate = (await sql.query(`update public.outbound_shipments set note='unchanged status'
    where id=$1 returning status_changed_at`, [normalId])).rows[0];
  assert.equal(new Date(nonStatusUpdate.status_changed_at).toISOString(),
    new Date(statusUpdate.status_changed_at).toISOString());
  await assert.rejects(() => sql.query('update public.outbound_shipments set status=null where id=$1', [normalId]),
    /null value|not-null/iu);
  assert.equal(new Date((await sql.query('select status_changed_at from public.outbound_shipments where id=$1', [normalId])).rows[0]
    .status_changed_at).toISOString(), new Date(statusUpdate.status_changed_at).toISOString());

  await sql.query('set role authenticated');
  await sql.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  await assert.rejects(() => sql.query(`select public.erp_apply_field_mutations(
    'outbound_shipments',$1::jsonb)`, [JSON.stringify([{ kind: 'patch', id: normalId,
    observedVersion: 1, expected: { status_changed_at: null }, changes: { status_changed_at: suppliedHistory } }])]),
  /FIELD_NOT_ALLOWED/u);
  await assert.rejects(() => sql.query(`update public.outbound_shipments
    set status_changed_at=$2 where id=$1`, [normalId, suppliedHistory]),
  /OUTBOUND_STATUS_TIMESTAMP_SYSTEM_MANAGED/u);
  await sql.query('reset role');

  const nullId = uuid(701);
  const historicalId = uuid(702);
  await sql.query(`insert into public.outbound_shipments(id,title,status) values
    ($1,'Restore null timestamp','draft'),($2,'Restore historical timestamp','received')`, [nullId, historicalId]);
  await sql.query('update public.outbound_shipments set status_changed_at=null where id=$1', [nullId]);
  await sql.query('update public.outbound_shipments set status_changed_at=$2 where id=$1', [historicalId, suppliedHistory]);

  const snapshot = (await sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data;
  const expectedTimestamps = new Map(snapshot.outbound_shipments.map(row => [row.id, row.status_changed_at]));
  assert.equal(expectedTimestamps.get(nullId), null);
  assert.equal(new Date(expectedTimestamps.get(historicalId)).toISOString(), suppliedHistory);
  const audit = (await sql.query('select public.erp_cloud_restore_audit_dataset($1) result', [snapshot])).rows[0].result;
  const manifest = { schemaVersion: 'cloud-erp-snapshot-v2', resourceCount: 24,
    counts: audit.table_counts, totalRows: Number(audit.total_rows), orphanCount: 0,
    duplicateVariantIdCount: 0, duplicateVariantLocalIdCount: 0 };
  const restored = (await sql.query(`select public.erp_restore_cloud_snapshot(
    $1,repeat('a',64),$2::jsonb,$3::jsonb,'isolated') result`,
  [uuid(703), snapshot, manifest])).rows[0].result;
  assert.equal(restored.ok, true);
  const restoredRows = (await sql.query('select id,status_changed_at from public.outbound_shipments order by id')).rows;
  for (const row of restoredRows) {
    const expected = expectedTimestamps.get(row.id);
    assert.equal(row.status_changed_at === null ? null : new Date(row.status_changed_at).toISOString(),
      expected === null ? null : new Date(expected).toISOString(), row.id);
  }

  const beforeFailedWriter = structuredClone((await sql.query(
    'select public.erp_cloud_restore_snapshot() data')).rows[0].data);
  await assert.rejects(() => sql.query(`select public.erp_cloud_restore_insert_rows(
    'public.outbound_shipments'::regclass,$1::jsonb)`, [JSON.stringify([{
    id: uuid(704), title: 'Missing timestamp evidence', status: 'draft',
  }])]), /CLOUD_RESTORE_OUTBOUND_TIMESTAMP_EVIDENCE_MISSING/u);
  assert.deepEqual((await sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data,
    beforeFailedWriter, 'Writer failure must roll back its INSERT');

  for (const role of ['public', 'anon', 'authenticated']) {
    assert.equal((await sql.query(`select has_function_privilege($1,
      'public.erp_cloud_restore_insert_rows(regclass,jsonb)','execute') allowed`, [role])).rows[0].allowed, false, role);
  }
  const triggerDefinitionBeforeReplay = (await sql.query(`select pg_get_functiondef(
    'public.erp_set_outbound_status_changed_at()'::regprocedure) definition`)).rows[0].definition;
  const fingerprintBeforeReplay = (await sql.query(`select md5(pg_get_functiondef(
    'public.erp_cloud_restore_insert_rows(regclass,jsonb)'::regprocedure)) fingerprint`)).rows[0].fingerprint;
  await sql.query(migration);
  assert.equal((await sql.query(`select md5(pg_get_functiondef(
    'public.erp_cloud_restore_insert_rows(regclass,jsonb)'::regprocedure)) fingerprint`)).rows[0].fingerprint,
  fingerprintBeforeReplay);
  assert.equal((await sql.query(`select pg_get_functiondef(
    'public.erp_set_outbound_status_changed_at()'::regprocedure) definition`)).rows[0].definition,
  triggerDefinitionBeforeReplay);

  console.log(JSON.stringify({ PASS: true, engine: 'native PostgreSQL', normalInsertTrigger: 'PASS',
    statusUpdate: 'PASS', nonStatusUpdate: 'PASS', nullStatusRejected: 'PASS', clientMutationRejected: 'PASS',
    restoreNullExact: 'PASS', restoreHistoricalExact: 'PASS', restoreRowsChecked: restoredRows.length,
    writerFailureRollback: 'PASS', internalWriterAcl: 'PASS', normalTriggerSemanticsPreserved: true, reapplyStable: true,
    liveMutation: 0 }));
} finally {
  await vite.close();
  await db.close();
}
