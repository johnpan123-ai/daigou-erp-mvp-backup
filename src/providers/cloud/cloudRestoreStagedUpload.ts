import { CLOUD_RESTORE_TABLES, type CloudRestoreCandidate } from './cloudAtomicRestore';

type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
export class CloudRestoreUploadServerError extends Error {
  readonly response: unknown;
  constructor(response: unknown) { super('CLOUD_RESTORE_PREPARE_SERVER_REJECTED'); this.response = response; }
}

/** Bounded OPS staging only. No business mutation and no retry/replay of Execute. */
export async function uploadCloudRestoreCandidate(
  rpc: Rpc,
  candidate: CloudRestoreCandidate,
  sourceData: CloudRestoreCandidate['data'],
  mode: 'strict' | 'cross-environment',
  requestId: string,
): Promise<unknown> {
  const started = performance.now();
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await rpc(name, args);
    if (result.error) throw new CloudRestoreUploadServerError(result.error);
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
    while (!failed && (stageQueue.length > 0 || cursor < chunks.length)) {
      try {
        const resource = stageQueue.shift();
        if (resource !== undefined) {
          firstStageAtMs ??= performance.now() - started;
          await call('erp_stage_restore_upload_resource', { p_request_id: requestId, p_resource: resource });
        } else {
          const chunk = chunks[cursor++];
          await call('erp_upload_restore_chunk', chunk);
          const left = remaining.get(chunk.p_resource)! - 1;
          remaining.set(chunk.p_resource, left);
          if (left === 0) stageQueue.push(chunk.p_resource);
          uploaded += 1;
          if (uploaded === chunks.length) uploadCompletedAtMs = performance.now() - started;
        }
      } catch (error) { failed = true; throw error; }
    }
  }));
  const uploadAndStageMs = performance.now() - transferStarted;
  const finalizeStarted = performance.now();
  const result = await call('erp_finalize_restore_upload', { p_request_id: requestId });
  console.info('[Cloud Restore Prepare]', { requestId, chunkCount: chunks.length,
    uploadAndStageMs: Math.round(uploadAndStageMs), uploadCompletedAtMs: Math.round(uploadCompletedAtMs),
    firstStageAtMs: firstStageAtMs === null ? null : Math.round(firstStageAtMs),
    finalizeMs: Math.round(performance.now() - finalizeStarted),
    totalMs: Math.round(performance.now() - started) });
  return result;
}
