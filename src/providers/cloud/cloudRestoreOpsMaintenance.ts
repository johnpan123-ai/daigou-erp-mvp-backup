type MaintenanceRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
let running = false;

/** Best-effort OPS-only follow-up. Never awaited by Begin/Prepare/Execute or
 * Global Sync; no network retries, payload logging, or business RPCs. The
 * authenticated owner maintenance entry remains independently callable. */
export async function cleanupExpiredRestoreOps(rpc: MaintenanceRpc, currentRequestId: string): Promise<void> {
  if (running) return;
  running = true;
  const started = performance.now();
  try {
    for (let batch = 0; batch < 32 && performance.now() - started < 15000; batch++) {
      const { data, error } = await rpc('erp_cleanup_expired_restore_ops', { p_exclude_request_id: currentRequestId });
      if (error || !data || typeof data !== 'object' || !('status' in data) || data.status !== 'progress') break;
    }
  } catch { /* Independent failure domain: an OPS cleanup cannot fail Prepare. */ }
  finally { running = false; }
}
