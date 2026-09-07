import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { cloudCacheDb } from '/src/lib/db.ts';
import { dataProvider } from '/src/providers/dataProvider.ts';
import {
  getCloudConnectivitySnapshot,
  markCloudReadFresh,
  markCloudUnavailable,
} from '/src/providers/cloud/cloudConnectivity.ts';
import { markLocalCloudWrite } from '/src/providers/cloud/cloudRealtimeEchoRegistry.ts';
import { installCloudRealtimeTestBridge } from '/src/contexts/cloudRealtimeTestBridge.ts';
import '/src/index.css';

localStorage.setItem('erp_provider_mode', 'experimental');
const requestedRoute = new URL(location.href).searchParams.get('route') || '/dashboard';
history.replaceState({}, '', `${requestedRoute}?p0ReactHarness=1`);

const clone = value => structuredClone(value);
const coreFixture = await fetch('/tests/fixtures/core-regression.json').then(response => response.json());
const server = clone(coreFixture);
server.productGroups = server.productGroups.map(group => group.id === 'g-holo'
  ? { ...group, show_in_purchase_list: true }
  : group);
server.purchaseBatches = server.purchaseBatches.map(batch => batch.id === 'b-holo'
  ? { ...batch, name: 'React Batch A', date: '2026-09-07', created_at: '2026-09-07T00:00:00.000Z', updated_at: '2026-09-07T00:00:00.000Z' }
  : batch);
server.purchaseBatchItems = server.purchaseBatchItems.map(item => item.id === 'bi-holo'
  ? { ...item, updated_at: '2026-09-07T00:00:00.000Z' }
  : item);
server.salesOrders = [{
  id: 'so-react-1',
  order_number: 'REACT-ORDER-1',
  platform: 'myacg',
  buyer_name: 'React Buyer',
  created_at: '2026-09-07T00:00:00.000Z',
  updated_at: '2026-09-07T00:00:00.000Z',
}];
server.salesOrderItems = [{
  id: 'soi-react-1',
  order_id: 'so-react-1',
  product_variant_id: 'v-holo',
  myacg_item_code: 'SKU-HOLO',
  product_name: 'Hololive Active',
  variant_name: 'A',
  quantity: 1,
  price: 1000,
  amount: 1000,
  order_status: '已付款',
  updated_at: '2026-09-07T00:00:00.000Z',
}];
server.japanPackages = [{
  id: 'jp-react-1',
  title: 'React Japan Package A',
  vendor_name: 'React Vendor',
  carrier: 'DHL',
  tracking_number: 'JP-REACT-1',
  status: 'registered',
  note: '',
  created_at: '2026-09-07T00:00:00.000Z',
  updated_at: '2026-09-07T00:00:00.000Z',
}];
server.japanPackageItems = [{
  id: 'jpi-react-1',
  japan_package_id: 'jp-react-1',
  product_group_id: 'g-holo',
  product_variant_id: 'v-holo',
  purchase_batch_id: 'b-holo',
  purchase_batch_item_id: 'bi-holo',
  product_title: 'Hololive Active',
  variant_name: 'A',
  sku: 'SKU-HOLO',
  quantity: 1,
  checked: false,
  note: '',
  created_at: '2026-09-07T00:00:00.000Z',
  updated_at: '2026-09-07T00:00:00.000Z',
}];
server.outboundShipments = [{
  id: 'out-react-1',
  title: 'React Outbound A',
  status: 'draft',
  carrier: '黑貓',
  tracking_number: 'OUT-REACT-1',
  note: '',
  created_at: '2026-09-07T00:00:00.000Z',
  updated_at: '2026-09-07T00:00:00.000Z',
}];
server.outboundShipmentItems = [{
  id: 'outi-react-1',
  outbound_shipment_id: 'out-react-1',
  japan_package_item_id: 'jpi-react-1',
  product_group_id: 'g-holo',
  product_variant_id: 'v-holo',
  product_title: 'Hololive Active',
  variant_name: 'A',
  sku: 'SKU-HOLO',
  quantity: 1,
  checked: false,
  note: '',
  created_at: '2026-09-07T00:00:00.000Z',
  updated_at: '2026-09-07T00:00:00.000Z',
}];

const tableToCollection = {
  inventory_items: 'inventory',
  sales_orders: 'salesOrders',
  sales_order_items: 'salesOrderItems',
  product_groups: 'productGroups',
  product_categories: 'productCategories',
  product_variants: 'productVariants',
  purchase_batches: 'purchaseBatches',
  purchase_batch_items: 'purchaseBatchItems',
  private_orders: 'privateOrders',
  private_order_items: 'privateOrderItems',
  japan_packages: 'japanPackages',
  japan_package_items: 'japanPackageItems',
  outbound_shipments: 'outboundShipments',
  outbound_shipment_items: 'outboundShipmentItems',
  bundle_components: 'bundleComponents',
};

const collectionAdapters = {
  inventory: ['getInventory', 'upsertInventory'],
  salesOrders: ['getSalesOrders', 'saveSalesOrders'],
  salesOrderItems: ['getSalesOrderItems', 'saveSalesOrderItems'],
  productGroups: ['getProductGroups', 'saveProductGroups'],
  productCategories: ['getProductCategories', 'saveProductCategories'],
  productVariants: ['getProductVariants', 'saveProductVariants'],
  purchaseBatches: ['getPurchaseBatches', 'savePurchaseBatches'],
  purchaseBatchItems: ['getPurchaseBatchItems', 'savePurchaseBatchItems'],
  privateOrders: ['getPrivateOrders', 'savePrivateOrders'],
  privateOrderItems: ['getPrivateOrderItems', 'savePrivateOrderItems'],
  japanPackages: ['getJapanPackages', 'saveJapanPackages'],
  japanPackageItems: ['getJapanPackageItems', 'saveJapanPackageItems'],
  outboundShipments: ['getOutboundShipments', 'saveOutboundShipments'],
  outboundShipmentItems: ['getOutboundShipmentItems', 'saveOutboundShipmentItems'],
  bundleComponents: ['getBundleComponents', 'saveBundleComponents'],
  importBatches: ['getImportBatches', 'saveImportBatches'],
};

const seedCache = async () => {
  await cloudCacheDb.clearData();
  for (const [collection, [getMethod, saveMethod]] of Object.entries(collectionAdapters)) {
    void getMethod;
    const rows = clone(server[collection] || []);
    if (saveMethod === 'upsertInventory') await cloudCacheDb.upsertInventory(rows);
    else await cloudCacheDb[saveMethod](rows);
  }
};
await seedCache();
markCloudReadFresh(Object.values(server).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0));

const pageLoads = {};
let writes = 0;
for (const [collection, [getMethod, saveMethod]] of Object.entries(collectionAdapters)) {
  dataProvider[getMethod] = async () => {
    pageLoads[getMethod] = (pageLoads[getMethod] || 0) + 1;
    return clone(await cloudCacheDb[getMethod]());
  };
  dataProvider[saveMethod] = async rows => {
    writes += 1;
    server[collection] = clone(rows);
    if (saveMethod === 'upsertInventory') return cloudCacheDb.upsertInventory(clone(rows));
    return cloudCacheDb[saveMethod](clone(rows));
  };
}

dataProvider.canWriteCloud = async () => true;
dataProvider.updateProductVariantPatch = async (id, patch) => {
  writes += 1;
  server.productVariants = server.productVariants.map(row => row.id === id ? { ...row, ...clone(patch) } : row);
  await cloudCacheDb.saveProductVariants(clone(server.productVariants));
};
dataProvider.updateProductVariantPatchBulk = async patches => {
  writes += 1;
  const byId = new Map(patches.map(entry => [entry.id, entry.patch]));
  server.productVariants = server.productVariants.map(row => byId.has(row.id) ? { ...row, ...clone(byId.get(row.id)) } : row);
  await cloudCacheDb.saveProductVariants(clone(server.productVariants));
};
dataProvider.deleteProductVariant = async id => {
  writes += 1;
  server.productVariants = server.productVariants.filter(row => row.id !== id);
  await cloudCacheDb.saveProductVariants(clone(server.productVariants));
};
dataProvider.deletePrivateOrderItems = async ids => {
  writes += 1;
  const selected = new Set(ids);
  server.privateOrderItems = server.privateOrderItems.filter(row => !selected.has(row.id));
  await cloudCacheDb.savePrivateOrderItems(clone(server.privateOrderItems));
};

let controllerResolve;
const controllerReady = new Promise(resolve => { controllerResolve = resolve; });
let controller = null;
let targetedQueries = 0;
let failNextQuery = false;

installCloudRealtimeTestBridge({
  query: async request => {
    targetedQueries += 1;
    if (failNextQuery) {
      failNextQuery = false;
      throw new Error('INJECTED_TARGETED_READ_FAILURE');
    }
    const collection = tableToCollection[request.table];
    let rows = clone(server[collection] || []);
    if (request.databaseIds) {
      const ids = new Set(request.databaseIds);
      rows = rows.filter(row => ids.has(row.id));
    }
    if (request.updatedAfter) {
      rows = rows.filter(row => !row.updated_at || row.updated_at > request.updatedAfter);
    }
    return rows;
  },
  attach: nextController => {
    controller = nextController;
    controllerResolve(nextController);
  },
  detach: () => { controller = null; },
});

const updateServerRow = (table, row) => {
  const collection = tableToCollection[table];
  const rows = server[collection];
  const index = rows.findIndex(candidate => candidate.id === row.id);
  if (index >= 0) rows[index] = clone(row);
  else rows.push(clone(row));
};

window.__P0_REACT_HARNESS__ = {
  ready: () => controllerReady,
  server,
  async emitUpsert(table, row, eventType = 'UPDATE') {
    updateServerRow(table, row);
    const activeController = controller || await controllerReady;
    await activeController.emit(table, {
      eventType,
      new: clone(row),
      old: {},
      commit_timestamp: new Date().toISOString(),
    });
  },
  async emitDelete(table, id) {
    const collection = tableToCollection[table];
    const existing = server[collection].find(row => row.id === id) || { id };
    server[collection] = server[collection].filter(row => row.id !== id);
    const activeController = controller || await controllerReady;
    await activeController.emit(table, {
      eventType: 'DELETE',
      new: {},
      old: clone(existing),
      commit_timestamp: new Date().toISOString(),
    });
  },
  async emitSelf(table, row) {
    markLocalCloudWrite(table, [row.id]);
    updateServerRow(table, row);
    const activeController = controller || await controllerReady;
    await activeController.emit(table, {
      eventType: 'UPDATE',
      new: clone(row),
      old: {},
      commit_timestamp: new Date().toISOString(),
    });
  },
  async emitSelfEcho(table, eventRow) {
    markLocalCloudWrite(table, [eventRow.id]);
    const activeController = controller || await controllerReady;
    await activeController.emit(table, {
      eventType: 'UPDATE',
      new: clone(eventRow),
      old: {},
      commit_timestamp: new Date().toISOString(),
    });
  },
  async emitDuplicate(table, row) {
    updateServerRow(table, row);
    const activeController = controller || await controllerReady;
    const payload = {
      eventType: 'UPDATE',
      new: clone(row),
      old: {},
      commit_timestamp: '2026-09-07T12:00:00.000Z',
    };
    await activeController.emitMany([
      { table, payload },
      { table, payload: clone(payload) },
    ]);
  },
  setServerRows(table, rows) {
    server[tableToCollection[table]] = clone(rows);
  },
  async setCacheRows(table, rows) {
    const collection = tableToCollection[table];
    const [, saveMethod] = collectionAdapters[collection];
    if (saveMethod === 'upsertInventory') {
      await cloudCacheDb.clearData();
      if (rows.length > 0) await cloudCacheDb.upsertInventory(clone(rows));
      return;
    }
    await cloudCacheDb[saveMethod](clone(rows));
  },
  mutateServerRow(table, row) { updateServerRow(table, row); },
  async fallback(reason, resources) {
    const activeController = controller || await controllerReady;
    return activeController.fallback(reason, resources);
  },
  failTargetedReadOnce() { failNextQuery = true; },
  offline() {
    markCloudUnavailable('test-offline');
    window.dispatchEvent(new Event('offline'));
  },
  online() { window.dispatchEvent(new Event('online')); },
  focus() { window.dispatchEvent(new Event('focus')); },
  visibility(state) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  },
  snapshot() {
    return {
      metrics: controller?.metrics() || null,
      targetedQueries,
      pageLoads: clone(pageLoads),
      writes,
      connectivity: getCloudConnectivitySnapshot(),
    };
  },
};

const [{ default: App }] = await Promise.all([import('/src/App.tsx')]);
createRoot(document.getElementById('root')).render(React.createElement(StrictMode, null, React.createElement(App)));
