import type { PrivateOrder, PrivateOrderItem, PurchaseBatch, PurchaseBatchItem } from './db';

export const mapPurchaseBatchItemsByGroup = (
  batches: PurchaseBatch[],
  items: PurchaseBatchItem[]
): Map<string, PurchaseBatchItem[]> => {
  const groupIdByBatchId = new Map(
    batches.map(batch => [batch.id, batch.product_group_id])
  );
  const itemsByGroupId = new Map<string, PurchaseBatchItem[]>();

  for (const item of items) {
    const groupId = groupIdByBatchId.get(item.purchase_batch_id);
    if (!groupId) continue;

    const groupItems = itemsByGroupId.get(groupId);
    if (groupItems) {
      groupItems.push(item);
    } else {
      itemsByGroupId.set(groupId, [item]);
    }
  }

  return itemsByGroupId;
};

export const mapPrivateOrderItemsByGroup = (
  orders: PrivateOrder[],
  items: PrivateOrderItem[]
): Map<string, PrivateOrderItem[]> => {
  const groupIdByOrderId = new Map(
    orders.map(order => [order.id, order.product_group_id])
  );
  const itemsByGroupId = new Map<string, PrivateOrderItem[]>();

  for (const item of items) {
    const groupId = groupIdByOrderId.get(item.private_order_id);
    if (!groupId) continue;

    const groupItems = itemsByGroupId.get(groupId);
    if (groupItems) {
      groupItems.push(item);
    } else {
      itemsByGroupId.set(groupId, [item]);
    }
  }

  return itemsByGroupId;
};
