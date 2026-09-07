import type { CloudResource } from './cloudSyncDomain';

export interface CloudRealtimePageCoverage {
  route: string;
  owner: string;
  resources: readonly CloudResource[];
  reactConsumer: string;
  draftGuard: 'read-only' | 'editing-state';
  editEndCatchUp: boolean;
}

/**
 * P0-2 contract: every listed consumer is wired through useCloudResourceSync.
 * Tests compare this matrix with the page hook declarations and exercise the
 * shared coordinator's refresh, draft deferral, and edit-end catch-up paths.
 */
export const CLOUD_REALTIME_PAGE_COVERAGE: readonly CloudRealtimePageCoverage[] = [
  {
    route: '/dashboard',
    owner: 'daily-work-dashboard',
    resources: ['products', 'purchases', 'privateOrders', 'inventory', 'salesOrders'],
    reactConsumer: 'Dashboard daily work counts and lists',
    draftGuard: 'read-only',
    editEndCatchUp: true,
  },
  {
    route: '/purchase-records',
    owner: 'purchase-records',
    resources: ['products', 'purchases', 'privateOrders', 'inventory', 'salesOrders'],
    reactConsumer: 'Purchase records groups, variants and demand totals',
    draftGuard: 'editing-state',
    editEndCatchUp: true,
  },
  {
    route: '/purchase-records/:id',
    owner: 'purchase-management:',
    resources: ['products', 'purchases', 'privateOrders', 'inventory', 'bundles', 'salesOrders'],
    reactConsumer: 'Purchase management worksheet, batches and private orders',
    draftGuard: 'editing-state',
    editEndCatchUp: true,
  },
  {
    route: '/recent-purchases',
    owner: 'recent-purchases',
    resources: ['products', 'purchases'],
    reactConsumer: 'Recent purchase ledger rows',
    draftGuard: 'read-only',
    editEndCatchUp: true,
  },
  {
    route: '/purchasing',
    owner: 'purchasing-summary',
    resources: ['products', 'purchases', 'privateOrders', 'inventory', 'salesOrders'],
    reactConsumer: 'Purchasing summary and Batch modal',
    draftGuard: 'editing-state',
    editEndCatchUp: true,
  },
  {
    route: '/inventory',
    owner: 'inventory-catalog',
    resources: ['inventory', 'products'],
    reactConsumer: 'Inventory and catalog grouping',
    draftGuard: 'editing-state',
    editEndCatchUp: true,
  },
  {
    route: '/unlisted-items',
    owner: 'unlisted-items',
    resources: ['products', 'purchases', 'privateOrders', 'inventory', 'salesOrders'],
    reactConsumer: 'Unlisted-item work queue',
    draftGuard: 'read-only',
    editEndCatchUp: true,
  },
  {
    route: '/duplicate-variants',
    owner: 'duplicate-variants',
    resources: ['products', 'purchases', 'privateOrders', 'salesOrders'],
    reactConsumer: 'Duplicate variant diagnostics',
    draftGuard: 'editing-state',
    editEndCatchUp: true,
  },
  {
    route: '/japan-packages',
    owner: 'japan-packages-list',
    resources: ['japanPackages'],
    reactConsumer: 'Japan package list',
    draftGuard: 'editing-state',
    editEndCatchUp: true,
  },
  {
    route: '/japan-packages/:id',
    owner: 'japan-package-detail:',
    resources: ['japanPackages', 'products', 'purchases', 'bundles'],
    reactConsumer: 'Japan package header and items',
    draftGuard: 'editing-state',
    editEndCatchUp: true,
  },
  {
    route: '/outbound-shipments',
    owner: 'outbound-shipments-list',
    resources: ['outboundShipments', 'japanPackages', 'products', 'bundles'],
    reactConsumer: 'Outbound shipment list and product search index',
    draftGuard: 'editing-state',
    editEndCatchUp: true,
  },
  {
    route: '/outbound-shipments/:id',
    owner: 'outbound-shipment-detail:',
    resources: ['outboundShipments', 'japanPackages', 'products', 'purchases', 'privateOrders', 'inventory', 'bundles', 'salesOrders'],
    reactConsumer: 'Outbound header, pool and shipment items',
    draftGuard: 'editing-state',
    editEndCatchUp: true,
  },
];
