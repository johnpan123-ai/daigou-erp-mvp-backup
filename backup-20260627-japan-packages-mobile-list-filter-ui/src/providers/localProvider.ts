import type { IDataProvider } from './types';
import { db, calculateFinalMyacgDemand } from '../lib/db';
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
  ImportStats,
  JapanPackage,
  JapanPackageItem
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
    const allLocalVars = await db.getProductVariants();
    const allLocalVarsMap = new Map(allLocalVars.map(v => [v.id, v]));
    for (const v of variants) {
      const existing = allLocalVarsMap.get(v.id);
      if (existing) {
        allLocalVarsMap.set(v.id, { ...existing, ...v });
      } else {
        allLocalVarsMap.set(v.id, v);
      }
    }
    const mergedVars = Array.from(allLocalVarsMap.values());
    return db.saveProductVariants(mergedVars);
  }
  async deleteProductVariant(id: string): Promise<void> {
    return db.deleteProductVariant(id);
  }
  async updateProductVariantPatch(id: string, patch: Partial<ProductVariant>): Promise<void> {
    return db.updateProductVariantPatch(id, patch);
  }
  async updateProductVariantPatchBulk(patches: { id: string, patch: Partial<ProductVariant> }[]): Promise<void> {
    return db.updateProductVariantPatchBulk(patches);
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
  async deletePrivateOrderItems(ids: string[]): Promise<void> {
    return db.deletePrivateOrderItems(ids);
  }
  async getJapanPackages(): Promise<JapanPackage[]> {
    return db.getJapanPackages();
  }
  async saveJapanPackages(packages: JapanPackage[]): Promise<void> {
    return db.saveJapanPackages(packages);
  }
  async getJapanPackageItems(): Promise<JapanPackageItem[]> {
    return db.getJapanPackageItems();
  }
  async saveJapanPackageItems(items: JapanPackageItem[]): Promise<void> {
    return db.saveJapanPackageItems(items);
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
    await db.createPurchaseRecordFromInventory(itemCodes);
    const inventory = await db.getInventory();
    const salesOrderItems = await db.getSalesOrderItems();
    const allVariants = await db.getProductVariants();
    
    const targetCodes = new Set(itemCodes.map(code => code.trim().toUpperCase()));
    let changed = false;
    
    for (const v of allVariants) {
      if (v.myacg_item_code && targetCodes.has(v.myacg_item_code.trim().toUpperCase())) {
        const effectiveMyacg = calculateFinalMyacgDemand(v.myacg_item_code, inventory, salesOrderItems);
        if (v.myacg_auto_quantity !== effectiveMyacg || v.effective_myacg_quantity !== effectiveMyacg) {
          v.myacg_auto_quantity = effectiveMyacg;
          v.effective_myacg_quantity = effectiveMyacg;
          changed = true;
        }
      }
    }
    
    if (changed) {
      await db.saveProductVariants(allVariants);
    }
  }
  async reparseProductVariants(): Promise<void> {
    return db.reparseProductVariants();
  }
  async reparseProductTitles(): Promise<void> {
    return db.reparseProductTitles();
  }
  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number, upgradedSkusCount?: number }> {
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
  async getLastImportBackup(): Promise<{ data: string; timestamp: string } | null> {
    return db.getLastImportBackup();
  }
  async saveLastImportBackup(backup: { data: string; timestamp: string }): Promise<void> {
    return db.saveLastImportBackup(backup);
  }
  async restoreBackup(backupData: any): Promise<boolean> {
    return db.importData(JSON.stringify(backupData));
  }
}

