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
  ImportStats,
  JapanPackage,
  JapanPackageItem,
  BundleComponent
} from '../lib/db';

export class StaleDataError extends Error {
  constructor(message = '資料已在其他分頁更新，請重新載入最新資料後再編輯。') {
    super(message);
    this.name = 'StaleDataError';
  }
}

class DynamicDataProvider implements IDataProvider {
  private localProvider = new LocalProvider();
  private supabaseProvider = supabaseProvider;

  private tabId = Math.random().toString(36).substring(2, 9);
  private lastLoadedTime = Date.now();
  private isStale = false;
  private staleCallbacks: ((isStale: boolean) => void)[] = [];

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === 'erp_last_write_info' && e.newValue) {
          try {
            const info = JSON.parse(e.newValue);
            if (info.tabId !== this.tabId) {
              this.isStale = true;
              this.notifySubscribers(true);
            }
          } catch (err) {}
        }
      });
    }
  }

  private notifySubscribers(stale: boolean) {
    this.staleCallbacks.forEach(callback => {
      try {
        callback(stale);
      } catch (err) {
        console.error('Error in stale callback', err);
      }
    });
  }

  onStaleChange(callback: (isStale: boolean) => void): () => void {
    this.staleCallbacks.push(callback);
    return () => {
      this.staleCallbacks = this.staleCallbacks.filter(cb => cb !== callback);
    };
  }

  registerFreshLoad(): void {
    this.lastLoadedTime = Date.now();
    this.isStale = false;
    this.notifySubscribers(false);
  }

  checkIsStaleLive(): boolean {
    if (typeof window === 'undefined') return false;
    const stored = localStorage.getItem('erp_last_write_info');
    if (stored) {
      try {
        const info = JSON.parse(stored);
        if (info.timestamp > this.lastLoadedTime && info.tabId !== this.tabId) {
          this.isStale = true;
          this.notifySubscribers(true);
          return true;
        }
      } catch (err) {}
    }
    return this.isStale;
  }

  private guardStale() {
    if (this.checkIsStaleLive()) {
      throw new StaleDataError();
    }
  }

  private registerWrite() {
    const now = Date.now();
    this.lastLoadedTime = now;
    this.isStale = false;
    this.notifySubscribers(false);
    localStorage.setItem('erp_last_write_info', JSON.stringify({ timestamp: now, tabId: this.tabId }));
  }

  async getInventory(): Promise<InventoryItem[]> {
    return this.getActiveProvider().getInventory();
  }
  async upsertInventory(items: InventoryItem[]): Promise<ImportStats> {
    this.guardStale();
    const result = await this.getActiveProvider().upsertInventory(items);
    this.registerWrite();
    return result;
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
    this.guardStale();
    await this.getActiveProvider().saveProductGroups(groups);
    this.registerWrite();
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
    this.guardStale();
    await this.getActiveProvider().saveProductVariants(variants);
    this.registerWrite();
  }
  async deleteProductVariant(id: string): Promise<void> {
    return this.getActiveProvider().deleteProductVariant(id);
  }
  async updateProductVariantPatch(id: string, patch: Partial<ProductVariant>): Promise<void> {
    return this.getActiveProvider().updateProductVariantPatch(id, patch);
  }
  async updateProductVariantPatchBulk(patches: { id: string, patch: Partial<ProductVariant> }[]): Promise<void> {
    return this.getActiveProvider().updateProductVariantPatchBulk(patches);
  }
  async getPurchaseBatches(): Promise<PurchaseBatch[]> {
    return this.getActiveProvider().getPurchaseBatches();
  }
  async savePurchaseBatches(batches: PurchaseBatch[]): Promise<void> {
    this.guardStale();
    await this.getActiveProvider().savePurchaseBatches(batches);
    this.registerWrite();
  }
  async getPurchaseBatchItems(): Promise<PurchaseBatchItem[]> {
    return this.getActiveProvider().getPurchaseBatchItems();
  }
  async savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void> {
    this.guardStale();
    await this.getActiveProvider().savePurchaseBatchItems(items);
    this.registerWrite();
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
  async deletePrivateOrderItems(ids: string[]): Promise<void> {
    return this.getActiveProvider().deletePrivateOrderItems(ids);
  }
  async getJapanPackages(): Promise<JapanPackage[]> {
    return this.getActiveProvider().getJapanPackages();
  }
  async saveJapanPackages(packages: JapanPackage[]): Promise<void> {
    this.guardStale();
    await this.getActiveProvider().saveJapanPackages(packages);
    this.registerWrite();
  }
  async getJapanPackageItems(): Promise<JapanPackageItem[]> {
    return this.getActiveProvider().getJapanPackageItems();
  }
  async saveJapanPackageItems(items: JapanPackageItem[]): Promise<void> {
    this.guardStale();
    await this.getActiveProvider().saveJapanPackageItems(items);
    this.registerWrite();
  }
  async getBundleComponents(): Promise<BundleComponent[]> {
    return this.getActiveProvider().getBundleComponents();
  }
  async saveBundleComponents(components: BundleComponent[]): Promise<void> {
    this.guardStale();
    await this.getActiveProvider().saveBundleComponents(components);
    this.registerWrite();
  }
  async saveBundleComponentsForVariant(bundleVariantId: string, componentVariantIds: string[]): Promise<void> {
    this.guardStale();
    await this.getActiveProvider().saveBundleComponentsForVariant(bundleVariantId, componentVariantIds);
    this.registerWrite();
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
    this.guardStale();
    const result = await this.getActiveProvider().importData(jsonString);
    this.registerWrite();
    return result;
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
  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number, upgradedSkusCount?: number }> {
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
  async getLastImportBackup(): Promise<{ data: string; timestamp: string } | null> {
    return this.getActiveProvider().getLastImportBackup();
  }
  async saveLastImportBackup(backup: { data: string; timestamp: string }): Promise<void> {
    return this.getActiveProvider().saveLastImportBackup(backup);
  }
  async restoreBackup(backupData: any): Promise<boolean> {
    this.guardStale();
    const result = await this.getActiveProvider().restoreBackup(backupData);
    this.registerWrite();
    return result;
  }

  private getActiveProvider(): IDataProvider {
    const mode = getProviderMode();
    if (mode === 'cloud') {
      return this.supabaseProvider;
    } else if (mode === 'fallback') {
      return this.supabaseProvider;
    }
    return this.localProvider;
  }
}

export const dataProvider = new DynamicDataProvider();
if (typeof window !== 'undefined') {
  (window as any).dataProvider = dataProvider;
  (window as any).StaleDataError = StaleDataError;
}
export type { IDataProvider };
export * from './types';
