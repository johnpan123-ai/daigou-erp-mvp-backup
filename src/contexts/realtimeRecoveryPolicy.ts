/**
 * P0-2 Phase 1a C1f: Realtime channel recovery policy (pure, no I/O).
 *
 * This module only decides WHEN a broken or unproven Realtime channel is replaced by a new
 * one. It never decides that data is Fresh: every replacement channel must earn the full
 * completeness proof again (SUBSCRIBED + postgres_changes `system` ok for that generation +
 * a catch-up / core snapshot that started after it). A timer here may change the presentation
 * (pending -> unproven) and schedule a reconnect; it can never release a Fresh hold or the
 * write fence.
 *
 * SDK coexistence (@supabase/realtime-js 2.106.2 / @supabase/phoenix 0.4.2): after a join
 * error or join timeout the SDK rejoins the SAME channel by itself (1 s, 2 s, 5 s, then 10 s)
 * while the socket is connected, and again when the socket reopens. A replacement is
 * therefore delayed by at least `sdkRejoinGraceMs` after CHANNEL_ERROR / TIMED_OUT, so the
 * SDK rejoin gets the first chance. A CLOSED channel is never rejoined by the SDK.
 */
export const REALTIME_RECOVERY_POLICY = Object.freeze({
  /** A3: a channel that has not proven postgres_changes listening after this long is shown as unproven. */
  pendingLimitMs: 15_000,
  /** CHANNEL_ERROR / TIMED_OUT: the SDK's own rejoin of the same channel gets this window first. */
  sdkRejoinGraceMs: 12_000,
  /** Bounded exponential backoff between channel replacements. */
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  /** +/- share of the backoff delay that is randomised. */
  jitterRatio: 0.2,
  /** Minimum time between two channel replacements, including manual reconnect requests. */
  minIntervalMs: 5_000,
});

export type RealtimeRecoveryCause = 'channel-error' | 'timed-out' | 'closed' | 'pending-timeout' | 'catch-up-incomplete' | 'manual' | 'focus' | 'online';

export interface RealtimeRecoveryView {
  /** Recovery attempts (channel replacements or proving catch-ups) since the last proven generation. */
  attempt: number;
  /** Epoch ms of the next scheduled replacement, or null. */
  nextAt: number | null;
  inFlight: boolean;
  lastCause: RealtimeRecoveryCause | null;
  lastError: string | null;
}

/** Delay before the next replacement. `random` returns [0, 1). */
export const computeRealtimeRecoveryDelay = (
  attempt: number,
  cause: RealtimeRecoveryCause,
  msSinceLastReplacement: number,
  random: () => number,
): number => {
  const policy = REALTIME_RECOVERY_POLICY;
  const intervalGap = Math.max(0, policy.minIntervalMs - Math.max(0, msSinceLastReplacement));
  // Only an explicit user request skips the backoff; focus / online events follow it.
  if (cause === 'manual') return intervalGap;
  const exponent = Math.min(Math.max(0, attempt), 16);
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const jitter = backoff * policy.jitterRatio * (Math.min(Math.max(random(), 0), 1) * 2 - 1);
  const jittered = Math.min(policy.maxDelayMs, Math.max(policy.baseDelayMs, Math.round(backoff + jitter)));
  const sdkGrace = cause === 'channel-error' || cause === 'timed-out' ? policy.sdkRejoinGraceMs : 0;
  return Math.max(jittered, sdkGrace, intervalGap);
};

export interface RealtimeRecoveryHost {
  now: () => number;
  random: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Re-checked when a timer fires: false once completeness is proven, or when disposed / disconnected on purpose. */
  shouldRecover: () => boolean;
  /**
   * One recovery attempt: replace the channel, or (listening confirmed) run a proving catch-up.
   * Must never mark anything Fresh itself; rejects when the attempt did not succeed.
   */
  recover: (cause: RealtimeRecoveryCause) => Promise<void>;
  onChange?: (view: RealtimeRecoveryView) => void;
}

/**
 * Single-flight, coalescing scheduler: at most one pending timer and at most one replacement
 * in flight. Requests while a replacement runs are folded into one follow-up check.
 */
export class RealtimeRecoveryScheduler {
  private attempt = 0;
  private timer: unknown = null;
  private dueAt: number | null = null;
  private inFlight = false;
  private followUp: RealtimeRecoveryCause | null = null;
  private lastReplacementAt: number | null = null;
  private lastCause: RealtimeRecoveryCause | null = null;
  private lastError: string | null = null;
  private disposed = false;
  /** Set when the in-flight attempt was superseded (cancel / SDK rejoin): its failure is not retried. */
  private supersededInFlight = false;
  /** The pending timer also carries a request that did not merely wait for the SDK rejoin. */
  private pendingBeyondSdkWait = false;
  private readonly host: RealtimeRecoveryHost;

  constructor(host: RealtimeRecoveryHost) {
    this.host = host;
  }

  request(cause: RealtimeRecoveryCause): void {
    if (this.disposed) return;
    const beyondSdkWait = cause !== 'channel-error' && cause !== 'timed-out';
    if (this.inFlight) {
      // A follow-up that does more than wait for the SDK rejoin is not overwritten by one that does.
      const keep = this.followUp !== null && this.followUp !== 'channel-error' && this.followUp !== 'timed-out' && !beyondSdkWait;
      if (!keep) this.followUp = cause;
      return;
    }
    const now = this.host.now();
    const since = this.lastReplacementAt === null ? Number.POSITIVE_INFINITY : now - this.lastReplacementAt;
    const due = now + computeRealtimeRecoveryDelay(this.attempt, cause, since, this.host.random);
    // Coalesce: an earlier pending replacement is kept; a sooner one replaces it.
    if (this.timer !== null && this.dueAt !== null && this.dueAt <= due) {
      if (beyondSdkWait) this.pendingBeyondSdkWait = true;
      return;
    }
    const carried = this.timer !== null && this.pendingBeyondSdkWait;
    this.clear();
    this.pendingBeyondSdkWait = beyondSdkWait || carried;
    this.lastCause = cause;
    this.dueAt = due;
    this.timer = this.host.setTimer(() => { void this.fire(cause); }, Math.max(0, due - now));
    this.publish();
  }

  /** The current generation proved completeness: reset backoff and drop any pending replacement. */
  noteProven(): void {
    this.attempt = 0;
    this.followUp = null;
    this.lastError = null;
    this.clear();
    this.publish();
  }

  /** A replacement was performed outside this scheduler (Staging fault control). */
  noteExternalReplacement(): void {
    this.lastReplacementAt = this.host.now();
    this.clear();
    this.publish();
  }

  cancel(): void {
    this.followUp = null;
    if (this.inFlight) this.supersededInFlight = true;
    this.clear();
    this.publish();
  }

  /**
   * The SDK rejoined the channel (SUBSCRIBED again). Only the waits that existed to give the SDK
   * rejoin its chance (CHANNEL_ERROR / TIMED_OUT) are dropped; a pending-timeout, catch-up or user
   * request stays scheduled, so a channel that keeps rejoining without ever proving listening is
   * still replaced. An attempt in flight for the old join is not retried after a failure; the
   * rejoined channel runs its own proof window (watchdog / catch-up).
   */
  noteSdkRejoined(): void {
    const sdkWait = (cause: RealtimeRecoveryCause | null) => cause === 'channel-error' || cause === 'timed-out';
    if (this.inFlight) {
      this.supersededInFlight = true;
      if (sdkWait(this.followUp)) this.followUp = null;
    } else if (this.timer !== null && !this.pendingBeyondSdkWait) {
      this.clear();
    }
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    this.followUp = null;
    this.clear();
  }

  view(): RealtimeRecoveryView {
    return { attempt: this.attempt, nextAt: this.dueAt, inFlight: this.inFlight, lastCause: this.lastCause, lastError: this.lastError };
  }

  private clear(): void {
    if (this.timer !== null) this.host.clearTimer(this.timer);
    this.timer = null;
    this.dueAt = null;
    this.pendingBeyondSdkWait = false;
  }

  private publish(): void {
    if (!this.disposed) this.host.onChange?.(this.view());
  }

  private async fire(cause: RealtimeRecoveryCause): Promise<void> {
    this.timer = null;
    this.dueAt = null;
    this.pendingBeyondSdkWait = false;
    if (this.disposed) return;
    if (!this.host.shouldRecover()) { this.publish(); return; }
    this.inFlight = true;
    this.supersededInFlight = false;
    this.attempt += 1;
    this.lastReplacementAt = this.host.now();
    this.publish();
    let failed = false;
    try {
      await this.host.recover(cause);
      this.lastError = null;
    } catch (error) {
      failed = true;
      this.lastError = String((error as { message?: unknown } | null)?.message ?? error).slice(0, 120);
    } finally {
      this.inFlight = false;
    }
    if (this.disposed) return;
    // A successful attempt starts its own proof window (watchdog / catch-up); requests that arrived
    // while it ran are dropped. A failed attempt keeps the fail-closed state and backs off.
    const next = failed ? this.followUp ?? (this.supersededInFlight ? null : cause) : null;
    this.supersededInFlight = false;
    this.followUp = null;
    this.publish();
    if (next && this.host.shouldRecover()) this.request(next === 'manual' || next === 'focus' || next === 'online' ? 'closed' : next);
  }
}
