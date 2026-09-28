import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

const SQL = readFileSync(new URL('../supabase/sql/043_cloud_restore_execute_dispatch_boundary.sql', import.meta.url), 'utf8');
const PROVIDER = readFileSync(new URL('../src/providers/cloud/supabaseProvider.ts', import.meta.url), 'utf8');
const DATA_PROVIDER = readFileSync(new URL('../src/providers/dataProvider.ts', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../src/components/CloudAtomicRestorePanel.tsx', import.meta.url), 'utf8');
const GUARD = readFileSync(new URL('../src/lib/cloudWriteGuard.ts', import.meta.url), 'utf8');

assert.equal((SQL.match(/^begin;$/gimu) || []).length, 1);
assert.equal((SQL.match(/^commit;$/gimu) || []).length, 1);
assert.match(SQL, /create table public\.erp_cloud_restore_candidate_proofs/u);
assert.match(SQL, /enable row level security/u);
assert.match(SQL, /force row level security/u);
assert.match(SQL, /revoke all on table public\.erp_cloud_restore_candidate_proofs from public,anon,authenticated/u);
assert.match(SQL, /create function public\.erp_prove_cloud_restore_candidate_v2\(/u);
assert.match(SQL, /create function public\.erp_restore_proven_cloud_snapshot_attempt\(/u);
assert.match(SQL, /rpc=EXECUTE event=db-entry/u);
assert.match(SQL, /v_proof\.effective_snapshot/u);
assert.match(SQL, /if v_attempt\.status='prepared'[\s\S]+set status='executing',execution_id=p_execution_id/u);
assert.match(SQL, /insert into public\.erp_cloud_restore_failures/u);
assert.match(SQL, /set status='not_committed'/u);
assert.match(SQL, /set status='completed'/u);
const lightweightExecute = SQL.slice(
  SQL.indexOf('create function public.erp_restore_proven_cloud_snapshot_attempt('),
  SQL.indexOf('revoke all on function public.erp_restore_proven_cloud_snapshot_attempt('),
);
assert.doesNotMatch(lightweightExecute, /p_source_snapshot|erp_cloud_restore_build_effective_snapshot/u);
assert.doesNotMatch(lightweightExecute, /raise log[^;]*(?:effective_snapshot|manifest)/iu);

const providerExecute = PROVIDER.slice(
  PROVIDER.indexOf('async restoreCloudSnapshot('),
  PROVIDER.indexOf('private async applyCloudFieldMutations'),
);
assert.match(providerExecute, /p_proof_id: command\.proofId/u);
assert.match(providerExecute, /p_request_id: requestId/u);
assert.doesNotMatch(providerExecute, /p_source_snapshot|p_manifest|p_snapshot_fingerprint/u);
assert.doesNotMatch(providerExecute, /assertCloudWriteAllowed\(\)/u,
  'A committed PREPARE must not be suppressed by a later client connectivity transition');
assert.match(DATA_PROVIDER, /committedRestoreWrite[\s\S]+registerWrite/u);
assert.match(DATA_PROVIDER, /restoreCloudSnapshot[\s\S]+committedRestoreWrite/u);
assert.equal((PANEL.match(/validateRestoreTarget \?\?/gu) || []).length, 0,
  'The proof RPC already performs target and portability validation; do not upload 13MB twice');
assert.match(PANEL, /proofId: activeProof\.proofId/u);
assert.match(GUARD, /fetchWithCloudRestoreRpcObservation/u);

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}
globalThis.window = { sessionStorage: new MemoryStorage(), location: { origin: 'https://erp.example.invalid' } };

const vite = await createServer({ configFile: false, cacheDir: join(tmpdir(), 'waca-v3-execute-vite'),
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const transport = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreRpcTransport.ts');
  const requestId = '00000000-0000-4000-8000-000000000001';
  const traceId = '00000000-0000-4000-8000-000000000002';
  const attemptId = '00000000-0000-4000-8000-000000000003';
  const executionId = '00000000-0000-4000-8000-000000000004';
  const proofId = '00000000-0000-4000-8000-000000000005';
  const executeBody = JSON.stringify({
    p_request_id: requestId, p_trace_id: traceId, p_attempt_id: attemptId,
    p_execution_id: executionId, p_proof_id: proofId,
  });
  let observedHeader = '';
  const success = await transport.fetchWithCloudRestoreRpcObservation(async (_input, init) => {
    observedHeader = new Headers(init.headers).get('x-restore-request-id');
    return new Response('{"ok":true}', { status: 200, headers: {
      'cf-ray': 'safe-ray', 'x-kong-request-id': 'safe-gateway-id', 'server-timing': 'db;dur=12',
    } });
  }, 'https://project.supabase.co/rest/v1/rpc/erp_restore_proven_cloud_snapshot_attempt', {
    method: 'POST', body: executeBody,
  });
  assert.equal(success.status, 200);
  await new Promise(resolve => setTimeout(resolve, 0));
  let record = transport.getCloudRestoreRpcTransportDiagnostics().at(-1);
  assert.equal(observedHeader, requestId);
  assert.equal(record.outcome, 'EXECUTE_RESPONSE_RECEIVED');
  assert.equal(record.requestBodyBytes, Buffer.byteLength(executeBody));
  assert.equal(record.traceId, traceId);
  assert.equal(record.attemptId, attemptId);
  assert.equal(record.executionId, executionId);
  assert.equal(record.httpStatus, 200);
  assert.equal(record.cfRay, 'safe-ray');
  assert.equal(record.gatewayRequestId, 'safe-gateway-id');
  assert(record.responseHeadersAt && record.responseCompletedAt);

  const httpErrorId = '00000000-0000-4000-8000-000000000006';
  await transport.fetchWithCloudRestoreRpcObservation(
    async () => new Response('bad gateway', { status: 502 }),
    'https://project.supabase.co/rest/v1/rpc/erp_restore_proven_cloud_snapshot_attempt',
    { method: 'POST', body: JSON.stringify({ p_request_id: httpErrorId }) },
  );
  record = transport.getCloudRestoreRpcTransportDiagnostics().find(value => value.requestId === httpErrorId);
  assert.equal(record.outcome, 'EXECUTE_HTTP_ERROR');
  assert.equal(record.httpStatus, 502);

  const networkId = '00000000-0000-4000-8000-000000000007';
  await assert.rejects(() => transport.fetchWithCloudRestoreRpcObservation(
    async () => { throw new TypeError('network unavailable'); },
    'https://project.supabase.co/rest/v1/rpc/erp_restore_proven_cloud_snapshot_attempt',
    { method: 'POST', body: JSON.stringify({ p_request_id: networkId }) },
  ));
  record = transport.getCloudRestoreRpcTransportDiagnostics().find(value => value.requestId === networkId);
  assert.equal(record.outcome, 'EXECUTE_DISPATCHED_NO_RESPONSE');

  const abortId = '00000000-0000-4000-8000-000000000008';
  const controller = new AbortController();
  const abortPromise = transport.fetchWithCloudRestoreRpcObservation(
    async (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
    'https://project.supabase.co/rest/v1/rpc/erp_restore_proven_cloud_snapshot_attempt',
    { method: 'POST', body: JSON.stringify({ p_request_id: abortId }), signal: controller.signal },
  );
  controller.abort('fixture-client-abort');
  await assert.rejects(() => abortPromise);
  record = transport.getCloudRestoreRpcTransportDiagnostics().find(value => value.requestId === abortId);
  assert.equal(record.outcome, 'EXECUTE_ABORTED_CLIENT');
  assert.equal(record.abortReason, 'fixture-client-abort');

  const notDispatchedId = '00000000-0000-4000-8000-000000000009';
  transport.recordCloudRestoreRpcIntent({
    requestId: notDispatchedId, rpcName: 'erp_restore_proven_cloud_snapshot_attempt',
    traceId, attemptId, executionId,
  });
  record = transport.getCloudRestoreRpcTransportDiagnostics().find(value => value.requestId === notDispatchedId);
  assert.equal(record.outcome, 'EXECUTE_NOT_DISPATCHED');
  assert.doesNotMatch(JSON.stringify(transport.getCloudRestoreRpcTransportDiagnostics()),
    /"(?:authorization|cookie|snapshot|customer|password)"/iu);

  const snapshotPath = process.env.CLOUD_RESTORE_LIVE_SHAPE_SNAPSHOT
    || 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-26-054815.json';
  if (existsSync(snapshotPath)) {
    const domain = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
    const portability = await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
    const raw = readFileSync(snapshotPath);
    const source = await domain.prepareCloudRestoreSnapshot(raw.toString('utf8'), {
      fileName: 'live-shape.json', sourceEnvironment: 'https://source.example.invalid',
      sourceFileSha256: await domain.sha256BytesHex(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)),
    });
    const portable = await portability.prepareCrossEnvironmentCloudRestoreCandidate(source, 'rhfdjsklfrgpoqsaqpkn');
    const effective = await portability.assertCloudRestoreEffectiveCandidate(portable);
    const legacyBody = JSON.stringify({
      p_attempt_id: attemptId, p_trace_id: traceId, p_execution_id: executionId,
      p_snapshot_fingerprint: portable.manifest.snapshotFingerprint,
      p_source_snapshot: effective.sourceData, p_manifest: portable.manifest,
      p_source_environment: source.sourceEnvironment, p_restore_mode: effective.mode,
    });
    const proofBody = JSON.stringify({
      p_request_id: requestId, p_source_snapshot: effective.sourceData,
      p_manifest: portable.manifest, p_restore_mode: effective.mode,
      p_source_environment: source.sourceEnvironment,
    });
    const prepareBody = JSON.stringify({
      p_attempt_id: attemptId, p_trace_id: traceId,
      p_source_fingerprint: portable.portability.sourceSnapshotFingerprint,
      p_effective_fingerprint: portable.manifest.snapshotFingerprint,
      p_restore_policy: portable.portability.policyVersion,
      p_target_environment: portable.portability.targetProjectRef,
      p_timeout_budget_ms: 120000,
      p_timeout_contract_version: 'postgresql-statement-timeout-v1',
    });
    const newExecuteBody = JSON.stringify({
      p_attempt_id: attemptId, p_trace_id: traceId, p_execution_id: executionId,
      p_proof_id: proofId, p_request_id: requestId,
    });
    const measurements = {
      rawFileBytes: raw.byteLength,
      rows: portable.manifest.totalRows,
      transforms: portable.portability.totalTransformedRows,
      prepareBytes: Buffer.byteLength(prepareBody),
      proofBytes: Buffer.byteLength(proofBody),
      legacyExecuteBytes: Buffer.byteLength(legacyBody),
      provenExecuteBytes: Buffer.byteLength(newExecuteBody),
    };
    console.log('RESTORE_LIVE_SHAPE_BYTES', JSON.stringify(measurements));
    assert.equal(measurements.rows, 18060); // legacy 15-resource fixture + durable WACA cutover state
    assert.equal(measurements.transforms, 15711);
    assert.equal(measurements.legacyExecuteBytes, 14222089);
    assert(measurements.provenExecuteBytes < 512);
    assert(measurements.legacyExecuteBytes / measurements.provenExecuteBytes > 20_000);
  } else {
    console.log('RESTORE_LIVE_SHAPE_BYTES NOT MEASURED: fixture unavailable');
  }
} finally {
  await vite.close();
  delete globalThis.window;
}

console.log('PASS Restore dispatch boundary: proof-backed sub-1KB EXECUTE, request correlation, and distinct not-dispatched/abort/http/no-response outcomes');
