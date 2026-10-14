/**
 * P0-2 Phase 1a: Realtime postgres_changes readiness gate.
 *
 * SUBSCRIBED only proves the Phoenix channel join. Supabase documents a window
 * after SUBSCRIBED in which postgres_changes is not yet listening; the backend
 * confirms listening with a `system` message { extension: 'postgres_changes',
 * status: 'ok' }. That message is not formally documented upstream, so its
 * absence (or any other shape) is treated as NOT ready: callers must keep the
 * existing authoritative catch-up in that case. Pure in-memory state, no I/O.
 * C1d: unrecognised system messages are recorded (structure only) for diagnostics.
 */
import { noteRealtimeSystemOk, recordRealtimeSystemAnomaly } from './cloudSyncObservability';

export type RealtimeReadinessState = 'ready' | 'timeout' | 'unavailable' | 'not-armed';

interface ReadinessGate {
  generation: number;
  subscribed: boolean;
  postgresListening: boolean;
  failed: boolean;
  readyAt: number | null;
  waiters: Set<() => void>;
}

let gate: ReadinessGate | null = null;
let generationCounter = 0;
const armWaiters = new Set<() => void>();

const wake = (target: ReadinessGate) => {
  const waiters = [...target.waiters];
  target.waiters.clear();
  waiters.forEach(waiter => waiter());
};

const settleIfReady = (target: ReadinessGate) => {
  if (target.failed || target.readyAt !== null || !target.subscribed || !target.postgresListening) return;
  target.readyAt = Date.now();
  wake(target);
};

/** Start a new readiness window for a freshly built channel. */
export const armRealtimeReadiness = (): number => {
  if (gate) wake(gate);
  gate = { generation: ++generationCounter, subscribed: false, postgresListening: false, failed: false, readyAt: null, waiters: new Set() };
  const waitingForArm = [...armWaiters];
  armWaiters.clear();
  waitingForArm.forEach(waiter => waiter());
  return gate.generation;
};

export const markRealtimeSubscribed = (generation: number): void => {
  if (!gate || gate.generation !== generation || gate.failed) return;
  gate.subscribed = true;
  settleIfReady(gate);
};

/** Only the exact backend confirmation counts; anything else is ignored. */
export const markRealtimeSystemMessage = (generation: number, payload: unknown): void => {
  if (!gate || gate.generation !== generation || gate.failed) return;
  const record = payload as { extension?: unknown; status?: unknown } | null;
  // C1d: an unknown shape never opens the gate (unchanged); only its structure is recorded.
  if (record?.extension !== 'postgres_changes') { recordRealtimeSystemAnomaly('unrecognized-shape', generation, payload); return; }
  // C1c: the server confirms listening only after the join reply (Production probe:
  // always after SUBSCRIBED). A confirmation before this generation's SUBSCRIBED is a
  // late message of an earlier join and must not open the new gate.
  if (record.status === 'ok' && !gate.subscribed) { recordRealtimeSystemAnomaly('ok-before-subscribed', generation, payload); return; }
  if (record.status === 'ok') {
    noteRealtimeSystemOk();
    gate.postgresListening = true;
    settleIfReady(gate);
  } else {
    recordRealtimeSystemAnomaly(record.status === 'error' ? 'error-status' : 'unrecognized-status', generation, payload);
    gate.failed = true;
    wake(gate);
  }
};

export const markRealtimeUnavailable = (generation: number): void => {
  if (!gate || gate.generation !== generation) return;
  gate.failed = true;
  wake(gate);
};

export const disarmRealtimeReadiness = (generation: number): void => {
  if (!gate || gate.generation !== generation) return;
  gate.failed = true;
  wake(gate);
  gate = null;
};

export const getRealtimeReadiness = (): { armed: boolean; generation: number | null; readyAt: number | null; failed: boolean } => ({
  armed: gate !== null,
  generation: gate?.generation ?? null,
  readyAt: gate?.readyAt ?? null,
  failed: gate?.failed ?? false,
});

/** Resolves as soon as the current gate is ready, failed, or the timeout elapses. */
export const awaitRealtimeReadiness = (
  timeoutMs: number,
  options: { waitForArm?: boolean } = {},
): Promise<{ state: RealtimeReadinessState; generation: number | null; readyAt: number | null }> => {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const current = gate;
  if (!current) {
    if (!options.waitForArm || timeoutMs <= 0) return Promise.resolve({ state: 'not-armed', generation: null, readyAt: null });
    // The channel effect may run after the first provider read starts (child
    // effects run first). Wait inside the same overall budget for a gate.
    return new Promise(resolve => {
      const onArm = () => {
        clearTimeout(timer);
        resolve(awaitRealtimeReadiness(Math.max(0, deadline - Date.now())));
      };
      const timer = setTimeout(() => {
        armWaiters.delete(onArm);
        resolve({ state: 'not-armed', generation: null, readyAt: null });
      }, Math.max(0, timeoutMs));
      armWaiters.add(onArm);
    });
  }
  const snapshot = (): { state: RealtimeReadinessState; generation: number; readyAt: number | null } | null => {
    if (gate !== current || current.failed) return { state: 'unavailable', generation: current.generation, readyAt: null };
    if (current.readyAt !== null) return { state: 'ready', generation: current.generation, readyAt: current.readyAt };
    return null;
  };
  const immediate = snapshot();
  if (immediate) return Promise.resolve(immediate);
  return new Promise(resolve => {
    let done = false;
    const finish = (value: { state: RealtimeReadinessState; generation: number | null; readyAt: number | null }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      current.waiters.delete(onWake);
      resolve(value);
    };
    const onWake = () => { const value = snapshot(); if (value) finish(value); };
    const timer = setTimeout(() => finish({ state: 'timeout', generation: current.generation, readyAt: null }), Math.max(0, deadline - Date.now()));
    current.waiters.add(onWake);
  });
};

/** True only while `generation` is the live gate and it is still confirmed ready. */
export const isRealtimeReadyGeneration = (generation: number | null, readyAtOrBefore?: number): boolean => {
  if (generation === null || !gate || gate.generation !== generation || gate.failed || gate.readyAt === null) return false;
  return readyAtOrBefore === undefined || gate.readyAt <= readyAtOrBefore;
};

/** Test-only reset (never called by application code). */
export const __resetRealtimeReadinessForTests = (): void => {
  if (gate) wake(gate);
  gate = null;
  armWaiters.clear();
};
