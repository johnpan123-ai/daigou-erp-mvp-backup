import type { JapanPackage, JapanPackageItem, OutboundShipmentItem } from './db';

export interface AvailableJapanPackageItem {
  item: JapanPackageItem;
  packageRow: JapanPackage;
  shippedQuantity: number;
  availableQuantity: number;
}

export const getAvailableJapanPackageItems = (
  packages: readonly JapanPackage[],
  packageItems: readonly JapanPackageItem[],
  shipmentItems: readonly OutboundShipmentItem[],
  currentShipmentId?: string,
): AvailableJapanPackageItem[] => {
  const eligiblePackages = new Map(
    packages
      .filter(pkg => pkg.status === 'arrived' || pkg.status === 'confirmed' || Boolean(pkg.arrived_at))
      .map(pkg => [pkg.id, pkg]),
  );
  const shippedByPackageItem = new Map<string, number>();
  for (const shipmentItem of shipmentItems) {
    if (!shipmentItem.japan_package_item_id || shipmentItem.outbound_shipment_id === currentShipmentId) continue;
    shippedByPackageItem.set(
      shipmentItem.japan_package_item_id,
      (shippedByPackageItem.get(shipmentItem.japan_package_item_id) ?? 0) + shipmentItem.quantity,
    );
  }

  return packageItems.flatMap(item => {
    const packageRow = eligiblePackages.get(item.japan_package_id);
    if (!packageRow || !item.checked) return [];
    const shippedQuantity = shippedByPackageItem.get(item.id) ?? 0;
    const availableQuantity = item.quantity - shippedQuantity;
    if (availableQuantity <= 0) return [];
    return [{ item, packageRow, shippedQuantity, availableQuantity }];
  });
};
