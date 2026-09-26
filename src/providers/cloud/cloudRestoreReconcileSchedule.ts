/** At most two evidence checks per attempt/mount.
 * Never starts PREPARE/BEGIN/EXECUTE, and never polls an ambiguous outcome. */
export class CloudRestoreReconcileSchedule {
  private readonly checks = new Map<string, number>();
  delay(traceId: string, reconcileAfter: string | null, now: number): number | null {
    const count = this.checks.get(traceId) ?? 0;
    const deadline = reconcileAfter === null ? now : Date.parse(reconcileAfter);
    if (count >= 2 || !Number.isFinite(deadline)) return null;
    // A second check is intentionally delayed rather than recursively polled.
    // It covers a lock released just after the deadline check, then stops.
    if (count > 0 && deadline <= now) return 1_000;
    return Math.max(0, Math.min(deadline - now, 2_147_483_647));
  }
  mark(traceId: string): void { this.checks.set(traceId, (this.checks.get(traceId) ?? 0) + 1); }
}
