import type {
  BundleComponent,
  JapanPackageItem,
  OutboundShipment,
  OutboundShipmentItem,
  ProductGroup,
  ProductVariant,
} from './db';

type SearchableOutboundItem = OutboundShipmentItem & {
  cancelled_at?: string;
  deleted_at?: string;
  status?: string;
};

const normalizeSearchText = (value: unknown): string => String(value ?? '').trim().toLocaleLowerCase();

const isActiveOutboundItem = (item: SearchableOutboundItem): boolean => {
  const status = normalizeSearchText(item.status);
  return !item.deleted_at
    && !item.cancelled_at
    && status !== 'cancelled'
    && status !== 'canceled'
    && item.quantity > 0;
};

export interface OutboundShipmentSearchIndexInput {
  shipmentItems: OutboundShipmentItem[];
  japanPackageItems: JapanPackageItem[];
  productGroups: ProductGroup[];
  productVariants: ProductVariant[];
  bundleComponents: BundleComponent[];
}

export function buildOutboundShipmentProductSearchIndex({
  shipmentItems,
  japanPackageItems,
  productGroups,
  productVariants,
  bundleComponents,
}: OutboundShipmentSearchIndexInput): Map<string, string[]> {
  const packageItemById = new Map(japanPackageItems.map(item => [item.id, item]));
  const productGroupById = new Map(productGroups.map(group => [group.id, group]));
  const productVariantById = new Map(productVariants.map(variant => [variant.id, variant]));
  const bundleComponentsByParentId = new Map<string, ProductVariant[]>();

  for (const relation of bundleComponents) {
    const component = productVariantById.get(relation.component_variant_id);
    if (!component) continue;
    const current = bundleComponentsByParentId.get(relation.bundle_variant_id);
    if (current) current.push(component);
    else bundleComponentsByParentId.set(relation.bundle_variant_id, [component]);
  }

  const result = new Map<string, Set<string>>();
  const addText = (shipmentId: string, value: unknown) => {
    const normalized = normalizeSearchText(value);
    if (!normalized) return;
    const current = result.get(shipmentId);
    if (current) current.add(normalized);
    else result.set(shipmentId, new Set([normalized]));
  };

  for (const rawItem of shipmentItems) {
    const item = rawItem as SearchableOutboundItem;
    if (!isActiveOutboundItem(item)) continue;

    const packageItem = item.japan_package_item_id
      ? packageItemById.get(item.japan_package_item_id)
      : undefined;
    const variantId = item.product_variant_id || packageItem?.product_variant_id;
    const variant = variantId ? productVariantById.get(variantId) : undefined;
    const groupId = item.product_group_id
      || packageItem?.product_group_id
      || variant?.product_group_id;
    const group = groupId ? productGroupById.get(groupId) : undefined;

    addText(item.outbound_shipment_id, item.product_title);
    addText(item.outbound_shipment_id, item.variant_name);
    addText(item.outbound_shipment_id, packageItem?.product_title);
    addText(item.outbound_shipment_id, packageItem?.variant_name);
    addText(item.outbound_shipment_id, variant?.product_title);
    addText(item.outbound_shipment_id, variant?.variant_name);
    addText(item.outbound_shipment_id, group?.title);

    if (!variant) continue;
    for (const component of bundleComponentsByParentId.get(variant.id) || []) {
      addText(item.outbound_shipment_id, component.product_title);
      addText(item.outbound_shipment_id, component.variant_name);
      if (component.product_group_id) {
        addText(item.outbound_shipment_id, productGroupById.get(component.product_group_id)?.title);
      }
    }
  }

  return new Map([...result.entries()].map(([shipmentId, values]) => [shipmentId, [...values]]));
}

export function outboundShipmentMatchesSearch(
  shipment: OutboundShipment,
  searchTerm: string,
  productSearchIndex: ReadonlyMap<string, readonly string[]>,
): boolean {
  const query = normalizeSearchText(searchTerm);
  if (!query) return true;

  return [shipment.title, shipment.tracking_number, shipment.carrier]
    .some(value => normalizeSearchText(value).includes(query))
    || (productSearchIndex.get(shipment.id) || []).some(value => value.includes(query));
}
