import type { CloudMutableEntity } from './cloudFieldCas';

type CloudSourceRow = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const text = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const optionalText = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const numeric = (value: unknown, fallback = 0): number => {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
};
const optionalNumeric = (value: unknown): number | null => value === null || value === undefined || value === ''
  ? null
  : numeric(value);
const bool = (value: unknown, fallback = false): boolean => typeof value === 'boolean' ? value : fallback;

export const deterministicCloudUuid = (input: string): string => {
  let h1 = 1779033703;
  let h2 = 302473350;
  let h3 = 336245363;
  let h4 = 50249321;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const hex = [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1]
    .map(value => (value >>> 0).toString(16).padStart(8, '0'));
  return `${hex[0]}-${hex[1].slice(0, 4)}-5${hex[1].slice(5)}-${['8', '9', 'a', 'b'][Number.parseInt(hex[2][0], 16) % 4]}${hex[2].slice(1, 4)}-${hex[2].slice(4)}${hex[3]}`;
};

export const canonicalCloudId = (entity: CloudMutableEntity, row: CloudSourceRow): string => {
  const databaseId = text(row.database_id);
  if (UUID_PATTERN.test(databaseId)) return databaseId;
  const localId = text(row.id);
  if (UUID_PATTERN.test(localId)) return localId;
  if (entity === 'inventory_items') {
    const inventoryKey = text(row.inventory_key);
    if (!inventoryKey) throw new Error('CLOUD_MUTATION_INVENTORY_KEY_REQUIRED');
    return deterministicCloudUuid(`inventory_items:${inventoryKey}`);
  }
  if (entity === 'sales_orders') {
    if (!localId) throw new Error('CLOUD_MUTATION_LOCAL_ID_REQUIRED');
    return deterministicCloudUuid(localId.trim().toUpperCase());
  }
  if (entity === 'sales_order_items') {
    const order = text(row.order_id).trim().toUpperCase();
    const code = text(row.myacg_item_code).trim().toUpperCase();
    const variant = text(row.variant_name).trim().toUpperCase();
    const price = numeric(row.price).toString();
    return deterministicCloudUuid(`${order}_${code}_${variant}_${price}`);
  }
  throw new Error(`CLOUD_MUTATION_CANONICAL_UUID_REQUIRED:${entity}`);
};

const common = (entity: CloudMutableEntity, row: CloudSourceRow): Record<string, unknown> => ({
  id: canonicalCloudId(entity, row),
  version: typeof row.version === 'number' ? row.version : undefined,
});

export const toCloudFieldRow = (
  entity: CloudMutableEntity,
  source: unknown,
): Record<string, unknown> => {
  const row = source as CloudSourceRow;
  const localId = text(row.local_id) || text(row.id);
  switch (entity) {
    case 'product_groups': return {
      ...common(entity, row), local_id: localId, title: text(row.title),
      normalized_title: optionalText(row.normalized_title), listing_type: optionalText(row.listing_type),
      priority: text(row.priority, 'Medium'), purchase_date: optionalText(row.purchase_date),
      closing_date: optionalText(row.closing_date), release_month: optionalText(row.release_month),
      has_official_site: bool(row.has_official_site), product_url: optionalText(row.product_url),
      proxy_agent: optionalText(row.proxy_agent), show_in_purchase_list: bool(row.show_in_purchase_list),
    };
    case 'product_categories': return {
      ...common(entity, row), local_id: localId, product_group_id: optionalText(row.product_group_id),
      title: text(row.title), sort_order: numeric(row.sort_order),
    };
    case 'product_variants': return {
      ...common(entity, row), local_id: localId, product_group_id: optionalText(row.product_group_id),
      product_category_id: optionalText(row.product_category_id), myacg_item_code: text(row.myacg_item_code),
      product_title: text(row.product_title), variant_name: text(row.variant_name),
      raw_variant_name: optionalText(row.raw_variant_name), myacg_auto_quantity: numeric(row.myacg_auto_quantity),
      effective_myacg_quantity: numeric(row.effective_myacg_quantity),
      myacg_manual_adjustment: numeric(row.myacg_manual_adjustment), waca_auto_quantity: numeric(row.waca_auto_quantity),
      waca_manual_adjustment: numeric(row.waca_manual_adjustment),
      private_manual_adjustment: optionalNumeric(row.private_manual_adjustment),
      purchased_manual_adjustment: optionalNumeric(row.purchased_manual_adjustment),
      note: text(row.note), sort_order: numeric(row.sort_order), catalog_missing: bool(row.catalog_missing),
      source: optionalText(row.source), default_jpy_cost: optionalNumeric(row.default_jpy_cost),
      default_twd_cost: optionalNumeric(row.default_twd_cost),
    };
    case 'inventory_items': return {
      ...common(entity, row), inventory_key: text(row.inventory_key), myacg_item_code: text(row.myacg_item_code),
      product_id: optionalText(row.product_id), product_title: text(row.product_title),
      normalized_product_title: optionalText(row.normalized_product_title), raw_variant_name: text(row.raw_variant_name),
      listing_type: text(row.listing_type), final_price: numeric(row.final_price),
      myacg_available_quantity: numeric(row.myacg_available_quantity),
      myacg_sold_quantity: numeric(row.myacg_sold_quantity), myacg_demand_quantity: numeric(row.myacg_demand_quantity),
      myacg_listed_at: text(row.myacg_listed_at), import_sort_index: optionalNumeric(row.import_sort_index),
      latest_catalog_import_id: optionalText(row.latest_catalog_import_id),
      catalog_last_seen_at: optionalText(row.catalog_last_seen_at),
    };
    case 'purchase_batches': return {
      ...common(entity, row), local_id: localId, product_group_id: optionalText(row.product_group_id),
      name: text(row.name), date: optionalText(row.date), note: optionalText(row.note), currency: text(row.currency, 'JPY'),
    };
    case 'purchase_batch_items': return {
      ...common(entity, row), local_id: localId, purchase_batch_id: optionalText(row.purchase_batch_id),
      product_variant_id: optionalText(row.product_variant_id), quantity: numeric(row.quantity),
      cost: numeric(row.cost), note: optionalText(row.note),
    };
    case 'private_orders': return {
      ...common(entity, row), local_id: localId, product_group_id: optionalText(row.product_group_id),
      customer_name: text(row.customer_name), contact: optionalText(row.contact), note: optionalText(row.note),
      status: text(row.status, 'pending'),
    };
    case 'private_order_items': return {
      ...common(entity, row), local_id: localId, private_order_id: optionalText(row.private_order_id),
      product_variant_id: optionalText(row.product_variant_id), quantity: numeric(row.quantity),
      amount: numeric(row.amount), note: optionalText(row.note),
    };
    case 'japan_packages': return {
      ...common(entity, row), title: text(row.title), vendor_name: optionalText(row.vendor_name),
      carrier: optionalText(row.carrier), tracking_number: optionalText(row.tracking_number),
      shipped_at: optionalText(row.shipped_at), expected_arrival_at: optionalText(row.expected_arrival_at),
      arrived_at: optionalText(row.arrived_at), status: text(row.status, 'registered'), note: optionalText(row.note),
    };
    case 'japan_package_items': return {
      ...common(entity, row), japan_package_id: optionalText(row.japan_package_id),
      product_group_id: optionalText(row.product_group_id), product_variant_id: optionalText(row.product_variant_id),
      purchase_batch_id: optionalText(row.purchase_batch_id), purchase_batch_item_id: optionalText(row.purchase_batch_item_id),
      product_title: optionalText(row.product_title), category_name: optionalText(row.category_name),
      variant_name: optionalText(row.variant_name), sku: optionalText(row.sku), quantity: numeric(row.quantity, 1),
      note: optionalText(row.note), checked: bool(row.checked), checked_at: optionalText(row.checked_at),
    };
    case 'outbound_shipments': return {
      ...common(entity, row), title: text(row.title), status: text(row.status, 'draft'),
      carrier: optionalText(row.carrier), tracking_number: optionalText(row.tracking_number),
      weight_kg: optionalNumeric(row.weight_kg), shipping_cost: optionalNumeric(row.shipping_cost),
      shipped_at: optionalText(row.shipped_at), received_at: optionalText(row.received_at), note: optionalText(row.note),
    };
    case 'outbound_shipment_items': return {
      ...common(entity, row), outbound_shipment_id: optionalText(row.outbound_shipment_id),
      japan_package_item_id: optionalText(row.japan_package_item_id), product_group_id: optionalText(row.product_group_id),
      product_variant_id: optionalText(row.product_variant_id), product_title: optionalText(row.product_title),
      variant_name: optionalText(row.variant_name), sku: optionalText(row.sku), quantity: numeric(row.quantity, 1),
      checked: bool(row.checked), checked_at: optionalText(row.checked_at), note: optionalText(row.note),
    };
    case 'sales_orders': return {
      ...common(entity, row), local_id: localId, platform: text(row.platform),
      order_number: text(row.order_number), buyer_name: text(row.buyer_name),
    };
    case 'sales_order_items': return {
      ...common(entity, row), local_id: localId,
      order_id: UUID_PATTERN.test(text(row.order_database_id))
        ? text(row.order_database_id)
        : deterministicCloudUuid(text(row.order_id).trim().toUpperCase()),
      product_variant_id: optionalText(row.product_variant_id), myacg_item_code: text(row.myacg_item_code),
      product_name: optionalText(row.product_name), variant_name: optionalText(row.variant_name),
      quantity: numeric(row.quantity), price: optionalNumeric(row.price), amount: optionalNumeric(row.amount),
      order_status: optionalText(row.order_status),
    };
    case 'bundle_components': return {
      ...common(entity, row), bundle_variant_id: optionalText(row.bundle_variant_id),
      component_variant_id: optionalText(row.component_variant_id),
    };
  }
};
