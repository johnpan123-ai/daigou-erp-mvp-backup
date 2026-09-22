export type CloudResource =
  | 'products'
  | 'purchases'
  | 'privateOrders'
  | 'inventory'
  | 'bundles'
  | 'japanPackages'
  | 'outboundShipments'
  | 'salesOrders';

export type CloudChangeKind = 'INSERT' | 'UPDATE' | 'DELETE';

export interface CloudChange {
  table: string;
  canonicalId: string;
  databaseId: string;
  localId: string | null;
  resource: CloudResource;
  kind: CloudChangeKind;
  committedAt?: string;
  origin?: 'remote' | 'local';
}

export interface CloudEntityIdentity {
  /** Supabase primary key. All Cloud reads and writes use this value. */
  databaseId: string;
  /** Optional source-local identifier retained as metadata only. */
  localId: string | null;
  /** IndexedDB/cache key selected once by the table's provider-boundary contract. */
  canonicalId: string;
}

const LOCAL_CANONICAL_TABLES = new Set([
  'purchase_batch_items',
  'private_orders',
  'private_order_items',
  'sales_orders',
  'sales_order_items',
]);

/**
 * Resolve identity exactly once at the Supabase/provider boundary.
 *
 * Most Cloud tables have always been cached by their database UUID. A small
 * legacy set is intentionally cached by local_id because the local domain uses
 * externally meaningful order/item IDs. Targeted refresh must use the same
 * table contract as the initial pull; callers must not choose IDs ad hoc.
 */
export const resolveCloudRowIdentity = (
  table: string,
  row: { id?: unknown; local_id?: unknown },
): CloudEntityIdentity => {
  const databaseId = typeof row.id === 'string' ? row.id.trim() : '';
  const localId = typeof row.local_id === 'string' && row.local_id.trim()
    ? row.local_id.trim()
    : null;
  const canonicalId = LOCAL_CANONICAL_TABLES.has(table) && localId
    ? localId
    : databaseId;
  return {
    databaseId,
    localId,
    canonicalId,
  };
};

export interface CloudRefreshRequest {
  reason: 'realtime' | 'editing-ended' | 'focus' | 'visibility' | 'reconnect' | 'manual';
  changes: CloudChange[];
  resources: CloudResource[];
  /** Server Restore epoch whose complete cache generation this read must commit. */
  authoritativeEpoch?: number;
}

export interface CloudSyncMetrics {
  receivedEvents: number;
  dedupedEvents: number;
  deferredEvents: number;
  editingCatchUps: number;
  targetedRefreshes: number;
  fallbackRefreshes: number;
  conflicts: number;
  fullPulls: number;
}

export interface CloudSyncCoordinatorOptions {
  refresh: (request: CloudRefreshRequest, signal?: AbortSignal) => Promise<void | CloudRefreshResult>;
  /** The production cache compares authoritative business values before deferring a draft. */
  authoritativeDrafts?: boolean;
  isEditing: (resource: CloudResource) => boolean;
  onRefreshed: (resources: CloudResource[]) => void;
  onConflict: (resources: CloudResource[]) => void;
  /** Cache readers may update even while another consumer protects a draft. */
  onCommitted?: (resources: CloudResource[]) => void | Promise<void>;
  coalesceMs?: number;
  now?: () => number;
}

export interface CloudRefreshResult {
  conflicts: CloudChange[];
  /** Business change, not just a newer version/timestamp. Explicit reads report this. */
  changed?: boolean;
}

const uniqueResources = (resources: CloudResource[]): CloudResource[] => (
  [...new Set(resources)]
);

export class CloudSyncCoordinator {
  private readonly options: CloudSyncCoordinatorOptions;
  private pending = new Map<string, CloudChange>();
  private deferred = new Map<string, CloudChange>();
  private deferredFallbackResources = new Set<CloudResource>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private inFlight: Promise<void> | null = null;
  private resumeInFlight: Promise<void> | null = null;
  private manualInFlight = new Map<string, Promise<CloudRefreshResult>>();
  private manualAbort = new AbortController();
  private readonly coalesceMs: number;
  private readonly now: () => number;
  private lastFallbackAt = 0;
  private readonly metrics: CloudSyncMetrics = {
    receivedEvents: 0,
    dedupedEvents: 0,
    deferredEvents: 0,
    editingCatchUps: 0,
    targetedRefreshes: 0,
    fallbackRefreshes: 0,
    conflicts: 0,
    fullPulls: 0,
  };

  constructor(options: CloudSyncCoordinatorOptions) {
    this.options = options;
    this.coalesceMs = options.coalesceMs ?? 350;
    this.now = options.now ?? Date.now;
  }

  receive(change: CloudChange): void {
    if (this.disposed) return;
    this.metrics.receivedEvents += 1;
    const key = `${change.table}:${change.canonicalId}`;
    if (this.pending.has(key)) this.metrics.dedupedEvents += 1;
    this.pending.set(key, change);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.coalesceMs);
  }

  async flush(): Promise<void> {
    if (this.disposed || this.pending.size === 0) return this.inFlight ?? undefined;
    if (this.inFlight) {
      await this.inFlight;
      if (this.pending.size > 0) return this.flush();
      return;
    }

    const changes = [...this.pending.values()];
    this.pending.clear();
    const resources = uniqueResources(changes.map(change => change.resource));
    const remoteResources = uniqueResources(changes.filter(change => change.origin !== 'local').map(change => change.resource));
    const editing = this.options.authoritativeDrafts ? [] : remoteResources.filter(resource => this.options.isEditing(resource));
    const refreshable = resources.filter(resource => !editing.includes(resource));

    if (editing.length > 0) {
      changes
        .filter(change => change.origin !== 'local' && editing.includes(change.resource))
        .forEach(change => {
          const key = `${change.table}:${change.canonicalId}`;
          if (this.deferred.has(key)) this.metrics.dedupedEvents += 1;
          else this.metrics.deferredEvents += 1;
          this.deferred.set(key, change);
        });
      this.metrics.conflicts += 1;
      this.options.onConflict(editing);
    }

    if (refreshable.length === 0) return;
    const allowedChanges = changes.filter(change => refreshable.includes(change.resource));
    this.metrics.targetedRefreshes += 1;
    this.inFlight = this.options.refresh({ reason: 'realtime', changes: allowedChanges, resources: refreshable })
      .then(result => this.completeRefresh(refreshable, result))
      .finally(() => { this.inFlight = null; });
    await this.inFlight;
  }

  async resume(resources: CloudResource[]): Promise<boolean> {
    if (this.disposed) return false;
    if (this.inFlight) await this.inFlight;
    if (this.resumeInFlight) await this.resumeInFlight;

    const eligible = uniqueResources(resources).filter(resource => !this.options.isEditing(resource));
    if (eligible.length === 0) return false;

    const changes = [...this.deferred.values()].filter(change => eligible.includes(change.resource));
    const fallbackResources = eligible.filter(resource => this.deferredFallbackResources.has(resource));
    const changedResources = uniqueResources(changes.map(change => change.resource));
    const refreshedResources = uniqueResources([...changedResources, ...fallbackResources]);
    if (refreshedResources.length === 0) return false;

    changes.forEach(change => this.deferred.delete(`${change.table}:${change.canonicalId}`));
    fallbackResources.forEach(resource => this.deferredFallbackResources.delete(resource));
    const needsResourceCatchUp = fallbackResources.length > 0;

    this.metrics.editingCatchUps += 1;
    this.metrics.targetedRefreshes += 1;
    this.resumeInFlight = this.options.refresh({
      reason: needsResourceCatchUp ? 'editing-ended' : 'realtime',
      changes: needsResourceCatchUp ? [] : changes,
      resources: refreshedResources,
    })
      .then(result => this.completeRefresh(refreshedResources, result))
      .catch(error => {
        changes.forEach(change => this.deferred.set(`${change.table}:${change.canonicalId}`, change));
        fallbackResources.forEach(resource => this.deferredFallbackResources.add(resource));
        throw error;
      })
      .finally(() => { this.resumeInFlight = null; });
    await this.resumeInFlight;
    return true;
  }

  async fallback(reason: 'focus' | 'visibility' | 'reconnect', resources: CloudResource[], signal?: AbortSignal): Promise<boolean> {
    if (this.disposed) return false;
    const now = this.now();
    if (reason !== 'reconnect' && now - this.lastFallbackAt < 15_000) return false;
    const unique = uniqueResources(resources);
    const editing = this.options.authoritativeDrafts ? [] : unique.filter(resource => this.options.isEditing(resource));
    if (editing.length > 0) {
      editing.forEach(resource => this.deferredFallbackResources.add(resource));
      this.metrics.conflicts += 1;
      this.options.onConflict(editing);
    }
    const refreshable = unique.filter(resource => !editing.includes(resource));
    if (refreshable.length === 0) return false;
    this.lastFallbackAt = now;
    this.metrics.fallbackRefreshes += 1;
    if (this.inFlight) await this.inFlight;
    if (this.resumeInFlight) await this.resumeInFlight;
    const result = await this.options.refresh({ reason, changes: [], resources: refreshable }, signal);
    signal?.throwIfAborted();
    [...this.deferred.entries()].forEach(([key, change]) => {
      // An incremental catch-up may not return the conflicting record again.
      // Absence from that response is not evidence that a protected draft resolved.
      if (refreshable.includes(change.resource) && !this.options.isEditing(change.resource)) this.deferred.delete(key);
    });
    refreshable.forEach(resource => this.deferredFallbackResources.delete(resource));
    await this.completeRefresh(refreshable, result);
    return true;
  }

  manualRefresh(resources: CloudResource[]): Promise<CloudRefreshResult> {
    if (this.disposed) return Promise.reject(new Error('CLOUD_REFRESH_UNAVAILABLE'));
    const unique = uniqueResources(resources).sort();
    const key = unique.join('|');
    const existing = this.manualInFlight.get(key);
    if (existing) return existing;
    // Explicit refresh is not focus's throttled/incremental fallback. Reuse the
    // same cache queue, atomic replacement and entity-scoped draft protection.
    const pending = (async () => {
      if (this.inFlight) await this.inFlight;
      if (this.resumeInFlight) await this.resumeInFlight;
      const result = await this.options.refresh({ reason: 'manual', resources: unique, changes: [] }, this.manualAbort.signal);
      await this.completeRefresh(unique, result);
      return result ?? { conflicts: [] };
    })().finally(() => this.manualInFlight.delete(key));
    this.manualInFlight.set(key, pending);
    return pending;
  }

  private async completeRefresh(resources: CloudResource[], result: void | CloudRefreshResult): Promise<void> {
    if (this.disposed) return;
    const conflicts = result?.conflicts ?? [];
    for (const change of conflicts) this.deferred.set(`${change.table}:${change.canonicalId}`, change);
    const blocked = uniqueResources([...conflicts, ...this.deferred.values()]
      .filter(change => this.options.isEditing(change.resource)).map(change => change.resource));
    this.options.onRefreshed(resources.filter(resource => !blocked.includes(resource)));
    if (blocked.length > 0) {
      this.metrics.conflicts += 1;
      this.options.onConflict(blocked);
    }
    // A manual button must not report success while mounted consumers are still
    // reading the committed cache (or silently drop a failed consumer read).
    await this.options.onCommitted?.(resources);
  }

  snapshotMetrics(): Readonly<CloudSyncMetrics> {
    return { ...this.metrics };
  }

  dispose(): void {
    this.disposed = true;
    this.manualAbort.abort();
    this.pending.clear();
    this.deferred.clear();
    this.deferredFallbackResources.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export type CloudReconnectTrigger =
  | 'online'
  | 'subscribed'
  | 'focus'
  | 'visibility'
  | 'resource-registration'
  | 'channel-interrupted';

export interface CloudReconnectDiagnostic {
  event: 'trigger' | 'deferred-no-resources' | 'attempt-start' | 'attempt-succeeded' | 'attempt-failed' | 'retry-scheduled' | 'complete' | 'exhausted' | 'cancelled';
  trigger: CloudReconnectTrigger;
  generation: number;
  attempt: number;
  resources: CloudResource[];
  retryDelayMs?: number;
}

interface CloudReconnectCatchUpOptions {
  refresh: (resources: CloudResource[], signal: AbortSignal) => Promise<boolean>;
  retryDelaysMs?: readonly number[];
  onDiagnostic?: (diagnostic: CloudReconnectDiagnostic) => void;
}

const sortedResources = (resources: CloudResource[]): CloudResource[] => (
  uniqueResources(resources).sort()
);

/**
 * Owns the reconnect-to-fresh transition. Connectivity events merely request
 * a cycle; this controller keeps retrying authoritative targeted reads without
 * requiring another Realtime event. Only one generation is active at a time.
 */
export class CloudReconnectCatchUp {
  private readonly options: CloudReconnectCatchUpOptions;
  private readonly retryDelaysMs: readonly number[];
  private resources: CloudResource[] = [];
  private pending = false;
  private armed = false;
  private exhausted = false;
  private disposed = false;
  private generation = 0;
  private resourceRevision = 0;
  private attempt = 0;
  private trigger: CloudReconnectTrigger = 'online';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private waiters: Array<(completed: boolean) => void> = [];

  constructor(options: CloudReconnectCatchUpOptions) {
    this.options = options;
    this.retryDelaysMs = options.retryDelaysMs ?? [500, 1_500, 5_000, 15_000];
  }

  updateResources(resources: CloudResource[]): void {
    if (this.disposed) return;
    const next = sortedResources(resources);
    const changed = next.join('|') !== this.resources.join('|');
    this.resources = next;
    if (changed) this.resourceRevision += 1;
    if (!changed || !this.pending || next.length === 0) return;
    this.trigger = 'resource-registration';
    this.emit('trigger');
    this.startIfReady();
  }

  /**
   * Arm one bounded catch-up generation without requiring resources to have
   * registered first. A later updateResources() call starts the same
   * generation, so initial React effect ordering cannot lose the refresh.
   */
  ensurePending(trigger: CloudReconnectTrigger): void {
    if (this.disposed || (this.pending && this.armed)) return;
    if (!this.pending) {
      this.generation += 1;
      this.attempt = 0;
    }
    this.pending = true;
    this.armed = true;
    this.exhausted = false;
    this.trigger = trigger;
    this.emit('trigger');
    this.startIfReady();
  }

  markNeeded(trigger: CloudReconnectTrigger): void {
    if (this.disposed) return;
    this.generation += 1;
    this.attempt = 0;
    this.pending = true;
    this.armed = false;
    this.exhausted = false;
    this.trigger = trigger;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abortController?.abort();
    this.resolveWaiters(false);
    this.emit('trigger');
  }

  request(trigger: CloudReconnectTrigger, resources?: CloudResource[]): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (resources) {
      const next = sortedResources(resources);
      if (next.join('|') !== this.resources.join('|')) this.resourceRevision += 1;
      this.resources = next;
    }
    if (!this.pending) {
      this.generation += 1;
      this.attempt = 0;
    } else if (this.exhausted) {
      this.attempt = 0;
      this.exhausted = false;
    }
    this.pending = true;
    this.armed = true;
    this.trigger = trigger;
    this.emit('trigger');
    const completion = new Promise<boolean>(resolve => this.waiters.push(resolve));
    this.startIfReady();
    return completion;
  }

  isPending(): boolean {
    return this.pending;
  }

  waitForCurrentCycle(): Promise<boolean> {
    if (this.exhausted) return Promise.resolve(false);
    if (!this.pending) return Promise.resolve(true);
    return new Promise<boolean>(resolve => this.waiters.push(resolve));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = false;
    this.armed = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abortController?.abort();
    this.abortController = null;
    this.emit('cancelled');
    this.resolveWaiters(false);
  }

  private startIfReady(): void {
    if (this.disposed || !this.pending || !this.armed || this.timer || this.inFlight) return;
    if (this.resources.length === 0) {
      this.emit('deferred-no-resources');
      return;
    }
    const generation = this.generation;
    const resourceRevision = this.resourceRevision;
    const resources = [...this.resources];
    const attempt = this.attempt + 1;
    this.attempt = attempt;
    const abortController = new AbortController();
    this.abortController = abortController;
    this.emit('attempt-start');
    this.inFlight = this.options.refresh(resources, abortController.signal)
      .then(completed => {
        if (this.disposed || generation !== this.generation) return;
        if (!completed) throw new Error('RECONNECT_CATCH_UP_DEFERRED');
        this.emit('attempt-succeeded');
        if (resourceRevision !== this.resourceRevision) {
          this.attempt = 0;
          return;
        }
        this.pending = false;
        this.exhausted = false;
        this.attempt = 0;
        this.emit('complete');
        this.resolveWaiters(true);
      })
      .catch(() => {
        if (this.disposed || generation !== this.generation) return;
        this.emit('attempt-failed');
        const retryDelayMs = this.retryDelaysMs[attempt - 1];
        if (retryDelayMs === undefined) {
          this.exhausted = true;
          this.emit('exhausted');
          this.resolveWaiters(false);
          return;
        }
        this.emit('retry-scheduled', retryDelayMs);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.startIfReady();
        }, retryDelayMs);
      })
      .finally(() => {
        if (this.abortController === abortController) this.abortController = null;
        this.inFlight = null;
        this.startIfReady();
      });
  }

  private emit(event: CloudReconnectDiagnostic['event'], retryDelayMs?: number): void {
    this.options.onDiagnostic?.({
      event,
      trigger: this.trigger,
      generation: this.generation,
      attempt: this.attempt,
      resources: [...this.resources],
      ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    });
  }

  private resolveWaiters(completed: boolean): void {
    const waiters = this.waiters.splice(0);
    waiters.forEach(resolve => resolve(completed));
  }
}

export const CLOUD_TABLE_RESOURCE: Readonly<Record<string, CloudResource>> = {
  product_groups: 'products',
  product_categories: 'products',
  product_variants: 'products',
  purchase_batches: 'purchases',
  purchase_batch_items: 'purchases',
  private_orders: 'privateOrders',
  private_order_items: 'privateOrders',
  inventory_items: 'inventory',
  bundle_components: 'bundles',
  japan_packages: 'japanPackages',
  japan_package_items: 'japanPackages',
  outbound_shipments: 'outboundShipments',
  outbound_shipment_items: 'outboundShipments',
  sales_orders: 'salesOrders',
  sales_order_items: 'salesOrders',
};
