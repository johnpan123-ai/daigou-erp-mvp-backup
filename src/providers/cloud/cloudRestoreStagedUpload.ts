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
  // Four bounded independent chunk uploads, never 24 MB in one PostgREST body.
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => {
    while (!failed && cursor < chunks.length) {
      const chunk = chunks[cursor++];
      try { await call('erp_upload_restore_chunk', chunk); }
      catch (error) { failed = true; throw error; }
    }
  }));
  const uploadMs = performance.now() - started;
  const finalizeStarted = performance.now();
  const result = await call('erp_finalize_restore_upload', { p_request_id: requestId });
  console.info('[Cloud Restore Prepare]', { requestId, chunkCount: chunks.length,
    uploadMs: Math.round(uploadMs), finalizeMs: Math.round(performance.now() - finalizeStarted),
    totalMs: Math.round(performance.now() - started) });
  return result;
}
