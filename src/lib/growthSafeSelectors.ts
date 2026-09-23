import type {
  InventoryItem,
  JapanPackageItem,
  OutboundShipmentItem,
  PrivateOrderItem,
  ProductCategory,
  ProductGroup,
  ProductVariant,
  PurchaseBatchItem,
} from './db';

const append = <T>(map: Map<string, T[]>, key: string, value: T) => {
  const current = map.get(key);
  if (current) current.push(value);
  else map.set(key, [value]);
};

export const buildVariantsByGroup = (
  categories: ProductCategory[],
  variants: ProductVariant[],
): Map<string, ProductVariant[]> => {
  const categoryGroupIdById = new Map<string, string>();
  for (const category of categories) {
    if (category.product_group_id) categoryGroupIdById.set(category.id, category.product_group_id);
  }

  const variantsByGroupId = new Map<string, ProductVariant[]>();
  for (const variant of variants) {
    const directGroupId = variant.product_group_id;
    const categoryGroupId = variant.product_category_id
      ? categoryGroupIdById.get(variant.product_category_id)
      : undefined;

    if (directGroupId) append(variantsByGroupId, directGroupId, variant);
    if (categoryGroupId && categoryGroupId !== directGroupId) {
      append(variantsByGroupId, categoryGroupId, variant);
    }
  }

  return variantsByGroupId;
};

export interface VariantDemandLookup {
  inventoryByNormalizedCode: Map<string, InventoryItem[]>;
  privateOrderQuantityByVariantId: Map<string, number>;
  purchaseQuantityByVariantId: Map<string, number>;
}

export interface IndexedVariantDemandResult {
  myacg: number;
  waca: number;
  privateOrder: number;
  purchased: number;
  gap: number;
}

export interface IndexedGroupDemandResult extends IndexedVariantDemandResult {
  demand: number;
  hasCatalogMissing: boolean;
}

export const buildInventoryDemandLookup = (
  inventory: InventoryItem[],
): Map<string, InventoryItem[]> => {
  const inventoryByNormalizedCode = new Map<string, InventoryItem[]>();
  for (const item of inventory) {
    const code = item.myacg_item_code.trim().toUpperCase();
    const matches = inventoryByNormalizedCode.get(code);
    if (matches) matches.push(item);
    else inventoryByNormalizedCode.set(code, [item]);
  }
  return inventoryByNormalizedCode;
};

export const buildVariantDemandLookup = (
  privateOrderItems: PrivateOrderItem[],
  batchItems: PurchaseBatchItem[],
  inventory: InventoryItem[],
  inventoryByNormalizedCode = buildInventoryDemandLookup(inventory),
): VariantDemandLookup => {
  const privateOrderQuantityByVariantId = new Map<string, number>();
  for (const item of privateOrderItems) {
    if (!item) continue;
    privateOrderQuantityByVariantId.set(
      item.product_variant_id,
      (privateOrderQuantityByVariantId.get(item.product_variant_id) ?? 0) + (item.quantity || 0),
    );
  }

  const purchaseQuantityByVariantId = new Map<string, number>();
  for (const item of batchItems) {
    if (!item) continue;
    purchaseQuantityByVariantId.set(
      item.product_variant_id,
      (purchaseQuantityByVariantId.get(item.product_variant_id) ?? 0) + (item.quantity || 0),
    );
  }

  return {
    inventoryByNormalizedCode,
    privateOrderQuantityByVariantId,
    purchaseQuantityByVariantId,
  };
};

export const calculateVariantDemandFromLookup = (
  variant: ProductVariant,
  lookup: VariantDemandLookup,
): IndexedVariantDemandResult => {
  const cleanCode = (variant.myacg_item_code || '').trim().toUpperCase();
  const inventoryItem = cleanCode ? lookup.inventoryByNormalizedCode.get(cleanCode)?.[0] : undefined;
  const rawMyacgQuantity = inventoryItem ? (inventoryItem.myacg_sold_quantity ?? 0) : -1;
  const localMyacg = (rawMyacgQuantity >= 0 ? rawMyacgQuantity : 0) + (variant.myacg_manual_adjustment ?? 0);
  const autoMyacg = variant.myacg_auto_quantity !== null && variant.myacg_auto_quantity !== undefined && variant.myacg_auto_quantity >= 0
    ? variant.myacg_auto_quantity + (variant.myacg_manual_adjustment ?? 0)
    : null;
  const legacyVariant = variant as ProductVariant & { myacg_quantity?: number; waca_quantity?: number; ordered_quantity?: number; ordered_qty?: number };
  const rawMyacg = variant.effective_myacg_quantity !== null && variant.effective_myacg_quantity !== undefined && variant.effective_myacg_quantity >= 0
    ? variant.effective_myacg_quantity + (variant.myacg_manual_adjustment ?? 0)
    : (autoMyacg ?? legacyVariant.myacg_quantity ?? localMyacg);
  const myacg = rawMyacg >= 0 ? rawMyacg : 0;

  const localWaca = (variant.waca_auto_quantity ?? 0) + (variant.waca_manual_adjustment ?? 0);
  const autoWaca = variant.waca_auto_quantity !== null && variant.waca_auto_quantity !== undefined && variant.waca_auto_quantity >= 0
    ? variant.waca_auto_quantity + (variant.waca_manual_adjustment ?? 0)
    : null;
  const rawWaca = autoWaca ?? legacyVariant.waca_quantity ?? localWaca;
  const waca = rawWaca >= 0 ? rawWaca : 0;
  const rawPrivateOrder = lookup.privateOrderQuantityByVariantId.get(variant.id) ?? 0;
  const privateOrder = rawPrivateOrder >= 0 ? rawPrivateOrder : 0;
  const localPurchased = lookup.purchaseQuantityByVariantId.get(variant.id) ?? 0;

  let purchased = 0;
  if (typeof variant.purchased_manual_adjustment === 'number' && variant.purchased_manual_adjustment > 0) {
    purchased = variant.purchased_manual_adjustment;
  } else if (localPurchased > 0) {
    purchased = localPurchased;
  } else {
    const legacyPurchased = legacyVariant.ordered_quantity ?? legacyVariant.ordered_qty;
    if (typeof legacyPurchased === 'number' && legacyPurchased > 0) purchased = legacyPurchased;
  }

  return {
    myacg,
    waca,
    privateOrder,
    purchased,
    gap: Math.max(myacg + waca + privateOrder - purchased, 0),
  };
};

export const calculateDemandForIndexedVariants = (
  variants: ProductVariant[],
  lookup: VariantDemandLookup,
): IndexedGroupDemandResult => {
  let demand = 0;
  let myacg = 0;
  let waca = 0;
  let privateOrder = 0;
  let purchased = 0;
  let gap = 0;
  let hasCatalogMissing = false;

  for (const variant of variants) {
    const result = calculateVariantDemandFromLookup(variant, lookup);
    myacg += result.myacg;
    waca += result.waca;
    privateOrder += result.privateOrder;
    demand += result.myacg + result.waca + result.privateOrder;
    purchased += result.purchased;
    gap += result.gap;
    if (variant.catalog_missing === true) hasCatalogMissing = true;
  }

  return { demand, myacg, waca, privateOrder, purchased, gap, hasCatalogMissing };
};

export const buildPurchaseRecordSearchDocuments = (
  groups: ProductGroup[],
  categories: ProductCategory[],
  variants: ProductVariant[],
  proxyByGroupId: ReadonlyMap<string, boolean>,
): Map<string, string[]> => {
  const categoryById = new Map(categories.map(category => [category.id, category]));
  const variantsByGroupId = buildVariantsByGroup(categories, variants);
  const documents = new Map<string, string[]>();

  for (const group of groups) {
    const terms = [
      group.title,
      group.normalized_title,
      group.release_month,
      group.closing_date,
      proxyByGroupId.get(group.id) ? '代理版' : group.listing_type,
      group.product_url,
    ];

    for (const variant of variantsByGroupId.get(group.id) ?? []) {
      terms.push(
        variant.variant_name,
        variant.raw_variant_name,
        variant.myacg_item_code,
        variant.product_category_id ? categoryById.get(variant.product_category_id)?.title : undefined,
      );
    }

    documents.set(
      group.id,
      terms.filter((term): term is string => Boolean(term)).map(term => term.toLowerCase()),
    );
  }

  return documents;
};

export const purchaseRecordMatchesSearch = (
  document: readonly string[] | undefined,
  lowerCaseQuery: string,
): boolean => (document ?? []).some(term => term.includes(lowerCaseQuery));

export interface OutboundShipmentMetrics {
  itemCount: number;
  totalQuantity: number;
}

export const buildOutboundShipmentMetrics = (
  shipmentItems: OutboundShipmentItem[],
): Map<string, OutboundShipmentMetrics> => {
  const metricsByShipmentId = new Map<string, OutboundShipmentMetrics>();
  for (const item of shipmentItems) {
    const current = metricsByShipmentId.get(item.outbound_shipment_id);
    if (current) {
      current.itemCount += 1;
      current.totalQuantity += item.quantity;
    } else {
      metricsByShipmentId.set(item.outbound_shipment_id, {
        itemCount: 1,
        totalQuantity: item.quantity,
      });
    }
  }
  return metricsByShipmentId;
};

export const buildJapanPackageQuantityById = (
  packageItems: JapanPackageItem[],
): Map<string, number> => {
  const quantityByPackageId = new Map<string, number>();
  for (const item of packageItems) {
    quantityByPackageId.set(
      item.japan_package_id,
      (quantityByPackageId.get(item.japan_package_id) ?? 0) + item.quantity,
    );
  }
  return quantityByPackageId;
};
