import { supabase } from './supabaseClient';
import type { IDataProvider } from '../types';
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
} from '../../lib/db';

export class SupabaseProvider implements IDataProvider {
  async testConnection(): Promise<string> {
    try {
      const { data, error } = await supabase
        .from('erp_healthcheck')
        .select('message')
        .limit(1);

      if (error) {
        throw error;
      }

      if (data && data.length > 0) {
        return data[0].message || 'Success';
      }
      return 'Connected, but no test data found.';
    } catch (err: any) {
      console.error('Supabase connection test failed:', err);
      throw new Error(err.message || 'Connection failed');
    }
  }

  // Stub other IDataProvider methods using prefixed underscore variables for unused parameters
  async getInventory(): Promise<InventoryItem[]> { throw new Error('Not implemented'); }
  async upsertInventory(_items: InventoryItem[]): Promise<ImportStats> { throw new Error('Not implemented'); }
  async getSalesOrders(): Promise<SalesOrder[]> { throw new Error('Not implemented'); }
  async saveSalesOrders(_items: SalesOrder[]): Promise<void> { throw new Error('Not implemented'); }
  async getSalesOrderItems(): Promise<SalesOrderItem[]> { throw new Error('Not implemented'); }
  async saveSalesOrderItems(_items: SalesOrderItem[]): Promise<void> { throw new Error('Not implemented'); }
  async getProductGroups(): Promise<ProductGroup[]> { throw new Error('Not implemented'); }
  async saveProductGroups(_groups: ProductGroup[]): Promise<void> { throw new Error('Not implemented'); }
  async getProductCategories(): Promise<ProductCategory[]> { throw new Error('Not implemented'); }
  async saveProductCategories(_categories: ProductCategory[]): Promise<void> { throw new Error('Not implemented'); }
  async getProductVariants(): Promise<ProductVariant[]> { throw new Error('Not implemented'); }
  async saveProductVariants(_variants: ProductVariant[]): Promise<void> { throw new Error('Not implemented'); }
  async getPurchaseBatches(): Promise<PurchaseBatch[]> { throw new Error('Not implemented'); }
  async savePurchaseBatches(_batches: PurchaseBatch[]): Promise<void> { throw new Error('Not implemented'); }
  async getPurchaseBatchItems(): Promise<PurchaseBatchItem[]> { throw new Error('Not implemented'); }
  async savePurchaseBatchItems(_items: PurchaseBatchItem[]): Promise<void> { throw new Error('Not implemented'); }
  async getPrivateOrders(): Promise<PrivateOrder[]> { throw new Error('Not implemented'); }
  async savePrivateOrders(_orders: PrivateOrder[]): Promise<void> { throw new Error('Not implemented'); }
  async getPrivateOrderItems(): Promise<PrivateOrderItem[]> { throw new Error('Not implemented'); }
  async savePrivateOrderItems(_items: PrivateOrderItem[]): Promise<void> { throw new Error('Not implemented'); }
  async getImportBatches(): Promise<ImportBatch[]> { throw new Error('Not implemented'); }
  async saveImportBatches(_batches: ImportBatch[]): Promise<void> { throw new Error('Not implemented'); }
  async exportData(): Promise<void> { throw new Error('Not implemented'); }
  async importData(_jsonString: string): Promise<boolean> { throw new Error('Not implemented'); }
  async clearData(): Promise<void> { throw new Error('Not implemented'); }
  async clearPurchaseRecords(): Promise<void> { throw new Error('Not implemented'); }
  async createPurchaseRecordFromInventory(_itemCodes: string[]): Promise<void> { throw new Error('Not implemented'); }
  async reparseProductVariants(): Promise<void> { throw new Error('Not implemented'); }
  async reparseProductTitles(): Promise<void> { throw new Error('Not implemented'); }
  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number }> { throw new Error('Not implemented'); }
}

export const supabaseProvider = new SupabaseProvider();
