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
  rowId: string;
  databaseId?: string;
  resource: CloudResource;
  kind: CloudChangeKind;
  committedAt?: string;
  origin?: 'remote' | 'local';
}

export const resolveCloudRowIdentity = (row: { id?: unknown; local_id?: unknown }): { rowId: string; databaseId: string } => {
  const databaseId = String(row.id || row.local_id || '');
  const rowId = String(row.local_id || row.id || '');
  return { rowId, databaseId };
};

export interface CloudRefreshRequest {
  reason: 'realtime' | 'focus' | 'visibility' | 'reconnect';
  changes: CloudChange[];
  resources: CloudResource[];
}

export interface CloudSyncMetrics {
  receivedEvents: number;
  dedupedEvents: number;
  targetedRefreshes: number;
  fallbackRefreshes: number;
  conflicts: number;
  fullPulls: number;
}

export interface CloudSyncCoordinatorOptions {
  refresh: (request: CloudRefreshRequest) => Promise<void>;
  isEditing: (resource: CloudResource) => boolean;
  onRefreshed: (resources: CloudResource[]) => void;
  onConflict: (resources: CloudResource[]) => void;
  coalesceMs?: number;
  now?: () => number;
}

const uniqueResources = (resources: CloudResource[]): CloudResource[] => (
  [...new Set(resources)]
);

export class CloudSyncCoordinator {
  private readonly options: CloudSyncCoordinatorOptions;
  private pending = new Map<string, CloudChange>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private inFlight: Promise<void> | null = null;
  private readonly coalesceMs: number;
  private readonly now: () => number;
  private lastFallbackAt = 0;
  private readonly metrics: CloudSyncMetrics = {
    receivedEvents: 0,
    dedupedEvents: 0,
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
    const key = `${change.table}:${change.rowId}`;
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
    const editing = remoteResources.filter(resource => this.options.isEditing(resource));
    const refreshable = resources.filter(resource => !editing.includes(resource));

    if (editing.length > 0) {
      this.metrics.conflicts += 1;
      this.options.onConflict(editing);
    }

    if (refreshable.length === 0) return;
    const allowedChanges = changes.filter(change => refreshable.includes(change.resource));
    this.metrics.targetedRefreshes += 1;
    this.inFlight = this.options.refresh({ reason: 'realtime', changes: allowedChanges, resources: refreshable })
      .then(() => this.options.onRefreshed(refreshable))
      .finally(() => { this.inFlight = null; });
    await this.inFlight;
  }

  async fallback(reason: 'focus' | 'visibility' | 'reconnect', resources: CloudResource[]): Promise<boolean> {
    if (this.disposed) return false;
    const now = this.now();
    if (reason !== 'reconnect' && now - this.lastFallbackAt < 15_000) return false;
    const unique = uniqueResources(resources);
    const editing = unique.filter(resource => this.options.isEditing(resource));
    if (editing.length > 0) {
      this.metrics.conflicts += 1;
      this.options.onConflict(editing);
    }
    const refreshable = unique.filter(resource => !editing.includes(resource));
    if (refreshable.length === 0) return false;
    this.lastFallbackAt = now;
    this.metrics.fallbackRefreshes += 1;
    await this.options.refresh({ reason, changes: [], resources: refreshable });
    this.options.onRefreshed(refreshable);
    return true;
  }

  snapshotMetrics(): Readonly<CloudSyncMetrics> {
    return { ...this.metrics };
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
