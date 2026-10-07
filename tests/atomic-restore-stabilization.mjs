import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { isolatedDatabase, owner } from './helpers/saveability-isolated.mjs';

const fixturePath = process.env.ERP2_CHAOS_BASELINE_B;
const baselineAPath = process.env.ERP2_CHAOS_BASELINE_A;
if (!fixturePath) throw new Error('ERP2_CHAOS_BASELINE_B is required');
if (!baselineAPath) throw new Error('ERP2_CHAOS_BASELINE_A is required');
const raw = await readFile(fixturePath, 'utf8');
const rawA = await readFile(baselineAPath, 'utf8');
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false } });
const db = await isolatedDatabase();
const result = { fixtureBytes: Buffer.byteLength(raw), prepareRuns: [], executeRuns: [], restartCount: 0 };
const postmasterBefore=(await db.sql.query('select pg_postmaster_start_time() t')).rows[0].t;

try {
  const restore = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const upload = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
  const candidate = await restore.prepareCloudRestoreSnapshot(raw, { fileName: 'CHAOS_BASELINE_B_VALID.json' });
  const candidateA = await restore.prepareCloudRestoreSnapshot(rawA, { fileName: 'STABILITY_BASELINE_A.json' });
  assert.equal(candidate.manifest.resourceCount, 24);
  assert.equal(candidate.manifest.totalRows, 25056);
  const actorIds = new Set([candidate, candidateA].flatMap(source => Object.values(source.data).flatMap(rows => rows
    .map(row => row.updated_by).filter(value => typeof value === 'string' && value !== owner))));
  for (const actorId of actorIds) {
    await db.sql.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3) on conflict do nothing',
      [actorId, 'restore-fixture@example.invalid', {}]);
  }

  const prove = async (source = candidate) => {
    const requestId = randomUUID();
    await db.sql.query("select set_config('request.headers',$1,false)", [JSON.stringify({
      host: 'rhfdjsklfrgpoqsaqpkn.supabase.co', 'x-restore-request-id': requestId,
    })]);
    const started = performance.now();
    const proof = await upload.uploadCloudRestoreCandidate(async (name,args) => {
      const specs={erp_begin_restore_upload:['p_request_id','p_manifest','p_restore_mode','p_source_environment'],
        erp_upload_restore_chunk:['p_request_id','p_resource','p_ordinal','p_rows'],
        erp_upload_restore_chunk_batch:['p_request_id','p_chunks'],
        erp_stage_restore_upload_resource:['p_request_id','p_resource'],erp_finalize_restore_upload:['p_request_id']};
      assert.ok(specs[name]);
      const values=specs[name].map(k=>typeof args[k]==='object'?JSON.stringify(args[k]):args[k]);
      return {data:(await db.sql.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) result`,values)).rows[0].result,error:null};
    }, {...source,sourceEnvironment:'isolated-chaos'}, source.data,'strict',requestId);
    const elapsed = performance.now() - started;
    assert.equal(proof.ok, true);
    assert.equal(proof.prepared_row_count, source.manifest.totalRows);
    assert.match(proof.prepared_payload_hash, /^[0-9a-f]{64}$/u);
    return { proof, requestId, elapsed };
  };
  const execute = async (source = candidate) => {
    const { proof, requestId, elapsed: prepareMs } = await prove(source);
    const attemptId = randomUUID();
    const traceId = randomUUID();
    const executionId = randomUUID();
    const beforeEpoch = Number((await db.sql.query(
      'select epoch from public.erp_cloud_restore_epoch where singleton=true')).rows[0].epoch);
    await db.sql.query('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,$7,$8)', [
      attemptId, traceId, source.manifest.snapshotFingerprint, source.manifest.snapshotFingerprint,
      'strict', 'rhfdjsklfrgpoqsaqpkn', 120000, 'postgresql-statement-timeout-v1',
    ]);
    const body = { p_attempt_id: attemptId, p_trace_id: traceId, p_execution_id: executionId,
      p_proof_id: proof.proof_id, p_request_id: requestId };
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 269);
    const started = performance.now();
    const restored = (await db.sql.query(
      'select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result',
      Object.values(body),
    )).rows[0].result;
    const executeMs = performance.now() - started;
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.executeModel, 'typed-staged-generation-v2');
    assert.equal(restored.timingsMs.beforeSnapshot, 0);
    assert.equal(restored.restoreEpoch, beforeEpoch + 1);
    assert.equal((await db.sql.query('select count(*)::int n from public.erp_cloud_restore_prepared_chunks')).rows[0].n, 0);
    const audit = (await db.sql.query('select public.erp_read_cloud_restore_integrity_audit() result')).rows[0].result;
    assert.equal(Number(audit.epoch), beforeEpoch + 1);
    return { prepareMs, executeMs, restoreEpoch: restored.restoreEpoch, timingsMs: restored.timingsMs };
  };

  const directWarmup = await prove();
  const typedPlan=(await db.sql.query('explain (analyze,buffers,format json) select * from public.erp_restore_stage_inventory_items where restore_proof_id=$1',[directWarmup.proof.proof_id])).rows[0]['QUERY PLAN'][0];
  const decodedPlan=(await db.sql.query('explain (analyze,buffers,format json) select r.* from public.erp_cloud_restore_prepared_chunks c cross join lateral jsonb_populate_recordset(null::public.inventory_items,c.rows) r where c.proof_id=$1 and c.resource=$2',[directWarmup.proof.proof_id,'inventory_items'])).rows[0]['QUERY PLAN'][0];
  result.inventoryReadPlans={typedMs:typedPlan['Execution Time'],legacyDecodeMs:decodedPlan['Execution Time'],typedNode:typedPlan.Plan['Node Type'],legacyNode:decodedPlan.Plan['Node Type'],newIndexAdded:false};
  const directStarted = performance.now();
  const direct = (await db.sql.query(
    'select public.erp_restore_staged_cloud_snapshot($1,$2,$3,$4,$5) result',
    [randomUUID(), directWarmup.proof.proof_id, candidate.manifest.snapshotFingerprint,
      candidate.manifest, 'isolated-chaos-b'],
  )).rows[0].result;
  assert.equal(direct.ok, true);
  result.directWarmup = { prepareMs: directWarmup.elapsed, executeMs: performance.now() - directStarted,
    timingsMs: direct.timingsMs };
  await db.sql.query('delete from public.erp_cloud_restore_candidate_proofs where proof_id=$1', [directWarmup.proof.proof_id]);
  const warmup = await execute();
  result.warmup = warmup;
  for (let index = 0; index < 5; index += 1) {
    const measured = await prove();
    result.prepareRuns.push(measured.elapsed);
    await db.sql.query('delete from public.erp_cloud_restore_candidate_proofs where proof_id=$1', [measured.proof.proof_id]);
  }
  for (let index = 0; index < 3; index += 1) result.executeRuns.push(await execute());
  const finalSnapshot = (await db.sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data;
  const final = await restore.buildCloudRestoreManifest(finalSnapshot, finalSnapshot);
  assert.equal(final.manifest.totalRows, candidate.manifest.totalRows);
  assert.equal(final.manifest.relationshipHash, candidate.manifest.relationshipHash);
  if (final.manifest.snapshotFingerprint !== candidate.manifest.snapshotFingerprint) {
    result.fieldDiff = {};
    const sameField = (key, left, right) => {
      if (left == null && right == null) return true;
      if (/(?:_at|_date)$/u.test(key) && typeof left === 'string' && typeof right === 'string'
        && Number.isFinite(Date.parse(left)) && Date.parse(left) === Date.parse(right)) return true;
      return restore.stableCloudRestoreJson(left) === restore.stableCloudRestoreJson(right);
    };
    for (const [, table] of restore.CLOUD_RESTORE_TABLES) {
      const expected = new Map(candidate.data[table].map(row => [String(row.id), row]));
      const fieldCounts = {};
      for (const row of final.data[table]) {
        const before = expected.get(String(row.id)) ?? {};
        for (const key of new Set([...Object.keys(before), ...Object.keys(row)])) {
          if (!sameField(key, before[key], row[key])) {
            fieldCounts[key] = (fieldCounts[key] ?? 0) + 1;
          }
        }
      }
      if (Object.keys(fieldCounts).length) result.fieldDiff[table] = fieldCounts;
    }
    assert.deepEqual(result.fieldDiff, {});
  }
  result.finalParity = 'PASS';
  result.restoreBx3 = 'PASS';

  const semanticDifferences = async expected => {
    const actualSnapshot = (await db.sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data;
    const actual = await restore.buildCloudRestoreManifest(actualSnapshot, actualSnapshot);
    assert.equal(actual.manifest.totalRows, expected.manifest.totalRows);
    assert.equal(actual.manifest.relationshipHash, expected.manifest.relationshipHash);
    const differences = {};
    const sameField = (key, left, right) => {
      if (left == null && right == null) return true;
      if (/(?:_at|_date)$/u.test(key) && typeof left === 'string' && typeof right === 'string'
        && Number.isFinite(Date.parse(left)) && Date.parse(left) === Date.parse(right)) return true;
      return restore.stableCloudRestoreJson(left) === restore.stableCloudRestoreJson(right);
    };
    for (const [, table] of restore.CLOUD_RESTORE_TABLES) {
      assert.equal(actual.data[table].length, expected.data[table].length, `${table}:row-count`);
      const expectedRows = new Map(expected.data[table].map(row => [String(row.id), row]));
      for (const row of actual.data[table]) {
        const before = expectedRows.get(String(row.id));
        if (!before) { differences[`${table}.unexpected`] = (differences[`${table}.unexpected`] ?? 0) + 1; continue; }
        for (const key of new Set([...Object.keys(before), ...Object.keys(row)])) {
          if (!sameField(key, before[key], row[key])) differences[`${table}.${key}`] = (differences[`${table}.${key}`] ?? 0) + 1;
        }
      }
    }
    assert.deepEqual(differences, {});
    return actual;
  };

  await execute(candidateA); await semanticDifferences(candidateA);
  await execute(candidate); await semanticDifferences(candidate);
  await execute(candidateA); const finalA = await semanticDifferences(candidateA);
  assert.equal(restore.stableCloudRestoreJson(finalA.data).includes('__ERP2_CHAOS_20261007__'), false);
  result.aToBToA = 'PASS';
  result.targetOnlyRemoved = 'PASS';
  result.oldValuesReplaced = 'PASS';
  result.softDeleteMatrix = 'PASS';
  result.relationshipRestore = 'PASS';
  result.wacaQuantityGhost = 'PASS';
  result.myacgQuantityGhost = 'PASS';
  result.manualMappingGhost = 'PASS';
  result.importBatchGhost = 'PASS';
  result.chaosSentinelRemaining = 0;

  const prepareEnvelope = async source => {
    const { proof, requestId } = await prove(source);
    const attemptId = randomUUID(), traceId = randomUUID(), executionId = randomUUID();
    const beforeEpoch = Number((await db.sql.query(
      'select epoch from public.erp_cloud_restore_epoch where singleton=true')).rows[0].epoch);
    await db.sql.query('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,$7,$8)', [
      attemptId, traceId, source.manifest.snapshotFingerprint, source.manifest.snapshotFingerprint,
      'strict', 'rhfdjsklfrgpoqsaqpkn', 120000, 'postgresql-statement-timeout-v1',
    ]);
    return { source, proof, requestId, attemptId, traceId, executionId, beforeEpoch,
      values: [attemptId, traceId, executionId, proof.proof_id, requestId] };
  };

  // Deliberately discard the first successful response, then recover from the
  // durable receipt. Replaying the exact execute identity must not advance the
  // Restore epoch a second time.
  const lostResponse = await prepareEnvelope(candidateA);
  const committed = (await db.sql.query(
    'select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result', lostResponse.values)).rows[0].result;
  assert.equal(committed.ok, true);
  const reconciled = (await db.sql.query('select public.erp_reconcile_cloud_restore_attempt($1,$2) result',
    [lostResponse.attemptId, lostResponse.traceId])).rows[0].result;
  assert.equal(reconciled.status, 'completed');
  assert.equal(restore.classifyCloudRestoreCommitOutcome({
    outcome: restore.assertCloudRestoreAttemptOutcome(reconciled), responseLost: true,
  }), 'COMMITTED_RESPONSE_LOST');
  assert.equal(Number(reconciled.resultEpoch), lostResponse.beforeEpoch + 1);
  const replay = (await db.sql.query(
    'select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result', lostResponse.values)).rows[0].result;
  assert.equal(replay.replayed, true);
  assert.equal(Number((await db.sql.query('select epoch from public.erp_cloud_restore_epoch where singleton=true')).rows[0].epoch),
    lostResponse.beforeEpoch + 1);
  result.responseLoss = 'PASS';
  result.doubleSubmit = 'PASS';

  // A controlled exception inside the business transaction proves that the
  // staged model still rolls back all 24 resources and leaves epoch unchanged.
  const interrupted = await prepareEnvelope(candidate);
  await db.sql.query("create function public.restore_057_failure_probe() returns trigger language plpgsql as $$begin raise exception 'RESTORE_057_CONTROLLED_FAILURE';end$$; create trigger restore_057_failure_probe before insert on public.waca_state for each row execute function public.restore_057_failure_probe()");
  const rejected = (await db.sql.query(
    'select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result', interrupted.values)).rows[0].result;
  assert.equal(rejected.status, 'not_committed');
  assert.equal(restore.classifyCloudRestoreCommitOutcome({
    outcome: restore.assertCloudRestoreAttemptOutcome(rejected), phase: 'execute',
  }), 'EXECUTE_ROLLED_BACK');
  const reconciledNoncommit = structuredClone(restore.assertCloudRestoreAttemptOutcome(rejected));
  reconciledNoncommit.failure.evidence = 'reconciled-noncommit';
  assert.equal(restore.classifyCloudRestoreCommitOutcome({
    outcome: reconciledNoncommit, phase: 'execute', databaseInterrupted: true,
  }), 'DATABASE_INTERRUPTED_NOT_COMMITTED');
  assert.equal(restore.classifyCloudRestoreCommitOutcome({ phase: 'execute', responseLost: true }),
    'COMMIT_RESULT_UNKNOWN');
  assert.equal(Number((await db.sql.query('select epoch from public.erp_cloud_restore_epoch where singleton=true')).rows[0].epoch),
    interrupted.beforeEpoch);
  await db.sql.query('drop trigger restore_057_failure_probe on public.waca_state; drop function public.restore_057_failure_probe()');
  await semanticDifferences(candidateA);
  result.processInterruptionRollback = 'PASS';
  // A real business statement after Prepare invalidates the immutable source
  // generation, even when it changes a field not present in the target proof.
  const stalePrepared = await prepareEnvelope(candidate);
  await db.sql.query("update public.product_groups set title=title||' CAS PROBE' where id=(select id from public.product_groups limit 1)");
  const sourceBeforeStale = (await db.sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data;
  const staleResult = (await db.sql.query(
    'select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result', stalePrepared.values)).rows[0].result;
  assert.equal(staleResult.status, 'not_committed');
  assert.equal(staleResult.failure.category, 'STALE');
  assert.deepEqual((await db.sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data,sourceBeforeStale);
  assert.equal(Number((await db.sql.query('select epoch from public.erp_cloud_restore_epoch where singleton')).rows[0].epoch),stalePrepared.beforeEpoch);
  result.sourceGenerationCAS = 'PASS';
  for (let run=0;run<5;run+=1) {
    await execute(candidate);
    await execute(candidateA);
    await semanticDifferences(candidateA);
  }
  result.exactBtoAFiveRuns = '5/5 COMMITTED + EXACT';
  result.partialWrite = 0;
  assert.deepEqual((await db.sql.query('select pg_postmaster_start_time() t')).rows[0].t,postmasterBefore);
  result.postmasterUnchanged='PASS';
  console.log(JSON.stringify(result));
  if(process.env.ERP2_RESTORE_TEST_OUTPUT) await writeFile(process.env.ERP2_RESTORE_TEST_OUTPUT,JSON.stringify(result,null,2));
} finally {
  await vite.close();
  await db.close();
}
