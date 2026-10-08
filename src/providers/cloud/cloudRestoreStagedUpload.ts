import { CLOUD_RESTORE_TABLES, type CloudRestoreCandidate } from './cloudAtomicRestore';

type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown; status?: number }>;
export interface RestorePrepareCallTiming {
  rpc: string;
  resources: string[];
  chunkCount: number;
  requestBytes: number;
  startMs: number;
  endMs: number;
  wallMs: number;
  httpStatus: number | null;
  serverMs: number | null;
  phaseTimingsMs: Record<string, number>;
}
export class CloudRestoreUploadServerError extends Error {
  readonly response: unknown;
  readonly rpc: string;
  readonly requestId: string;
  constructor(response: unknown, rpc = '', requestId = '') {
    super('CLOUD_RESTORE_PREPARE_SERVER_REJECTED'); this.response = response;
    this.rpc = rpc; this.requestId = requestId;
  }
}

/** Bounded OPS staging only. No business mutation and no retry/replay of Execute. */
export async function uploadCloudRestoreCandidate(
  rpc: Rpc,
  candidate: CloudRestoreCandidate,
  sourceData: CloudRestoreCandidate['data'],
  mode: 'strict' | 'cross-environment',
  requestId: string,
  onTimings?: (timings: Record<string, number>) => void,
  onCallTimings?: (calls: RestorePrepareCallTiming[]) => void,
): Promise<unknown> {
  const started = performance.now();
  const calls: RestorePrepareCallTiming[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const at = performance.now();
    const encoder = new TextEncoder();
    const requestBytes = encoder.encode(JSON.stringify(args)).length;
    let result: Awaited<ReturnType<Rpc>>;
    try { result = await rpc(name, args); }
    catch (error) {
      if (name === 'erp_begin_restore_upload') throw new CloudRestoreUploadServerError(error, name, requestId);
      throw error;
    }
    const ended = performance.now();
    const response = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {};
    const parts = Array.isArray(args.p_chunks) ? args.p_chunks as Array<{ p_resource: string }> : [];
    const serverMs = response.serverMs ?? response.finalizeServerMs;
    const phases = response.phaseTimingsMs && typeof response.phaseTimingsMs === 'object'
      ? Object.fromEntries(Object.entries(response.phaseTimingsMs).filter(([key, value]) =>
        ['columns', 'immutableChunks', 'validationProjection', 'identityProof', 'typedStage',
          'authorization', 'resourceCoverage', 'validationInput', 'portability', 'wacaValidation',
          'projectedSemanticProof', 'manifestValidation', 'preparedChunkProof', 'proofWriteAndCleanup'].includes(key)
        && typeof value === 'number' && Number.isFinite(value) && value >= 0)) as Record<string, number> : {};
    // Transient scalar timings only. Never include payloads, row values, tokens
    // or raw errors; diagnostics do not affect proof, identity or persistence.
    calls.push({ rpc: name, resources: typeof args.p_resource === 'string' ? [args.p_resource] : parts.map(p => p.p_resource),
      chunkCount: parts.length || (Array.isArray(args.p_rows) ? 1 : 0), requestBytes,
      startMs: Math.round(at - started), endMs: Math.round(ended - started), wallMs: Math.round(ended - at),
      httpStatus: typeof result.status === 'number' ? result.status : null,
      serverMs: typeof serverMs === 'number' && Number.isFinite(serverMs) ? serverMs : null, phaseTimingsMs: phases });
    if (result.error) throw new CloudRestoreUploadServerError(result.error, name, requestId);
    return result.data;
  };
  await call('erp_begin_restore_upload', { p_request_id: requestId, p_manifest: candidate.manifest,
    p_restore_mode: mode, p_source_environment: candidate.sourceEnvironment });
  const chunks = CLOUD_RESTORE_TABLES.flatMap(([, resource]) => {
    const rows = sourceData[resource];
    return Array.from({ length: Math.ceil(rows.length / 512) }, (_, ordinal) => ({
      p_request_id: requestId, p_resource: resource, p_ordinal: ordinal,
      p_rows: rows.slice(ordinal * 512, (ordinal + 1) * 512),
    }));
  });
  const beginMs = performance.now() - started;
  const packingStarted = performance.now();
  const batches: typeof chunks[] = [];
  let batch: typeof chunks = [];
  let batchBytes = 2;
  const encoder = new TextEncoder();
  for (const chunk of chunks) {
    const bytes = encoder.encode(JSON.stringify({ p_resource: chunk.p_resource, p_ordinal: chunk.p_ordinal, p_rows: chunk.p_rows })).length + 1;
    if (batch.length > 0 && (batch.length === 4 || batchBytes + bytes > 1024 * 1024)) {
      batches.push(batch); batch = []; batchBytes = 2;
    }
    batch.push(chunk); batchBytes += bytes;
  }
  if (batch.length > 0) batches.push(batch);
  const packingMs = performance.now() - packingStarted;
  const sendBatch = async (parts: typeof chunks): Promise<void> => {
    if (parts.length === 1) { await call('erp_upload_restore_chunk', parts[0]); return; }
    try {
      await call('erp_upload_restore_chunk_batch', { p_request_id: requestId,
        p_chunks: parts.map(({ p_resource, p_ordinal, p_rows }) => ({ p_resource, p_ordinal, p_rows })) });
    } catch (error) {
      const response = error instanceof CloudRestoreUploadServerError ? error.response : null;
      if (!response || typeof response !== 'object' || !('message' in response)
        || response.message !== 'CLOUD_RESTORE_UPLOAD_BATCH_SIZE_LIMIT') throw error;
      // A conclusively rejected, zero-insert oversized OPS batch only. Never
      // retry an unknown response or Execute. Same immutable chunk identities.
      const midpoint = Math.ceil(parts.length / 2);
      await sendBatch(parts.slice(0, midpoint));
      await sendBatch(parts.slice(midpoint));
    }
  };
  let cursor = 0;
  let failed = false;
  const resources = CLOUD_RESTORE_TABLES.map(([, resource]) => resource);
  const remaining = new Map(resources.map(resource => [resource, Math.ceil(sourceData[resource].length / 512)]));
  const stageQueue = resources.filter(resource => remaining.get(resource) === 0);
  let firstStageAtMs: number | null = null;
  let uploadCompletedAtMs = chunks.length === 0 ? performance.now() - started : 0;
  let uploaded = 0;
  const transferStarted = performance.now();
  // One shared pool bounds TOTAL concurrent RPCs at four. A resource stages
  // only after all of ITS immutable chunks succeed, while other uploads can
  // continue. No full backup body, no Execute, no replay and no early finalize.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (!failed && (stageQueue.length > 0 || cursor < batches.length)) {
      try {
        const resource = stageQueue.shift();
        if (resource !== undefined) {
          firstStageAtMs ??= performance.now() - started;
          await call('erp_stage_restore_upload_resource', { p_request_id: requestId, p_resource: resource });
        } else {
          const parts = batches[cursor++];
          await sendBatch(parts);
          for (const chunk of parts) {
            const left = remaining.get(chunk.p_resource)! - 1;
            remaining.set(chunk.p_resource, left);
            if (left === 0) stageQueue.push(chunk.p_resource);
          }
          uploaded += parts.length;
          if (uploaded === chunks.length) uploadCompletedAtMs = performance.now() - started;
        }
      } catch (error) { failed = true; throw error; }
    }
  }));
  const uploadAndStageMs = performance.now() - transferStarted;
  const finalizeStarted = performance.now();
  const result = await call('erp_finalize_restore_upload', { p_request_id: requestId });
  const timings = { beginMs: Math.round(beginMs), packingMs: Math.round(packingMs),
    uploadAndStageMs: Math.round(uploadAndStageMs), finalizeMs: Math.round(performance.now() - finalizeStarted),
    totalMs: Math.round(performance.now() - started) };
  onTimings?.(timings);
  onCallTimings?.(calls);
  console.info('[Cloud Restore Prepare]', { requestId, chunkCount: chunks.length,
    batchCount: batches.length, ...timings, uploadCompletedAtMs: Math.round(uploadCompletedAtMs),
    firstStageAtMs: firstStageAtMs === null ? null : Math.round(firstStageAtMs),
  });
  return result;
}
