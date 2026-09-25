import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { cloudCacheDb } from '/src/lib/db.ts';
import { dataProvider, StaleDataError } from '/src/providers/dataProvider.ts';
import {
  getCloudConnectivitySnapshot,
  markCloudReadFresh,
  markCloudUnavailable,
} from '/src/providers/cloud/cloudConnectivity.ts';
import { markLocalCloudWrite } from '/src/providers/cloud/cloudRealtimeEchoRegistry.ts';
import { installCloudRealtimeTestBridge } from '/src/contexts/cloudRealtimeTestBridge.ts';
import '/src/index.css';

localStorage.setItem('erp_provider_mode', 'experimental');
const fixtureParams = new URL(location.href).searchParams;
const requestedRoute = fixtureParams.get('route') || '/dashboard';
const partialReceivingScenario = fixtureParams.get('partialReceiving') === '1';
const outboundReceivingScenario = fixtureParams.get('outboundReceiving') === '1';
const realProviderReads = fixtureParams.get('realReads') === '1';
const { supabaseProvider } = realProviderReads ? await import('/src/providers/cloud/supabaseProvider.ts') : {};
history.replaceState({}, '', `${requestedRoute}?p0ReactHarness=1`);

const clone = value => structuredClone(value);
const coreFixture = await fetch('/tests/fixtures/core-regression.json').then(response => response.json());
const server = clone(coreFixture);
if (realProviderReads) server.inventory = server.inventory.map((row, index) => ({
  ...row, id: `92000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
}));
if (fixtureParams.get('bootstrapVariant')) {
  server.productVariants = server.productVariants.map(row => row.id === 'v-holo'
    ? { ...row, variant_name: fixtureParams.get('bootstrapVariant'), version: 10 } : row);
}
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
if (partialReceivingScenario) {
  server.japanPackageItems.push({
    ...server.japanPackageItems[0],
    id: 'jpi-react-2',
    purchase_batch_item_id: 'bi-react-2',
    variant_name: 'B',
    sku: 'SKU-HOLO-B',
  });
}
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
if (outboundReceivingScenario) {
  server.outboundShipments[0] = { ...server.outboundShipments[0], status: 'received' };
  server.outboundShipmentItems.push({
    ...server.outboundShipmentItems[0],
    id: 'outi-react-2',
    japan_package_item_id: undefined,
    product_variant_id: undefined,
    product_title: 'Second Receiving Item',
    variant_name: 'B',
    sku: 'SKU-SECOND',
  });
}
if (partialReceivingScenario) server.outboundShipmentItems = [];

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
let heldPageRead, releasePageRead, pageReadHeld = false;
let holdAllPageReads = false;
let heldOutboundSave, releaseOutboundSave, outboundSaveHeld = false;
let failNextOutboundSave = false;
if (fixtureParams.get('holdInitialPageRead') === '1') {
  holdAllPageReads = true;
  heldPageRead = new Promise(resolve => { releasePageRead = resolve; });
}
for (const [collection, [getMethod, saveMethod]] of Object.entries(collectionAdapters)) {
  dataProvider[getMethod] = async (...args) => {
    pageLoads[getMethod] = (pageLoads[getMethod] || 0) + 1;
    if (heldPageRead) {
      const gate = heldPageRead;
      if (!holdAllPageReads) heldPageRead = null;
      pageReadHeld = true;
      await gate;
      pageReadHeld = false;
    }
    return clone(await (realProviderReads && typeof supabaseProvider[getMethod] === 'function'
      ? supabaseProvider[getMethod](...args)
      : cloudCacheDb[getMethod](...args)));
  };
  dataProvider[saveMethod] = async rows => {
    writes += 1;
    if (saveMethod === 'saveOutboundShipmentItems' && heldOutboundSave) {
      const gate = heldOutboundSave;
      heldOutboundSave = null;
      outboundSaveHeld = true;
      await gate;
      outboundSaveHeld = false;
    }
    if (saveMethod === 'saveOutboundShipmentItems' && failNextOutboundSave) {
      failNextOutboundSave = false;
      throw new Error('simulated outbound confirmation failure');
    }
    server[collection] = clone(rows);
    if (saveMethod === 'upsertInventory') return cloudCacheDb.upsertInventory(clone(rows));
    return cloudCacheDb[saveMethod](clone(rows));
  };
}

dataProvider.savePurchaseBatchTransaction = async command => {
  writes += 1;
  server.purchaseBatches = [
    ...server.purchaseBatches.filter(batch => batch.id !== command.batch.id),
    clone(command.batch),
  ];
  server.purchaseBatchItems = [
    ...server.purchaseBatchItems.filter(item => item.purchase_batch_id !== command.batch.id),
    ...clone(command.items),
  ];
  await cloudCacheDb.savePurchaseBatchTransaction(
    clone(server.purchaseBatches),
    clone(server.purchaseBatchItems),
  );
};

dataProvider.canWriteCloud = async () => true;
dataProvider.updateProductVariantPatch = async (id, patch) => {
  if (dataProvider.checkIsStaleLive()) throw new StaleDataError();
  writes += 1;
  server.productVariants = server.productVariants.map(row => row.id === id ? { ...row, ...clone(patch) } : row);
  await cloudCacheDb.saveProductVariants(clone(server.productVariants));
};
dataProvider.updateProductVariantPatchBulk = async patches => {
  if (dataProvider.checkIsStaleLive()) throw new StaleDataError();
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
const targetedQueriesByTable = {};
let failNextQuery = false;
let heldTargetedRead;
let releaseTargetedRead;
let targetedReadHeld = false;
const targetedReadFailures = new Map();
let idempotentReplays = 0;
let japanPackageTransactionCalls = 0;

const applyReceivingState = (itemId, checked, checkedAt = new Date().toISOString()) => {
  server.japanPackageItems = server.japanPackageItems.map(item => item.id === itemId ? {
    ...item,
    checked,
    checked_at: checked ? checkedAt : undefined,
    version: Number(item.version || 1) + 1,
    updated_at: checkedAt,
  } : item);
  const activeItems = server.japanPackageItems.filter(item => item.japan_package_id === 'jp-react-1' && !item.deleted_at);
  const currentPackage = server.japanPackages.find(pkg => pkg.id === 'jp-react-1');
  let status = currentPackage.status;
  if (status !== 'problem') {
    if (activeItems.length > 0 && activeItems.every(item => item.checked)) status = 'confirmed';
    else if (activeItems.some(item => item.checked) || status === 'arrived' || status === 'confirmed') status = 'arrived';
  }
  server.japanPackages = server.japanPackages.map(pkg => pkg.id === 'jp-react-1' ? {
    ...pkg,
    status,
    arrived_at: status === 'arrived' || status === 'confirmed' ? (pkg.arrived_at || '2026-09-20') : pkg.arrived_at,
    version: Number(pkg.version || 1) + (status !== pkg.status ? 1 : 0),
    updated_at: checkedAt,
  } : pkg);
};

if (partialReceivingScenario) {
  dataProvider.applyJapanPackageTransaction = async command => {
    japanPackageTransactionCalls += 1;
    if (command.transactionType !== 'set-receiving') throw new Error('PARTIAL_RECEIVING_FIXTURE_EXPECTED_SET_RECEIVING');
    for (const update of command.updates) applyReceivingState(update.itemId, update.checked, update.checkedAt);
    await cloudCacheDb.saveJapanPackageTransaction(
      clone(server.japanPackages),
      clone(server.japanPackageItems),
    );
    return {
      ok: true,
      transactionType: command.transactionType,
      idempotencyKey: command.idempotencyKey,
      replayed: false,
      package: clone(server.japanPackages.find(pkg => pkg.id === command.packageId)),
      items: clone(server.japanPackageItems.filter(item => item.japan_package_id === command.packageId)),
    };
  };
}

const readServer = async request => {
    targetedQueries += 1;
    if (heldTargetedRead) {
      const gate = heldTargetedRead;
      heldTargetedRead = null;
      targetedReadHeld = true;
      await gate;
      targetedReadHeld = false;
    }
    targetedQueriesByTable[request.table] = (targetedQueriesByTable[request.table] || 0) + 1;
    const tableFailures = targetedReadFailures.get(request.table) || 0;
    if (tableFailures > 0) {
      targetedReadFailures.set(request.table, tableFailures - 1);
      throw new Error(`INJECTED_TARGETED_READ_FAILURE:${request.table}`);
    }
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
    if (request.from !== undefined && request.to !== undefined) rows = rows.slice(request.from, request.to + 1);
    return rows;
};

if (realProviderReads) {
  // Only the HTTP boundary is simulated. Routes use the actual Cloud provider,
  // bootstrap, paged query adapter, IDB/cache and subscription implementation.
  const { supabase } = await import('/src/providers/cloud/supabaseClient.ts');
  supabase.auth.getSession = async () => ({ data: { session: { user: { id: 'fixture-owner' } } }, error: null });
  supabase.from = table => {
    const request = { table };
    let activeOnly = false;
    const builder = {
      select() { return builder; }, order() { return builder; }, limit() { return builder; },
      eq() { return builder; }, abortSignal() { return builder; },
      is(column, value) { if (column === 'deleted_at' && value === null) activeOnly = true; return builder; },
      range(from, to) { Object.assign(request, { from, to }); return builder; },
      in(column, ids) { if (column === 'id') request.databaseIds = ids; return builder; },
      gt(column, value) { if (column === 'updated_at') request.updatedAfter = value; return builder; },
      single: async () => ({ data: table === 'profiles' ? { role: 'owner' } : null, error: null }),
      then(resolve, reject) {
        return readServer(request).then(rows => ({ data: activeOnly ? rows.filter(row => !row.deleted_at) : rows, error: null })).then(resolve, reject);
      },
    };
    return builder;
  };
  dataProvider.waitForCloudBootstrapConvergence = () => supabaseProvider.waitForCloudBootstrapConvergence();
}

installCloudRealtimeTestBridge({
  query: realProviderReads ? undefined : readServer,
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
  navigate(path) {
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  },
  async remoteReceiving(itemId, checked) {
    if (!partialReceivingScenario) throw new Error('PARTIAL_RECEIVING_SCENARIO_REQUIRED');
    const changedAt = new Date().toISOString();
    applyReceivingState(itemId, checked, changedAt);
    const packageRow = clone(server.japanPackages.find(pkg => pkg.id === 'jp-react-1'));
    const itemRow = clone(server.japanPackageItems.find(item => item.id === itemId));
    const activeController = controller || await controllerReady;
    await activeController.emitMany([
      {
        table: 'japan_package_items',
        payload: { eventType: 'UPDATE', new: itemRow, old: {}, commit_timestamp: changedAt },
      },
      {
        table: 'japan_packages',
        payload: { eventType: 'UPDATE', new: packageRow, old: {}, commit_timestamp: changedAt },
      },
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
  holdNextTargetedRead() { heldTargetedRead = new Promise(resolve => { releaseTargetedRead = resolve; }); },
  holdNextPageRead() { heldPageRead = new Promise(resolve => { releasePageRead = resolve; }); },
  holdNextOutboundSave() { heldOutboundSave = new Promise(resolve => { releaseOutboundSave = resolve; }); },
  failNextOutboundSave() { failNextOutboundSave = true; },
  releasePageRead() {
    holdAllPageReads = false;
    heldPageRead = null;
    releasePageRead?.();
  },
  releaseOutboundSave() { releaseOutboundSave?.(); },
  releaseTargetedRead() { releaseTargetedRead?.(); },
  failTargetedTableRead(table, count = 1) { targetedReadFailures.set(table, count); },
  replaySameKey(canonicalResult) {
    idempotentReplays += 1;
    return clone(canonicalResult);
  },
  markReconnectNeeded() {
    const activeController = controller;
    activeController?.markReconnectNeeded();
  },
  offline() {
    markCloudUnavailable('test-offline');
    window.dispatchEvent(new Event('offline'));
  },
  async online() {
    window.dispatchEvent(new Event('online'));
    const activeController = controller || await controllerReady;
    return activeController.waitForReconnect();
  },
  focus() { window.dispatchEvent(new Event('focus')); },
  visibility(state) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  },
  snapshot() {
    return {
      metrics: controller?.metrics() || null,
      targetedQueries,
      targetedReadHeld,
      pageReadHeld,
      outboundSaveHeld,
      targetedQueriesByTable: clone(targetedQueriesByTable),
      pageLoads: clone(pageLoads),
      writes,
      idempotentReplays,
      japanPackageTransactionCalls,
      connectivity: getCloudConnectivitySnapshot(),
      reconnectDiagnostics: controller?.reconnectDiagnostics() || [],
    };
  },
};

const [{ default: App }] = await Promise.all([import('/src/App.tsx')]);
createRoot(document.getElementById('root')).render(React.createElement(StrictMode, null, React.createElement(App)));
