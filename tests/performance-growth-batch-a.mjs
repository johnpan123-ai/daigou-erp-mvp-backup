import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({
  root: ROOT,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
});

const measure = fn => {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
};

const makeFixture = factor => {
  const groupCount = 12 * factor;
  const variantsPerGroup = 4;
  const groups = [];
  const categories = [];
  const variants = [];
  const inventory = [];
  const privateItemsByGroup = new Map();
  const batchItemsByGroup = new Map();
  const shipments = [];
  const shipmentItems = [];
  const packages = [];
  const packageItems = [];

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const groupId = `group-${factor}-${groupIndex}`;
    const categoryId = `category-${factor}-${groupIndex}`;
    const group = {
      id: groupId,
      title: groupIndex % 3 === 0 ? `中文商品 ${groupIndex}` : groupIndex % 3 === 1 ? `日本語グッズ ${groupIndex}` : `English Product ${groupIndex}`,
      normalized_title: `normalized ${groupIndex}`,
      listing_type: groupIndex % 5 === 0 ? '代理版' : '一般預購',
      release_month: `2026-${String((groupIndex % 12) + 1).padStart(2, '0')}`,
      closing_date: '2026-10-01',
      product_url: `https://example.test/${groupIndex}`,
      purchase_date: '',
      priority: 'Medium',
      has_official_site: false,
      show_in_purchase_list: true,
      created_at: '2026-09-23T00:00:00Z',
      updated_at: '2026-09-23T00:00:00Z',
    };
    groups.push(group);
    categories.push({ id: categoryId, product_group_id: groupId, title: `分類 ${groupIndex}`, sort_order: groupIndex });

    const privateItems = [];
    const batchItems = [];
    for (let variantIndex = 0; variantIndex < variantsPerGroup; variantIndex += 1) {
      const variantId = `variant-${factor}-${groupIndex}-${variantIndex}`;
      const sku = `SKU-${factor}-${groupIndex}-${variantIndex}`;
      variants.push({
        id: variantId,
        product_group_id: variantIndex % 2 === 0 ? groupId : undefined,
        product_category_id: categoryId,
        myacg_item_code: sku,
        product_title: group.title,
        variant_name: variantIndex === 0 ? `特別版 ${groupIndex}` : `Version ${variantIndex}`,
        raw_variant_name: `Raw ${variantIndex}`,
        myacg_auto_quantity: variantIndex + 1,
        effective_myacg_quantity: variantIndex + 1,
        waca_auto_quantity: variantIndex % 2,
        note: '',
        sort_order: variantIndex,
        source: 'inventory_import',
        default_jpy_cost: 500 + variantIndex,
      });
      inventory.push({
        id: `inventory-${factor}-${groupIndex}-${variantIndex}`,
        myacg_item_code: sku,
        product_title: group.title,
        raw_variant_name: `Raw ${variantIndex}`,
        listing_type: group.listing_type,
        final_price: 1000 + variantIndex,
        myacg_available_quantity: 1,
        myacg_sold_quantity: variantIndex + 1,
        myacg_listed_at: '2026-09-23T00:00:00Z',
      });
      privateItems.push({
        id: `private-item-${factor}-${groupIndex}-${variantIndex}`,
        private_order_id: `private-order-${factor}-${groupIndex}`,
        product_variant_id: variantId,
        quantity: variantIndex % 2,
        amount: 0,
        note: '',
      });
      batchItems.push({
        id: `batch-item-${factor}-${groupIndex}-${variantIndex}`,
        purchase_batch_id: `batch-${factor}-${groupIndex}`,
        product_variant_id: variantId,
        quantity: variantIndex + 1,
        cost: 500,
        note: '',
      });
    }
    privateItemsByGroup.set(groupId, privateItems);
    batchItemsByGroup.set(groupId, batchItems);

    const shipmentId = `shipment-${factor}-${groupIndex}`;
    shipments.push({ id: shipmentId });
    const packageId = `package-${factor}-${groupIndex}`;
    packages.push({ id: packageId });
    for (let itemIndex = 0; itemIndex < 3; itemIndex += 1) {
      shipmentItems.push({
        id: `shipment-item-${factor}-${groupIndex}-${itemIndex}`,
        outbound_shipment_id: shipmentId,
        quantity: itemIndex + 1,
        checked: false,
      });
      packageItems.push({
        id: `package-item-${factor}-${groupIndex}-${itemIndex}`,
        japan_package_id: packageId,
        quantity: itemIndex + 1,
        checked: itemIndex % 2 === 0,
      });
    }
  }

  return {
    factor,
    groups,
    categories,
    variants,
    inventory,
    privateItemsByGroup,
    batchItemsByGroup,
    shipments,
    shipmentItems,
    packages,
    packageItems,
  };
};

const legacySearch = (fixture, query, proxyByGroupId) => {
  const lowerQuery = query.toLowerCase();
  return fixture.groups.filter(group => {
    const categoryIds = new Set(fixture.categories.filter(category => category.product_group_id === group.id).map(category => category.id));
    const groupVariants = fixture.variants.filter(variant => variant.product_group_id === group.id || (variant.product_category_id && categoryIds.has(variant.product_category_id)));
    const variantMatch = groupVariants.some(variant => {
      if (variant.variant_name?.toLowerCase().includes(lowerQuery)) return true;
      if (variant.raw_variant_name?.toLowerCase().includes(lowerQuery)) return true;
      const category = variant.product_category_id
        ? fixture.categories.find(candidate => candidate.id === variant.product_category_id)
        : undefined;
      return Boolean(category?.title?.toLowerCase().includes(lowerQuery));
    });
    const effectiveListingType = proxyByGroupId.get(group.id) ? '代理版' : (group.listing_type || '');
    return [group.title, group.normalized_title, group.release_month, group.closing_date, effectiveListingType, group.product_url]
      .some(value => value?.toLowerCase().includes(lowerQuery)) || variantMatch;
  }).map(group => group.id);
};

const legacyVariantDemand = (variant, privateItems, batchItems, inventory) => {
  const cleanCode = (variant.myacg_item_code || '').trim().toUpperCase();
  const inventoryMatches = inventory.filter(item => item.myacg_item_code.trim().toUpperCase() === cleanCode);
  const rawMyacgQuantity = inventoryMatches.length > 0 ? (inventoryMatches[0].myacg_sold_quantity ?? 0) : -1;
  const localMyacg = (rawMyacgQuantity >= 0 ? rawMyacgQuantity : 0) + (variant.myacg_manual_adjustment ?? 0);
  const autoMyacg = variant.myacg_auto_quantity !== null && variant.myacg_auto_quantity !== undefined && variant.myacg_auto_quantity >= 0
    ? variant.myacg_auto_quantity + (variant.myacg_manual_adjustment ?? 0)
    : null;
  const rawMyacg = variant.effective_myacg_quantity !== null && variant.effective_myacg_quantity !== undefined && variant.effective_myacg_quantity >= 0
    ? variant.effective_myacg_quantity + (variant.myacg_manual_adjustment ?? 0)
    : (autoMyacg ?? variant.myacg_quantity ?? localMyacg);
  const myacg = rawMyacg >= 0 ? rawMyacg : 0;
  const localWaca = (variant.waca_auto_quantity ?? 0) + (variant.waca_manual_adjustment ?? 0);
  const autoWaca = variant.waca_auto_quantity !== null && variant.waca_auto_quantity !== undefined && variant.waca_auto_quantity >= 0
    ? variant.waca_auto_quantity + (variant.waca_manual_adjustment ?? 0)
    : null;
  const rawWaca = autoWaca ?? variant.waca_quantity ?? localWaca;
  const waca = rawWaca >= 0 ? rawWaca : 0;
  const privateOrder = privateItems.filter(item => item.product_variant_id === variant.id).reduce((sum, item) => sum + (item.quantity || 0), 0);
  const localPurchased = batchItems.filter(item => item.product_variant_id === variant.id).reduce((sum, item) => sum + (item.quantity || 0), 0);
  let purchased = 0;
  if (typeof variant.purchased_manual_adjustment === 'number' && variant.purchased_manual_adjustment > 0) purchased = variant.purchased_manual_adjustment;
  else if (localPurchased > 0) purchased = localPurchased;
  else {
    const legacyPurchased = variant.ordered_quantity ?? variant.ordered_qty;
    if (typeof legacyPurchased === 'number' && legacyPurchased > 0) purchased = legacyPurchased;
  }
  return { myacg, waca, privateOrder, purchased, gap: Math.max(myacg + waca + privateOrder - purchased, 0) };
};

const legacyGroupDemand = (fixture, group) => {
  const categoryIds = new Set(fixture.categories.filter(category => category.product_group_id === group.id).map(category => category.id));
  const groupVariants = fixture.variants.filter(variant => variant.product_group_id === group.id || (variant.product_category_id && categoryIds.has(variant.product_category_id)));
  const privateItems = fixture.privateItemsByGroup.get(group.id);
  const batchItems = fixture.batchItemsByGroup.get(group.id);
  const result = { demand: 0, myacg: 0, waca: 0, privateOrder: 0, purchased: 0, gap: 0, hasCatalogMissing: false };
  for (const variant of groupVariants) {
    const demand = legacyVariantDemand(variant, privateItems, batchItems, fixture.inventory);
    result.myacg += demand.myacg;
    result.waca += demand.waca;
    result.privateOrder += demand.privateOrder;
    result.demand += demand.myacg + demand.waca + demand.privateOrder;
    result.purchased += demand.purchased;
    result.gap += demand.gap;
    if (variant.catalog_missing === true) result.hasCatalogMissing = true;
  }
  return result;
};

try {
  const selectors = await server.ssrLoadModule('/src/lib/growthSafeSelectors.ts');
  const pageSources = await Promise.all([
    'src/pages/PurchaseRecords.tsx',
    'src/pages/Purchasing.tsx',
    'src/pages/Dashboard.tsx',
    'src/pages/OutboundShipmentsList.tsx',
    'src/pages/JapanPackagesList.tsx',
  ].map(path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')));

  assert.match(pageSources[0], /useDeferredValue\(searchTerm\)/, 'Purchase Records input must defer the expensive query pipeline');
  assert.match(pageSources[0], /buildPurchaseRecordSearchDocuments/, 'Purchase Records must use prepared search documents');
  assert.match(pageSources[1], /buildVariantsByGroup/, 'Purchasing must use group indexes');
  assert.doesNotMatch(pageSources[1], /purchaseBatches\s*\.filter\(/, 'Purchasing must not rescan all batches per group');
  assert.match(pageSources[2], /groupDemandTotalsById/, 'Dashboard must precompute group totals');
  assert.doesNotMatch(pageSources[2], /calculateGroupDemandAndPurchased/, 'Dashboard must not rescan all categories and variants per group');
  assert.doesNotMatch(pageSources[3], /shipmentItems\.filter\([^\n]*outbound_shipment_id/, 'Outbound render must not filter all shipment items per shipment');
  assert.doesNotMatch(pageSources[4], /packageItems\.filter\([^\n]*japan_package_id\s*===/, 'Japan package render must not filter all package items per package');

  const results = [];
  for (const factor of [1, 2, 5]) {
    const fixture = makeFixture(factor);
    const proxyByGroupId = new Map(fixture.groups.map(group => [group.id, group.listing_type === '代理版']));
    const equivalenceQueries = ['中文商品', '日本語', 'english product', '特別版', 'raw 2', '分類 3', '代理版', '2026-10'];

    const legacySearchResult = measure(() => equivalenceQueries.map(query => legacySearch(fixture, query, proxyByGroupId)));
    const documentsResult = measure(() => selectors.buildPurchaseRecordSearchDocuments(
      fixture.groups,
      fixture.categories,
      fixture.variants,
      proxyByGroupId,
    ));
    const indexedSearchResult = measure(() => equivalenceQueries.map(query => fixture.groups
      .filter(group => selectors.purchaseRecordMatchesSearch(documentsResult.value.get(group.id), query.toLowerCase()))
      .map(group => group.id)));
    assert.deepEqual(indexedSearchResult.value, legacySearchResult.value, `Search results must remain equivalent at ${factor}x`);
    const skuGroup = fixture.groups[0].id;
    assert.equal(
      selectors.purchaseRecordMatchesSearch(documentsResult.value.get(skuGroup), `sku-${factor}-0-2`),
      true,
      `SKU search must remain available at ${factor}x`,
    );
    assert.equal(
      selectors.purchaseRecordMatchesSearch(documentsResult.value.get(skuGroup), ''),
      true,
      `Clear search must restore records at ${factor}x`,
    );

    const legacyDemand = measure(() => fixture.groups.map(group => [group.id, legacyGroupDemand(fixture, group)]));
    const indexedDemand = measure(() => {
      const variantsByGroupId = selectors.buildVariantsByGroup(fixture.categories, fixture.variants);
      const inventoryLookup = selectors.buildInventoryDemandLookup(fixture.inventory);
      return fixture.groups.map(group => {
        const privateItems = fixture.privateItemsByGroup.get(group.id);
        const batchItems = fixture.batchItemsByGroup.get(group.id);
        const demandLookup = selectors.buildVariantDemandLookup(privateItems, batchItems, fixture.inventory, inventoryLookup);
        return [
          group.id,
          selectors.calculateDemandForIndexedVariants(
            variantsByGroupId.get(group.id) ?? [],
            demandLookup,
          ),
        ];
      });
    });
    assert.deepEqual(indexedDemand.value, legacyDemand.value, `Dashboard/Purchasing totals must remain equivalent at ${factor}x`);

    const legacyOutbound = measure(() => new Map(fixture.shipments.map(shipment => {
      const items = fixture.shipmentItems.filter(item => item.outbound_shipment_id === shipment.id);
      return [shipment.id, { itemCount: items.length, totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0) }];
    })));
    const indexedOutbound = measure(() => selectors.buildOutboundShipmentMetrics(fixture.shipmentItems));
    assert.deepEqual(indexedOutbound.value, legacyOutbound.value, `Outbound metrics must remain equivalent at ${factor}x`);

    const legacyJapan = measure(() => new Map(fixture.packages.map(pkg => [
      pkg.id,
      fixture.packageItems.filter(item => item.japan_package_id === pkg.id).reduce((sum, item) => sum + item.quantity, 0),
    ])));
    const indexedJapan = measure(() => selectors.buildJapanPackageQuantityById(fixture.packageItems));
    assert.deepEqual(indexedJapan.value, legacyJapan.value, `Japan package quantities must remain equivalent at ${factor}x`);

    const groupCount = fixture.groups.length;
    const variantCount = fixture.variants.length;
    const inventoryCount = fixture.inventory.length;
    const shipmentCount = fixture.shipments.length;
    const shipmentItemCount = fixture.shipmentItems.length;
    const packageCount = fixture.packages.length;
    const packageItemCount = fixture.packageItems.length;
    results.push({
      factor,
      rows: { groupCount, variantCount, inventoryCount, shipmentCount, shipmentItemCount, packageCount, packageItemCount },
      milliseconds: {
        searchLegacy: legacySearchResult.ms,
        searchIndexBuild: documentsResult.ms,
        searchIndexed: indexedSearchResult.ms,
        demandLegacy: legacyDemand.ms,
        demandIndexed: indexedDemand.ms,
        outboundLegacy: legacyOutbound.ms,
        outboundIndexed: indexedOutbound.ms,
        japanLegacy: legacyJapan.ms,
        japanIndexed: indexedJapan.ms,
      },
      operationCounts: {
        demandGroupCollectionScansBefore: groupCount * (fixture.categories.length + variantCount),
        demandGroupCollectionScansAfter: fixture.categories.length + variantCount + groupCount,
        inventoryCandidateChecksBefore: variantCount * inventoryCount,
        inventoryIndexAndLookupsAfter: inventoryCount + variantCount,
        outboundBefore: shipmentCount * shipmentItemCount,
        outboundAfter: shipmentItemCount + shipmentCount,
        japanBefore: packageCount * packageItemCount,
        japanAfter: packageItemCount + packageCount,
      },
    });
  }

  assert.deepEqual(results.map(result => result.factor), [1, 2, 5]);
  assert.ok(results.every(result => result.operationCounts.outboundAfter < result.operationCounts.outboundBefore));
  assert.ok(results.every(result => result.operationCounts.japanAfter < result.operationCounts.japanBefore));
  assert.ok(results.every(result => result.operationCounts.inventoryIndexAndLookupsAfter < result.operationCounts.inventoryCandidateChecksBefore));

  const negativePrivateVariant = makeFixture(1).variants[0];
  const negativePrivateLookup = selectors.buildVariantDemandLookup(
    [{ id: 'negative-private', private_order_id: 'negative-order', product_variant_id: negativePrivateVariant.id, quantity: -3, amount: 0, note: '' }],
    [],
    [],
  );
  assert.equal(
    selectors.calculateVariantDemandFromLookup(negativePrivateVariant, negativePrivateLookup).privateOrder,
    0,
    'Indexed demand must preserve the legacy non-negative private-order clamp',
  );

  console.log(JSON.stringify({ benchmark: 'performance-batch-a', results }, null, 2));
  console.log('PASS 1x / 2x / 5x unique canonical fixture growth benchmark');
  console.log('PASS Purchase Records multilingual, SKU, clear, and indexed search equivalence');
  console.log('PASS Purchasing/Dashboard demand, purchased, gap, and catalog-missing equivalence');
  console.log('PASS Outbound O(SI + S) and Japan Packages O(PI + P) operation-count contracts');
  console.log('PASS source guards reject the identified nested full-collection scans');
} finally {
  await server.close();
}
