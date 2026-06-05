import type { IDataProvider } from './types';
import { db } from '../lib/db';
import type { 
  InventoryItem, 
  SalesOrder, 
  SalesOrderItem, 
  ProductGroup, 
  ProductCategory, 
  ProductVariant, 
  PurchaseBatch, 
  PurchaseBatchItem, 
  PrivateOrder, 
  PrivateOrderItem, 
  ImportBatch,
  ImportStats
} from '../lib/db';

export class LocalProvider implements IDataProvider {
  async getInventory(): Promise<InventoryItem[]> {
    return db.getInventory();
  }
  async upsertInventory(items: InventoryItem[]): Promise<ImportStats> {
    return db.upsertInventory(items);
  }
  async getSalesOrders(): Promise<SalesOrder[]> {
    return db.getSalesOrders();
  }
  async saveSalesOrders(items: SalesOrder[]): Promise<void> {
    return db.saveSalesOrders(items);
  }
  async getSalesOrderItems(): Promise<SalesOrderItem[]> {
    return db.getSalesOrderItems();
  }
  async saveSalesOrderItems(items: SalesOrderItem[]): Promise<void> {
    return db.saveSalesOrderItems(items);
  }
  async getProductGroups(): Promise<ProductGroup[]> {
    return db.getProductGroups();
  }
  async saveProductGroups(groups: ProductGroup[]): Promise<void> {
    return db.saveProductGroups(groups);
  }
  async getProductCategories(): Promise<ProductCategory[]> {
    return db.getProductCategories();
  }
  async saveProductCategories(categories: ProductCategory[]): Promise<void> {
    return db.saveProductCategories(categories);
  }
  async getProductVariants(options?: { recalc?: boolean }): Promise<ProductVariant[]> {
    return db.getProductVariants(options);
  }
  async saveProductVariants(variants: ProductVariant[]): Promise<void> {
    return db.saveProductVariants(variants);
  }
  async getPurchaseBatches(): Promise<PurchaseBatch[]> {
    return db.getPurchaseBatches();
  }
  async savePurchaseBatches(batches: PurchaseBatch[]): Promise<void> {
    return db.savePurchaseBatches(batches);
  }
  async getPurchaseBatchItems(): Promise<PurchaseBatchItem[]> {
    return db.getPurchaseBatchItems();
  }
  async savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void> {
    return db.savePurchaseBatchItems(items);
  }
  async getPrivateOrders(): Promise<PrivateOrder[]> {
    return db.getPrivateOrders();
  }
  async savePrivateOrders(orders: PrivateOrder[]): Promise<void> {
    return db.savePrivateOrders(orders);
  }
  async getPrivateOrderItems(): Promise<PrivateOrderItem[]> {
    return db.getPrivateOrderItems();
  }
  async savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void> {
    return db.savePrivateOrderItems(items);
  }
  async getImportBatches(): Promise<ImportBatch[]> {
    return db.getImportBatches();
  }
  async saveImportBatches(batches: ImportBatch[]): Promise<void> {
    return db.saveImportBatches(batches);
  }
  async exportData(): Promise<void> {
    return db.exportData();
  }
  async importData(jsonString: string): Promise<boolean> {
    return db.importData(jsonString);
  }
  async clearData(): Promise<void> {
    return db.clearData();
  }
  async clearPurchaseRecords(): Promise<void> {
    return db.clearPurchaseRecords();
  }
  async createPurchaseRecordFromInventory(itemCodes: string[]): Promise<void> {
    return db.createPurchaseRecordFromInventory(itemCodes);
  }
  async reparseProductVariants(): Promise<void> {
    return db.reparseProductVariants();
  }
  async reparseProductTitles(): Promise<void> {
    return db.reparseProductTitles();
  }
  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number }> {
    return db.syncProductGroupsWithInventory();
  }
  async deleteProductGroup(groupId: string): Promise<void> {
    const groups = await db.getProductGroups();
    const updatedGroups = groups.filter(g => g.id !== groupId);
    await db.saveProductGroups(updatedGroups);

    const categories = await db.getProductCategories();
    const updatedCategories = categories.filter(c => c.product_group_id !== groupId);
    await db.saveProductCategories(updatedCategories);

    const variants = await db.getProductVariants();
    const updatedVariants = variants.filter(v => v.product_group_id !== groupId);
    await db.saveProductVariants(updatedVariants);
  }
  async deleteProductGroups(groupIds: string[]): Promise<void> {
    const groups = await db.getProductGroups();
    const updatedGroups = groups.filter(g => !groupIds.includes(g.id));
    await db.saveProductGroups(updatedGroups);

    const categories = await db.getProductCategories();
    const updatedCategories = categories.filter(c => !c.product_group_id || !groupIds.includes(c.product_group_id));
    await db.saveProductCategories(updatedCategories);

    const variants = await db.getProductVariants();
    const updatedVariants = variants.filter(v => !v.product_group_id || !groupIds.includes(v.product_group_id));
    await db.saveProductVariants(updatedVariants);
  }
  async canWriteCloud(): Promise<boolean> {
    return true;
  }
}

