import type { IDataProvider } from './types';
import { LocalProvider } from './localProvider';
import { supabaseProvider } from './cloud/supabaseProvider';
import { getProviderMode } from './providerMode';
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

class DynamicDataProvider implements IDataProvider {
  private localProvider = new LocalProvider();
  private supabaseProvider = supabaseProvider;

  private getActiveProvider(): IDataProvider {
    const mode = getProviderMode();
    if (mode === 'cloud') {
      return this.supabaseProvider;
    } else if (mode === 'fallback') {
      return this.supabaseProvider;
    }
    return this.localProvider;
  }

  async getInventory(): Promise<InventoryItem[]> {
    return this.getActiveProvider().getInventory();
  }
  async upsertInventory(items: InventoryItem[]): Promise<ImportStats> {
    return this.getActiveProvider().upsertInventory(items);
  }
  async getSalesOrders(): Promise<SalesOrder[]> {
    return this.getActiveProvider().getSalesOrders();
  }
  async saveSalesOrders(items: SalesOrder[]): Promise<void> {
    return this.getActiveProvider().saveSalesOrders(items);
  }
  async getSalesOrderItems(): Promise<SalesOrderItem[]> {
    return this.getActiveProvider().getSalesOrderItems();
  }
  async saveSalesOrderItems(items: SalesOrderItem[]): Promise<void> {
    return this.getActiveProvider().saveSalesOrderItems(items);
  }
  async getProductGroups(): Promise<ProductGroup[]> {
    return this.getActiveProvider().getProductGroups();
  }
  async saveProductGroups(groups: ProductGroup[]): Promise<void> {
    return this.getActiveProvider().saveProductGroups(groups);
  }
  async getProductCategories(): Promise<ProductCategory[]> {
    return this.getActiveProvider().getProductCategories();
  }
  async saveProductCategories(categories: ProductCategory[]): Promise<void> {
    return this.getActiveProvider().saveProductCategories(categories);
  }
  async getProductVariants(options?: { recalc?: boolean }): Promise<ProductVariant[]> {
    return this.getActiveProvider().getProductVariants(options);
  }
  async saveProductVariants(variants: ProductVariant[]): Promise<void> {
    return this.getActiveProvider().saveProductVariants(variants);
  }
  async updateProductVariantPatch(id: string, patch: Partial<ProductVariant>): Promise<void> {
    return this.getActiveProvider().updateProductVariantPatch(id, patch);
  }
  async getPurchaseBatches(): Promise<PurchaseBatch[]> {
    return this.getActiveProvider().getPurchaseBatches();
  }
  async savePurchaseBatches(batches: PurchaseBatch[]): Promise<void> {
    return this.getActiveProvider().savePurchaseBatches(batches);
  }
  async getPurchaseBatchItems(): Promise<PurchaseBatchItem[]> {
    return this.getActiveProvider().getPurchaseBatchItems();
  }
  async savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void> {
    return this.getActiveProvider().savePurchaseBatchItems(items);
  }
  async getPrivateOrders(): Promise<PrivateOrder[]> {
    return this.getActiveProvider().getPrivateOrders();
  }
  async savePrivateOrders(orders: PrivateOrder[]): Promise<void> {
    return this.getActiveProvider().savePrivateOrders(orders);
  }
  async getPrivateOrderItems(): Promise<PrivateOrderItem[]> {
    return this.getActiveProvider().getPrivateOrderItems();
  }
  async savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void> {
    return this.getActiveProvider().savePrivateOrderItems(items);
  }
  async getImportBatches(): Promise<ImportBatch[]> {
    return this.getActiveProvider().getImportBatches();
  }
  async saveImportBatches(batches: ImportBatch[]): Promise<void> {
    return this.getActiveProvider().saveImportBatches(batches);
  }
  async exportData(): Promise<void> {
    return this.getActiveProvider().exportData();
  }
  async importData(jsonString: string): Promise<boolean> {
    return this.getActiveProvider().importData(jsonString);
  }
  async clearData(): Promise<void> {
    return this.getActiveProvider().clearData();
  }
  async clearPurchaseRecords(): Promise<void> {
    return this.getActiveProvider().clearPurchaseRecords();
  }
  async createPurchaseRecordFromInventory(itemCodes: string[]): Promise<void> {
    return this.getActiveProvider().createPurchaseRecordFromInventory(itemCodes);
  }
  async reparseProductVariants(): Promise<void> {
    return this.getActiveProvider().reparseProductVariants();
  }
  async reparseProductTitles(): Promise<void> {
    return this.getActiveProvider().reparseProductTitles();
  }
  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number }> {
    return this.getActiveProvider().syncProductGroupsWithInventory();
  }
  async deleteProductGroup(groupId: string): Promise<void> {
    return this.getActiveProvider().deleteProductGroup(groupId);
  }
  async deleteProductGroups(groupIds: string[]): Promise<void> {
    return this.getActiveProvider().deleteProductGroups(groupIds);
  }
  async canWriteCloud(): Promise<boolean> {
    return this.getActiveProvider().canWriteCloud();
  }
}


export const dataProvider: IDataProvider = new DynamicDataProvider();
export type { IDataProvider };
export * from './types';
