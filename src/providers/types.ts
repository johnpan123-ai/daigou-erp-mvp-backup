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

export interface IDataProvider {
  getInventory(): Promise<InventoryItem[]>;
  upsertInventory(items: InventoryItem[]): Promise<ImportStats>;
  
  getSalesOrders(): Promise<SalesOrder[]>;
  saveSalesOrders(items: SalesOrder[]): Promise<void>;
  getSalesOrderItems(): Promise<SalesOrderItem[]>;
  saveSalesOrderItems(items: SalesOrderItem[]): Promise<void>;

  getProductGroups(): Promise<ProductGroup[]>;
  saveProductGroups(groups: ProductGroup[]): Promise<void>;
  getProductCategories(): Promise<ProductCategory[]>;
  saveProductCategories(categories: ProductCategory[]): Promise<void>;
  getProductVariants(): Promise<ProductVariant[]>;
  saveProductVariants(variants: ProductVariant[]): Promise<void>;

  getPurchaseBatches(): Promise<PurchaseBatch[]>;
  savePurchaseBatches(batches: PurchaseBatch[]): Promise<void>;
  getPurchaseBatchItems(): Promise<PurchaseBatchItem[]>;
  savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void>;

  getPrivateOrders(): Promise<PrivateOrder[]>;
  savePrivateOrders(orders: PrivateOrder[]): Promise<void>;
  getPrivateOrderItems(): Promise<PrivateOrderItem[]>;
  savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void>;

  getImportBatches(): Promise<ImportBatch[]>;
  saveImportBatches(batches: ImportBatch[]): Promise<void>;

  exportData(): Promise<void>;
  importData(jsonString: string): Promise<boolean>;
  clearData(): Promise<void>;
  clearPurchaseRecords(): Promise<void>;
  createPurchaseRecordFromInventory(itemCodes: string[]): Promise<void>;
  reparseProductVariants(): Promise<void>;
  reparseProductTitles(): Promise<void>;
  syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number }>;
  deleteProductGroup(groupId: string): Promise<void>;
  deleteProductGroups(groupIds: string[]): Promise<void>;
}
